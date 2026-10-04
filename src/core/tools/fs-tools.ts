/**
 * 文件工具三件套：read / write / edit。路径相对会话 cwd 解析。
 * 三道护栏长在工具自己肚子里（不靠调用方自觉）：凭据文件不许读、
 * 系统关键路径不许写、没读过就不许整写覆盖。写要不要经用户点头由审批层管。
 *
 * @module dsc/core/tools/fs-tools
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolEntry, ToolOutput } from '../tools.js'
import { diffLines, type DiffHunk } from '../diff-text.js'
import { noteRead, noteWrite, readBlockReason, staleEditReason, staleOverwriteReason, writeHardBlockReason } from '../path-policy.js'
import { sandboxPermissionProperties } from './sandbox-args.js'

/** read 工具缺省一次读多少行（配置没给 readLineLimit 时用它）。 */
export const READ_DEFAULT_LINE_LIMIT = 2000

/** T34：read 输出的字符硬顶（dsh 的 maxOutputChars 同款口径；再往上是 spill 的事）。 */
const READ_MAX_CHARS = 16_000
/** T34：单行显示的字符上限（bundle/锁文件那种一行几十万字符的，截断后给个说明）。 */
const READ_LINE_CHAR_CAP = 2_000
/** T34：模型传 limit 时的行数硬顶（字符顶才是真防线，这个只防离谱数值）。 */
const READ_MAX_LINES = 10_000

/** T25：read 认得的图片扩展名 → MIME（data URL 前缀用）。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}
/** 一张图进上下文的尺寸上限：6MB 原图 base64 后约 8MB，与输入框贴图同一条红线。 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

/** 变更摘要里 diff 段最多保留多少行（超出砍尾并标 truncated，防一次整篇重写撑爆条目与日志）。 */
const CHANGE_DIFF_LINE_LIMIT = 800

const abs = (cwd: string, p: unknown): string => {
  if (typeof p !== 'string' || p === '') throw new Error('path 必须是非空字符串')
  return isAbsolute(p) ? p : resolve(cwd, p)
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} 必须是字符串`)
  return v
}

/**
 * 把「改之前 / 改之后」的全文算成一份变更摘要（轮尾「文件已更改」卡的数据）。
 *
 * 什么时候没有摘要：新旧内容完全相同（覆盖写了个寂寞）——界面上没有可展示的改动，
 * 事件与日志都不带。diff 段超过 {@link CHANGE_DIFF_LINE_LIMIT} 行时从前往后保留、
 * 砍掉的部分标 `truncated`（整篇重写大文件的场景，面板会提示只显示了前一部分）。
 *
 * 导出给 Session.takeTurnChanges 复用：回合聚合的 diff 就是「回合基线 vs 盘上现值」
 * 走同一套算法，两处的口径（上下文行数、砍尾阈值、status 判定）天然一致。
 */
export function summarizeChange(file: string, before: string, after: string): ToolOutput['changes'] {
  const result = diffLines(before, after, 3)
  if (result.identical || !result.ok || result.hunks.length === 0) return undefined
  const kept: DiffHunk[] = []
  let budget = CHANGE_DIFF_LINE_LIMIT
  for (const hunk of result.hunks) {
    if (budget <= 0) break
    const lines = hunk.lines.length <= budget ? hunk.lines : hunk.lines.slice(0, budget)
    kept.push(lines.length === hunk.lines.length ? hunk : { ...hunk, lines })
    budget -= lines.length
  }
  return {
    path: file,
    added: result.added,
    removed: result.removed,
    hunks: kept,
    ...(kept.length < result.hunks.length ? { truncated: true } : {}),
    status: before === '' ? 'added' : 'modified',
    baseline: before,
  }
}

/**
 * 造一个 read 工具。单次读取行数由 tools-default 插件从配置取值传入
 * （缺省 {@link READ_DEFAULT_LINE_LIMIT}）；模型传了 limit 就用模型的，这里只是缺省。
 */
export function createReadTool(lineLimit = READ_DEFAULT_LINE_LIMIT): ToolEntry {
  return {
    name: 'read',
    description:
      '读取文件内容。文本文件输出「行号 + 制表符 + 原文」，可指定起始行与行数；' +
      '图片文件（png/jpg/gif/webp/bmp/svg）直接作为图片附件加载，用视觉看图即可，不用转 base64。' +
      '读代码、配置、日志一律用它，不要用 bash 跑 cat/head/tail——那样拿不到行号，也没法续读。' +
      '要整写覆盖一个已存在的文件之前必须先读过它，本工具会记下你读过哪个版本。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对当前目录）' },
        offset: { type: 'number', description: '起始行（1-based，默认 1）' },
        limit: { type: 'number', description: `读取行数（默认 ${lineLimit}）` },
      },
      required: ['path'],
    },
    risk: 'read',
    async run(args, ctx) {
      const file = abs(ctx.cwd, args.path)
      const blocked = readBlockReason(file)
      if (blocked !== null) throw new Error(blocked)
      // T25：图片按扩展名分流——整读成 data URL 走图片附件（模型没勾照片输入时
      // 请求组装的 dropImageParts 投影会兜底换成说明，这里不用关心模态）
      const mime = IMAGE_MIME[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]
      if (mime !== undefined) {
        const stat = await fs.stat(file)
        if (stat.size > IMAGE_MAX_BYTES) {
          throw new Error(`这张图有 ${Math.round(stat.size / 1024 / 1024)}MB，超过 6MB 上限；先压缩或缩小再看`)
        }
        const bytes = await fs.readFile(file)
        noteRead(file, ctx.sessionId)
        return {
          text: `已加载图片 ${file}（${mime}，${stat.size} 字节），图在附件里。`,
          images: [`data:${mime};base64,${bytes.toString('base64')}`],
        }
      }
      const raw = await fs.readFile(file, 'utf8')
      noteRead(file, ctx.sessionId)
      // T34：二进制（含 NUL 字节）不硬灌——乱码只会烧上下文，给一句明确指引
      if (raw.slice(0, 8000).includes('\u0000')) {
        throw new Error('这看起来是二进制文件，read 不支持直接读。需要内容时用 bash 配合格式工具取样（如 base64 / certutil -encode / xxd）。')
      }
      const lines = raw.split(/\r?\n/)
      const start = Math.max(1, typeof args.offset === 'number' ? Math.floor(args.offset) : 1)
      // T34：limit 不再是模型要多少给多少——行数与字符量都有硬顶，超长行也截断
      const requested = typeof args.limit === 'number' ? Math.floor(args.limit) : lineLimit
      const limit = Math.min(Math.max(requested, 1), READ_MAX_LINES)
      const slice = lines.slice(start - 1, start - 1 + limit)
      const body: string[] = []
      let used = 0
      let withheld = 0
      for (const [index, line] of slice.entries()) {
        const shown = line.length > READ_LINE_CHAR_CAP ? `${line.slice(0, READ_LINE_CHAR_CAP)}…（本行超长已截断）` : line
        const cost = shown.length + 1
        if (body.length > 0 && used + cost > READ_MAX_CHARS) {
          withheld = slice.length - index
          break
        }
        body.push(`${start + index}\t${shown}`)
        used += cost
      }
      const total = lines.length
      const tail: string[] = []
      if (withheld > 0) tail.push(`…（输出达到 ${String(READ_MAX_CHARS)} 字符上限，还有 ${String(withheld)} 行没显示，用 offset 续读）`)
      if (start - 1 + slice.length < total) tail.push(`…（共 ${String(total)} 行，可用 offset/limit 续读）`)
      return `${file}\n${body.join('\n')}${tail.length > 0 ? `\n${tail.join('\n')}` : ''}`
    },
  }
}

/** 缺省预算的 read 工具（自检脚本直接复用；插件里走 {@link createReadTool} 收配置值）。 */
export const readTool: ToolEntry = createReadTool()

export const writeTool: ToolEntry = {
  name: 'write',
  description:
    '把内容整体写入文件（覆盖原内容），目录不存在会自动创建。' +
    '改已有文件优先用 edit 做定点替换；只有在「新建文件」或「整篇重写」时才用本工具。' +
    '已存在的文件必须先 read 过才允许覆盖，否则本工具会拒绝并让你先去读。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
      ...sandboxPermissionProperties,
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const hard = writeHardBlockReason(file)
    if (hard !== null) throw new Error(hard)
    const stale = staleOverwriteReason(file, ctx.sessionId)
    if (stale !== null) throw new Error(stale)
    const content = str(args.content, 'content')
    // T35：CAS 锚——从这一刻到 writeFile 之间文件若被第三方改过，就拒绝整写
    const anchorStat = await fs.stat(file).catch(() => null)
    // 旧内容拿不到（新建）就当空串：diff 呈现为整篇新增
    const before = await fs.readFile(file, 'utf8').catch(() => '')
    await fs.mkdir(resolve(file, '..'), { recursive: true })
    const beforeWrite = anchorStat === null ? null : await fs.stat(file).catch(() => null)
    if (anchorStat !== null && (beforeWrite === null || Math.abs(beforeWrite.mtimeMs - anchorStat.mtimeMs) > 1)) {
      throw new Error('文件在你准备写入时又被其他程序改动，重试一次（先重新读它）。')
    }
    await fs.writeFile(file, content, 'utf8')
    noteWrite(file, ctx.sessionId)
    const changes = summarizeChange(file, before, content)
    return {
      text: `已写入 ${file}（${content.length} 字符）`,
      ...(changes === undefined ? {} : { changes }),
    }
  },
}

export const editTool: ToolEntry = {
  name: 'edit',
  description:
    '对文件做一次精确字符串替换：old 必须与文件内容逐字唯一匹配，然后原样换成 new。' +
    '改一两处代码就用它，不要把整个文件读出来再 write 回去。' +
    'old 匹配多处会失败，此时加长上下文（多带几行）让它唯一，而不是改用 write 覆盖。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      old: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
      new: { type: 'string', description: '替换后的内容' },
      ...sandboxPermissionProperties,
    },
    required: ['path', 'old', 'new'],
  },
  risk: 'write',
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const hard = writeHardBlockReason(file)
    if (hard !== null) throw new Error(hard)
    // T35：模型读过、之后又被第三方改过的文件不许拿旧印象去改（与 write 同一台账，
    // 但不要求「没读过就拒绝」——edit 是现读现值，这是它与整写覆盖的语义差别）
    const stale = staleEditReason(file, ctx.sessionId)
    if (stale !== null) throw new Error(stale)
    const oldText = str(args.old, 'old')
    const newText = str(args.new, 'new')
    const anchorStat = await fs.stat(file).catch(() => null)
    const raw = await fs.readFile(file, 'utf8')
    const first = raw.indexOf(oldText)
    if (first < 0) throw new Error('old 内容在文件中不存在')
    if (raw.indexOf(oldText, first + 1) >= 0) throw new Error('old 内容在文件中匹配多处，请加长上下文使其唯一')
    const after = raw.slice(0, first) + newText + raw.slice(first + oldText.length)
    // T35：CAS——读文件与写回之间被别的程序改过就拒绝，绝不拿刚算好的旧基线整篇写回
    const beforeWrite = anchorStat === null ? null : await fs.stat(file).catch(() => null)
    if (anchorStat !== null && (beforeWrite === null || Math.abs(beforeWrite.mtimeMs - anchorStat.mtimeMs) > 1)) {
      throw new Error('文件在编辑过程中又被其他程序改动，重试一次（先重新读它）。')
    }
    await fs.writeFile(file, after, 'utf8')
    noteWrite(file, ctx.sessionId)
    const changes = summarizeChange(file, raw, after)
    return {
      text: `已编辑 ${file}`,
      ...(changes === undefined ? {} : { changes }),
    }
  },
}
