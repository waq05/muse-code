/**
 * 文件工具三件套：read / write / edit。路径相对会话 cwd 解析。
 * 三道护栏长在工具自己肚子里（不靠调用方自觉）：凭据文件不许读、
 * 系统关键路径不许写、没读过就不许整写覆盖。写要不要经用户点头由审批层管。
 *
 * @module dsc/core/tools/fs-tools
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'
import { noteRead, noteWrite, readBlockReason, staleOverwriteReason, writeHardBlockReason } from '../path-policy.js'
import { sandboxPermissionProperties } from './sandbox-args.js'

const READ_LINE_LIMIT = 2000

const abs = (cwd: string, p: unknown): string => {
  if (typeof p !== 'string' || p === '') throw new Error('path 必须是非空字符串')
  return isAbsolute(p) ? p : resolve(cwd, p)
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} 必须是字符串`)
  return v
}

export const readTool: ToolEntry = {
  name: 'read',
  description:
    '读取文本文件内容，输出「行号 + 制表符 + 原文」，可指定起始行与行数。' +
    '读代码、配置、日志一律用它，不要用 bash 跑 cat/head/tail——那样拿不到行号，也没法续读。' +
    '要整写覆盖一个已存在的文件之前必须先读过它，本工具会记下你读过哪个版本。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对或相对当前目录）' },
      offset: { type: 'number', description: '起始行（1-based，默认 1）' },
      limit: { type: 'number', description: '读取行数（默认 2000）' },
    },
    required: ['path'],
  },
  risk: 'read',
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const blocked = readBlockReason(file)
    if (blocked !== null) throw new Error(blocked)
    const raw = await fs.readFile(file, 'utf8')
    noteRead(file)
    const lines = raw.split(/\r?\n/)
    const start = Math.max(1, typeof args.offset === 'number' ? Math.floor(args.offset) : 1)
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : READ_LINE_LIMIT)
    const slice = lines.slice(start - 1, start - 1 + limit)
    const body = slice.map((line, index) => `${start + index}\t${line}`).join('\n')
    const total = lines.length
    const more = start - 1 + slice.length < total ? `\n…（共 ${total} 行，可用 offset/limit 续读）` : ''
    return `${file}\n${body}${more}`
  },
}

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
    const stale = staleOverwriteReason(file)
    if (stale !== null) throw new Error(stale)
    const content = str(args.content, 'content')
    await fs.mkdir(resolve(file, '..'), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
    noteWrite(file)
    return `已写入 ${file}（${content.length} 字符）`
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
    const oldText = str(args.old, 'old')
    const newText = str(args.new, 'new')
    const raw = await fs.readFile(file, 'utf8')
    const first = raw.indexOf(oldText)
    if (first < 0) throw new Error('old 内容在文件中不存在')
    if (raw.indexOf(oldText, first + 1) >= 0) throw new Error('old 内容在文件中匹配多处，请加长上下文使其唯一')
    await fs.writeFile(file, raw.slice(0, first) + newText + raw.slice(first + oldText.length), 'utf8')
    noteWrite(file)
    return `已编辑 ${file}`
  },
}
