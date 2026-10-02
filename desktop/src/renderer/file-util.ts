/**
 * 文件树 / 预览共用的纯工具：路径拼接、文件名、大小格式化、预览类型分流。
 * 零 React、零副作用，Dock 与 file-preview 两边都从这里拿，避免各写一份。
 */

/** 路径里的文件名（两种分隔符都认）。 */
export function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Windows 风格的子路径拼接（fs-list / fs-read 都吃反斜杠绝对路径）。 */
export function joinPath(parent: string, name: string): string {
  return /[\\/]$/.test(parent) ? parent + name : `${parent}\\${name}`
}

/** 文件大小的人类读法（树行与占位提示共用）。 */
export function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

/** 宿主 fs-read 回包的 kind（desktop-dock 插件定义，这里只认形状）。 */
export type ReadKind = 'text' | 'image' | 'bytes' | 'binary'

/** fs-read 的回包（按 kind 分流；字段随 kind 可缺省）。 */
export interface ReadResult {
  path: string
  kind: ReadKind
  mime?: string
  base64?: string
  text?: string
  size?: number
  tooLarge: boolean
  message?: string
}

/** 预览页签的渲染分流（kind:'text' 时再按扩展名细分为 markdown / csv / 代码）。 */
export type PreviewKind = 'markdown' | 'csv' | 'xlsx' | 'pdf' | 'image' | 'code' | 'binary' | 'text'

/** 文本类文件的扩展名 → shiki 语法 id（没列出的按纯文本渲染）。 */
export const SHIKI_LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  md: 'markdown', mdx: 'mdx',
  py: 'python', pyi: 'python',
  rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  php: 'php', rb: 'ruby', lua: 'lua', scala: 'scala',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'dotenv',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', props: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte', astro: 'astro',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  m: 'objective-c', mm: 'objective-cpp', dart: 'dart', r: 'r', jl: 'julia',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', cljs: 'clojure',
  pl: 'perl', pm: 'perl', zig: 'zig', sol: 'solidity', fs: 'fsharp',
  diff: 'diff', patch: 'diff', log: 'log', rst: 'rst', tex: 'latex',
  makefile: 'makefile', mk: 'makefile',
}

/** 「这是哪种预览」：宿主回包 kind + 文件扩展名共同决定（md/csv 走 text 回包再细分）。 */
export function previewKindFor(read: ReadResult): PreviewKind {  if (read.kind === 'image') return 'image'
  if (read.kind === 'binary') return 'binary'
  if (read.kind === 'bytes') {
    if (read.mime === 'application/pdf') return 'pdf'
    return 'xlsx'
  }
  const name = basenameOf(read.path).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  if (['md', 'mdx', 'markdown'].includes(ext)) return 'markdown'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (read.mime === 'application/pdf') return 'pdf'
  return 'code'
}

/**
 * 路径的展示形态（dsh `displayPathOf` 的同位函数）：工作目录内 → 相对路径；
 * home 内 → `~/…`；其余原样。两段比较都按小写比——Windows 路径大小写不敏感，
 * 模型写的 `D:\dsc` 和宿主给回的 `d:\dsc` 是同一个目录。
 *
 * 为什么只把分隔符统一成正斜杠、不整条重写：展示层的职责是「短一点、认得出」，
 * 盘符与目录名保持模型/宿主写的原样，免得用户在资源管理器里对不上。
 */
export function displayPathOf(path: string, cwd: string, home = ''): string {
  if (path === '') return ''
  const posix = path.replace(/\\/g, '/')
  if (cwd !== '') {
    const base = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const low = posix.toLowerCase()
    const baseLow = base.toLowerCase()
    if (low === baseLow.slice(0, -1)) return '.'
    if (low.startsWith(baseLow)) return posix.slice(base.length)
  }
  if (home !== '') {
    const base = `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const low = posix.toLowerCase()
    const baseLow = base.toLowerCase()
    if (low === baseLow.slice(0, -1)) return '~'
    if (low.startsWith(baseLow)) return `~/${posix.slice(base.length)}`
  }
  return posix
}
