/**
 * 技能市场：从一个源浏览并安装技能。
 *
 * 支持两类源（源清单在 `~/.dsc/settings.json`，见 core/prefs.ts）：
 *   1. GitHub 目录链接，如 `https://github.com/<owner>/<repo>/tree/<ref>/<dir>`
 *      —— 用一次 `git/trees?recursive=1` 列出目录，正文与附属文件走 raw 域名；
 *   2. 索引 JSON，如 `https://example.com/skills/index.json`
 *      —— 形状 `{ skills: [{ name, description, version?, path?, files? }] }`（也接受裸数组）。
 *
 * 三条约束：条目清单缓存 1 小时（`~/.dsc/cache/`）；GitHub 匿名限额低，
 * 有 `GITHUB_TOKEN` 就用；单文件超过 1.5 MB 或单技能附属文件超过 40 个不拉，
 * 免得一次安装把家目录灌满。
 *
 * @module dsc/core/market
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { MarketSkillView, MarketSource } from '../contract.js'
import { parseSkillMarkdown } from './skills.js'

const CACHE_DIR = join(homedir(), '.dsc', 'cache')
const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
const MAX_EXTRA_FILES = 40
const MAX_FILE_BYTES = 1_500_000
const BROWSE_CONCURRENCY = 6

/** 安装所需的内部条目（UI 只看 MarketSkillView）。 */
export interface MarketEntry {
  name: string
  description: string
  version?: string
  source: string
  /** dir = 目录包（内含 mainFile）；flat = 单个 markdown 文件。 */
  kind: 'dir' | 'flat'
  /** 取文件的根：rawBase 存在时它是相对 raw 根的路径，否则本身就是绝对 URL。 */
  root: string
  /** 主文件名（dir 是 `SKILL.md`，flat 是 `<name>.md`）。 */
  mainFile: string
  /** 附属文件（相对 root，如 `references/x.md`）。 */
  files: string[]
  /** GitHub raw 根（`https://raw.githubusercontent.com/<owner>/<repo>/<ref>`）。 */
  rawBase?: string
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function fetchBytes(url: string, headers: Record<string, string> = {}): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsc-skill-market', ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}（${url}）`)
  return new Uint8Array(await response.arrayBuffer())
}

async function fetchText(url: string): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url))
}

/** 一个条目的某个文件该从哪儿取。 */
function fileUrl(entry: MarketEntry, relative: string): string {
  const base =
    entry.rawBase !== undefined && !entry.root.startsWith('http')
      ? `${entry.rawBase}/${entry.root}`
      : entry.root
  return `${base}/${relative}`
}

/** 并发受限的 map（结果按输入顺序返回）。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await work(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

interface GitHubRef {
  owner: string
  repo: string
  ref: string
  dir: string
}

/** 解析 GitHub 目录链接（`/tree/<ref>/<dir>`，省略 dir 表示仓库根）。 */
export function parseGitHubTree(url: string): GitHubRef | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/i.exec(url.trim())
  if (match === null) return null
  const [, owner, repo, ref, dir] = match
  if (owner === undefined || repo === undefined || ref === undefined) return null
  return { owner, repo, ref, dir: (dir ?? '').replace(/^\/+|\/+$/g, '') }
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  return token === '' ? {} : { authorization: `Bearer ${token}` }
}

/** GitHub 源：一次递归 trees 列目录，再并发取各 SKILL.md 的 frontmatter。 */
async function browseGitHub(source: MarketSource): Promise<MarketEntry[]> {
  const ref = parseGitHubTree(source.url)
  if (ref === null) {
    throw new Error('源地址既不是 GitHub 目录链接，也不是 .json 索引（形如 https://github.com/owner/repo/tree/main/skills）')
  }
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`
  const response = await fetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsc-skill-market', ...githubHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    if (response.status === 403 || response.status === 422) {
      throw new Error(`GitHub API 拒绝（${response.status}）：匿名限额较低，设置 GITHUB_TOKEN 后重试`)
    }
    throw new Error(`GitHub API ${response.status} ${response.statusText}（${api}）`)
  }
  const payload = (await response.json()) as { tree?: { path?: string; type?: string }[] }
  const prefix = ref.dir === '' ? '' : `${ref.dir}/`
  const rawBase = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}`

  const dirSkills = new Map<string, string[]>()
  const flatSkills: string[] = []
  for (const node of payload.tree ?? []) {
    const path = node.path ?? ''
    if (node.type !== 'blob') continue
    if (prefix !== '' && !path.startsWith(prefix)) continue
    const relative = prefix === '' ? path : path.slice(prefix.length)
    const segments = relative.split('/')
    if (segments.length === 1) {
      if (relative.endsWith('.md') && relative.toLowerCase() !== 'readme.md') flatSkills.push(relative)
      continue
    }
    const skillName = segments[0] as string
    const inside = segments.slice(1).join('/')
    const extras = dirSkills.get(skillName)
    if (extras === undefined) dirSkills.set(skillName, inside === 'SKILL.md' ? [] : [inside])
    else if (inside !== 'SKILL.md' && extras.length < MAX_EXTRA_FILES) extras.push(inside)
  }
  // 只有确实含 SKILL.md 的目录才算技能；上面一遍没记录 mainFile，这里按路径复查
  const blobs = new Set((payload.tree ?? []).map((node) => node.path ?? ''))

  const entries: MarketEntry[] = []
  const dirs = [...dirSkills.keys()].sort()
  entries.push(
    ...(await mapLimit(dirs, BROWSE_CONCURRENCY, async (name): Promise<MarketEntry> => {
      const entry: MarketEntry = {
        name,
        description: '未提供描述，安装后本地解析',
        source: source.name,
        kind: 'dir',
        root: `${prefix}${name}`,
        mainFile: 'SKILL.md',
        files: (dirSkills.get(name) ?? []).filter((file) => blobs.has(`${prefix}${name}/${file}`)),
        rawBase,
      }
      try {
        entry.description = describe(parseSkillMarkdown(await fetchText(fileUrl(entry, 'SKILL.md'))))
      } catch {
        // 取不到 frontmatter 就保留占位描述，安装时再本地解析
      }
      return entry
    })),
  )
  entries.push(
    ...(await mapLimit(flatSkills.sort(), BROWSE_CONCURRENCY, async (path): Promise<MarketEntry> => {
      const entry: MarketEntry = {
        name: basename(path, '.md'),
        description: '未提供描述，安装后本地解析',
        source: source.name,
        kind: 'flat',
        root: path.slice(0, Math.max(0, path.lastIndexOf('/'))),
        mainFile: basename(path),
        files: [],
        rawBase,
      }
      try {
        entry.description = describe(parseSkillMarkdown(await fetchText(fileUrl(entry, entry.mainFile))))
      } catch {
        // 同上
      }
      return entry
    })),
  )
  return entries
}

/** 索引 JSON 源。 */
async function browseIndex(source: MarketSource): Promise<MarketEntry[]> {
  const doc = JSON.parse(await fetchText(source.url)) as unknown
  const list = Array.isArray(doc) ? doc : ((doc as { skills?: unknown }).skills ?? (doc as { items?: unknown }).items)
  if (!Array.isArray(list)) throw new Error('索引里找不到 skills 数组')
  const dirUrl = source.url.replace(/[^/]*$/, '')
  const entries: MarketEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') continue
    const path = typeof item.path === 'string' && item.path !== '' ? item.path : `${name}/SKILL.md`
    const absolute = new URL(path, dirUrl).toString()
    const isFlat = /\.md$/i.test(absolute)
    entries.push({
      name,
      description: typeof item.description === 'string' ? item.description : '',
      version: typeof item.version === 'string' ? item.version : undefined,
      source: source.name,
      kind: isFlat ? 'flat' : 'dir',
      root: isFlat ? absolute.replace(/\/[^/]*$/, '') : absolute,
      mainFile: basename(absolute),
      files: Array.isArray(item.files)
        ? item.files.filter((file): file is string => typeof file === 'string')
        : [],
    })
  }
  return entries
}

/** 描述行：有 when-to-use 就拼在后面，技能卡片一行放得下。 */
function describe(parsed: { description: string; whenToUse?: string }): string {
  if (parsed.description === '') return '（frontmatter 没写 description）'
  return parsed.whenToUse === undefined
    ? parsed.description
    : `${parsed.description} · 何时用：${parsed.whenToUse}`
}

function cachePath(url: string): string {
  return join(CACHE_DIR, `market-${createHash('sha1').update(url.trim()).digest('hex').slice(0, 16)}.json`)
}

/** 浏览一个源（1 小时内命中缓存不联网）。 */
export async function browseMarketSource(
  source: MarketSource,
  options: { refresh?: boolean } = {},
): Promise<MarketEntry[]> {
  const file = cachePath(source.url)
  if (options.refresh !== true && existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { at?: number; entries?: MarketEntry[] }
      if (typeof doc.at === 'number' && Date.now() - doc.at < CACHE_TTL_MS && Array.isArray(doc.entries)) {
        return doc.entries
      }
    } catch {
      // 缓存坏了就重新拉
    }
  }
  const entries = /\.json(\?|$)/i.test(source.url.trim()) ? await browseIndex(source) : await browseGitHub(source)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ at: Date.now(), entries }), 'utf8')
  return entries
}

/** 拉取一个条目并写进技能目录；返回落盘位置与文件数。 */
export async function installMarketEntry(
  entry: MarketEntry,
  destRoot: string,
): Promise<{ target: string; files: number }> {
  const target = join(destRoot, entry.kind === 'dir' ? entry.name : `${entry.name}.md`)
  if (existsSync(target)) throw new Error(`本地已有 ${entry.name}，先在技能中心删掉旧文件再装`)
  const write = (relative: string): Promise<boolean> =>
    fetchBytes(fileUrl(entry, relative)).then((bytes) => {
      if (bytes.byteLength > MAX_FILE_BYTES) return false
      const path = join(destRoot, entry.kind === 'dir' ? entry.name : '', relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      return true
    })
  let written = (await write(entry.mainFile)) ? 1 : 0
  if (written === 0) throw new Error(`拉取 ${entry.mainFile} 失败（文件超过 ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB 上限）`)
  if (entry.kind === 'dir') {
    for (const relative of entry.files) {
      try {
        if (await write(relative)) written += 1
      } catch {
        // 附属文件取不到不阻塞安装：正文里引用的话本地会报找不到，用户可重装
      }
    }
  }
  return { target, files: written }
}

/** 内部条目 → UI 条目。 */
export function toMarketSkillView(entry: MarketEntry, installedNames: ReadonlySet<string>): MarketSkillView {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    version: entry.version,
    installed: installedNames.has(entry.name),
  }
}

/** 供错误信息复用（避免上层再判一次类型）。 */
export { errText as marketErrorText }
