/**
 * CDP 动作层：把「模型给的 ref」变成真正的鼠标键盘事件，外加对话框、上传、frame/tab。
 *
 * 设计要点：
 *   1. **动作前先复核 ref**（{@link verifyRef}）：`DOM.describeNode` 只能说明「这个后端节点号还在」，
 *      它看不到 ARIA 角色与可访问名——页面把「删除」按钮换成「清空」按钮，后端节点号往往不变。
 *      所以复核要两问：`DOM.describeNode`（还在吗）+ `Accessibility.getPartialAXTree`（role/name 变了吗）。
 *      两家都不对就报「页面已变，请重新 snapshot」，绝不照着旧快照乱点；
 *   2. **定位靠 `DOM.getBoxModel`**：取 content 四边形的中心，再做 `Input.dispatchMouseEvent`
 *      moved → pressed → released。不用 `Runtime.evaluate` 自己算坐标：iframe 与滚动偏移
 *      由 CDP 换算好，少一类坐标对不上的 bug；
 *   3. **等待是简化版**：短轮询「box model 算得出来 + 面积非零 + DOM 域已 enable」，
 *      **不是** Playwright 那套 actionability（元素稳定、命中测试落在自己身上、
 *      receives-events 判定全都没做）。做不到就写在注释与错误信息里，不假装做了；
 *   4. **对话框有超时兜底**：页面弹了 JS 对话框之后，这个页面上的多数 CDP 命令会被浏览器挂住，
 *      只留 `Page.handleJavaScriptDialog` 能过——所以对话框必须在超时后自动放掉，
 *      否则一次 `alert()` 就能把整条自动化卡死（策略与计时在插件层）。
 *
 * @module dsc/core/cdp/actions
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { AxNode, SnapshotRef } from './snapshot.js'
import { refRecordMatches } from './snapshot.js'
import type { CdpSessionView, CdpTransport } from './transport.js'

/** 页面上一次动作的战果（插件拿它拼给人看的摘要与结构化 JSON）。 */
export interface PointResult {
  x: number
  y: number
}

/** 点击参数。 */
export interface ClickOptions {
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  /** 等元素出现/可见的上限（缺省 5s）。 */
  timeoutMs?: number
}

/** 输入参数。 */
export interface TypeOptions {
  /** 先全选删掉旧内容（默认 false = 追加）。 */
  clear?: boolean
  /** 输完按回车（默认 false）。 */
  submit?: boolean
}

/** 按键解析结果。 */
export interface KeyStroke {
  /** 显示用的键名（`Enter`、`a`）。 */
  key: string
  code: string
  /** Windows 虚拟键码（Chrome 靠它认键）。 */
  vk: number
  /** 修饰键位掩码：Alt 1 / Ctrl 2 / Meta 4 / Shift 8。 */
  modifiers: number
  /** 需要产生字符时给 CDP 的 text（带 Ctrl/Alt/Meta 的按键不给）。 */
  text?: string
}

/** 页面基本状态。 */
export interface DocumentState {
  url: string
  title: string
  readyState: string
}

/** 一个可附加的目标（标签页或独立进程 iframe）。 */
export interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
}

/** 鼠标键位掩码（dispatchMouseEvent 的 buttons 字段）。 */
const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

/** 视口外的点先滚进可视区，再取坐标。 */
const SCROLL_MARGIN = 8

/** 特殊键表（照 `examples/plugins/browser-control.js:241-251` 扩了一版）。 */
const KEY_TABLE: Record<string, { vk: number; code: string; text?: string }> = {
  enter: { vk: 13, code: 'Enter', text: '\r' },
  return: { vk: 13, code: 'Enter', text: '\r' },
  tab: { vk: 9, code: 'Tab', text: '\t' },
  escape: { vk: 27, code: 'Escape' },
  esc: { vk: 27, code: 'Escape' },
  backspace: { vk: 8, code: 'Backspace' },
  delete: { vk: 46, code: 'Delete' },
  del: { vk: 46, code: 'Delete' },
  insert: { vk: 45, code: 'Insert' },
  arrowup: { vk: 38, code: 'ArrowUp' },
  arrowdown: { vk: 40, code: 'ArrowDown' },
  arrowleft: { vk: 37, code: 'ArrowLeft' },
  arrowright: { vk: 39, code: 'ArrowRight' },
  home: { vk: 36, code: 'Home' },
  end: { vk: 35, code: 'End' },
  pageup: { vk: 33, code: 'PageUp' },
  pagedown: { vk: 34, code: 'PageDown' },
  space: { vk: 32, code: 'Space', text: ' ' },
  f1: { vk: 112, code: 'F1' },
  f2: { vk: 113, code: 'F2' },
  f3: { vk: 114, code: 'F3' },
  f4: { vk: 115, code: 'F4' },
  f5: { vk: 116, code: 'F5' },
  f6: { vk: 117, code: 'F6' },
  f7: { vk: 118, code: 'F7' },
  f8: { vk: 119, code: 'F8' },
  f9: { vk: 120, code: 'F9' },
  f10: { vk: 121, code: 'F10' },
  f11: { vk: 122, code: 'F11' },
  f12: { vk: 123, code: 'F12' },
}

/** 修饰键位掩码。 */
const MODIFIER_TABLE: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  win: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
}

/** 敏感原语黑名单：网页上下文里这些本来也不该出现，出现就说明这次求值来路不对。 */
const SENSITIVE_PRIMITIVES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'require(', re: /(?<![\w.])require\s*\(/ },
  { name: 'process.binding', re: /process\s*\.\s*binding\b/ },
  { name: 'process.mainModule', re: /process\s*\.\s*mainModule\b/ },
  { name: 'process.dlopen', re: /process\s*\.\s*dlopen\b/ },
  { name: 'module.constructor', re: /module\s*\.\s*constructor\b/ },
  { name: 'child_process', re: /child_process/ },
  { name: 'electron', re: /\belectron\b\s*\.\s*(?:remote|ipcRenderer)/ },
]

/**
 * 解析键名。
 *
 * 支持 `enter` / `ctrl+a` / `Control+Shift+Delete` 这类写法。
 * 字母与数字按键现算虚拟键码（虚拟键码就是大写 ASCII）。
 */
export function resolveKey(key: string): KeyStroke {
  const parts = key.split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) throw new Error('按键名是空的')
  const main = parts[parts.length - 1]!
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_TABLE[part.toLowerCase()]
    if (bit === undefined) throw new Error(`不认识的修饰键：${part}（可用 Ctrl/Alt/Shift/Meta）`)
    modifiers |= bit
  }
  const special = KEY_TABLE[main.toLowerCase()]
  if (special !== undefined) {
    const stroke: KeyStroke = { key: special.code, code: special.code, vk: special.vk, modifiers }
    // 带 Ctrl/Alt/Meta 的按键不该产生字符（Ctrl+A 是全选，不是输入一个 a）
    if (special.text !== undefined && (modifiers & (1 | 2 | 4)) === 0) stroke.text = special.text
    return stroke
  }
  if ([...main].length === 1) {
    const char = main
    const upper = char.toUpperCase()
    const vk = upper.charCodeAt(0)
    const isLetter = /[A-Za-z]/.test(char)
    const isDigit = /[0-9]/.test(char)
    const stroke: KeyStroke = {
      key: char,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${char}` : '',
      vk,
      modifiers,
    }
    if ((modifiers & (1 | 2 | 4)) === 0) stroke.text = (modifiers & 8) !== 0 ? upper : char
    return stroke
  }
  throw new Error(
    `不认识的按键：${key}。可用：Enter / Tab / Escape / Backspace / Delete / 方向键 / Home / End / PageUp / PageDown / Space / F1-F12 / 单个字符，组合键写成 ctrl+a`,
  )
}

/**
 * 求值表达式预扫：敏感原语 + 地址字面量。
 *
 * 这一步是**给守卫看的**（守卫在动手前拒绝），不是沙箱：页面里的 JS 本来就跑在网页上下文，
 * 真正要拦的是「模型写了个从本机读东西的表达式」和「表达式里塞了个私网/元数据地址」。
 */
export function scanExpression(expression: string): { sensitive: string[]; urls: string[] } {
  const sensitive: string[] = []
  for (const { name, re } of SENSITIVE_PRIMITIVES) {
    if (new RegExp(re.source, re.flags).test(expression)) sensitive.push(name)
  }
  const urls: string[] = []
  // 用 `\S+` 而不是自己写字符类：少一个量词就会退化成「http:// 加一个字符」，
  // 尾部的引号/括号/逗号由 TRIM_TAIL 去掉，判定才是干净的地址。
  for (const match of expression.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRIM_TAIL, '')
    if (url !== '') urls.push(url)
  }
  return { sensitive, urls }
}

/** 表达式里的地址字面量（最小匹配到空白为止，再修掉尾巴）。 */
const URL_PATTERN = /https?:\/\/\S+/gi

/** 地址尾巴上不该算进去的标点。 */
const TRIM_TAIL = /["'`<>)\],;]+$/

/**
 * 复核 ref 还指得着同一个东西。
 *
 * 抛错信息统一成「页面已变，请重新 snapshot」，模型照做即可自愈。
 */
export async function verifyRef(page: CdpSessionView, ref: SnapshotRef): Promise<void> {
  const stale = (): Error =>
    new Error(
      `ref「${ref.ref}」对应的元素已经变了（${ref.role}${ref.name === '' ? '' : ` "${ref.name}"`} 不在原处或已换名）：` +
        '页面已变，请重新 snapshot（browser_look action=snapshot）拿新 ref 再动手',
    )
  let described: { node?: { backendNodeId?: number } }
  try {
    described = await page.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
      backendNodeId: ref.backendNodeId,
    })
  } catch {
    throw stale() // 后端节点号已经算不出节点：元素被删了
  }
  const backendNodeId = described.node?.backendNodeId
  if (typeof backendNodeId !== 'number' || backendNodeId !== ref.backendNodeId) throw stale()
  // describeNode 看不到 ARIA 角色与可访问名，必须再问一次无障碍域
  let partial: { nodes?: AxNode[] }
  try {
    partial = await page.send<{ nodes?: AxNode[] }>('Accessibility.getPartialAXTree', {
      backendNodeId: ref.backendNodeId,
      fetchRelatives: false,
    })
  } catch {
    throw stale()
  }
  const node = (partial.nodes ?? []).find((candidate) => candidate.backendDOMNodeId === ref.backendNodeId) ?? partial.nodes?.[0]
  if (!refRecordMatches(ref, node)) throw stale()
}

/**
 * 等元素有非空 box model，并算出可点中心。
 *
 * 这是**简化版**可交互等待：只问「框算得出来吗、面积是不是零」，
 * 没做 Playwright 那套（元素在两次测量之间是否稳定、中心点命中测试是否落在自己身上、
 * 上方有没有别的东西挡住）。所以点完必须再看一眼页面，别假设一定生效。
 */
export async function waitForClickPoint(page: CdpSessionView, ref: SnapshotRef, timeoutMs: number, signal?: AbortSignal): Promise<PointResult> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let lastProblem = '还没等到元素出现'
  for (;;) {
    signal?.throwIfAborted()
    let model: { content?: number[] } | null = null
    try {
      model = await page.send<{ content?: number[] }>('DOM.getBoxModel', { backendNodeId: ref.backendNodeId })
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error)
    }
    const content = model?.content
    if (content !== undefined && content.length >= 8) {
      const points = quadToPoints(content)
      if (quadArea(points) > 0) {
        const center = quadCenter(points)
        if (await ensureInViewport(page, ref.backendNodeId, center)) {
          const refreshed = await boxCenter(page, ref.backendNodeId)
          if (refreshed !== null) return refreshed
        } else {
          lastProblem = '元素在视口外，滚动后还是没进可视区'
        }
      } else {
        lastProblem = '元素算得出框，但面积是零（不可见）'
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `等 ref「${ref.ref}」可点击超时（${timeoutMs}ms）：${lastProblem}。` +
          '这是简化版等待（只看框算不算得出来），页面如果还在加载，可以加大 waitTimeoutMs 或先 browser_look action=wait_for',
      )
    }
    await sleep(100, signal)
  }
}

/** 点到哪、点了几次。 */
export interface ClickOutcome extends PointResult {
  clicks: number
  button: string
}

/** 点击（moved → pressed → released；双击发两轮，第二轮 clickCount=2）。 */
export async function clickRef(
  page: CdpSessionView,
  ref: SnapshotRef,
  options: ClickOptions = {},
  signal?: AbortSignal,
): Promise<ClickOutcome> {
  await verifyRef(page, ref)
  await assertEnabled(page, ref)
  const timeoutMs = options.timeoutMs ?? 5000
  const point = await waitForClickPoint(page, ref, timeoutMs, signal)
  const button = options.button ?? 'left'
  const mask = BUTTON_MASK[button] ?? 1
  const clicks = options.double === true ? 2 : 1
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  const rounds = options.double === true ? [1, 2] : [1]
  for (const clickCount of rounds) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button,
      buttons: mask,
      clickCount,
    })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button,
      buttons: 0,
      clickCount,
    })
  }
  return { ...point, clicks, button }
}

/** 悬停（只发 mouseMoved，不按）。 */
export async function hoverRef(page: CdpSessionView, ref: SnapshotRef, timeoutMs = 5000, signal?: AbortSignal): Promise<PointResult> {
  await verifyRef(page, ref)
  const point = await waitForClickPoint(page, ref, timeoutMs, signal)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  return point
}

/** 往元素里输入文本（`DOM.focus` + `Input.insertText`，中文与特殊字符都过）。 */
export async function typeIntoRef(
  page: CdpSessionView,
  ref: SnapshotRef,
  text: string,
  options: TypeOptions = {},
): Promise<{ chars: number; cleared: boolean; submitted: boolean }> {
  await verifyRef(page, ref)
  await assertEnabled(page, ref)
  await page.send('DOM.focus', { backendNodeId: ref.backendNodeId })
  let cleared = false
  if (options.clear === true) {
    // 全选 + 删：比读一次旧值再逐字退格可靠（值可能是密码框里的点，读不出来）
    await pressKey(page, 'ctrl+a')
    await pressKey(page, 'Delete')
    cleared = true
  }
  if (text !== '') await page.send('Input.insertText', { text })
  let submitted = false
  if (options.submit === true) {
    await pressKey(page, 'Enter')
    submitted = true
  }
  return { chars: [...text].length, cleared, submitted }
}

/** 按键（可先聚焦某个 ref）。 */
export async function pressKey(page: CdpSessionView, key: string, ref?: SnapshotRef): Promise<KeyStroke> {
  const stroke = resolveKey(key)
  if (ref !== undefined) await page.send('DOM.focus', { backendNodeId: ref.backendNodeId })
  const base: Record<string, unknown> = {
    modifiers: stroke.modifiers,
    windowsVirtualKeyCode: stroke.vk,
    nativeVirtualKeyCode: stroke.vk,
    key: stroke.key,
  }
  if (stroke.code !== '') base.code = stroke.code
  // 带修饰键的按键用 rawKeyDown：keyDown 会顺带产出字符，Ctrl+A 会变成「输入 a」
  const downType = stroke.text === undefined ? 'rawKeyDown' : 'keyDown'
  await page.send('Input.dispatchKeyEvent', {
    ...base,
    type: downType,
    ...(stroke.text === undefined ? {} : { text: stroke.text, unmodifiedText: stroke.text }),
  })
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  return stroke
}

/** 选择下拉项（按 value 或可见文本匹配，大小写与首尾空白都忽略）。 */
export async function selectRef(page: CdpSessionView, ref: SnapshotRef, values: readonly string[]): Promise<{ selected: string[] }> {
  await verifyRef(page, ref)
  const resolved = await page.send<{ objectId?: string }>('DOM.resolveNode', { backendNodeId: ref.backendNodeId })
  if (typeof resolved.objectId !== 'string') throw new Error(`ref「${ref.ref}」拿不到页面里的对象句柄，可能已经不是元素了`)
  const response = await page.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
    'Runtime.callFunctionOn',
    {
      objectId: resolved.objectId,
      functionDeclaration: `function (wanted) {
        if (typeof this.options === 'undefined') return null;
        const wantedList = wanted.map((v) => String(v).trim().toLowerCase());
        for (const option of Array.from(this.options)) {
          const value = String(option.value).trim().toLowerCase();
          const label = String(option.textContent ?? '').trim().toLowerCase();
          option.selected = wantedList.includes(value) || wantedList.includes(label);
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(this.selectedOptions ?? []).map((option) => String(option.textContent ?? '').trim());
      }`,
      arguments: [{ value: [...values] }],
      returnByValue: true,
    },
  )
  if (response.exceptionDetails !== undefined) {
    throw new Error(`设置下拉项时页面报错：${response.exceptionDetails.text ?? '未知异常'}`)
  }
  if (response.result?.value === null || response.result?.value === undefined) {
    throw new Error(`ref「${ref.ref}」不是 <select>（没有 options），下拉选择用不上它`)
  }
  const selected = Array.isArray(response.result.value) ? response.result.value.map((item) => String(item)) : []
  if (selected.length === 0) throw new Error(`给定的值 ${values.join('、')} 在这个下拉里一个都没匹配上`)
  return { selected }
}

/** 滚动参数。 */
export interface ScrollOptions {
  /** 从哪个元素的位置滚（缺省视口中心）。 */
  ref?: SnapshotRef
  /** up/down/left/right 按 deltaY/deltaX 滚一屏；top/bottom 直接到头。 */
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'
  /** 滚动量（像素），缺省 500。 */
  deltaY?: number
  deltaX?: number
  timeoutMs?: number
}

/** 滚动：方向上用鼠标滚轮事件（跟真人一样会触发 scroll 与懒加载），top/bottom 直接用 scrollTo。 */
export async function scrollPage(page: CdpSessionView, options: ScrollOptions = {}, signal?: AbortSignal): Promise<PointResult & { deltaX: number; deltaY: number }> {
  const direction = options.direction ?? 'down'
  if (direction === 'top' || direction === 'bottom') {
    const target = direction === 'top' ? '0' : 'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
    await page.send('Runtime.evaluate', {
      expression: `window.scrollTo(0, ${target}); document.scrollingElement ? document.scrollingElement.scrollTop : 0`,
      returnByValue: true,
    })
    return { x: 0, y: 0, deltaX: 0, deltaY: 0 }
  }
  const amount = Math.abs(options.deltaY ?? options.deltaX ?? 500)
  const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : (options.deltaX ?? 0)
  const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : (options.deltaY ?? 0)
  let point: PointResult
  if (options.ref !== undefined) {
    point = await waitForClickPoint(page, options.ref, options.timeoutMs ?? 5000, signal)
  } else {
    const metrics = await page.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
      'Page.getLayoutMetrics',
    )
    const width = metrics.cssLayoutViewport?.clientWidth ?? 800
    const height = metrics.cssLayoutViewport?.clientHeight ?? 600
    point = { x: Math.round(width / 2), y: Math.round(height / 2) }
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  })
  return { x: point.x, y: point.y, deltaX, deltaY }
}

/** 一次填多个字段（先把所有 ref 复核完再动手，避免填一半才发现有个 ref 过期）。 */
export async function fillForm(
  page: CdpSessionView,
  entries: ReadonlyArray<{ ref: SnapshotRef; value: string }>,
  options: { clear?: boolean } = {},
): Promise<{ filled: number; fields: string[] }> {
  for (const entry of entries) {
    await verifyRef(page, entry.ref)
    await assertEnabled(page, entry.ref)
  }
  const fields: string[] = []
  for (const entry of entries) {
    await typeIntoRef(page, entry.ref, entry.value, { clear: options.clear !== false })
    fields.push(entry.ref.ref)
  }
  return { filled: fields.length, fields }
}

/** 求值结果。 */
export interface EvaluateOutcome {
  /** 结果文本（JSON 化后截断到 2000 字）。 */
  text: string
  truncated: boolean
}

/**
 * 页面内求值。
 *
 * `returnByValue: true` 让普通值直接回来；对象拿不到值就用 `description` 兜底（形如 `Object`）。
 * 结果一律 JSON 化再截断：页面可能返回整个 DOM，全文塞回模型就是白烧上下文。
 */
export async function evaluateInPage(page: CdpSessionView, expression: string, timeoutMs = 15_000): Promise<EvaluateOutcome> {
  const response = await page.send<{
    result?: { value?: unknown; description?: string; type?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs })
  if (response.exceptionDetails !== undefined) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? '未知异常'
    throw new Error(`页面 JS 抛异常：${detail.split('\n')[0]?.slice(0, 300) ?? detail}`)
  }
  const raw = response.result?.value
  let text: string
  if (raw !== undefined) {
    try {
      text = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw)
    } catch {
      text = String(raw)
    }
  } else {
    text = response.result?.description ?? String(response.result?.type ?? 'undefined')
  }
  const truncated = text.length > 2000
  return { text: truncated ? `${text.slice(0, 2000)}…（结果更长，已截断到 2000 字）` : text, truncated }
}

/** 给文件输入框塞本机文件。 */
export async function uploadFiles(page: CdpSessionView, ref: SnapshotRef, paths: readonly string[], baseDir: string): Promise<{ files: string[] }> {
  if (paths.length === 0) throw new Error('没有给要上传的文件路径')
  const files = paths.map((entry) => {
    const full = isAbsolute(entry) ? entry : resolve(baseDir, entry)
    if (!existsSync(full)) throw new Error(`要上传的文件不存在：${full}`)
    return full // Windows 上用原生反斜杠路径，DOM.setFileInputFiles 就这么收
  })
  await verifyRef(page, ref)
  await page.send('DOM.setFileInputFiles', { files, backendNodeId: ref.backendNodeId })
  return { files }
}

/** 应答（或关掉）JS 对话框。 */
export async function handleDialog(page: CdpSessionView, options: { accept: boolean; promptText?: string }): Promise<void> {
  await page.send('Page.handleJavaScriptDialog', {
    accept: options.accept,
    ...(options.promptText === undefined ? {} : { promptText: options.promptText }),
  })
}

/** 截图。 */
export async function captureScreenshot(page: CdpSessionView, fullPage: boolean): Promise<{ base64: string; fullPage: boolean }> {
  const shot = await page.send<{ data?: string }>('Page.captureScreenshot', {
    format: 'png',
    ...(fullPage ? { captureBeyondViewport: true } : {}),
  })
  if (typeof shot.data !== 'string' || shot.data === '') throw new Error('截图失败：浏览器没返回图像数据')
  return { base64: shot.data, fullPage }
}

/** 读页面地址、标题与加载状态。 */
export async function readDocumentState(page: CdpSessionView): Promise<DocumentState> {
  const response = await page.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title, readyState: document.readyState })',
    returnByValue: true,
  })
  const value = response.result?.value as Partial<DocumentState> | undefined
  return {
    url: typeof value?.url === 'string' ? value.url : '',
    title: typeof value?.title === 'string' ? value.title : '',
    readyState: typeof value?.readyState === 'string' ? value.readyState : 'unknown',
  }
}

/** 等页面加载完（readyState 到 interactive/complete 就算，别为了一两个慢图片卡死）。 */
export async function waitForPageLoad(page: CdpSessionView, timeoutMs = 15_000, signal?: AbortSignal): Promise<DocumentState> {
  const deadline = Date.now() + timeoutMs
  let state = await readDocumentState(page)
  while (state.readyState !== 'complete' && state.readyState !== 'interactive') {
    if (Date.now() >= deadline) return state
    await sleep(200, signal)
    try {
      state = await readDocumentState(page)
    } catch {
      // 导航中途执行上下文会被换掉，这一轮读失败很正常
    }
  }
  return state
}

/** 等文本出现或选择器命中（wait_for 用）。 */
export async function waitForCondition(
  page: CdpSessionView,
  condition: { text?: string; selector?: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ matched: boolean; waitedMs: number }> {
  const expression =
    condition.selector !== undefined && condition.selector !== ''
      ? `!!document.querySelector(${JSON.stringify(condition.selector)})`
      : `!!(document.body && typeof document.body.innerText === 'string' && document.body.innerText.includes(${JSON.stringify(condition.text ?? '')}))`
  const started = Date.now()
  for (;;) {
    signal?.throwIfAborted()
    try {
      const response = await page.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })
      if (response.result?.value === true) return { matched: true, waitedMs: Date.now() - started }
    } catch {
      // 页面正在导航：这一轮当没命中
    }
    if (Date.now() - started >= timeoutMs) return { matched: false, waitedMs: Date.now() - started }
    await sleep(200, signal)
  }
}

/** 只用得上 `send` 的极小接口：浏览器级连接与页面 session 都能传进来。 */
export interface CdpSender {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** 设下载目录（不设的话下载会落在临时 profile 里，关掉浏览器就没了）。 */
export async function setDownloadBehavior(sender: CdpSender, downloadDir: string): Promise<void> {
  await sender.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: false,
  })
}

/** 列全部目标（标签页 + 独立进程 iframe，后者靠它才能 frame 进去）。 */
export async function listTargets(browser: CdpTransport): Promise<TargetInfo[]> {
  const response = await browser.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets')
  return response.targetInfos ?? []
}

/** 附加到目标（flatten 才支持一条连接里挂多个 session）。返回 sessionId。 */
export async function attachToTarget(browser: CdpTransport, targetId: string): Promise<string> {
  const response = await browser.send<{ sessionId?: string }>('Target.attachToTarget', { targetId, flatten: true })
  if (typeof response.sessionId !== 'string' || response.sessionId === '') {
    throw new Error(`附加到目标 ${targetId} 失败：浏览器没给 sessionId`)
  }
  return response.sessionId
}

/** 新开标签页。 */
export async function createTarget(browser: CdpTransport, url: string): Promise<string> {
  const response = await browser.send<{ targetId?: string }>('Target.createTarget', { url })
  if (typeof response.targetId !== 'string' || response.targetId === '') throw new Error('新建标签页失败：浏览器没给 targetId')
  return response.targetId
}

/** 关标签页。 */
export async function closeTarget(browser: CdpTransport, targetId: string): Promise<void> {
  await browser.send('Target.closeTarget', { targetId })
}

/** 把标签页切到前台（不然截图拿到的是别的页）。 */
export async function activateTarget(browser: CdpTransport, targetId: string): Promise<void> {
  await browser.send('Target.activateTarget', { targetId })
}

/** 取页面主框架的 frameId（frame 路由要用）。 */
export async function mainFrameId(page: CdpSessionView): Promise<string> {
  const tree = await page.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
  const id = tree.frameTree?.frame?.id
  return typeof id === 'string' ? id : ''
}

/** 元素是不是禁用了（禁用就别点，点了也不会生效，白白让模型以为成功）。 */
async function assertEnabled(page: CdpSessionView, ref: SnapshotRef): Promise<void> {
  try {
    const partial = await page.send<{ nodes?: AxNode[] }>('Accessibility.getPartialAXTree', {
      backendNodeId: ref.backendNodeId,
      fetchRelatives: false,
    })
    const node = (partial.nodes ?? [])[0]
    const disabled = (node?.properties ?? []).find((property) => property.name?.toLowerCase() === 'disabled')
    if (disabled?.value?.value === true || disabled?.value?.value === 'true') {
      throw new Error(`ref「${ref.ref}」现在是禁用状态（disabled），点它/填它都不会生效；先解决页面上的前置条件`)
    }
  } catch (error) {
    // 「禁用」这个判断是我们自己抛的，别的错误（取不到无障碍信息）不该拦住动作
    if (error instanceof Error && error.message.includes('禁用状态')) throw error
  }
}

/** 元素不在视口里就滚进来。返回 false = 滚了还是不在（多半被固定定位挡住或页面不滚）。 */
async function ensureInViewport(page: CdpSessionView, backendNodeId: number, point: PointResult): Promise<boolean> {
  const metrics = await page.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
  const width = metrics.cssLayoutViewport?.clientWidth ?? 0
  const height = metrics.cssLayoutViewport?.clientHeight ?? 0
  if (width === 0 || height === 0) return true // 拿不到视口尺寸就别自作聪明
  const visible =
    point.x >= SCROLL_MARGIN && point.y >= SCROLL_MARGIN && point.x <= width - SCROLL_MARGIN && point.y <= height - SCROLL_MARGIN
  if (visible) return true
  await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const again = await boxCenter(page, backendNodeId)
  if (again === null) return false
  return again.x >= 0 && again.y >= 0 && again.x <= width && again.y <= height
}

/** 直接取 box model 的中心（不滚动、不等待）。 */
async function boxCenter(page: CdpSessionView, backendNodeId: number): Promise<PointResult | null> {
  try {
    const model = await page.send<{ content?: number[] }>('DOM.getBoxModel', { backendNodeId })
    const content = model.content
    if (content === undefined || content.length < 8) return null
    const center = quadCenter(quadToPoints(content))
    return { x: Math.round(center.x), y: Math.round(center.y) }
  } catch {
    return null
  }
}

/** 四边形（8 个数）→ 4 个点。 */
function quadToPoints(quad: number[]): Array<{ x: number; y: number }> {
  return [
    { x: quad[0] ?? 0, y: quad[1] ?? 0 },
    { x: quad[2] ?? 0, y: quad[3] ?? 0 },
    { x: quad[4] ?? 0, y: quad[5] ?? 0 },
    { x: quad[6] ?? 0, y: quad[7] ?? 0 },
  ]
}

/** 四边形面积（鞋带公式；零面积 = 看不见）。 */
function quadArea(points: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

/** 四边形中心。 */
function quadCenter(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

/** 可取消的短延时。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new Error('操作已取消'))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer)
        rejectPromise(new Error('操作已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
