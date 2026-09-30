/**
 * file-review 插件：edit / write 动手之前，把「改了哪几行」算成 unified diff 摆给用户看。
 *
 * **挂在哪一环**：守卫链 order 25——真实刻度是灾难地板 5、模式闸门 10、安全钩子 20、
 * **文件预览 25**、审批 30（`core/tool-guards.ts:43` 写着内置刻度）。摆这个位置的理由：
 *   1. 它必须早于审批卡（30），用户点「允许」之前就已经看见要改什么；
 *   2. 它必须晚于模式闸门与安全钩子，这一位只听「参数里写了什么」，不需要跟它们抢裁决权；
 *   3. 它永远 defer，从不 deny、从不 pass——一条纯观察的守卫返回 pass 会把后面的审批卡
 *      一起跳掉（`plugins/approval-floor.ts:19` 记着这个坑），所以这里只表态「我没意见」。
 * 这跟 Codex 的做法同构：Codex 在执行前算出 unified diff，把它挂在审批请求
 * （`ApplyPatchApprovalRequestEvent.changes`，`protocol/src/approvals.rs:471-487`）与会话流
 * （`PatchHistoryCell`，`tui/src/history_cell/patches.rs:44-50`）上。
 *
 * **怎么送到用户眼前**：走 `ctx.emit('dsc/notice', …)` → transcript 折成一条 system 条目
 * （`plugins/transcript.ts:35-38`）。这是仓库里现成的「把一句话摆进对话流」通道，
 * 而且恢复历史会话时 transcript 会整个清空重放（`plugins/transcript.ts:43-48`），
 * 所以这些预览不会攒成僵尸条目。
 *
 * **为什么是只读的**：这一位不读文件以外的任何东西、不落盘、不改参数、不拦任何调用（恒 defer），
 * 最坏情况就是多出一段没被采纳的预览文字。算不动（超大改动区间）时退回摘要，而不是抛错——
 * 守卫链上抛错按拒处理（`core/tool-guards.ts:104-109`），预览这种锦上添花的东西没有资格拦下写操作。
 *
 * @module dsc/plugins/file-review
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import {
  diffLines,
  renderHunk,
  type DiffResult,
} from '../core/diff-text.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { ToolGuard, ToolGuardInput } from '../core/tool-guards.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'
import { callFacts } from '../core/tools.js'

/** 插件在条目树（`~/.dsc/plugins.json`）里的键；同时是设置分区 id。 */
export const FILE_REVIEW_CONFIG_KEY = 'file-review'

/** 走这套预览的工具：只认会落盘的那两个（bash 里的写没法在动手前知道结果，不在这一位管）。 */
const REVIEWED_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** 可调值的区间：设置页的 min/max 与这里的夹取共用一份，免得两处对不上。 */
export const FILE_REVIEW_RANGES = {
  /** diff 最多显示几行（含 hunk 头）。 */
  maxLines: { min: 5, max: 2000 },
  /** 每个 hunk 前后各留几行上下文。 */
  contextLines: { min: 0, max: 20 },
} as const

/**
 * 缺省值。取 120 行：一次正常的定点编辑通常几十行就够，
 * 120 行既能把「改了哪些地方」说全，又不会让一条预览挤掉半屏对话。
 */
export const FILE_REVIEW_DEFAULTS = {
  enabled: true,
  maxLines: 120,
  contextLines: 3,
} as const

/** 这个插件的可调值。 */
export interface FileReviewConfig {
  /** 关掉之后一次预览都不发（审批照常问，只是不会再先贴 diff）。 */
  enabled: boolean
  /** 一条预览最多显示几行 diff（含 hunk 头）；超出的在末尾写明还剩多少行。 */
  maxLines: number
  /** 每个 hunk 前后各留几行上下文。 */
  contextLines: number
}

/** 夹到区间内的整数；认不出的值退回缺省。 */
function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), range.min), range.max) : fallback
}

/**
 * 逐项夹到 {@link FILE_REVIEW_RANGES} 的范围里，写错类型就用缺省值。
 * 单个值越界不该让整条工具链停下，所以这里不抛错；真有问题在设置页上看得见。
 */
export function parseFileReviewConfig(raw: Record<string, unknown>): FileReviewConfig {
  return {
    // 只有显式写了 false 才算关：没配过（缺键）时保持默认开着
    enabled: raw.enabled !== false,
    maxLines: clampInt(raw.maxLines, FILE_REVIEW_RANGES.maxLines, FILE_REVIEW_DEFAULTS.maxLines),
    contextLines: clampInt(raw.contextLines, FILE_REVIEW_RANGES.contextLines, FILE_REVIEW_DEFAULTS.contextLines),
  }
}

/**
 * 取这个插件此刻该用的配置：装配时传进来的那份作底，磁盘上那份覆盖它。
 * 每次判定现读（不是挂载时读一次），所以设置里改完立刻生效。
 */
export function readFileReviewConfig(passed?: unknown): FileReviewConfig {
  return parseFileReviewConfig(resolvePluginConfig(FILE_REVIEW_CONFIG_KEY, passed))
}

/** 一次预览的全部素材（纯数据，渲染与自检脚本都从这里出发）。 */
export interface FileReviewPreview {
  /** 工具名（write / edit）。 */
  toolName: string
  /** 目标文件的绝对路径。 */
  path: string
  /** 换算成相对工作目录的写法（拿不到相对路径时就是绝对路径）。 */
  displayPath: string
  /** 'create' = 文件原先不存在，整篇都是新增；'update' = 定点改动。 */
  action: 'create' | 'update'
  /** 改动前的行数。 */
  beforeLines: number
  /** 改动后的行数。 */
  afterLines: number
  added: number
  removed: number
  diff: DiffResult
  /**
   * 改动前后的全文。
   * 为什么要留着：hunk 是**按当前上下文行数**切出来的（`renderReview` 拿到的是当下这份配置），
   * 而 `buildPreview` 生成时用的上下文只是那一刻的配置——用户改完设置项，
   * 已经算好的那份 hunk 切法就过期了。留一份原文，渲染时按当时的配置重切一次，
   * 设置改完立刻生效，不必等下一次工具调用。
   */
  before: string
  after: string
  /** 单行摘要（`/review` 的最近几次预览用它）。 */
  summary: string
}

/** 摘要由素材算出来，所以先造不带 summary 的素材，最后一步补上。 */
type PreviewDraft = Omit<FileReviewPreview, 'summary'>

/** 一次预览的渲染产物：摆给用户的文本 + 截断信息。 */
export interface RenderedReview {
  text: string
  /** 因为超过显示上限被省略的 diff 行数（0 = 全显示了）。 */
  omitted: number
  /** 实际显示了多少行 diff（含 hunk 头）。 */
  shown: number
}

/** 把绝对路径写成相对工作目录的样子；Windows 上统一成 `/`，跟 diff 头与编辑器一致。 */
export function displayPathOf(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  const use = rel === '' || rel.startsWith('..') ? path : rel
  return use.replace(/\\/g, '/')
}

/**
 * 认这次调用要动哪个文件。
 *
 * 路径的绝对化复用 `core/tools.ts:42` 的 `callFacts`（跟循环递进守卫链的是同一份认法，
 * 参数名 file_path / path / target / file 都认），自己再写一份迟早会跟它走岔。
 * 返回值 null = 这次调用没指名要动哪个文件，那就不预览。
 */
function targetPathOf(input: ToolGuardInput): string | null {
  // 先确认参数里确实写了 path：工具靠它定位，没写就没什么可预览的
  const raw = input.args.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return callFacts(input.args, input.cwd).target ?? input.target ?? null
}

/** 读旧内容。文件不存在 = 新建（读失败与不存在要分开，读失败得说一句）。 */
function readBefore(path: string): { text: string; missing: boolean; problem: string | null } {
  try {
    return { text: readFileSync(path, 'utf8'), missing: false, problem: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: '', missing: true, problem: null }
    return { text: '', missing: false, problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 算一份预览。
 *
 * `edit` 的替换规则跟 `core/tools/fs-tools.ts:113-115` 保持一致：old 必须唯一命中；
 * 不唯一或找不到就说清「预览算不出来、工具执行时才会报错」，而不是给一份假的 diff。
 *
 * @param input - 守卫链递进来的那次调用（只读它的 toolName / args / cwd / target）。
 * @param config - 当前配置（决定上下文行数）。
 * @returns 预览素材；这次调用不该预览时返回 null。
 */
export function buildPreview(input: ToolGuardInput, config: FileReviewConfig): FileReviewPreview | null {
  if (!REVIEWED_TOOLS.has(input.toolName.toLowerCase())) return null
  const path = targetPathOf(input)
  if (path === null) return null

  const before = readBefore(path)
  let after = ''
  let action: 'create' | 'update' = before.missing ? 'create' : 'update'

  if (input.toolName.toLowerCase() === 'edit') {
    const oldText = typeof input.args.old === 'string' ? input.args.old : null
    const newText = typeof input.args.new === 'string' ? input.args.new : null
    if (oldText === null || newText === null) return null
    if (before.missing) {
      // edit 对不存在的文件必然失败，预览没有意义（工具自己会回一句 old 不存在）
      return null
    }
    const at = before.text.indexOf(oldText)
    if (at < 0) {
      return noteOnly(input.toolName, input.cwd, path, 'old 内容在文件里找不到，这次 edit 会失败；这里不是即将发生的改动')
    }
    if (before.text.indexOf(oldText, at + 1) >= 0) {
      return noteOnly(input.toolName, input.cwd, path, 'old 内容匹配多处，这次 edit 会失败；这里不是即将发生的改动')
    }
    after = before.text.slice(0, at) + newText + before.text.slice(at + oldText.length)
  } else {
    if (typeof input.args.content !== 'string') return null
    after = input.args.content
    action = before.missing ? 'create' : 'update'
  }

  const diff = diffLines(before.text, after, config.contextLines)
  const draft: PreviewDraft = {
    toolName: input.toolName.toLowerCase(),
    path,
    displayPath: displayPathOf(input.cwd, path),
    action,
    beforeLines: countLines(before.text),
    afterLines: countLines(after),
    added: diff.added,
    removed: diff.removed,
    diff,
    before: before.text,
    after,
  }
  return { ...draft, summary: summarize(draft, before.problem) }
}

/** 「算不出 diff」时的那种预览：没有 hunk，只有一句说明（正文不贴，免得看着像改动）。 */
function noteOnly(toolName: string, cwd: string, path: string, note: string): FileReviewPreview {
  const empty: DiffResult = { ok: false, hunks: [], added: 0, removed: 0, note, identical: false, oversize: false }
  const draft: PreviewDraft = {
    toolName: toolName.toLowerCase(),
    path,
    displayPath: displayPathOf(cwd, path),
    action: 'update',
    beforeLines: 0,
    afterLines: 0,
    added: 0,
    removed: 0,
    diff: empty,
    before: '',
    after: '',
  }
  return { ...draft, summary: `${draft.displayPath}｜预览算不出：${note}` }
}

/** 行数（空文本算 0 行，与 diffLines 的切法保持一致）。 */
function countLines(text: string): number {
  if (text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? 0 : body.split('\n').length
}

/** 单行摘要（带读文件失败之类的意外时一并说清）。 */
function summarize(preview: PreviewDraft, problem: string | null): string {
  const verb = preview.action === 'create' ? '新建' : '修改'
  const counts = preview.diff.ok ? `+${String(preview.added)} -${String(preview.removed)}` : '只给摘要'
  const trouble = problem === null ? '' : `（没能读到原文件：${problem}）`
  return `${verb} ${preview.displayPath}｜${counts}${trouble}`
}

/**
 * 渲染成摆给用户看的那段文本。
 *
 * 截断照仓库惯例来（`core/spill.ts:268`）：超出上限时留明确标记，写清「只显示了多少行、还有多少行」，
 * 绝不让读者以为看到的是全部。截断按整行切，绝不腰斩一个 hunk 头。
 *
 * @param preview - {@link buildPreview} 的产物。
 * @param config - 当前配置（决定显示上限）。
 * @param note - 额外要说明的一句话（例如审批策略是「仅查看」，这次根本不会落盘）。
 */
export function renderReview(preview: FileReviewPreview, config: FileReviewConfig, note?: string): RenderedReview {
  const verb = preview.action === 'create' ? '新建' : '修改'
  // 按当下这份配置重切一次 hunk：用户在设置页改了上下文行数，也不该等下一次工具调用才生效
  const diff = preview.diff.ok ? diffLines(preview.before, preview.after, config.contextLines) : preview.diff
  const counts = diff.ok
    ? `+${String(diff.added)} 行 / -${String(diff.removed)} 行`
    : '逐行 diff 未给出'
  const head: string[] = [`【文件更改预览·尚未落盘】${verb} ${preview.displayPath}（${counts}）`]

  const body: string[] = []
  if (diff.identical) {
    body.push('（内容与磁盘上现在这份完全一样，这次写入不会改动任何一行）')
  } else if (!diff.ok) {
    body.push(`（${diff.note ?? '算不出逐行差异'}）`)
  } else {
    for (const hunk of diff.hunks) body.push(...renderHunk(hunk))
    if (config.contextLines === 0) body.push('（上下文行数设为 0，只列改动本身）')
  }

  const shown = Math.min(body.length, config.maxLines)
  const omitted = body.length - shown
  const tail: string[] = []
  if (omitted > 0) tail.push(`…（这份预览只显示前 ${String(shown)} 行，还有 ${String(omitted)} 行未显示；把设置里「一条预览最多显示几行」调大可以看全）`)
  if (diff.note !== undefined && diff.ok) tail.push(`（${diff.note}）`)
  if (note !== undefined && note !== '') tail.push(note)

  return { text: [...head, ...body.slice(0, shown), ...tail].join('\n'), omitted, shown }
}

export const fileReviewPlugin: Plugin.Object = {
  name: 'file-review',
  inject: ['guards', 'settings', 'commands'],
  apply(ctx, passed) {
    /** 每次都现读：设置里改完立刻生效，不必重启宿主。 */
    const config = (): FileReviewConfig => readFileReviewConfig(passed)
    /** 最近几次预览的摘要（`/review` 命令用；只留摘要不留正文，免得白占内存）。 */
    const recent: string[] = []
    /** 本会话发过多少条预览、其中多少条被截断（`/review` 一眼看出它有没有在工作）。 */
    let emitted = 0
    let truncated = 0

    const remember = (line: string): void => {
      recent.unshift(line)
      if (recent.length > 8) recent.length = 8
    }

    const guard: ToolGuard = {
      id: 'file-review',
      // 真实刻度：地板 5、模式 10、安全钩子 20、本插件 25、审批 30（core/tool-guards.ts:43）
      order: 25,
      decide(input: ToolGuardInput) {
        const cfg = config()
        if (!cfg.enabled) return { action: 'defer' }
        // 只读工具不预览；bash 之类的执行类工具没法在动手前知道它写了什么，也不预览
        if (input.risk === 'read') return { action: 'defer' }

        let preview: FileReviewPreview | null
        try {
          preview = buildPreview(input, cfg)
        } catch (error) {
          // 守卫链上抛错按拒处理（core/tool-guards.ts:104-109）。预览是锦上添花的东西，
          // 没有资格因为自己算不动就把一次写操作拦下来，所以这里自己吞掉，只留一句提示。
          ctx.emit('dsc/notice', `文件更改预览算不出来（不影响这次调用）：${error instanceof Error ? error.message : String(error)}`)
          return { action: 'defer' }
        }
        if (preview === null) return { action: 'defer' }

        const rendered = renderReview(preview, cfg)
        emitted += 1
        if (rendered.omitted > 0) truncated += 1
        remember(preview.summary)
        // 先落进对话流：审批卡（order 30）随即会弹在它下面，用户是先看见改动、再决定放不放行
        ctx.emit('dsc/notice', rendered.text)
        return { action: 'defer' }
      },
    }
    const offGuard = ctx.guards.register(guard)

    // ── /review 命令：不经模型就能确认这一位在不在链上、配置是什么 ────────────────
    const describe = (): string => {
      const cfg = config()
      const lines: string[] = []
      lines.push(`文件更改预览：${cfg.enabled ? '开着' : '关着'}｜守卫链 order 25（模式 10、安全钩子 20、本插件 25、审批 30）`)
      lines.push(`一条预览最多显示 ${String(cfg.maxLines)} 行｜每个 hunk 前后留 ${String(cfg.contextLines)} 行上下文`)
      lines.push(`这次挂载以来发过 ${String(emitted)} 条预览（其中 ${String(truncated)} 条被截断）`)
      lines.push('配置文件：~/.dsc/plugins.json 的 file-review 条目（设置页也能改）')
      lines.push(recent.length === 0 ? '最近还没有预览过。' : `最近预览：\n${recent.map((line) => `  ${line}`).join('\n')}`)
      return lines.join('\n')
    }
    const offCommand = ctx.commands.register(
      { name: 'review', args: '', description: '看文件更改预览的状态与最近几次预览' },
      ({ ui }) => ui.notice(describe()),
    )

    // ── 设置分区 ──────────────────────────────────────────────────────────────
    const section: SettingsSectionSpec = {
      id: FILE_REVIEW_CONFIG_KEY,
      title: '文件更改预览',
      subtitle: 'edit / write 落盘前先把 unified diff 摆进对话流，改哪几行看得见',
      // 排在大输出溢出（37）前面：这一档管的是「改之前看见」，比事后截断更靠前
      order: 36,
      fields(): SettingsField[] {
        const cfg = config()
        return [
          {
            type: 'switch',
            key: 'enabled',
            label: '启用文件更改预览',
            help: '关掉之后不再往对话流贴 diff，工具照常执行、审批照常问。',
          },
          {
            type: 'number',
            key: 'maxLines',
            label: '一条预览最多显示几行',
            min: FILE_REVIEW_RANGES.maxLines.min,
            max: FILE_REVIEW_RANGES.maxLines.max,
            step: 10,
            help: `超过这个行数的部分不显示，末尾写明还剩多少行（默认 ${String(FILE_REVIEW_DEFAULTS.maxLines)}）。`,
          },
          {
            type: 'number',
            key: 'contextLines',
            label: '改动前后各留几行上下文',
            min: FILE_REVIEW_RANGES.contextLines.min,
            max: FILE_REVIEW_RANGES.contextLines.max,
            step: 1,
            help: '跟 `diff -u` 的 -U 一个意思：0 = 只看改动本身，3 = 默认。留几行上下文才看得出改在哪个函数里。',
          },
          {
            type: 'info',
            label: '它在链上的位置',
            text: 'order 25：比审批卡（30）早，所以点「允许」之前就已经看见要改什么；它自己永远不拦、不替别的守卫放行（一律 defer）。',
          },
          {
            type: 'info',
            label: '这次挂载的统计',
            text: `发过 ${String(emitted)} 条预览，其中 ${String(truncated)} 条因为超过行数上限被截断。`,
          },
        ]
      },
      values(): SettingsValues {
        const cfg = config()
        return { enabled: cfg.enabled, maxLines: cfg.maxLines, contextLines: cfg.contextLines }
      },
      save(key, value): string | void {
        switch (key) {
          case 'enabled':
            writePluginConfig(FILE_REVIEW_CONFIG_KEY, { enabled: value === true })
            break
          case 'maxLines': {
            const num = Number(value)
            if (!Number.isFinite(num)) return '这里要填一个数字（行）'
            // 越界的值写进去也没关系：用的时候会被夹回区间（parseFileReviewConfig）
            writePluginConfig(FILE_REVIEW_CONFIG_KEY, { maxLines: Math.round(num) })
            break
          }
          case 'contextLines': {
            const num = Number(value)
            if (!Number.isFinite(num)) return '这里要填一个数字（行）'
            writePluginConfig(FILE_REVIEW_CONFIG_KEY, { contextLines: Math.round(num) })
            break
          }
          default:
            return `这个分区没有这项：${key}`
        }
        ctx.emit('dsc/changed')
      },
    }
    const offSection = ctx.settings.registerSection(section)

    ctx.on('dsc/session-open', () => {
      // 换会话清一次统计：上一个会话的预览数跟新会话没关系
      recent.length = 0
      emitted = 0
      truncated = 0
    })

    return () => {
      offSection()
      offCommand()
      offGuard()
    }
  },
}
