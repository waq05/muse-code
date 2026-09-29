/**
 * 受控浏览器的启动、端点发现与整树清理。
 *
 * 为什么自己起浏览器而不是连用户的日常实例：
 *   1. Chrome 136+ 起，对默认 profile 目录**静默忽略** `--remote-debugging-port`；
 *      144+ 每次还要弹一次授权。想稳，就必须给一个自建 profile；
 *   2. 自建 profile 才敢在收尾时整个删掉——用户自己的 profile 里是书签、密码、登录态，
 *      碰不得，也不该被自动化流程污染；
 *   3. `--remote-debugging-port=0` 让系统分配空闲端口，避免和用户已经开着的调试实例撞端口。
 *      代价是「端口号事先不知道」，所以端点只能从 profile 目录里的 `DevToolsActivePort`
 *      文件读——这比解析 stderr 稳：Windows 上 stderr 是 GBK，中文路径一进来就乱码。
 *
 * 清理是这里最大的坑：Windows 没有进程组信号，`child.kill()` 只杀得掉浏览器主进程，
 * renderer/gpu/utility 一堆子进程会活下来继续占着 profile 目录，下一次启动就报
 * 「profile 已被占用」。所以必须 `taskkill /PID <pid> /T /F` 整树杀，等 300ms 让文件句柄
 * 释放，再递归删自建 profile。
 *
 * 这里刻意**不**装 SIGINT/SIGTERM 处理器：宿主统一走 `dsc/exit` 事件收尾，
 * 插件抢着处理信号会让宿主自己的退出流程半路失效（stagehand 那份也是
 * `handleSIGINT/SIGTERM: false`）。
 *
 * @module dsc/core/cdp/launch
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CdpTransport, type CdpTransportOptions } from './transport.js'

/** 启动+清理需要的配置（由插件从设置里读）。 */
export interface BrowserLaunchConfig {
  /** 用户填的浏览器路径；空 = 自动探测。 */
  executablePath: string
  /** 用户填的 profile 目录；空 = 自建临时目录（收尾时连目录一起删）。 */
  profileDir: string
  /** 无窗口运行。 */
  headless: boolean
}

/** 探测用的环境根（注入点，自检可以造假路径）。 */
export interface BrowserProbeEnv {
  localAppData: string
  programFiles: string
  programFilesX86: string
}

/** 取本机环境里的三个安装根目录。 */
export function probeEnv(): BrowserProbeEnv {
  return {
    localAppData: process.env.LOCALAPPDATA ?? '',
    programFiles: process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? 'C:\\Program Files',
    programFilesX86: process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  }
}

/**
 * 候选可执行文件，按优先级排。
 * Program Files 里的系统级安装优先，再退到 %LOCALAPPDATA% 的用户级安装
 * （Chrome 从官网装到用户目录时只在那里）。
 */
export function candidateExecutables(env: BrowserProbeEnv): string[] {
  const list = [
    join(env.programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  if (env.localAppData !== '') {
    list.push(join(env.localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    list.push(join(env.localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return list
}

/** 探测入参：存在性判断与环境根都可注入，自检不需要真装浏览器。 */
export interface ProbeOptions {
  exists?: (path: string) => boolean
  env?: BrowserProbeEnv
}

/**
 * 找浏览器可执行文件。
 *
 * @param config - 用户配置（`executablePath` 非空时优先用它，但仍然要存在）。
 * @param options - 注入点，见 {@link ProbeOptions}。
 * @returns 绝对路径；一个都没有返回 null（调用方负责报一句能照做的错）。
 */
export function probeExecutable(config: BrowserLaunchConfig, options: ProbeOptions = {}): string | null {
  const exists = options.exists ?? existsSync
  const configured = config.executablePath.trim()
  if (configured !== '') {
    const full = resolve(configured)
    return exists(full) ? full : null
  }
  for (const candidate of candidateExecutables(options.env ?? probeEnv())) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * 拼启动参数串。
 *
 * 为什么 `about:blank` 放最后：它是位置参数，前面全是开关。
 * 为什么不经 shell：参数里可能带空格与中文（用户目录名），走 shell 会拼接引号踩坑；
 * `spawn(exe, args)` 每个参数原样进 argv，Chrome 的 `--switch=value` 解析器认得值里的空格。
 *
 * @param config - 启动配置。
 * @param profileDir - 已经定下来的 profile 目录（自建临时目录或用户配置的那个）。
 */
export function buildLaunchArgs(config: BrowserLaunchConfig, profileDir: string): string[] {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    ...(config.headless ? ['--headless=new'] : []),
    'about:blank',
  ]
}

/**
 * 解析 profile 目录里的 `DevToolsActivePort` 文件。
 *
 * 文件两行：第一行是端口，第二行是 `/devtools/browser/<uuid>` 路径。
 * 第二行可能缺（老版本、被截断），所以单独容忍。
 *
 * @returns 端口非法就返回 null。
 */
export function parseDevToolsActivePort(text: string): { port: number; browserPath: string } | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const port = Number(lines[0] ?? '')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const browserPath = lines[1] ?? ''
  return { port, browserPath: browserPath.startsWith('/') ? browserPath : '' }
}

/** 端点发现的入参。 */
export interface EndpointOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  /** 探到端点后的自检注入点：返回 true 表示「这个端点可以用」。 */
  probe?: (endpoint: string) => boolean
}

const LAUNCH_TIMEOUT_MS = 30_000
const ENDPOINT_INTERVAL_MS = 100

/**
 * 等端点出现。
 *
 * 主路：轮询读 `DevToolsActivePort`。
 * 退路：文件只给了端口没给路径时，问一句 `http://127.0.0.1:<port>/json/version`
 * 拿 `webSocketDebuggerUrl`——注意这条**不能**替代主路：`--remote-debugging-port=0` 下
 * 端口号只有那个文件知道，没有文件就没有端口可问。
 */
export async function waitForEndpoint(profileDir: string, options: EndpointOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? LAUNCH_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? ENDPOINT_INTERVAL_MS
  const started = Date.now()
  const portFile = join(profileDir, 'DevToolsActivePort')
  let lastProblem = 'DevToolsActivePort 还没出现'
  for (;;) {
    options.signal?.throwIfAborted()
    if (existsSync(portFile)) {
      let parsed: { port: number; browserPath: string } | null = null
      try {
        parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      } catch (error) {
        lastProblem = `读 DevToolsActivePort 失败：${error instanceof Error ? error.message : String(error)}`
      }
      if (parsed !== null) {
        if (parsed.browserPath !== '') {
          const endpoint = `ws://127.0.0.1:${parsed.port}${parsed.browserPath}`
          if (options.probe === undefined || options.probe(endpoint)) return endpoint
          lastProblem = '端点存在但连不上'
        } else {
          try {
            const endpoint = await fetchBrowserWebSocket(parsed.port, 2000, options.signal)
            if (options.probe === undefined || options.probe(endpoint)) return endpoint
            lastProblem = '端点存在但连不上'
          } catch (error) {
            lastProblem = `端口 ${parsed.port} 上没有可用的调试端点：${error instanceof Error ? error.message : String(error)}`
          }
        }
      } else {
        lastProblem = 'DevToolsActivePort 内容还不是合法端口'
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`等浏览器调试端点超时（${timeoutMs}ms）：${lastProblem}。路径：${profileDir}`)
    }
    await delay(intervalMs, options.signal)
  }
}

/** 问一次 `/json/version` 拿浏览器级 WebSocket 地址（仅在端点文件缺路径时用）。 */
export async function fetchBrowserWebSocket(port: number, timeoutMs = 3000, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const doc = (await response.json()) as { webSocketDebuggerUrl?: unknown }
  if (typeof doc.webSocketDebuggerUrl !== 'string' || doc.webSocketDebuggerUrl === '') {
    throw new Error('/json/version 里没有 webSocketDebuggerUrl')
  }
  return doc.webSocketDebuggerUrl
}

/** 一次成功启动的结果。 */
export interface LaunchedBrowser {
  /** 用的可执行文件。 */
  exe: string
  /** 主进程 pid（整树杀要用它）。 */
  pid: number
  /** profile 目录。 */
  profileDir: string
  /** true = 这个目录是我们建的，收尾时要删；false = 用户配置的目录，只杀进程不动文件。 */
  ownedProfile: boolean
  /** 浏览器级 CDP 端点。 */
  endpoint: string
  /** 主进程还活着吗（重连之前先问它：进程死了重连多少次都是白费）。 */
  isAlive(): boolean
}

/**
 * 起一个受控浏览器并等它的调试端点就绪。
 *
 * `stdio: 'ignore'`：Chrome 的 stderr 在 Windows 上是 GBK，读进来也是乱码，
 * 端点又从 `DevToolsActivePort` 读，所以干脆别接管道（顺带避免管道写满卡死）。
 * 起不来（进程提前退出/超时）时自己把残留杀掉、把自建 profile 删掉再抛错。
 */
export async function launchBrowser(
  config: BrowserLaunchConfig,
  signal: AbortSignal,
  options: ProbeOptions & EndpointOptions = {},
): Promise<LaunchedBrowser> {
  signal.throwIfAborted()
  const exe = probeExecutable(config, options)
  if (exe === null) {
    const configured = config.executablePath.trim()
    throw new Error(
      configured === ''
        ? '没找到 Chrome 或 Edge。请在设置「浏览器自动化」里把 executablePath 填成浏览器可执行文件的绝对路径'
        : `配置的浏览器路径不存在：${configured}（请在设置「浏览器自动化」里改掉）`,
    )
  }
  const ownedProfile = config.profileDir.trim() === ''
  const profileDir = ownedProfile ? mkdtempSync(join(tmpdir(), 'dsc-browser-')) : resolve(config.profileDir.trim())
  if (!ownedProfile) mkdirSync(profileDir, { recursive: true })
  const args = buildLaunchArgs(config, profileDir)
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  const pid = proc.pid ?? 0
  let spawnError: Error | null = null
  let exited = false
  proc.on('error', (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error))
  })
  proc.on('exit', () => {
    exited = true
  })
  // 进程提前退出（或 spawn 直接失败）就别再干等端口了，否则要白等 30 秒
  let failLaunch: ((error: Error) => void) | null = null
  const failed = new Promise<string>((_resolve, reject) => {
    failLaunch = reject
  })
  const watchdog = setInterval(() => {
    if (spawnError !== null) failLaunch?.(new Error(`浏览器进程起不来：${spawnError.message}`))
    else if (exited) {
      failLaunch?.(new Error('浏览器进程启动后立刻退出了（可执行文件可能被安全软件拦下，或 profile 目录不可写）'))
    }
  }, 100)
  watchdog.unref?.()
  try {
    const endpoint = await Promise.race([
      waitForEndpoint(profileDir, {
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        probe: options.probe,
        signal,
      }),
      failed,
    ])
    return { exe, pid, profileDir, ownedProfile, endpoint, isAlive: () => !exited && proc.exitCode === null }
  } catch (error) {
    if (pid !== 0) killProcessTree(pid)
    sleepSync(300)
    if (ownedProfile) removeProfileDirSync(profileDir)
    throw error
  } finally {
    clearInterval(watchdog)
  }
}

/**
 * 连接断了之后该做什么。抽成纯函数是为了在没有浏览器的情况下也能自检这条判断：
 * 进程还活着才谈得上「重连」；进程已经死了，重连只是对着一个死端点白等超时。
 */
export function reconnectDecision(state: {
  processAlive: boolean
  canReconnect: boolean
  canRestart: boolean
}): 'reconnect' | 'restart' | 'fail' {
  if (state.processAlive && state.canReconnect) return 'reconnect'
  if (state.canRestart) return 'restart'
  return 'fail'
}

/** 一条重连/重开的额度账。抽出来是为了在没有浏览器的情况下也能自检。 */
export class ReconnectBudget {
  private usedReconnects = 0
  private usedRestarts = 0

  constructor(
    /** 同一个进程最多重连几次（缺省 5）。 */
    private readonly maxReconnects = 5,
    /** 进程死了最多重开几次（缺省 2；`close` 之后重开不算在内）。 */
    private readonly maxRestarts = 2,
  ) {}

  get reconnects(): number {
    return this.usedReconnects
  }

  get restarts(): number {
    return this.usedRestarts
  }

  canReconnect(): boolean {
    return this.usedReconnects < this.maxReconnects
  }

  canRestart(): boolean {
    return this.usedRestarts < this.maxRestarts
  }

  noteReconnect(): void {
    this.usedReconnects += 1
  }

  /** 重开之后重连额度重新算（新进程是新的开始）。 */
  noteRestart(): void {
    this.usedRestarts += 1
    this.usedReconnects = 0
  }

  /** 用户主动收工：下一次是干净的开始，不背之前的重试账。 */
  reset(): void {
    this.usedReconnects = 0
    this.usedRestarts = 0
  }
}

/** 一个受控浏览器进程的持有者：懒启动、崩溃重连/重开、整树清理。 */
export class BrowserProcess {
  private launched: LaunchedBrowser | null = null
  private transport: CdpTransport | null = null
  private readonly budget = new ReconnectBudget()
  private readonly connectOptions: CdpTransportOptions
  private closed = false

  /**
   * @param readConfig - 每次启动现读配置（设置改了就生效，不必重启插件）。
   * @param connectOptions - 传输层注入点（自检用假 socket）。
   */
  constructor(
    private readonly readConfig: () => BrowserLaunchConfig,
    connectOptions: CdpTransportOptions = {},
  ) {
    this.connectOptions = { label: '浏览器级 CDP', ...connectOptions }
  }

  /** 进程还活着吗（退出码为 null 才算活着）。 */
  get alive(): boolean {
    return this.launched !== null && !this.closed && this.launched.isAlive()
  }

  /** 当前 profile 目录（没启动过就是 null）。 */
  get profileDir(): string | null {
    return this.launched?.profileDir ?? null
  }

  /** 当前用的可执行文件（没启动过就是 null）。 */
  get executable(): string | null {
    return this.launched?.exe ?? null
  }

  /** 主进程 pid（没启动过就是 null）。 */
  get pid(): number | null {
    return this.launched?.pid ?? null
  }

  /**
   * 拿一条可用的浏览器级连接。
   *
   * 三种情况：
   *   - 连接还在 → 直接用；
   *   - 连接断了但进程还活着（CDP 会话被浏览器自己关掉）→ 重连，最多 5 次；
   *   - 进程死了 → 清理残留后重开，最多 2 次（额度用完就让人来 `close` 一次，别无限重开）。
   */
  async browserTransport(signal?: AbortSignal): Promise<CdpTransport> {
    if (this.closed) throw new Error('受控浏览器已被关掉；下一次调用工具会自动重开')
    if (this.transport !== null && !this.transport.closed) return this.transport
    const decision = reconnectDecision({
      processAlive: this.launched !== null && this.launched.isAlive(),
      canReconnect: this.budget.canReconnect(),
      canRestart: this.budget.canRestart(),
    })
    // 1) 进程还在：CDP 会话被浏览器自己关掉了，重连即可（最多 5 次）
    if (decision === 'reconnect' && this.launched !== null) {
      this.budget.noteReconnect()
      try {
        this.transport = await connectWithRetry(this.launched.endpoint, this.connectOptions, signal)
        return this.transport
      } catch (error) {
        throw new Error(
          `CDP 连接断了，第 ${this.budget.reconnects} 次重连也没成功（${error instanceof Error ? error.message : String(error)}）。` +
            '可以再试一次；连着几次都不行就 browser action=close 收掉这台浏览器，下次调用会重开一台',
        )
      }
    }
    if (decision === 'fail') {
      throw new Error(
        `受控浏览器反复退出或连不上（重连 ${this.budget.reconnects} 次、重开 ${this.budget.restarts} 次都没稳住）。` +
          '先 browser action=close 收掉它，再检查是不是有别的程序在杀浏览器进程',
      )
    }
    // 2) 进程死了（或重连额度用完）：重开一台。
    //    额度在「启动之前」就扣，起不来也算一次——否则启动失败会变成无限重开。
    this.budget.noteRestart()
    if (this.launched !== null) this.killSync() // 清掉可能残留的整棵进程树，再重开
    const signalOrNever = signal ?? new AbortController().signal
    try {
      this.launched = await launchBrowser(this.readConfig(), signalOrNever)
    } catch (error) {
      throw new Error(`启动受控浏览器失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.transport = await connectWithRetry(this.launched.endpoint, this.connectOptions, signal)
    return this.transport
  }

  /**
   * 收掉这台浏览器：整树杀 → 等 300ms → 删自建 profile。
   * 同步实现是刻意的：`apply` 返回的 disposer 与 `dsc/exit` 监听器都必须同步跑完，
   * 异步清理在这里会被宿主直接跳过。
   */
  killSync(): void {
    const current = this.launched
    this.transport?.close()
    this.transport = null
    this.launched = null
    if (current === null) return
    if (current.pid !== 0) killProcessTree(current.pid)
    // 等句柄释放再删目录：Chrome 退出后要几十到几百毫秒才放开 profile 里的文件
    sleepSync(300)
    if (current.ownedProfile) removeProfileDirSync(current.profileDir)
  }

  /** 永久收工（插件卸载/宿主退出）：killSync 之外再记一笔「别再自动重开」。 */
  shutdown(): void {
    this.closed = true
    this.killSync()
  }

  /**
   * 用户主动关掉（`browser action=close` 与设置里的「关闭浏览器」）：
   * 资源照样清干净，但重试额度重置——下次调用工具是一次干净的新开始，
   * 不能因为用户关过两次浏览器就说「反复退出」。
   */
  close(): void {
    this.killSync()
    this.budget.reset()
  }
}

/** 建连重试：浏览器刚起来时监听可能还差一拍。 */
async function connectWithRetry(endpoint: string, options: CdpTransportOptions, signal?: AbortSignal): Promise<CdpTransport> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await CdpTransport.open(endpoint, options, signal)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await delay(200, signal)
    }
  }
  throw lastError ?? new Error('CDP 建连失败')
}

/**
 * 整树杀进程。
 *
 * Windows 没有进程组，`child.kill()` 只带走主进程，renderer/gpu/utility 会变成孤儿
 * 继续攥着 profile；`taskkill /T` 沿着父子关系整棵带走，`/F` 是必须的（Chrome
 * 对 SIGTERM 类软信号经常不理）。
 * 非 Windows 退回 `process.kill`（这条代码路径主要面向 Windows，留着是为了不炸）。
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // taskkill 不在 PATH 或进程已经没了：忽略，反正后面还会删目录
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已经没了
  }
}

/** 递归删 profile 目录（删不掉就留着，别把退出流程搞崩）。 */
export function removeProfileDirSync(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // 有句柄没放开时会失败；下一次启动用新目录，不影响功能
  }
}

/** 同步睡一会儿（disposer 里不能 await）。 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 可取消的延时。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new Error('操作已取消'))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer)
        rejectPromise(new Error('操作已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
