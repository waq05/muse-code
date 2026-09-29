/**
 * LSP 服务器表与「找项目根」。
 *
 * 两件事放一起的理由：它们都是**每条查询之前的纯判断**——哪个服务器管这个扩展名、它的项目根在哪，
 * 都不需要起进程。进程与协议在 `client.ts`。
 *
 * 内置表照 hermes 的 `agent/lsp/servers.py` 取了主干（TypeScript/Python/Rust/Go/C/C++ 加 JSON/YAML），
 * 但字段收窄成六项：`id / languageId / extensions / command / args / markers`。用户可以用设置里的
 * 一行 JSON 追加或覆盖（配置键 `servers`）：同 id 覆盖内置项，新 id 排在内置项**前面**，
 * 这样自定义服务器才有机会抢走某个扩展名。
 *
 * 可执行文件解析照 `src/core/mcp.ts` 的 `resolveCommand`（Windows 上 Node 只执行 PE 文件，
 * `spawn('typescript-language-server')` 明明 PATH 里有 `.cmd` 也会 EINVAL）。差别只有一处：
 * 那边找不到就交给 shell 去试，这里找不到就是**这个服务器不注册**——LSP 多一条「猜错了」的情况，
 * 不如把「PATH 里没有它」当成一个可解释的降级原因直接告诉模型。
 *
 * @module dsc/core/lsp/servers
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** 一个语言服务器条目。 */
export interface LspServerDef {
  /** 稳定标识（进错误文案与 `lsp:<id>` 围栏来源）。 */
  id: string
  /** `didOpen` 里报的 languageId；具体文件的 id 由 {@link languageIdFor} 定。 */
  languageId: string
  /** 认领的扩展名（小写、带点），或完整文件名（如 `Dockerfile`）。 */
  extensions: string[]
  /** 可执行文件名或路径。 */
  command: string
  /** 传给可执行文件的参数。 */
  args: string[]
  /** 用来向上找项目根的标记文件名。 */
  markers: string[]
}

/** 内置服务器表（按认领优先级排列）。 */
export const BUILTIN_SERVERS: readonly LspServerDef[] = [
  {
    id: 'typescript',
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    markers: ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'],
  },
  {
    id: 'pyright',
    languageId: 'python',
    extensions: ['.py', '.pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    markers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt', '.git'],
  },
  {
    id: 'rust',
    languageId: 'rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    markers: ['Cargo.toml', 'Cargo.lock', '.git'],
  },
  {
    id: 'go',
    languageId: 'go',
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    markers: ['go.mod', 'go.work', 'go.sum', '.git'],
  },
  {
    id: 'clangd',
    languageId: 'cpp',
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    command: 'clangd',
    // 跨文件 findReferences 要靠后台索引；不加这个参数时 clangd 只认当前编译单元。
    args: ['--background-index'],
    markers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', '.git'],
  },
  {
    id: 'json',
    languageId: 'json',
    extensions: ['.json', '.jsonc'],
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    markers: ['package.json', 'tsconfig.json', '.git'],
  },
  {
    id: 'yaml',
    languageId: 'yaml',
    extensions: ['.yaml', '.yml'],
    command: 'yaml-language-server',
    args: ['--stdio'],
    markers: ['docker-compose.yml', 'docker-compose.yaml', '.yamllint', '.git'],
  },
]

/**
 * 「怎么装」的提示（只在 PATH 里找不到可执行文件时用得上）。
 * 单独一张表而不是 `LspServerDef` 的字段：它是给人看的一句话，不参与任何判定。
 */
const INSTALL_HINTS: Readonly<Record<string, string>> = {
  typescript: 'npm i -g typescript typescript-language-server',
  pyright: 'npm i -g pyright（或改用 pylsp，在设置里覆盖成 command "pylsp"）',
  rust: 'rustup component add rust-analyzer',
  go: 'go install golang.org/x/tools/gopls@latest',
  clangd: '装 LLVM 发行包，或 scoop install clangd / apt install clangd',
  json: 'npm i -g vscode-langservers-extracted',
  yaml: 'npm i -g yaml-language-server',
}

/** 一条能直接交给 `spawn` 的目标。 */
export interface SpawnTarget {
  /** 解析出来的可执行文件（绝对路径，或解析不了时的原样命令）。 */
  file: string
  /** true = 要经 shell 起（`.cmd` / `.bat` 只能这么跑）。 */
  shell: boolean
}

/** `PATH` 里没写 `PATHEXT` 时按这几个后缀找（照 `core/mcp.ts`）。 */
const FALLBACK_PATHEXT: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD']

/**
 * 解析一条命令到可执行文件。
 *
 * @param command - 配置里的命令（文件名或路径）。
 * @param env - 已筛过的子进程环境（从这里读 `PATH` / `PATHEXT`）。
 * @param cwd - 解析相对路径的基准目录；空串按当前目录。
 * @returns 找到就返回目标；一个都找不到返回 `undefined`（调用方据此跳过这个服务器）。
 */
export function resolveExecutable(
  command: string,
  env: Record<string, string | undefined>,
  cwd: string,
): SpawnTarget | undefined {
  const windows = process.platform === 'win32'
  // 带分隔符的按路径解析，不带分隔符的按 PATH 找。
  const roots = /[\\/]/.test(command)
    ? [isAbsolute(command) ? command : resolve(cwd === '' ? process.cwd() : cwd, command)]
    : (env.PATH ?? readEnvValue(env, 'PATH') ?? '')
        .split(windows ? ';' : ':')
        .filter((dir) => dir !== '')
        .map((dir) => join(dir, command))
  const declared = (env.PATHEXT ?? readEnvValue(env, 'PATHEXT') ?? '')
    .split(';')
    .filter((suffix) => suffix !== '')
  const suffixes = windows ? (declared.length > 0 ? declared : FALLBACK_PATHEXT) : ['']
  for (const root of roots) {
    // Windows 上带后缀的候选要排在无后缀**前面**：PATH 里无后缀的 `npm` 往往是 sh 包装脚本，
    // statSync 认得出它是文件（isRunnable 放行）却没法被 spawn；先撞上它就会
    // 错过同目录下真正能跑的 npm.cmd，返回一个起不来的目标。
    const candidates = windows ? suffixes.map((suffix) => root + suffix).concat(root) : [root]
    for (const candidate of candidates) {
      if (!isRunnable(candidate)) continue
      const lower = candidate.toLowerCase()
      return { file: candidate, shell: windows && (lower.endsWith('.cmd') || lower.endsWith('.bat')) }
    }
  }
  return undefined
}

/** 读环境变量（Windows 上变量名不分大小写，所以找不到时再比一遍小写）。 */
function readEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  if (process.platform !== 'win32') return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key]
  }
  return undefined
}

/** 这个路径是不是一个能跑的文件（POSIX 上还要求可执行位）。 */
function isRunnable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 一个服务器此刻在表里的样子（给设置页与 `ctx.get('lsp').servers()` 看）。 */
export interface LspServerInfo extends LspServerDef {
  /** `PATH` 里找得到它的可执行文件吗；false = 这个服务器不会起进程。 */
  available: boolean
  /** 解析出来的可执行文件绝对路径（`available` 为 false 时没有）。 */
  executable?: string
}

/** 把服务器表连同「能不能起」一起投影出来。 */
export function describeServers(
  servers: readonly LspServerDef[],
  env: Record<string, string | undefined>,
  cwd: string,
): LspServerInfo[] {
  return servers.map((server) => {
    const target = resolveExecutable(server.command, env, cwd)
    return target === undefined
      ? { ...server, available: false }
      : { ...server, available: true, executable: target.file }
  })
}

/** 没装时给一句怎么装。 */
export function installHint(serverId: string): string | undefined {
  return INSTALL_HINTS[serverId]
}

/**
 * 解析用户的一行 JSON 服务器清单。
 *
 * 形状是一个数组，一项一个服务器：
 * ```json
 * [{"id":"python","command":"pylsp","extensions":[".py"],"markers":["pyproject.toml"]}]
 * ```
 * `languageId`（缺省取 id）、`args`、`markers` 可省。任何一项不合法就整份拒收并指出第几项哪里不对
 * ——与 `mcp` 插件同一套规矩：宁可不生效，也不要把半份清单悄悄装上。
 *
 * @param text - 设置里那一行 JSON；空串 = 没有覆盖。
 * @returns `problem` 非空时 `servers` 一定是空的。
 */
export function parseServerOverrides(text: string): { servers: LspServerDef[]; problem: string | null } {
  const trimmed = text.trim()
  if (trimmed === '') return { servers: [], problem: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { servers: [], problem: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(parsed)) return { servers: [], problem: '要是一个数组，一项一个服务器' }
  const servers: LspServerDef[] = []
  for (const [index, item] of parsed.entries()) {
    const at = `第 ${index + 1} 项`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { servers: [], problem: `${at}不是对象` }
    }
    const raw = item as Record<string, unknown>
    const id = nonEmptyString(raw.id)
    if (id === undefined) return { servers: [], problem: `${at}的 id 要是非空字符串` }
    const command = nonEmptyString(raw.command)
    if (command === undefined) return { servers: [], problem: `${at}（${id}）的 command 要是非空字符串` }
    const extensions = stringList(raw.extensions)
    if (extensions === undefined || extensions.length === 0) {
      return { servers: [], problem: `${at}（${id}）的 extensions 要是非空字符串数组，例如 [".py"]` }
    }
    const args = stringList(raw.args)
    if (args === undefined) return { servers: [], problem: `${at}（${id}）的 args 要是字符串数组` }
    const markers = stringList(raw.markers)
    if (markers === undefined) return { servers: [], problem: `${at}（${id}）的 markers 要是字符串数组` }
    servers.push({
      id,
      languageId: nonEmptyString(raw.languageId) ?? id,
      extensions: extensions.map((ext) => ext.toLowerCase()),
      command,
      args,
      markers,
    })
  }
  return { servers, problem: null }
}

/** 非空字符串才要，其余（含非字符串）当没给。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 字符串数组才要；元素必须都是非空字符串。没给（undefined）返回空数组，给了但畸形返回 undefined。 */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return undefined
    out.push(item)
  }
  return out
}

/**
 * 把用户覆盖合进内置表：同 id 覆盖，新 id 排在最前面。
 *
 * 新 id 排前面是有意的——用户新写一个服务器，多半就是为了认领一个内置表没管的扩展名，
 * 或者抢走内置表里某个扩展名；排后面等于写了不生效。
 */
export function mergeServers(
  builtin: readonly LspServerDef[],
  overrides: readonly LspServerDef[],
): LspServerDef[] {
  const byId = new Map(overrides.map((server) => [server.id, server]))
  const builtinIds = new Set(builtin.map((server) => server.id))
  const merged: LspServerDef[] = []
  // 内置表没有的新 id 排在最前面：用户新写一个服务器，多半就是为了抢一个内置表没管的
  // 扩展名（或抢内置项的扩展名），排后面等于写了不生效。overrides 自身重复的 id
  // 以 Map 里最后一份为准，只收一次。
  for (const [id, server] of byId) {
    if (builtinIds.has(id)) continue
    merged.push(server)
  }
  // 内置项按原序保留；同 id 被用户那份**就地顶掉**：表长与相对顺序不变，也不会出现两份同 id。
  for (const server of builtin) {
    merged.push(byId.get(server.id) ?? server)
  }
  return merged
}

/**
 * 取文件扩展名：带点的后缀（小写）；没有后缀时给整个文件名（`Dockerfile` 这种靠文件名认领）。
 *
 * 复合扩展名（`home.blade.php`）只取最后一段——本项目内置表里没有这种语言，够用。
 */
export function extensionOf(filePath: string): string {
  const base = basename(filePath).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : base
}

/**
 * 这个服务器认不认这个文件。
 *
 * @param server - 服务器条目。
 * @param filePath - 待判定的文件路径。
 */
export function matchesFile(server: LspServerDef, filePath: string): boolean {
  const base = basename(filePath).toLowerCase()
  const ext = extensionOf(filePath)
  return server.extensions.some((raw) => {
    const want = raw.toLowerCase()
    return want.startsWith('.') ? ext === want : base === want || ext === want
  })
}

/**
 * 给一个文件挑服务器：表里第一条认领它的。
 *
 * @param servers - 生效的服务器表（已按优先级排好）。
 * @param filePath - 待查询的文件。
 */
export function findServerForFile(
  servers: readonly LspServerDef[],
  filePath: string,
): LspServerDef | undefined {
  return servers.find((server) => matchesFile(server, filePath))
}

/**
 * 向上找项目根：从文件所在目录开始，逐级往上找第一个含任一标记文件的目录。
 *
 * 走多少级有上限（默认 64）：软链接成环或路径异常时也不会转死。
 * 找不到就返回 `undefined`——调用方据此给出「定不了项目根」的降级文案，而不是瞎猜一个根。
 *
 * @param filePath - 待查询的文件（绝对路径）。
 * @param markers - 标记文件名（精确文件名，不支持通配）。
 * @param maxWalk - 最多往上走几级。
 */
export function findProjectRoot(
  filePath: string,
  markers: readonly string[],
  maxWalk = 64,
): string | undefined {
  let current = resolve(dirname(resolve(filePath)))
  for (let step = 0; step < maxWalk; step += 1) {
    for (const marker of markers) {
      if (marker !== '' && existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** 扩展名 → `didOpen` 该报的 languageId（同一个 TypeScript 服务器认领 .ts 与 .js 两种语言）。 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.pyi': 'python',
  '.h': 'c',
  '.hh': 'c',
}

/**
 * 这个文件该用哪个 languageId 开文档：具体扩展名优先，退回服务器声明的那个。
 *
 * @param server - 认领这个文件的服务器。
 * @param filePath - 文件路径。
 */
export function languageIdFor(server: LspServerDef, filePath: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? server.languageId
}
