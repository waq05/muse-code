/**
 * TUI 排版常量表：文字三档、纵向间距、缩进、横向留白、状态色与行首标记。
 *
 * 桌面端的同一套尺度在 `desktop/src/renderer/styles/tokens.css`（文字看
 * `--dsc-text-*`，间距看 `--dsc-sp-*`）。终端只有 16 色和「常规 / 暗淡」两档亮度，
 * 所以渲染层的四级文字在这里收敛成三档：正文走终端默认前景，次要信息和状态标签
 * 都走暗淡色（dim），状态标签再按需叠一个状态色。组件里不再写死 `margin*`、
 * `padding*`、`marginLeft` 或成串的空格缩进，改密度只改这个文件。
 *
 * @module dsc-tui/app/theme
 */

/** 可直接展开进 `<Text>` 的文字样式，用法：`<Text {...TEXT.body}>…</Text>`。 */
export interface TextStyle {
  readonly color?: string
  readonly dimColor?: boolean
  readonly bold?: boolean
}

/** 文字三档，对应渲染层 `--dsc-text-primary` / `-secondary` / `-scaffold`。 */
export const TEXT = {
  /** 正文与用户输入：终端默认前景，不加粗，永远是画面里最亮的一档。 */
  body: { bold: false },
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
  pending: 'cyan',
  /** 完成。 */
  done: 'green',
  /** 失败与已拒绝。 */
  failed: 'red',
  /** 等用户回应：等待审批、一次性提示。 */
  waiting: 'yellow',
} as const satisfies Record<string, string | undefined>

/** 纵向间距，单位是终端行（终端只能整行走，渲染层的 4px 网格在这里落不成半格）。 */
export const GAP = {
  /** 0 档：会话流里相邻条目贴排，一屏尽量多放几条。 */
  none: 0,
  /** 1 档：弹出块（审批卡、会话选择器、提示条）与会话流之间的分隔。 */
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

/** 强调色：输入行提示符、光标、活动块的描边，对应渲染层的 `--dsc-accent`。 */
export const ACCENT = 'cyan'

/** 描边色，对应渲染层的 `--dsc-stroke-*`：默认灰描边，活动块用强调色，告警用黄色。 */
export const BORDER = {
  frame: 'gray',
  active: ACCENT,
  alert: 'yellow',
} as const
