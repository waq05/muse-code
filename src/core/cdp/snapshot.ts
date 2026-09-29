/**
 * 无障碍树快照：`Accessibility.getFullAXTree` → 给模型看的文本树 + 行内 ref。
 *
 * 为什么用无障碍树而不是自己遍历 DOM：
 *   1. role / name / checked / expanded 这些「这个东西是什么、叫什么、什么状态」
 *      浏览器已经按 W3C 的规范算好了（含 `aria-*`、`<label for>`、`<button>` 的隐式角色）。
 *      自己写等于重抄一份几千行的 accname 规范，抄不对还会算错；
 *   2. 文本树天然是给模型看的形状——元素少、层级清楚、没有 style 噪音；
 *   3. 每个节点带 `backendDOMNodeId`，这个号能直接喂给 `DOM.getBoxModel` /
 *      `DOM.setFileInputFiles` / `Input.*`，于是「模型只给 ref、我们负责落到像素」成立。
 *
 * ref 的两条规矩（这是与「截图 + 坐标」最大的差别）：
 *   - **只给能动手的东西发 ref**：默认 compact 视图只列可交互角色（button/link/textbox/…），
 *     模型拿到的每个 ref 都是能点能填的，不会去点一个装饰性的 div；
 *   - **ref 带代际**：每次快照递增 generation，动作前既核对 ref 属于本次快照，
 *     又用 `DOM.describeNode` + `Accessibility.getPartialAXTree` 复核这个后端节点还在、
 *     role/name 没变（页面自己改了 DOM 而模型还照着旧快照动手，就靠这一步拦下来）。
 *
 * @module dsc/core/cdp/snapshot
 */

/** 无障碍树里的一个值（type + value 两步取值是协议的规定形状）。 */
export interface AxValue<T> {
  type?: string
  value?: T
}

/** `Accessibility.getFullAXTree` 返回的一个节点（只声明我们用得到的字段）。 */
export interface AxNode {
  nodeId?: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  role?: AxValue<string>
  name?: AxValue<string>
  description?: AxValue<string>
  value?: AxValue<unknown>
  backendDOMNodeId?: number
  properties?: Array<{ name?: string; value?: AxValue<unknown> }>
}

/** 一次快照里的树。 */
export interface AxTree {
  nodes?: AxNode[]
}

/**
 * 可交互角色白名单（小写比较）。
 * 这些角色要么能点（button/link/menuitem/tab）、要么能填（textbox/combobox/checkbox/…）、
 * 要么能拖（slider）。不在名单里的（heading/paragraph/generic/StaticText…）只做上下文，
 * 默认视图不列，也不发 ref。
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'menulist',
  'menulistoption',
  'popupbutton',
  'togglebutton',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
])

/** 纯文本角色：内容折进父节点的 `: 文本` 里，自己不成行（否则一页多出几百行噪音）。 */
const TEXT_ROLES: ReadonlySet<string> = new Set(['statictext', 'inlinetextbox'])

/** 结构容器角色：全量视图也不单独成行，但**继续往下走**——可交互后代不能丢。 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['generic', 'none', 'presentation', 'rootwebarea'])

/** 值比名字更能说明现状的角色（输入框里填了什么，比它的 label 重要）。 */
const VALUE_FIRST_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox'])

/** 一行里名字/文本最长多少字符（再长就是整段正文塞进一行）。 */
const MAX_INLINE_CHARS = 160

/** 快照里一个 ref 的来历。 */
export interface SnapshotRef {
  /** 模型看到的编号，形如 `e5`。 */
  ref: string
  /** 后端节点号（喂给 DOM 域用）。 */
  backendNodeId: number
  /** 发 ref 那一刻的 role。 */
  role: string
  /** 发 ref 那一刻的可访问名（空串表示无名）。 */
  name: string
  /** 发 ref 时的快照代际。 */
  generation: number
}

/** {@link serializeAxTree} 的入参。 */
export interface SerializeOptions {
  /** true = 完整树（含标题、段落这类上下文）；false = 只列可交互元素。 */
  full: boolean
  /** 本次快照的代际，写进每个 ref。 */
  generation: number
}

/** 文本化结果。 */
export interface SerializedSnapshot {
  /** 树文本（不含页眉页脚，围栏与截断由调用方处理）。 */
  text: string
  /** ref → 记录（只含本视图里出现过的 ref）。 */
  refs: Map<string, SnapshotRef>
  /** 发放的 ref 个数。 */
  refCount: number
  /** 本视图里可交互节点个数（含没拿到 backendDOMNodeId 的）。 */
  interactiveCount: number
  /** 树文本行数（未截断时）。 */
  lineCount: number
}

/** 按行截断的结果。 */
export interface LineTruncation {
  text: string
  truncated: boolean
  /** 保留了几行。 */
  shownLines: number
  /** 原本几行。 */
  totalLines: number
}

/** 取无障碍值里的 value。 */
function axValue<T>(field: AxValue<T> | undefined): T | undefined {
  return field === undefined ? undefined : field.value
}

/** 节点的 role（小写；没有就空串）。 */
function roleOf(node: AxNode): string {
  const value = axValue(node.role)
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** 角色的显示名（保留浏览器给的原始大小写，`MenuListOption` 比 `menulistoption` 好读）。 */
function roleLabel(node: AxNode): string {
  const value = axValue(node.role)
  return typeof value === 'string' ? value : 'unknown'
}

/** 压成一行并截断（快照是一行一个元素，绝不能带换行）。 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_INLINE_CHARS ? `${flat.slice(0, MAX_INLINE_CHARS)}…` : flat
}

/** 节点的可访问名（浏览器算好的，直接抄）。 */
function nameOf(node: AxNode): string {
  const value = axValue(node.name)
  return typeof value === 'string' ? oneLine(value) : ''
}

/** 节点的当前值（输入框里填的内容）。 */
function valueOf(node: AxNode): string {
  const value = axValue(node.value)
  if (typeof value === 'string') return oneLine(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 属性表：`checked` / `disabled` / `expanded` 这些状态都在这里。 */
function propertiesOf(node: AxNode): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const property of node.properties ?? []) {
    if (typeof property.name !== 'string') continue
    map.set(property.name.toLowerCase(), axValue(property.value))
  }
  return map
}

/** 状态后缀：一行里把「禁用/勾上/展开/几级标题」直接写出来，模型不用再问一次。 */
function flagsOf(node: AxNode): string {
  const props = propertiesOf(node)
  const flags: string[] = []
  const strict = (value: unknown, positive: string, negative?: string): void => {
    if (value === true || value === 'true') flags.push(` [${positive}]`)
    else if (negative !== undefined && (value === false || value === 'false')) flags.push(` [${negative}]`)
  }
  strict(props.get('checked'), 'checked', 'not-checked')
  strict(props.get('disabled'), 'disabled')
  strict(props.get('readonly') ?? props.get('readOnly'), 'readonly')
  strict(props.get('required'), 'required')
  strict(props.get('expanded'), 'expanded', 'collapsed')
  strict(props.get('selected'), 'selected')
  strict(props.get('pressed'), 'pressed')
  strict(props.get('hidden'), 'hidden')
  strict(props.get('invalid'), 'invalid')
  const level = props.get('level')
  if (typeof level === 'number' && level > 0) flags.push(` [level=${level}]`)
  const popup = props.get('haspopup')
  if (typeof popup === 'string' && popup !== '' && popup !== 'false') flags.push(` [popup=${popup}]`)
  return flags.join('')
}

/**
 * 把一棵无障碍树文本化。
 *
 * 视图规则：
 *   - compact（`full: false`）：只列可交互角色；容器与文本角色不列，但**继续遍历它们的子节点**，
 *     所以 `<div><button>存</button></div>` 里的按钮不会丢；
 *   - full：额外列 heading/paragraph/link 之外的结构节点，缩进反映层级，作为「这页长什么样」的上下文。
 *
 * ref 规则：compact 只给可交互节点发；full 给所有成行节点发
 * （需求里给的样例形状就是 `- heading "Hello" [ref=e1]`——全量视图下连标题也能被点名）。
 * 两种视图下 ref 都从 e1 起编，代际写进 {@link SnapshotRef}。
 */
export function serializeAxTree(tree: AxTree, options: SerializeOptions): SerializedSnapshot {
  const nodes = tree.nodes ?? []
  const byId = new Map<string, AxNode>()
  for (const node of nodes) {
    if (typeof node.nodeId === 'string') byId.set(node.nodeId, node)
  }
  // 找根：谁都没被当成孩子（getFullAXTree 通常只有一个根）
  const childSet = new Set<string>()
  for (const node of nodes) {
    for (const child of node.childIds ?? []) childSet.add(child)
  }
  const roots = nodes.filter((node) => typeof node.nodeId !== 'string' || !childSet.has(node.nodeId))
  const lines: string[] = []
  const refs = new Map<string, SnapshotRef>()
  const refOfBackend = new Map<number, string>()
  let refSeq = 0
  let interactiveCount = 0

  const refFor = (node: AxNode, interactive: boolean): string => {
    const backendNodeId = node.backendDOMNodeId
    if (typeof backendNodeId !== 'number' || backendNodeId <= 0) return ''
    if (!interactive && !options.full) return ''
    const existing = refOfBackend.get(backendNodeId)
    if (existing !== undefined) return existing
    refSeq += 1
    const ref = `e${refSeq}`
    refs.set(ref, { ref, backendNodeId, role: roleLabel(node), name: nameOf(node), generation: options.generation })
    refOfBackend.set(backendNodeId, ref)
    return ref
  }

  const walk = (node: AxNode, depth: number, visited: Set<string>): void => {
    const nodeId = node.nodeId
    if (typeof nodeId === 'string') {
      if (visited.has(nodeId)) return // 协议不该有环，真出现了也别转死
      visited.add(nodeId)
    }
    const role = roleOf(node)
    const interactive = INTERACTIVE_ROLES.has(role)
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AxNode => child !== undefined)
    // 文本：直接/隔着一层容器包着的 StaticText 折进来
    const inline = collectText(node, children, byId, 0)
    const ignored = node.ignored === true
    // 计数只算真正露出来的可交互节点：ignored 的那些模型根本看不到，不该算进「本页有几个可点」
    if (interactive && !ignored) interactiveCount += 1
    const printable = !ignored && !TEXT_ROLES.has(role) && (interactive || (options.full && !CONTAINER_ROLES.has(role)))
    let nextDepth = depth
    if (printable) {
      const name = nameOf(node)
      const valueText = valueOf(node)
      const text = (VALUE_FIRST_ROLES.has(role) && valueText !== '' ? valueText : inline !== '' ? inline : valueText)
      const ref = refFor(node, interactive)
      const label = name === '' ? '' : ` "${name}"`
      const suffix = text === '' || name.includes(text) ? '' : `: ${text}`
      const indent = options.full ? '  '.repeat(Math.min(depth, 12)) : ''
      const refPart = ref === '' ? '' : ` [ref=${ref}]`
      lines.push(`${indent}- ${roleLabel(node)}${label}${refPart}${flagsOf(node)}${suffix}`)
      nextDepth = depth + 1
    }
    for (const child of children) walk(child, nextDepth, visited)
  }

  for (const root of roots) walk(root, 0, new Set())
  return {
    text: lines.join('\n'),
    refs,
    refCount: refs.size,
    interactiveCount,
    lineCount: lines.length,
  }
}

/**
 * 折下层文本：只穿 `StaticText`/`InlineTextBox` 和容器角色，遇到别的角色就停。
 * 停在别的角色上是关键——不能让一个按钮的文本把整页正文都吸进来。
 */
function collectText(node: AxNode, children: AxNode[], byId: Map<string, AxNode>, depth: number): string {
  if (depth > 6) return ''
  const role = roleOf(node)
  const parts: string[] = []
  if (TEXT_ROLES.has(role)) {
    const value = axValue(node.name) ?? axValue(node.value)
    if (typeof value === 'string' && value.trim() !== '') parts.push(oneLine(value))
  }
  for (const child of children) {
    const childRole = roleOf(child)
    if (!TEXT_ROLES.has(childRole) && !CONTAINER_ROLES.has(childRole) && child.ignored !== true) continue
    const grandChildren = (child.childIds ?? []).map((id) => byId.get(id)).filter((item): item is AxNode => item !== undefined)
    const nested = collectText(child, grandChildren, byId, depth + 1)
    if (nested !== '') parts.push(nested)
  }
  return oneLine(parts.join(' '))
}

/**
 * 按行截断，**绝不切到元素中间**。
 *
 * 超限时的做法：尽量多留整行，末尾补一句说明还剩几行（调用方决定那句话怎么写）。
 * 上限小到连一行都放不下时，宁可留整行超一点点，也不把一行劈成两半——
 * 半行 `- button [ref=e1` 会让模型编出一个不存在的 ref。
 */
export function truncateByLines(text: string, maxChars: number, note: (remaining: number) => string): LineTruncation {
  const lines = text.split('\n')
  if (text.length <= maxChars) {
    return { text, truncated: false, shownLines: lines.length, totalLines: lines.length }
  }
  const reserve = Math.min(note(lines.length).length + 1, Math.max(1, Math.floor(maxChars / 3)))
  const keep: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > maxChars - reserve) break
    keep.push(line)
    used += line.length + 1
  }
  if (keep.length === 0) keep.push(lines[0] ?? '')
  const remaining = lines.length - keep.length
  return {
    text: [...keep, note(remaining)].join('\n'),
    truncated: true,
    shownLines: keep.length,
    totalLines: lines.length,
  }
}

/**
 * 复核一个 ref 指向的节点是不是还和发 ref 时一样。
 *
 * 三个都算「页面已变」：节点没了、变成了 ignored（被藏起来）、role 或可访问名变了。
 * 这一层是纯函数，CDP 取数据那部分在 `actions.ts` 的 `verifyRef` 里。
 */
export function refRecordMatches(record: SnapshotRef, node: AxNode | undefined): boolean {
  if (node === undefined) return false
  if (node.ignored === true) return false
  if (typeof node.backendDOMNodeId === 'number' && node.backendDOMNodeId !== record.backendNodeId) return false
  const role = roleLabel(node)
  if (role !== 'unknown' && role.toLowerCase() !== record.role.toLowerCase()) return false
  return nameOf(node) === record.name
}

/** {@link lookupSnapshotRef} 的结果。 */
export type RefLookup = { ok: true; ref: SnapshotRef } | { ok: false; reason: string }

/**
 * 从当前 ref 表里取一个 ref，顺带做**代际校验**。
 *
 * 三条拒绝理由分开写，是因为模型看到的东西不一样、该做的事也不一样：
 *   - 压根没给 ref → 让它先快照；
 *   - 不认识 / 被作废（导航过、换过目标）→ 带上作废原因，再让它快照；
 *   - 认识但属于上一代 → 明说「属于上一次快照」，而不是含糊的「失效」。
 */
export function lookupSnapshotRef(
  refs: ReadonlyMap<string, SnapshotRef>,
  ref: string,
  generation: number,
  invalidReason = '',
): RefLookup {
  const name = ref.trim()
  if (name === '') {
    return { ok: false, reason: '这次动作要一个 ref（形如 e5）。先 browser_look action=snapshot 拿一份快照' }
  }
  const record = refs.get(name)
  if (record === undefined) {
    const why = invalidReason === '' ? '' : `${invalidReason}；`
    return { ok: false, reason: `不认识 ref「${name}」：${why}请先 browser_look action=snapshot 拿一份新快照` }
  }
  if (record.generation !== generation) {
    return {
      ok: false,
      reason: `ref「${name}」属于上一次快照：页面已变，请重新 snapshot（browser_look action=snapshot）再动手`,
    }
  }
  return { ok: true, ref: record }
}
