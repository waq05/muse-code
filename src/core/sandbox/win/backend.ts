/**
 * Windows 受限令牌后端的探测与执行器：把 bash 工具的执行体换成
 * `node runner-entry.js … -- <原命令>`，由 runner 用受限令牌真正 spawn 子进程。
 *
 * 为什么换执行体而不是在守卫链上拦：守卫链只拦得住 dsc 自己发起的工具调用，
 * 拦不住命令内部的任意写（`node build.js` 里那行 fs.writeFile）。文件系统的
 * 强制这一层只有换执行体才拿得到：ACL 上的能力 SID 授权 + 受限令牌的
 * WRITE_RESTRICTED pass-2 交集检查，写根之外一律写不进去。
 *
 * 这一层**只管文件系统的写**，三处已知缺口如实写进 `describe()`，绝不假装管住了：
 *   1. 硬链接别名：在写根内建一个指向根外文件的硬链接，写它等于写根外（NTFS 硬链接
 *      不受路径判定约束）；
 *   2. 读不受限：WRITE_RESTRICTED 的 pass-2 只对写生效，读、网络、进程可见性
 *      与普通用户一样；
 *   3. 网络：真管控要「专用账号 + WFP + 白名单代理」那套提权 setup，本层只在
 *      网络开关关时叠一层代理环境变量软墙（codex env.rs 同款），拦不住铁了心的进程。
 *
 * 降级语义（刻意的，不是妥协）：ACL 授权任何一步失败 → 后端当场作废自己
 * （`plan()` 此后返回 null），命令回到策略围栏那条路，并把错误全文报给用户。
 * 半吊子的强制比明说「没强制」危险。
 *
 * @module dsc/core/sandbox/win/backend
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSC_HOME } from '../../path-policy.js'
import type { CommandRunner, SpawnPlan } from '../../tools/command-runner.js'
import { grantWrite, revokeWrite, type GrantOutcome } from './acl.js'
import { type BoundWin32, bindAll, tryLoadFfi } from './ffi.js'
import { rootWriteSid, tempWriteSid } from './workspace-sid.js'

/** 执行器 id（宿主诊断与 `enforcement` 上报用这个键）。 */
export const WINDOWS_TOKEN_RUNNER_ID = 'sandbox-windows-token'

/** runner 自身失败的 stderr 签名：宿主靠它把「runner 挂了」与「命令失败了」分开。 */
export const RUNNER_FAILURE_SIGNATURE = 'dsc-sandbox-run: '

/** 询问顺序：与容器后端同档（策略围栏先问，它之后才轮到换执行体）。 */
const RUNNER_ORDER = 20

/** 授权锁文件目录：同目录并发授权要串行化，锁文件落在 dsc 家目录下。 */
const LOCK_DIR = join(DSC_HOME, 'sandbox', 'locks')

/** 网络开关关闭时叠的代理软墙（照 codex `env.rs` 的取值）。 */
const OFFLINE_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  PIP_NO_INDEX: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  NPM_CONFIG_OFFLINE: 'true',
  CARGO_NET_OFFLINE: 'true',
  GIT_SSH_COMMAND: 'cmd /c exit 1',
}

/** runner 入口脚本的构建产物（backend 编译后在 lib/ 里与 runner-entry.js 同目录）。 */
function runnerEntryPath(): string {
  return fileURLToPath(new URL('./runner-entry.js', import.meta.url))
}

/**
 * 探一次受限令牌后端可用性：Windows + koffi 装得上 + runner 构建产物在。
 * 不实际建令牌（探测要快且无副作用），真正的失败在 runner 里响亮报出来。
 */
export function probeWindowsToken(): { available: boolean; detail: string } {
  if (process.platform !== 'win32') return { available: false, detail: '非 Windows 平台' }
  const loaded = tryLoadFfi()
  if (!loaded.ok) return { available: false, detail: `Win32 FFI 底座不可用：${loaded.why}` }
  const entry = runnerEntryPath()
  if (!existsSync(entry)) {
    return { available: false, detail: `runner 入口没有构建产物：找不到 ${entry}（先跑 pnpm run build）` }
  }
  return { available: true, detail: '受限令牌后端可用（koffi FFI + runner 子进程）' }
}

/** 执行器构造入参（路径都要求是 realpath 规范化后的绝对路径）。 */
export interface WindowsTokenRunnerOptions {
  mode: 'read-only' | 'workspace-write'
  /** 会话工作目录（常驻可写根）。 */
  cwd: string
  /** 沙箱私有临时目录（会话结束回收授权）。 */
  tmpDir: string
  /** 附加可写根。 */
  extraRoots?: readonly string[]
  /** 网络开关（每次都现取，改设置立即生效）。 */
  networkAccess: () => boolean
  /** 降级与回收失败的一句话，交给插件报给用户。 */
  onDetail?: (message: string) => void
}

/** 执行器句柄：runner 本体 + 收尾 + 一句话说明。 */
export interface WindowsTokenRunnerHandle {
  runner: CommandRunner
  /** 进程收尾：尽力回收临时目录的能力 ACE（工作区/附加根是常驻授权，不回收）。 */
  dispose(): void
  /** 给用户看的一句话：强制了什么、哪些不管。 */
  describe(): string
}

/** 一条目录 ↔ 能力 SID 的配对。 */
interface AuthorizedRoot {
  path: string
  sid: string
}

/** 把错误转成一行可读文本（授权失败的「错误全文」要原样报给用户）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 建一个受限令牌执行器。
 *
 * 授权是**惰性**的：第一次 `plan()` 才给目录打 ACL（大树首次传播要几十秒，
 * 挂载时不做）。按路径缓存结果，同一目录只授权一次；任一目录失败就整体降级。
 */
export function createWindowsTokenRunner(options: WindowsTokenRunnerOptions): WindowsTokenRunnerHandle {
  // 目录清单：工作目录、私有临时目录、附加可写根（工作区与附加根用 rootWriteSid，
  // temp 用 tempWriteSid，两种派生前缀不同，永不撞号）
  const roots: AuthorizedRoot[] = []
  const push = (path: string, sid: string): void => {
    const key = path.replace(/[\\/]+$/, '').toLowerCase()
    if (roots.some((root) => root.path.replace(/[\\/]+$/, '').toLowerCase() === key)) return
    roots.push({ path, sid })
  }
  if (options.mode === 'workspace-write') {
    push(options.cwd, rootWriteSid(options.cwd))
    push(options.tmpDir, tempWriteSid(options.tmpDir))
    for (const extra of options.extraRoots ?? []) {
      if (extra.trim() !== '') push(extra, rootWriteSid(extra))
    }
  }
  // read-only 刻意不做任何 ACL 授权：该档令牌不含能力 SID，写本来就全拒；
  // 授权只会「永久改用户工作区的 ACL + 强制标签」，是纯副作用零收益，违背最小惊扰

  const entry = runnerEntryPath()
  const grants = new Map<string, GrantOutcome>()
  let bound: BoundWin32 | null = null
  let authorized = false
  let degraded = false

  /** 惰性物化授权：true = 可以换执行体，false = 已降级（此后 plan 一律返回 null）。 */
  const ensureAuthorized = (): boolean => {
    if (degraded) return false
    if (authorized) return true
    if (roots.length === 0) {
      // read-only：没有可授权目录，连 FFI 都不必加载（dispose 靠 bound===null 短路）
      authorized = true
      return true
    }
    try {
      const loaded = tryLoadFfi()
      if (!loaded.ok) throw new Error(`Win32 FFI 底座不可用：${loaded.why}`)
      const boundNow = bindAll(loaded.ffi)
      bound = boundNow
      mkdirSync(LOCK_DIR, { recursive: true })
      for (const root of roots) {
        if (grants.has(root.path)) continue
        try {
          grants.set(root.path, grantWrite(boundNow, root.path, root.sid, LOCK_DIR))
        } catch (error) {
          throw new Error(`给可写根「${root.path}」（能力 SID ${root.sid}）打 ACL 失败：${describeError(error)}`)
        }
      }
      authorized = true
      return true
    } catch (error) {
      degraded = true
      options.onDetail?.(`受限令牌后端已降级为策略围栏（不再换执行体）：${describeError(error)}`)
      return false
    }
  }

  const runner: CommandRunner = {
    id: WINDOWS_TOKEN_RUNNER_ID,
    order: RUNNER_ORDER,
    plan(run, current): SpawnPlan | null {
      if (!ensureAuthorized()) return null
      // 已经是本后端换过的计划（别人套第二次）：不套两层
      if (current.file === process.execPath && current.args[0] === entry) return null

      // 网络关时叠一级软墙：不改调用方给的 env 对象，改复制品
      const env = options.networkAccess() ? current.env : { ...current.env, ...OFFLINE_ENV }
      const args = [
        entry,
        '--mode', options.mode,
        '--temp', options.tmpDir,
        ...roots.flatMap((root) => ['--root', `${root.sid}=${root.path}`]),
        '--',
        current.file,
        ...current.args,
      ]
      // 普通 node 子进程：不需要自定义 spawn，file/args/env/cwd 表达得下
      return { ...current, file: process.execPath, args, env, cwd: run.cwd }
    },
  }

  return {
    runner,
    dispose(): void {
      // 临时目录是会话级授权：回收能力 ACE。工作区与附加根是常驻授权，不回收。
      // 这里是尽力而为——回收失败只记一句，绝不影响会话结果（残留的假 SID ACE 惰性无害，
      // 没有任何真实账号持有它）
      if (bound === null) return
      try {
        revokeWrite(bound, options.tmpDir, tempWriteSid(options.tmpDir), LOCK_DIR)
      } catch (error) {
        options.onDetail?.(`回收临时目录授权失败（不影响本次结果）：${describeError(error)}`)
      }
    },
    describe(): string {
      if (roots.length === 0) {
        return '文件系统写：read-only 档，令牌不含能力 SID，任何目录都写不了；未对工作区做任何 ACL 改动；读与进程可见性不受限'
      }
      const list = roots.map((root) => root.path).join('、')
      return `文件系统写：只允许写 ${list}（ACL 能力 SID + WRITE_RESTRICTED 交集检查，` +
        `命令在受限令牌的 runner 子进程里跑）；已知缺口：硬链接别名可指到写根外仍能写、` +
        `读与进程可见性一概不受限、网络真管控要第二级提权 setup（本层只叠代理环境变量软墙）`
    },
  }
}
