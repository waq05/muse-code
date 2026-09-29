/**
 * LSP 的 URI ↔ 路径与坐标换算（全是纯函数，自检重点覆盖）。
 *
 * ## 为什么必须「先解码成路径再比内外」
 *
 * 实测（Node v24，Windows）：
 * ```
 * pathToFileURL('C:\\dsc\\src\\a b#c%20.ts').href
 *   === 'file:///C:/dsc/src/a%20b%23c%2520.ts'      // 盘符不编码，空格/#/% 都编码
 * fileURLToPath('file:///c%3A/dsc/src/a.ts', {windows:true}) === 'c:\\dsc\\src\\a.ts'
 * ```
 * 也就是说同一条路径可以有好几种合法写法：`C:` 与 `c:`、`%3A` 与 `:`、UNC 的
 * `file://server/share`、以及大小写不同的盘符。拿 URI 字符串做前缀比较（`uri.startsWith(rootUri)`）
 * 会在「服务器回 `file:///c%3A/...`，我们手里是 `file:///C:/...`」这种情况下判成「不在工作区里」。
 * 所以本模块统一的做法是：**双方都 `fileURLToPath` 解码成路径，规范化后再比**。
 *
 * 另一个坑：`fileURLToPath` 对畸形转义会直接抛（`%2F`、Windows 下的 `%5C`、`%00`），
 * 而 POSIX 世界下 `%00` 不抛、会返回带 NUL 的路径。所以解码后还要查一遍 NUL，
 * 拿不准就返回 `undefined`，由调用方退回「原样显示 URI」。
 *
 * ## 列偏移为什么不用换算
 *
 * LSP 的 `character` 是 **UTF-16 code unit** 偏移。JS 字符串的长度天然就是这个单位：
 * `'a😀b'.length === 4`（emoji 占两个 code unit）。所以工具层把一基列减一就完事，
 * 不需要码点换算，**前提是文本和解码都按 UTF-16 理解**——`fs.readFileSync(..., 'utf8')`
 * 给的正是 JS 字符串，两边一致。（本文件只做一基/零基换算；这个前提在自检里验一次。）
 *
 * @module dsc/core/lsp/uri
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 零基坐标（LSP 线上格式）。 */
export interface LspPosition {
  line: number
  character: number
}

/** 零基区间（LSP 线上格式）。 */
export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** 本机是不是 Windows 世界（URI 解码要按它选规则；自检可以显式传 world 覆盖）。 */
export function hostWorld(): boolean {
  return process.platform === 'win32'
}

/**
 * 路径 → `file://` URI。
 *
 * @param path - 文件路径（相对路径按当前工作目录展开）。
 * @returns `file://` URI；盘符不编码，空格/`#`/`%` 按 RFC 3986 编码。
 */
export function pathToUri(path: string): string {
  try {
    return pathToFileURL(resolve(path)).href
  } catch {
    // 畸形路径（例如空 UNC 服务器名）会让 pathToFileURL 抛；这里手工拼一个仍合法的 URI。
    const normalized = resolve(path).replace(/\\/g, '/')
    const rooted = normalized.startsWith('/') ? normalized : `/${normalized}`
    const encoded = rooted
      .split('/')
      .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
      .join('/')
    return `file://${encoded}`
  }
}

/**
 * `file://` URI → 路径。
 *
 * 四条已知的畸形/歧义情况都在这里收口（返回 `undefined` 表示「解不出来」，调用方原样显示 URI）：
 *   - 非 `file:` 协议（`jdt://`、`untitled:` 这类虚拟文档）；
 *   - `%2F`（编码的斜杠）与 Windows 下的 `%5C`：`fileURLToPath` 会抛；
 *   - 解出来带 NUL（POSIX 世界下 `file:///dsc/a%00b.ts` 能解成功）：路径里带 NUL 没有任何用处；
 *   - 主机名不是本机的 UNC（POSIX 世界下 `file://server/share/x` 会抛 ERR_INVALID_FILE_URL_HOST）。
 *
 * @param uri - 待解码的 URI（通常来自语言服务器）。
 * @param windows - 按哪个世界解；缺省跟随本机平台。
 */
export function uriToPath(uri: string, windows: boolean = hostWorld()): string | undefined {
  if (!uri.startsWith('file:')) return undefined
  try {
    const path = fileURLToPath(uri, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    return undefined
  }
}

/** URI 或路径统一成「用来比较的路径」：绝对化 + Windows 上折成小写、去掉末尾分隔符。 */
function comparablePath(value: string, windows: boolean): string | undefined {
  const decoded = value.startsWith('file:') ? uriToPath(value, windows) : value
  if (decoded === undefined || decoded.includes('\0')) return undefined
  const absolute = resolve(decoded)
  if (!windows) return absolute
  // Windows 上盘符与文件名都不分大小写；末尾分隔符也不该让两个同目录判成不同。
  const trimmed = absolute.replace(/[\\/]+$/, '')
  return (trimmed === '' ? absolute : trimmed).toLowerCase()
}

/**
 * 两个 URI/路径指的是不是同一个文件（先解码、再绝对化、再按平台折大小写）。
 *
 * @param left - URI 或路径。
 * @param right - URI 或路径。
 * @param windows - 按哪个世界比；缺省跟随本机平台。
 */
export function samePath(left: string, right: string, windows: boolean = hostWorld()): boolean {
  const a = comparablePath(left, windows)
  const b = comparablePath(right, windows)
  if (a === undefined || b === undefined) return false
  return a === b
}

/**
 * `candidate` 是不是在 `root` 里面（含相等）。
 *
 * 为什么不用字符串前缀：`.../src2` 会以 `.../src` 为前缀，判错了会让不属于这个 root 的文件
 * 被当成同一个语言服务器实例的文档。这里走 `path.relative`（Windows 下它自己就不分大小写）。
 *
 * @param root - 根目录路径（或 URI）。
 * @param candidate - 待判定的路径（或 URI）。
 * @param windows - 按哪个世界判；缺省跟随本机平台。
 */
export function pathWithin(root: string, candidate: string, windows: boolean = hostWorld()): boolean {
  const rootPath = comparablePath(root, windows)
  const candidatePath = comparablePath(candidate, windows)
  if (rootPath === undefined || candidatePath === undefined) return false
  if (rootPath === candidatePath) return true
  const rel = relative(rootPath, candidatePath)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 把 URI 或路径渲染成给模型看的路径：在工作目录里的给相对路径，外面的给绝对路径，
 * 解不出来的（非 `file:` 协议、畸形转义）原样返回。Windows 上分隔符统一成 `/`——
 * 模型会把这些字符串拷回 `file_path` 参数，两种分隔符 `fs` 都认，正斜杠更不容易被 JSON 转义搅乱。
 *
 * @param uriOrPath - 语言服务器回的 URI，或本来就是路径。
 * @param cwd - 会话工作目录。
 * @param windows - 按哪个世界解；缺省跟随本机平台。
 */
export function displayPath(uriOrPath: string, cwd: string, windows: boolean = hostWorld()): string {
  // 非 file: 的 URI（jdt:// 这类虚拟文档）解不出来：原样返回。它没有对应的磁盘路径，
  // 再往下 resolve/relative 只会被当成相对路径搅成一串假路径。
  // 单字母 + 冒号是 Windows 盘符（C:\…），不算 scheme，继续按路径走。
  if (!uriOrPath.startsWith('file:')) {
    const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(uriOrPath)
    if (scheme !== null && uriOrPath[1] !== ':') return uriOrPath
  }
  const decoded = uriOrPath.startsWith('file:') ? uriToPath(uriOrPath, windows) : uriOrPath
  if (decoded === undefined) return uriOrPath
  const absolute = resolve(decoded)
  const inside = pathWithin(cwd, absolute, windows)
  const shown = inside ? relative(resolve(cwd), absolute) || '.' : absolute
  return windows ? shown.replaceAll(sep, '/') : shown
}

/**
 * 工具层的**一基**行列 → LSP 的**零基**坐标。
 *
 * 列不做码点换算：LSP 的 `character` 就是 UTF-16 code unit 偏移，而 JS 字符串长度就是这个单位
 * （`'a😀b'.length === 4`），所以「一基减一」即正确。
 *
 * @param line - 一基行号（第一行 = 1）。
 * @param character - 一基列号（第一列 = 1）。
 * @throws Error - 不是正整数时抛（调用方负责转成给模型的降级文案）。
 */
export function toProtocolPosition(line: number, character: number): LspPosition {
  if (!Number.isInteger(line) || line < 1) throw new Error(`line 要是一基正整数（第一行 = 1），收到 ${String(line)}`)
  if (!Number.isInteger(character) || character < 1) {
    throw new Error(`character 要是一基正整数（第一列 = 1），收到 ${String(character)}`)
  }
  return { line: line - 1, character: character - 1 }
}

/** 零基行号 → 一基（回给模型时用）。 */
export function toDisplayLine(line: number): number {
  return line + 1
}

/** 零基列号 → 一基（回给模型时用）。 */
export function toDisplayCharacter(character: number): number {
  return character + 1
}
