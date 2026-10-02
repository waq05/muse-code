/**
 * 输入端 @ 文件提及补全（T14）：定位光标处的 @token、给候选排序、把选中路径插回正文。
 *
 * 纯模块：不碰 React、不碰网络，工作区文件清单由调用方注入 lister（dock 的 fs-list
 * 透传），探针在 node 里直测。路径一律 posix 相对形态（插入正文、被 chat/markdown-text
 * 的 matchMentionPath 识别成 chip、被轮尾改动卡按后缀匹配命中）。
 *
 * @module desktop/renderer/mention-complete
 */

/** 光标处的 @ 提及查询：token 是 @ 之后的已敲字符（可为空串），start 指向 @ 本身。 */
export interface MentionQuery {
  token: string
  start: number
  /** 光标位置（token 结尾）。 */
  end: number
}

/** token 最长 64 字符：再长多半是把整段文字吸进来的误判，不触发。 */
const MAX_TOKEN_CHARS = 64

/**
 * 找光标处的 @ 提及查询。规则：
 * - 从光标往前找最近的 `@`；`@` 前必须是文本开头或空白（邮箱 `a@b` 不触发）；
 * - `@` 到光标之间不能有空白或换行（路径里的 `/` 允许）；
 * - 没有 `@` 或 token 超长返回 null。
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const at = Math.min(Math.max(caret, 0), text.length)
  let start = -1
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char === '@') {
      start = index
      break
    }
    if (/\s/.test(char ?? '')) break
  }
  if (start < 0) return null
  if (start > 0 && !/\s/.test(text[start - 1] ?? '')) return null
  const token = text.slice(start + 1, at)
  if (token.length > MAX_TOKEN_CHARS) return null
  return { token, start, end: at }
}

/**
 * 把选中的路径插回正文：替换 `@token` 为 `@路径` 并补一个尾随空格，
 * 返回新文本与插入后的光标位置。
 */
export function insertMention(text: string, query: MentionQuery, path: string): { text: string; caret: number } {
  const inserted = `@${path} `
  const next = `${text.slice(0, query.start)}${inserted}${text.slice(query.end)}`
  return { text: next, caret: query.start + inserted.length }
}

/**
 * 候选排序：文件名前缀命中 > 文件名包含 > 路径包含 > 无命中（按路径深度与字典序兜底）；
 * 空 token 直接按深度 + 字典序给前列。同档内路径短的靠前（浅目录 ≈ 更常被提）。
 */
export function rankMentionCandidates(files: readonly string[], token: string, limit = 12): string[] {
  const query = token.toLowerCase()
  const scored: { path: string; score: number }[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const name = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
    let score: number
    if (query === '') {
      score = file.split('/').length * 100 + name.length
    } else if (name.startsWith(query)) {
      score = 0
    } else if (name.includes(query)) {
      score = 1000 + name.length
    } else if (lower.includes(query)) {
      score = 2000 + lower.length
    } else {
      continue
    }
    scored.push({ path: file, score: score * 1000 + Math.min(file.length, 999) })
  }
  scored.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1))
  return scored.slice(0, limit).map((entry) => entry.path)
}

/** 遍历时跳过的目录名（构建产物与依赖：清单里全是它们只会淹没真候选）。 */
export const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.turbo', '__pycache__', '.cache', '.venv', 'venv', 'target',
  'runtime-staging',
  // Chromium userData 的标准缓存子目录（自检/打包残留会以这些名字出现在仓库里）
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache', 'CachedData',
  'crashpad', 'blob_storage', 'Session Storage', 'Local Storage', 'Shared Dictionary',
])

/** 遍历上限：条数与深度都按住，超大仓库不至于把补全拖死。 */
export const WALK_MAX_FILES = 4000
export const WALK_MAX_DEPTH = 6

/** fs-list 透传回包的最小形状（desktop-dock 插件定义，这里只认形状）。 */
export type DirLister = (dir: string) => Promise<{ entries: { name: string; dir: boolean }[] }>

/**
 * 深度优先收集工作区的文件相对路径（posix 分隔符，根为 `./` 的形式不带头）。
 * 目录按 SKIP_DIR_NAMES 剪枝，总量到 WALK_MAX_FILES 即止；lister 抛错时跳过该目录。
 */
export async function collectWorkspaceFiles(lister: DirLister, root = '.'): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= WALK_MAX_FILES) return
    let entries: { name: string; dir: boolean }[]
    try {
      entries = (await lister(dir)).entries
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= WALK_MAX_FILES) return
      const path = dir === '.' || dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.dir) {
        // 点开头目录（.mimosa/.zcode 这类工具状态目录）一律跳过：名字按字典序排在
        // 源码前面，历史文件一多就把整个上限吃满，源码目录反而一个都收不进。
        if (depth >= WALK_MAX_DEPTH || SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(path, depth + 1)
      } else {
        files.push(path)
      }
    }
  }
  await walk(root, 0)
  return files
}
