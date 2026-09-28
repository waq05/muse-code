/**
 * 搜索工具两件套：glob（文件名匹配）/ grep（内容匹配）。
 * 递归遍历默认跳过 node_modules / .git / dist 等大目录。
 *
 * @module dsc/core/tools/search-tools
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__'])
const MAX_FILE_BYTES = 1024 * 1024

/** 把 glob 模式转 RegExp：`**` 跨目录段，`*`/`?` 段内。 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*'
        i += 1
        if (normalized[i + 1] === '/') i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= limit) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, full, out, limit)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

const displayPath = (root: string, file: string): string => relative(root, file).replace(/\\/g, '/')

export const globTool: ToolEntry = {
  name: 'glob',
  description:
    '按文件名模式查找文件（相对当前目录）。支持 ** 跨目录、* 段内通配、? 单字符。例：**/*.ts、src/*.json。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式' },
      path: { type: 'string', description: '搜索根目录（默认当前目录）' },
      limit: { type: 'number', description: '最多返回条数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : 100)
    const matcher = globToRegExp(args.pattern)
    const files: string[] = []
    await walk(root, root, files, 10_000)
    const hits = files.map((file) => displayPath(root, file)).filter((rel) => matcher.test(rel)).slice(0, limit)
    return hits.length === 0 ? `（无匹配：${args.pattern}）` : hits.join('\n')
  },
}

export const grepTool: ToolEntry = {
  name: 'grep',
  description: '在目录内按行搜索内容（正则或纯文本），返回 文件:行号: 内容。跳过二进制与大文件。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索内容（正则；非法正则退化为字面量）' },
      path: { type: 'string', description: '搜索根目录或单文件（默认当前目录）' },
      maxResults: { type: 'number', description: '最多返回行数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    let matcher: RegExp
    try {
      matcher = new RegExp(args.pattern, 'i')
    } catch {
      matcher = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const maxResults = Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 100)
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const rootStat = await fs.stat(root)
    const files = rootStat.isFile() ? [root] : []
    if (files.length === 0) await walk(root, root, files, 20_000)

    const lines: string[] = []
    for (const file of files) {
      if (lines.length >= maxResults) break
      let stat
      try {
        stat = await fs.stat(file)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      if (content.includes('\0')) continue
      const split = content.split(/\r?\n/)
      for (let index = 0; index < split.length; index += 1) {
        if (lines.length >= maxResults) break
        if (matcher.test(split[index])) {
          lines.push(`${displayPath(root, file)}:${index + 1}: ${split[index].trim().slice(0, 200)}`)
        }
      }
    }
    return lines.length === 0 ? `（无匹配：${args.pattern}）` : lines.join('\n')
  },
}
