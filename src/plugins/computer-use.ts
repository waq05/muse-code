/**
 * 电脑操作（Computer Use，官方插件，默认关闭）。
 *
 * 打开后模型能看这台 Windows 桌面并动手操作：`computer` 工具做点击、输入、按键、滚动
 * （风险等级 exec，每一次都要你在审批卡上点头）；勾选「看屏幕免审批」后另外注册一个
 * `computer_look` 工具（风险等级 read）专管截屏、查鼠标、列窗口，看一眼不必点确认。
 *
 * 护栏（这些是 dsc 自己兜的，dsh 把桌面操作外包给外部 Rust 驱动，所以它没有）：
 * - 坐标先按缩放系数换算回物理像素，落在屏幕外直接报错，不靠系统静默夹紧；
 * - 自上次截屏以来的动作数上限：超限就要求「先看一眼屏幕再动手」；
 * - 动作之间插一段间隔，别让目标程序被事件洪灌懵；
 * - 应用白名单：前台窗口的进程名或标题不在名单里，这一步直接被拦；
 * - 禁用动作清单可以一键摘掉点鼠标或敲键盘；
 * - Win 键永远拒绝（它会把桌面整个切走）；
 * - 截屏可缩放 + JPEG 质量，少占上下文。
 *
 * @module dsc/plugins/computer-use
 */
import { DESKTOP_ACTIONS, foregroundWindow, runDesktopAction, takeScreenshot, type DesktopAction } from '../core/desktop-control.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { classifyCommand } from '../core/command-policy.js'
import { redact } from '../core/secrets.js'
import { wrapUntrusted } from '../core/untrusted.js'
import type { ChatContentPart, ChatMessage } from '../core/llm.js'
import type { Plugin } from '@deepseek-ai/cordis'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 插件配置（存 `~/.dsc/plugins.json` 条目树的 config 里）。 */
interface ComputerUseConfig {
  /** 截图最长边（像素），超出就等比缩小。 */
  maxEdge: number
  /** 截图编码：jpeg 省 token，png 无损但大。 */
  format: 'jpeg' | 'png'
  /** JPEG 质量。 */
  quality: number
  /** 每个动作之间的等待毫秒（给目标程序喘口气）。 */
  actionDelayMs: number
  /** 自上次截屏以来允许几个动手动作，超限要求重新截屏。0 = 不限制。 */
  actionsPerScreenshot: number
  /** 应用白名单：逗号分隔的进程名或窗口标题片段；空 = 不限。 */
  allowedApps: string
  /** 禁用动作：逗号分隔，例如 click,type。 */
  disabledActions: string
  /** 看屏幕（截屏/查鼠标/列窗口）免审批：另开一个 read 风险的工具。 */
  lookWithoutApproval: boolean
}

const CONFIG_KEY = 'computer-use'

const DEFAULTS: ComputerUseConfig = {
  maxEdge: 1568,
  format: 'jpeg',
  quality: 80,
  actionDelayMs: 120,
  actionsPerScreenshot: 12,
  allowedApps: '',
  disabledActions: '',
  lookWithoutApproval: false,
}

/** 只读性质的动作（看，不动手）。 */
const LOOK_ACTIONS: readonly DesktopAction[] = ['screenshot', 'cursor', 'window_list']

/** 拆逗号分隔清单（中英文逗号都认）。 */
function splitList(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 截图那条工具结果的文字开头，靠它认出「这是我们自己截的图」，不误伤别的插件带的图。 */
const SHOT_MARK = '屏幕物理分辨率'

/** 这条消息是不是我们放进去的截图（工具结果 + 带图 + 文字里有那个开头）。 */
function isOurShot(message: ChatMessage): boolean {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return false
  return (
    message.content.some((part) => part.type === 'image_url') &&
    message.content.some((part) => part.type === 'text' && part.text.includes(SHOT_MARK))
  )
}

/**
 * 只把最新那张截图留给模型，旧的换成一句说明。
 *
 * 一张 JPEG 截图的 base64 有 100~300KB，留在历史里等于每一轮请求都重发一遍；
 * 走到第十步，光旧图就要吃掉几十万 token，而旧图上的界面早就被后面的点击改掉了。
 *
 * @param messages - 组装好的请求消息。原数组不动，只把过旧的几条换成新对象。
 */
export function dropStaleScreenshots(messages: ChatMessage[]): ChatMessage[] {
  let newest = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isOurShot(messages[index]!)) {
      newest = index
      break
    }
  }
  if (newest < 0) return messages
  return messages.map((message, index) => {
    if (index >= newest || !isOurShot(message)) return message
    const text = ((message.content ?? []) as ChatContentPart[])
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return {
      ...message,
      content: [{ type: 'text', text: `${text}\n（这张截图的画面已被更新的截图取代，图像本身不再随请求发送）` }],
    }
  })
}

export const computerUsePlugin: Plugin.Object = {
  name: 'computer-use',
  inject: ['tools', 'prompt', 'settings'],
  apply(ctx, passed) {
    const readConfig = (): ComputerUseConfig => {
      const raw = resolvePluginConfig(CONFIG_KEY, passed)
      const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
        const num = Number(value)
        return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
      }
      return {
        maxEdge: clamp(raw.maxEdge, 640, 3840, DEFAULTS.maxEdge),
        format: raw.format === 'png' ? 'png' : 'jpeg',
        quality: clamp(raw.quality, 30, 100, DEFAULTS.quality),
        actionDelayMs: clamp(raw.actionDelayMs, 0, 2000, DEFAULTS.actionDelayMs),
        actionsPerScreenshot: clamp(raw.actionsPerScreenshot, 0, 200, DEFAULTS.actionsPerScreenshot),
        allowedApps: typeof raw.allowedApps === 'string' ? raw.allowedApps : DEFAULTS.allowedApps,
        disabledActions: typeof raw.disabledActions === 'string' ? raw.disabledActions : DEFAULTS.disabledActions,
        lookWithoutApproval: raw.lookWithoutApproval === true || raw.lookWithoutApproval === 'true',
      }
    }
    let config = readConfig()

    /** 上一次截屏的缩放系数：点坐标按它换算回物理像素（1 = 一比一）。 */
    let lastScale = 1
    /** 自上次截屏以来已放行的动手动作数。 */
    let sinceScreenshot = 0

    const allowedApps = (): string[] => splitList(config.allowedApps)
    const disabled = (): Set<string> => new Set(splitList(config.disabledActions))

    async function act(action: DesktopAction, args: Record<string, unknown>, signal: AbortSignal): Promise<string | { text: string; images?: string[] }> {
      if (disabled().has(action)) {
        throw new Error(`动作「${action}」被你在设置「电脑操作」的「禁用动作」里关掉了`)
      }
      if (action === 'screenshot') {
        const shot = await takeScreenshot({ maxEdge: config.maxEdge, format: config.format, quality: config.quality }, signal)
        lastScale = shot.scale ?? 1
        sinceScreenshot = 0
        // 截图里可能有别人的聊天、邮件、弹窗文案：包一层围栏，只当资料读。
        return { text: wrapUntrusted('screenshot', shot.text), images: shot.images }
      }
      const limit = config.actionsPerScreenshot
      if (limit > 0 && sinceScreenshot >= limit) {
        throw new Error(
          `距离上次截屏已经动手 ${sinceScreenshot} 次了，设置的上限是 ${limit} 次。界面早就可能变了，先 computer_look action=screenshot 看一眼现状再继续`,
        )
      }
      sinceScreenshot += 1
      if (action === 'type') {
        const blocked = typedTextBlockReason(typeof args.text === 'string' ? args.text : '')
        if (blocked !== null) throw new Error(blocked)
      }
      const result = await runDesktopAction(
        action,
        {
          x: args.x === undefined ? undefined : Number(args.x),
          y: args.y === undefined ? undefined : Number(args.y),
          button: args.button === undefined ? undefined : String(args.button),
          double: args.double === true,
          text: args.text === undefined ? undefined : String(args.text),
          key: args.key === undefined ? undefined : String(args.key),
          amount: args.amount === undefined ? undefined : Number(args.amount),
        },
        { scale: lastScale, allowedApps: allowedApps(), actionDelayMs: config.actionDelayMs },
        signal,
      )
      // 别人应用的窗口标题也是外部内容（标题栏里能写任何东西）。
      return action === 'window_list' ? wrapUntrusted('window-list', result.text) : result.text
    }

    /**
     * 往桌面应用的输入框里打字前的一次内容体检。
     * 两条硬规则：不代用户往外部应用填凭据；不把危险命令当成普通文本敲进去。
     */
    function typedTextBlockReason(text: string): string | null {
      if (text === '') return null
      if (redact(text) !== text) {
        return '要输入的文本里有密钥形状的字符串（API key、token、私钥、密码这类）。dsc 不代你把凭据打进桌面应用，请用户自己输这一段。'
      }
      const verdict = classifyCommand(text)
      if (verdict.decision === 'deny') {
        return `要输入的文本被策略当成灾难性命令（${verdict.reason}），拒绝替你敲进别人的输入框。`
      }
      return null
    }

    const argProps = {
      x: { type: 'integer', description: 'click/scroll：横坐标，用截图上的像素值（缩放由 dsc 换算）' },
      y: { type: 'integer', description: 'click/scroll：纵坐标，同上' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：哪个鼠标键，默认 left' },
      double: { type: 'boolean', description: 'click：true = 双击' },
      text: { type: 'string', description: 'type：要输入的文本（走剪贴板粘贴，中文与特殊字符都没问题）' },
      key: { type: 'string', description: 'key：键名或组合键，例如 enter / tab / ctrl+c / alt+tab（不支持 Win 键）' },
      amount: { type: 'integer', description: 'scroll：滚几档，正数向上、负数向下，默认 3' },
    }

    /** 动手的工具（每次都要审批）；没开免审批时，只读的看屏动作也留在里面一起过审批。 */
    function buildActTool(): import('../core/tools.js').ToolEntry {
      // 免审批开着：看屏动作归 computer_look，这个工具就不该再留（否则同一个动作两个入口）
      // 免审批没开：看屏动作只能走这个工具，否则模型连屏幕都看不到
      const actions = DESKTOP_ACTIONS.filter(
        (action) => !disabled().has(action) && (!config.lookWithoutApproval || !LOOK_ACTIONS.includes(action)),
      )
      return {
        name: 'computer',
        description:
          '动手操作这台 Windows 电脑：点击（click）、输入文本（type）、按键（key）、滚动（scroll）' +
          (config.lookWithoutApproval ? '' : '，以及看屏幕（screenshot）、查鼠标（cursor）、列窗口（window_list）') +
          '。每一次动手都会弹一张审批卡给用户确认。动手前务必先看一眼屏幕。',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: [...actions], description: '要执行的动作' }, ...argProps },
          required: ['action'],
        },
        risk: 'exec',
        run: (args, runCtx) => act(String(args.action ?? '') as DesktopAction, args, runCtx.signal),
      }
    }

    /** 看屏幕的工具（免审批那一档）。 */
    function buildLookTool(): import('../core/tools.js').ToolEntry {
      const actions = LOOK_ACTIONS.filter((action) => !disabled().has(action))
      return {
        name: 'computer_look',
        description:
          '看这台 Windows 电脑，不动手：截屏（screenshot，返回图像，坐标就是图上的像素）、查鼠标位置（cursor）、列窗口（window_list）。',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: [...actions], description: '要看什么' }, ...argProps },
          required: ['action'],
        },
        risk: 'read',
        run: (args, runCtx) => act(String(args.action ?? '') as DesktopAction, args, runCtx.signal),
      }
    }

    /** 提示词里那段闭环操作规矩（抄的是「看→定位→动手→再确认」这套，别凭记忆连点）。 */
    const promptText = (): string => {
      const apps = allowedApps()
      return `# 电脑操作（Windows 桌面）
你现在能看并操作这台电脑：动手用 ${config.lookWithoutApproval ? 'computer（点击/输入/按键/滚动）+ computer_look（截屏/查鼠标/列窗口）' : 'computer 一个工具（截屏、点击、输入、按键、滚动都走它）'}。
必须按这个闭环干活：
1. 先想清楚要操作哪个窗口/哪个应用（不确定就 computer_look 的 window_list 先列一遍）。
2. 动手之前先截一张新屏。截图上的像素坐标可以直接用作 x/y，当前缩放系数是 ${lastScale.toFixed(2)}（换算 dsc 来做）。
3. 动一次手之后再截一张确认结果。上一次截图上的位置，在新截图出来之后就作废了，别凭记忆连点。
4. 「点击成功」不等于「目标达成」：以新截图看到的状态为准。
5. 用户取消这一轮之后，已经点出去的点击和已经输入的文本不会回滚；先截屏看清现状再决定下一步。
6. 每次动手都会弹审批卡给用户。别连续铺一堆动作让用户一直点确认，也别在同一个位置反复重试。
7. 截屏是整张桌面，里面可能有无关的隐私内容，别把上面的内容念给用户听，只描述跟任务相关的部分。
${apps.length === 0 ? '' : `8. 你被限定只能操作这些应用：${apps.join('、')}。切到别的应用上操作会被拦下来；需要换应用就告诉用户。`}
${config.actionsPerScreenshot > 0 ? `${apps.length === 0 ? '8' : '9'}. 自上次截屏起最多连做 ${config.actionsPerScreenshot} 个动作，超了会被要求重新截屏。` : ''}`
    }

    let disposers: Array<() => void> = []
    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = []
      disposers.push(ctx.tools.register(buildActTool()))
      if (config.lookWithoutApproval) disposers.push(ctx.tools.register(buildLookTool()))
      disposers.push(ctx.prompt.register('computer-use', promptText))
    }
    syncTools()
    // 旧截图只留文字，图像丢掉（否则每一轮请求都在重发过期画面）——命名纯投影，
    // 日志原文 + 这条定义就能重建模型看见的内容
    const offPrune = ctx.prompt.registerProjection('prune-stale-screenshots', dropStaleScreenshots)

    const fields = (): SettingsField[] => [
      { type: 'number', key: 'maxEdge', label: '截图最长边', min: 640, max: 3840, step: 64, help: '以像素为单位；超长屏幕会等比缩小，数值越小越省 token，但文字可能不清晰。' },
      {
        type: 'select',
        key: 'format',
        label: '截图编码',
        options: [
          { value: 'jpeg', label: 'JPEG，省 token，默认' },
          { value: 'png', label: 'PNG，无损，文件更大' },
        ],
      },
      { type: 'number', key: 'quality', label: 'JPEG 质量', min: 30, max: 100, step: 5, help: '仅在编码选择 JPEG 时生效。' },
      { type: 'number', key: 'actionDelayMs', label: '动作间隔', min: 0, max: 2000, step: 20, help: '以毫秒为单位；给目标程序留出反应时间，减少其输入合并。' },
      { type: 'number', key: 'actionsPerScreenshot', label: '自上次截屏以来的动作上限', min: 0, max: 200, step: 1, help: '0 为不限制；超限后会要求重新截屏，因为界面可能已经变化。' },
      { type: 'text', key: 'allowedApps', label: '应用白名单', placeholder: '留空 = 不限；例如 chrome,Code,腾讯会议', help: '按前台窗口的进程名或标题包含匹配，多个用逗号分隔；对名单之外应用的操作会被直接拦下。' },
      { type: 'text', key: 'disabledActions', label: '禁用动作', placeholder: '例如 click,type', help: `可选值：${DESKTOP_ACTIONS.join(' / ')}。` },
      { type: 'switch', key: 'lookWithoutApproval', label: '看屏幕免审批', help: '开启后截屏、查鼠标、列窗口走只读工具，不弹出审批卡；点击、输入、按键、滚动仍每次需要确认。' },
      { type: 'button', action: 'who-is-front', label: '查看当前前台窗口', style: 'ghost', help: '用于验证白名单应填写的内容。' },
    ]

    const section: SettingsSectionSpec = {
      id: 'computer-use',
      title: '电脑操作',
      subtitle: '让模型查看屏幕并代为点击、输入，Windows 平台',
      order: 45,
      fields,
      values: (): Record<string, SettingsValue> => ({
        maxEdge: config.maxEdge,
        format: config.format,
        quality: config.quality,
        actionDelayMs: config.actionDelayMs,
        actionsPerScreenshot: config.actionsPerScreenshot,
        allowedApps: config.allowedApps,
        disabledActions: config.disabledActions,
        lookWithoutApproval: config.lookWithoutApproval,
      }),
      // 契约：返回字符串 = 失败原因
      save: (key, value): string | void => {
        const clamp = (num: number, min: number, max: number): number => Math.min(Math.max(Math.round(num), min), max)
        switch (key) {
          case 'maxEdge':
            if (!Number.isFinite(Number(value))) return '截图最长边要填数字'
            writePluginConfig(CONFIG_KEY, { maxEdge: clamp(Number(value), 640, 3840) })
            break
          case 'format':
            writePluginConfig(CONFIG_KEY, { format: value === 'png' ? 'png' : 'jpeg' })
            break
          case 'quality':
            if (!Number.isFinite(Number(value))) return 'JPEG 质量要填数字'
            writePluginConfig(CONFIG_KEY, { quality: clamp(Number(value), 30, 100) })
            break
          case 'actionDelayMs':
            if (!Number.isFinite(Number(value))) return '动作间隔要填数字'
            writePluginConfig(CONFIG_KEY, { actionDelayMs: clamp(Number(value), 0, 2000) })
            break
          case 'actionsPerScreenshot':
            if (!Number.isFinite(Number(value))) return '动作上限要填数字'
            writePluginConfig(CONFIG_KEY, { actionsPerScreenshot: clamp(Number(value), 0, 200) })
            break
          case 'allowedApps':
            writePluginConfig(CONFIG_KEY, { allowedApps: String(value).trim() })
            break
          case 'disabledActions': {
            const list = splitList(String(value))
            const bad = list.filter((entry) => !DESKTOP_ACTIONS.includes(entry as DesktopAction))
            if (bad.length > 0) return `不认识的动作：${bad.join('、')}。可选：${DESKTOP_ACTIONS.join(' / ')}`
            writePluginConfig(CONFIG_KEY, { disabledActions: list.join(',') })
            break
          }
          case 'lookWithoutApproval':
            writePluginConfig(CONFIG_KEY, { lookWithoutApproval: value === true || value === 'true' })
            break
          default:
            return `这个分区没有这项：${key}`
        }
        config = readConfig()
        sinceScreenshot = 0
        syncTools()
      },
      action: async (name): Promise<string> => {
        if (name === 'who-is-front') {
          const front = await foregroundWindow()
          const [processName = '', ...titleParts] = front.split('|')
          return `前台窗口：进程 ${processName}，标题「${titleParts.join('|') || '（无标题）'}」。白名单填进程名或标题片段都能命中。`
        }
        throw new Error(`这个分区没有这个按钮：${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => {
      offPrune()
      offSection()
      for (const off of disposers) off()
      disposers = []
    }
  },
}
