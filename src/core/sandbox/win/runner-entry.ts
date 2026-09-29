/**
 * 沙箱 runner 子进程入口：dsc 宿主 spawn 这个脚本（普通权限），由它在**本进程内**
 * 构造受限令牌并 `CreateProcessAsUserW` 真正的命令。
 *
 * 为什么隔一层 runner（三个理由都有实测依据）：
 *   1. `lpEnvironment` 经 koffi 传显式环境块必报 ERROR_INVALID_PARAMETER——子进程环境
 *      只能靠继承；TMP/TEMP 重定向要在「不污染宿主环境」的前提下生效，只能由一个
 *      短命进程改自己再 spawn（runner 干的就是这个）；
 *   2. runner 忽略 CTRL+C（SetConsoleCtrlHandler），保证被中断时能把子进程的收尾做完、
 *      把退出码原样镜像回去；
 *   3. 作业对象句柄随 runner 死亡而关闭（KILL_ON_JOB_CLOSE）：宿主 taskkill 杀 runner
 *      就等于整棵受限子树被内核收掉，不留孤儿。
 *
 * argv 契约（宿主负责拼，runner 负责逐项验）：
 *   node runner-entry.js --mode <read-only|workspace-write> --temp <dir>
 *     [--root <sid>=<dir> …] -- <argv…>
 *
 * 失败语义：runner 自身的问题打一行 `dsc-sandbox-run: …` 到 stderr 并退出 127；
 * 受限命令的退出码按**全宽 uint32** 原样镜像（NTSTATUS 不做有符号重映射）。
 *
 * 几处踩过坑的硬约束（都别改）：
 *   - 绝不用 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE：受限令牌下 DLL 初始化会死
 *     0xC0000142，只能 STARTF_USESHOWWINDOW + SW_HIDE；
 *   - 先排水后 WaitForSingleObject：管道缓冲填满时先 wait 会双方死锁；
 *   - AssignProcessToJobObject 必须在 ResumeThread **之前**：不受作业保护的受限进程
 *     一秒都不许跑。
 *
 * @module dsc/core/sandbox/win/runner-entry
 */
import {
  CREATE_SUSPENDED,
  INFINITE,
  JOBOBJ_LIMIT_FLAGS_OFFSET,
  JOBOBJECT_EXTENDED_LIMIT_SIZE,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JobObjectExtendedLimitInformation,
  PI_OFFSETS,
  PROCESS_INFORMATION_SIZE,
  SI_OFFSETS,
  STARTF_USESHOWWINDOW,
  STARTF_USESTDHANDLES,
  STARTUPINFOW_SIZE,
  SW_HIDE,
  WAIT_OBJECT_0,
} from './abi.js'
import {
  type BoundWin32,
  type WinFfi,
  bindAll,
  byteArea,
  isBrokenPipe,
  loadFfi,
  slotUint32,
  slotUintPtr,
  throwLastError,
  throwWin32,
} from './ffi.js'
import { buildRestrictedToken, type RestrictedToken } from './token.js'
import { verifySidForPath } from './workspace-sid.js'

/** runner 自身失败签名（宿主诊断认这一行）。 */
export const RUNNER_SIGNATURE = 'dsc-sandbox-run: '
/** runner 自身失败的退出码。 */
export const RUNNER_EXIT_CODE = 127

/** 管道排水每次最多读的字节数（64KB，够填一页还不够撑爆内存）。 */
const DRAIN_CHUNK = 65536

/** SetHandleInformation 的「可继承」标志位。 */
const HANDLE_FLAG_INHERIT = 1

/** 解析后的 runner 入参。 */
export interface RunnerArgs {
  mode: 'read-only' | 'workspace-write'
  /** 沙箱私有临时目录（runner 会把它设成自己的 TMP/TEMP）。 */
  tempDir: string
  /** 授权过的可写根：SID ↔ 路径成对（temp 自己也在里面）。 */
  roots: ReadonlyArray<{ sid: string; path: string }>
  /** `--` 之后的受限命令 argv。 */
  childArgv: readonly string[]
}

/** 严格解析并校验 argv：任何不认识、缺项、对不上号的输入都算 runner 失败，绝不猜。 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  let mode: RunnerArgs['mode'] | undefined
  let tempDir: string | undefined
  const roots: Array<{ sid: string; path: string }> = []

  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('argv 缺少 `--` 分隔符（后面必须跟受限命令）')
  const flags = argv.slice(0, separator)
  const childArgv = argv.slice(separator + 1)
  if (childArgv.length === 0) throw new Error('`--` 之后没有受限命令')
  if (childArgv[0] === undefined || childArgv[0] === '') throw new Error('`--` 之后的第一个参数必须是非空可执行文件名')

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--mode') {
      const value = flags[++index]
      if (value !== 'read-only' && value !== 'workspace-write') {
        throw new Error(`--mode 只认 read-only / workspace-write，收到「${String(value)}」`)
      }
      mode = value
      continue
    }
    if (flag === '--temp') {
      const value = flags[++index]
      if (value === undefined || value === '') throw new Error('--temp 需要一个非空目录')
      // 同一个 flag 给两次是调用方 bug：静默取后者等于悄悄换了 TMP/TEMP 落点
      if (tempDir !== undefined) throw new Error('--temp 给重复了')
      tempDir = value
      continue
    }
    if (flag === '--root') {
      const pair = flags[++index]
      if (pair === undefined) throw new Error('--root 需要 <sid>=<dir>')
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error(`--root 的值要写成 <sid>=<dir>，收到「${pair}」`)
      const sid = pair.slice(0, eq)
      const path = pair.slice(eq + 1)
      if (path === '') throw new Error(`--root 的目录是空的：「${pair}」`)
      roots.push({ sid, path })
      continue
    }
    throw new Error(`不认识的 runner 参数：「${flag}」`)
  }
  if (mode === undefined) throw new Error('缺少 --mode')
  if (tempDir === undefined) throw new Error('缺少 --temp')
  if (mode === 'workspace-write' && roots.length === 0) {
    throw new Error('workspace-write 模式至少要有一个 --root（可写根）')
  }

  // SID ↔ 路径逐对复算：调用方把 SID 拼错就等于凭空多一个可写根（受限令牌的
  // restricting 列表按 SID 写死），必须在这里拦死
  for (const root of roots) {
    const kind = samePath(root.path, tempDir) ? 'temp' : 'root'
    if (!verifySidForPath(root.sid, root.path, kind)) {
      throw new Error(`--root 的 SID 与路径对不上（${root.path} 该派生 ${kind} 形状的 SID，实际收到 ${root.sid}）`)
    }
  }

  // temp 与每条可写根的双向不相交：可继承 ACE 会把能力串出去，这是真实的逃逸面
  for (const root of roots) {
    if (samePath(root.path, tempDir)) continue
    if (strictlyInside(tempDir, root.path) || strictlyInside(root.path, tempDir)) {
      throw new Error(`临时目录与可写根相交（${tempDir} ⊂⊃ ${root.path}）：可继承授权会串能力，拒绝这组参数`)
    }
  }

  // 重复的可写根：同一目录授权两次无害，但说明调用方拼重了，直接报出来
  const seen = new Set<string>()
  for (const root of roots) {
    const key = root.path.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) throw new Error(`--root 给重复了：「${root.path}」`)
    seen.add(key)
  }
  return { mode, tempDir, roots, childArgv }
}

/** 路径等价判定：大小写不敏感、末尾分隔符不算数（Windows 口径）。 */
function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

/** 大小写不敏感的「真包含」：child 在 parent 里且不是 parent 本身（按分隔符边界判）。 */
export function strictlyInside(child: string, parent: string): boolean {
  const outer = parent.replace(/[\\/]+$/, '').toLowerCase()
  const inner = child.replace(/[\\/]+$/, '').toLowerCase()
  if (outer === inner) return false
  return inner.startsWith(`${outer}\\`) || inner.startsWith(`${outer}/`)
}

/**
 * Windows argv 引号化（CommandLineToArgvW 规则）：
 * 空串或含空白/引号才加引号；引号前的反斜杠翻倍再加一个转义反斜杠；
 * 结尾的连续反斜杠翻倍（它们在收尾引号前面）。
 */
export function quoteArgv(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const character of arg) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

/** 任意字符串 → NUL 结尾的 UTF-16 缓冲（Win32 的 str16 入参口径）。 */
function utf16Buffer(text: string): Buffer {
  const buffer = Buffer.alloc(text.length * 2 + 2)
  buffer.write(text, 0, 'utf16le')
  return buffer
}

/** 手工打包 STARTUPINFOW（104 字节，偏移见 abi.SI_OFFSETS）。 */
function packStartupInfo(stdinRead: number, stdoutWrite: number, stderrWrite: number): Buffer {
  const info = Buffer.alloc(STARTUPINFOW_SIZE)
  info.writeUInt32LE(STARTUPINFOW_SIZE, SI_OFFSETS.cb)
  info.writeUInt32LE(STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SI_OFFSETS.dwFlags)
  info.writeUInt16LE(SW_HIDE, SI_OFFSETS.wShowWindow)
  info.writeBigUInt64LE(BigInt(stdinRead), SI_OFFSETS.hStdInput)
  info.writeBigUInt64LE(BigInt(stdoutWrite), SI_OFFSETS.hStdOutput)
  info.writeBigUInt64LE(BigInt(stderrWrite), SI_OFFSETS.hStdError)
  return info
}

/** 手工打包 JOBOBJECT_EXTENDED_LIMIT_INFORMATION（144 字节，只设 KILL_ON_JOB_CLOSE）。 */
function packJobLimits(): Buffer {
  const limits = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE)
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJ_LIMIT_FLAGS_OFFSET)
  return limits
}

/**
 * 读管道直到对端关闭（PeekNamedPipe 非阻塞探测 + 有数据才 ReadFile）。
 *
 * 为什么不用阻塞 ReadFile：stdout 与 stderr 要同时排，先排 A 会等 B 写满缓冲；
 * PeekNamedPipe 轮询 + 2ms 让步的写法在 dsh 上实证过，不烧 CPU 也不丢数据。
 */
async function drainPipe(bound: BoundWin32, handle: number, sink: NodeJS.WriteStream): Promise<void> {
  const available = slotUint32(bound)
  const area = byteArea(bound, DRAIN_CHUNK)
  for (;;) {
    if (Number(bound.peekNamedPipe(handle, null, 0, null, available.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'PeekNamedPipe', code)
    }
    const count = available.get()
    if (count === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      continue
    }
    const read = slotUint32(bound)
    if (Number(bound.readFile(handle, area.ptr, Math.min(count, DRAIN_CHUNK), read.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'ReadFile', code)
    }
    const got = read.get()
    if (got === 0) return
    sink.write(Buffer.from(area.bytes().subarray(0, got)))
  }
}

/** 入口：参数 → 环境 → 令牌 → 管道 → 挂起 spawn → 作业 → 放行 → 排水 → 等待 → 镜像退出码。 */
async function main(): Promise<number> {
  const args = parseRunnerArgs(process.argv.slice(2))
  const ffi = loadFfi()
  const bound = bindAll(ffi)

  // runner 忽略 CTRL+C：收尾（镜像退出码、让作业句柄自然关闭）必须做完
  if (Number(bound.setConsoleCtrlHandler(null, 1)) === 0) throwLastError(bound, 'SetConsoleCtrlHandler')

  // TMP/TEMP 重定向到自己进程环境。lpEnvironment 必须传 NULL（koffi 传显式环境块
  // 必报 ERROR_INVALID_PARAMETER），子进程继承的就是改过的这一份
  if (Number(bound.setEnvironmentVariableW(utf16Buffer('TMP'), utf16Buffer(args.tempDir))) === 0) {
    throwLastError(bound, 'SetEnvironmentVariableW(TMP)')
  }
  if (Number(bound.setEnvironmentVariableW(utf16Buffer('TEMP'), utf16Buffer(args.tempDir))) === 0) {
    throwLastError(bound, 'SetEnvironmentVariableW(TEMP)')
  }

  // 令牌：restricting 列表 = [logon, Everyone, …可写根 SID]（temp 的 SID 也在 roots 里）
  const token: RestrictedToken = buildRestrictedToken(bound, {
    mode: args.mode,
    rootSids: args.roots.map((root) => root.sid),
  })

  // 三对匿名管道；只给子进程端打继承位（父端要立刻关掉，否则排水永远等不到 EOF）
  const stdinRead = slotUintPtr(bound)
  const stdinWrite = slotUintPtr(bound)
  const stdoutRead = slotUintPtr(bound)
  const stdoutWrite = slotUintPtr(bound)
  const stderrRead = slotUintPtr(bound)
  const stderrWrite = slotUintPtr(bound)
  for (const pair of [[stdinRead, stdinWrite], [stdoutRead, stdoutWrite], [stderrRead, stderrWrite]] as const) {
    if (Number(bound.createPipe(pair[0].slot, pair[1].slot, null, 0)) === 0) throwLastError(bound, 'CreatePipe')
  }
  for (const childEnd of [stdinRead.get(), stdoutWrite.get(), stderrWrite.get()]) {
    if (Number(bound.setHandleInformation(childEnd, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) === 0) {
      throwLastError(bound, 'SetHandleInformation')
    }
  }

  // 命令行按 CommandLineToArgvW 规则引号化：lpApplicationName 传 NULL，第一个 token 就是程序名
  const commandLine = Buffer.from(`${args.childArgv.map((arg) => quoteArgv(arg)).join(' ')}\0`, 'utf16le')
  const startup = packStartupInfo(stdinRead.get(), stdoutWrite.get(), stderrWrite.get())
  // Buffer 出参直接给 koffi 取地址；它必须活到调用返回（这里是局部变量，满足）
  const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE)

  const created = Number(bound.createProcessAsUserW(
    token.handle,
    null, // lpApplicationName：NULL → 从命令行第一个 token 解析
    commandLine,
    null, // lpProcessAttributes
    null, // lpThreadAttributes
    1, // bInheritHandles：三个子进程端要传下去
    CREATE_SUSPENDED, // 先挂起：塞进作业前不许跑
    null, // lpEnvironment：NULL（koffi 传显式块必失败），靠继承 runner 的环境
    null, // lpCurrentDirectory：NULL = 用 runner 的 cwd（宿主设成的会话目录）
    startup,
    processInfo,
  ))
  if (created === 0) throwLastError(bound, 'CreateProcessAsUserW')
  const hProcess = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hProcess))
  const hThread = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hThread))

  // 作业：KILL_ON_JOB_CLOSE —— runner 死（含被 taskkill）= 整棵子树被内核收掉
  //
  // 从 CreateProcessAsUserW 成功到子进程真正入作业之间，它一直处于**挂起**态；
  // 这段窗口里任何一步失败，都必须当场把它杀掉：一个不受作业保护的受限进程
  // 一秒都不许活着（否则 runner 退出后会留下一个永远挂起的孤儿）。
  let job = 0
  try {
    job = Number(bound.createJobObjectW(null, null))
    if (job === 0) throwLastError(bound, 'CreateJobObjectW')
    if (Number(bound.setInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      packJobLimits(),
      JOBOBJECT_EXTENDED_LIMIT_SIZE,
    )) === 0) {
      throwLastError(bound, 'SetInformationJobObject')
    }
    if (Number(bound.assignProcessToJobObject(job, hProcess)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      throwWin32(bound, 'AssignProcessToJobObject', code)
    }
  } catch (error) {
    bound.terminateProcess(hProcess, 1)
    if (job !== 0) {
      try {
        bound.closeHandle(job)
      } catch {
        /* 收尾失败不遮真实错误 */
      }
    }
    throw error
  }
  const resumed = Number(bound.resumeThread(hThread)) >>> 0
  if (resumed === 0xffffffff) {
    const code = Number(bound.getLastLastError()) >>> 0
    bound.terminateProcess(hProcess, 1)
    throwWin32(bound, 'ResumeThread', code)
  }

  // 父端立刻关掉三个写端/读端（继承副本已在子进程手里）
  for (const parentEnd of [stdinWrite.get(), stdoutWrite.get(), stderrWrite.get()]) {
    if (Number(bound.closeHandle(parentEnd)) === 0) throwLastError(bound, 'CloseHandle(父端管道)')
  }

  // 先排水后等待：不排的话管道缓冲满会双方死锁
  await Promise.all([
    drainPipe(bound, stdoutRead.get(), process.stdout),
    drainPipe(bound, stderrRead.get(), process.stderr),
  ])

  if (Number(bound.waitForSingleObject(hProcess, INFINITE)) !== WAIT_OBJECT_0) {
    throwLastError(bound, 'WaitForSingleObject')
  }
  const exitCode = slotUint32(bound)
  if (Number(bound.getExitCodeProcess(hProcess, exitCode.slot)) === 0) throwLastError(bound, 'GetExitCodeProcess')

  // 收尾顺序：先线程/进程/令牌，**作业最后关**。子进程已退出，关作业不会再杀人；
  // 而 runner 被外部 taskkill 时作业句柄随进程关闭 → 内核按 KILL_ON_JOB_CLOSE
  // 收掉整棵子树，这就是杀树语义
  bound.closeHandle(hThread)
  bound.closeHandle(hProcess)
  token.dispose()
  bound.closeHandle(job)
  return exitCode.get() >>> 0
}

main().then((code) => {
  process.exitCode = code
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${RUNNER_SIGNATURE}${message}\n`)
  process.exitCode = RUNNER_EXIT_CODE
})
