/**
 * TUI 排版常量表：真彩色板、文字三档、纵向间距、缩进、横向留白、状态色与行首标记。
 *
 * 色板对齐 dsh-TUI 的「Gentle Mist Blue」暗色系（0.6.58 起从 16 色 ANSI 名升级为
 * 真彩 hex；NO_COLOR / 老 256 色终端由 ink 的 dimColor 自动降级兜底）。语义分组：
 * 正文暖白、强调雾蓝、状态四色（进行中/完成/失败/等待）、权限蓝（行内代码/小标题/
 * 列表符号共用）、用户消息金、pill 蓝底深字、静止描边。
 *
 * 桌面端的同一套尺度在 `desktop/src/renderer/styles/tokens.css`（文字看
 * `--dsc-text-*`，间距看 `--dsc-sp-*`）。组件里不再写死 `margin*`、`padding*`、
 * `marginLeft` 或成串的空格缩进，改密度只改这个文件。
 *
 * @module dsc-tui/app/theme
 */

/** 真彩色板（hex），单一真源——组件里不许再写颜色字面量。 */
export const PALETTE = {
  /** 正文暖白（终端默认前景通常偏灰白，这里统一钉住）。 */
  text: '#E8E6E0',
  /** 品牌雾蓝：提示符、光标、活动块描边、链接、进行中状态。 */
  accent: '#7DA1DE',
  /** 品牌深蓝（渐变上端，欢迎块大字用）。 */
  brand: '#4D6BFE',
  /** 冰蓝（渐变中段）。 */
  ice: '#93BEFF',
  /** 浅冰蓝（渐变下端）。 */
  pale: '#D7E4FF',
  /** 完成（雾绿）。 */
  success: '#82B89D',
  /** 失败与已拒绝（软玫瑰）。 */
  error: '#DA8A93',
  /** 等用户回应 / 警示（软琥珀）。 */
  warning: '#D8B270',
  /** 权限蓝：行内代码、markdown 小标题、列表符号。 */
  permission: '#ABC2EC',
  /** 用户消息金（对齐 dsh userPromptLabel）。 */
  userPrompt: '#FFDF80',
  /** 子代理紫。 */
  merged: '#B3A0D4',
  /** pill 蓝底（回到底部条）与其上的深字。 */
  pillBg: '#5E88CC',
  pillText: '#22262E',
  /** 静止描边（输入框、提示条的灰框）。 */
  border: '#55606F',
  /** 阴影面（工具卡表面，预留）。 */
  surface: '#242B3A',
} as const satisfies Record<string, string>

/** 可直接展开进 `<Text>` 的文字样式，用法：`<Text {...TEXT.body}>…</Text>`。 */
export interface TextStyle {
  readonly color?: string
  readonly dimColor?: boolean
  readonly bold?: boolean
  readonly italic?: boolean
}

/** 文字三档，对应渲染层 `--dsc-text-primary` / `-secondary` / `-scaffold`。 */
export const TEXT = {
  /** 正文与用户输入：暖白前景，不加粗，永远是画面里最亮的一档。 */
  body: { color: PALETTE.text, bold: false },
  /** 次要信息（时间戳、耗时、token 统计、路径、说明文字）：暗淡色，禁止用亮色。 */
  secondary: { dimColor: true, bold: false },
  /** 状态与结果标签（完成、失败、已拒绝、思考中）：暗淡色，再按需叠 `STATUS_COLOR`。 */
  label: { dimColor: true, bold: false },
} as const satisfies Record<'body' | 'secondary' | 'label', TextStyle>

/**
 * 状态色，语义对齐渲染层的 `--dsc-green` / `--dsc-red` / `--dsc-cyan` / `--dsc-yellow`。
 * 中性态不给颜色，只靠暗淡色表示，避免状态色贬值。
 */
export const STATUS_COLOR = {
  /** 空闲：无状态色。 */
  idle: undefined,
  /** 进行中：思考中、执行中、运行中的工具调用。 */
  pending: PALETTE.accent,
  /** 完成。 */
  done: PALETTE.success,
  /** 失败与已拒绝。 */
  failed: PALETTE.error,
  /** 等用户回应：等待审批、一次性提示。 */
  waiting: PALETTE.warning,
} as const satisfies Record<string, string | undefined>

/** 纵向间距，单位是终端行（终端只能整行走，渲染层的 4px 网格在这里落不成半格）。 */
export const GAP = {
  /** 0 档：块内部贴排（markdown 块与块之间的空行由 MarkdownView 自己声明）。 */
  none: 0,
  /** 1 档：条目之间、弹出块与会话流之间的分隔。 */
  tight: 1,
  /** 2 档：整段留白，给需要明显分组的块留着。 */
  block: 2,
} as const

/** 缩进，单位是半角列。 */
export const INDENT = {
  /** 工具行本身贴左排：行首图标已经占了位置。 */
  tool: 0,
  /** 参数摘要、结果摘要这类展开块统一缩两格。 */
  detail: 2,
} as const

/** 横向留白，单位是半角列。 */
export const PAD = {
  /** 描边框之内的左右内边距。 */
  inline: 1,
  /** 同一行里两个字段之间的间隔（状态栏字段、候选项的标签与说明）。 */
  field: 2,
  /** 整帧左右页边距（对齐 dsh PageMargin normal 的 2 列）。 */
  page: 2,
} as const

/** 行首标记位，两项等宽两格：未选中项用空格补位，标签才不会左右跳。 */
export const MARK = {
  /** 列表选中项。 */
  selected: '❯ ',
  /** 未选中项的等宽补位。 */
  idle: '  ',
} as const

/** 行内分隔符，统一用间隔号与固定空格，免得一处写 `·` 一处写成串空格。 */
export const SEP = {
  /** 一行里并列几段信息时的分隔（工具行的名称 / 参数 / 状态）。 */
  dot: ' · ',
  /** 只靠留白分隔的两段信息，宽度与 `PAD.field` 一致。 */
  gap: '  ',
} as const

/**
 * 差异渲染色：unified diff 的新增/删除行（审批卡「将做的改动」、轮尾文件更改卡共用）。
 * 语义与完成/失败同源（绿/红），单独命名是免得语义漂移——diff 行不是状态。
 */
export const DIFF_COLOR = {
  /** 新增行。 */
  add: PALETTE.success,
  /** 删除行。 */
  del: PALETTE.error,
} as const

/**
 * context 条按内容类型的分段色（0.6.60 批三）：沿用 dsh StatusMetrics 的蓝色系
 * 谱系（system → tools 由深到亮，语义就是「越新越亮」），但整体提亮一档——
 * dsh 的深海军蓝系按它自家的浅灰空闲段设计，压在 msc 的深色空闲段上会沉底看不见。
 * 顺序与 core/estimateRequestSegments 的五段一一对应。
 */
export const CONTEXT_SEGMENTS = [
  { key: 'system', color: '#2B3D78' },
  { key: 'prompt', color: '#344A92' },
  { key: 'assistant', color: '#4D6BFE' },
  { key: 'thinking', color: '#5A7CFF' },
  { key: 'tools', color: '#93BEFF' },
] as const

/** 强调色：输入行提示符、光标、活动块的描边，对应渲染层的 `--dsc-accent`。 */
export const ACCENT = PALETTE.accent

/** 描边色：默认灰描边，活动块用强调色，告警用琥珀。 */
export const BORDER = {
  frame: PALETTE.border,
  active: ACCENT,
  alert: PALETTE.warning,
} as const
