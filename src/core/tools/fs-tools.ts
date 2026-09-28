/**
 * 文件工具三件套：read / write / edit。路径相对会话 cwd 解析；
 * 个人版不做目录白名单（写类操作由审批卡兜底）。
 *
 * @module dsc/core/tools/fs-tools
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'

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
  description: '读取文本文件内容。可指定起始行（1-based）与行数。适合读代码、配置、日志。',
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
    const raw = await fs.readFile(file, 'utf8')
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
  description: '把内容整体写入文件（覆盖）。目录不存在会自动创建。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const content = str(args.content, 'content')
    await fs.mkdir(resolve(file, '..'), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
    return `已写入 ${file}（${content.length} 字符）`
  },
}

export const editTool: ToolEntry = {
  name: 'edit',
  description: '对文件做一次精确字符串替换。old 必须与文件内容唯一匹配（原样替换为 new）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      old: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
      new: { type: 'string', description: '替换后的内容' },
    },
    required: ['path', 'old', 'new'],
  },
  risk: 'write',
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const oldText = str(args.old, 'old')
    const newText = str(args.new, 'new')
    const raw = await fs.readFile(file, 'utf8')
    const first = raw.indexOf(oldText)
    if (first < 0) throw new Error('old 内容在文件中不存在')
    if (raw.indexOf(oldText, first + 1) >= 0) throw new Error('old 内容在文件中匹配多处，请加长上下文使其唯一')
    await fs.writeFile(file, raw.slice(0, first) + newText + raw.slice(first + oldText.length), 'utf8')
    return `已编辑 ${file}`
  },
}
