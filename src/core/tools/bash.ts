/**
 * bash 工具：在会话目录里执行 shell 命令。win32 走 PowerShell（缺省
 * powershell.exe），POSIX 走 sh；stdout/stderr 合并返回，超时与长度封顶。
 *
 * 工具自己这一层做三件事（审批层做的是「要不要问」，不是这三件）：
 *   1. 硬地板：策略引擎判成 deny 的命令在任何权限模式下都不执行；
 *   2. 子进程环境脱敏：dsc 自己的 API key 与各种 *_TOKEN 不传进去；
 *   3. 输出遮红：命令输出里密钥形状的字符串换成占位。
 *
 * @module dsc/core/tools/bash
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ToolEntry } from '../tools.js'
import { classifyCommand } from '../command-policy.js'
import { redact, scrubChildEnv } from '../secrets.js'
import { wrapUntrusted } from '../untrusted.js'
import { finishCommand, planCommand, type SpawnPlan } from './command-runner.js'
import { sandboxPermissionProperties } from './sandbox-args.js'

const isWin = process.platform === 'win32'

/** bash 工具的可调预算：全都是部署差异的选择，经 tools-default 插件配置下发。 */
export interface BashBudgets {
  /** 不带 timeoutMs 参数时的超时（毫秒）。 */
  timeoutMs: number
  /** timeoutMs 的硬上限（毫秒）——比这更长的活该去后台跑，不该占着一轮。 */
  maxTimeoutMs: number
  /** 输出封顶字符数（超出截断，spill 插件会在更长之前先接手落盘）。 */
  outputChars: number
}

/** 缺省预算（配置没给值时用）。 */
export const BASH_DEFAULT_BUDGETS: BashBudgets = {
  timeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  outputChars: 8_000,
}

/** 会从网上拉内容的命令：输出是外部数据，进对话前必须过围栏（网页里的「指令」不是给你的）。 */
export const NETWORK_FETCH_RE = /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)(\.exe)?\b/i

/**
 * 收掉一整棵进程树（2026-09-29）：`child.kill` 只杀直系子进程——
 * Windows 上 powershell.exe 被杀后里面跑的构建工具会变孤儿继续跑；
 * POSIX 上 `sh -c` 收到 SIGKILL 也不会转发给孙进程。
 * Windows 用 taskkill /T；POSIX 用 detached 进程组负数 pid 全组杀。
 * T15 后台作业的 job_kill 复用这一份。
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** 优雅终止后的宽限期（T36）：到点还没自己退，才上强杀。 */
const KILL_GRACE_MS = 3_000
/** 强杀之后还没等到 close 的最后兜底（T36）：再等不到就把已收输出直接交回。 */
const FORCE_FAILSAFE_MS = 2_000

/**
 * 第一档终止（T36）：礼貌地请进程退——构建工具能跑完清理逻辑、缓存能落盘。
 * POSIX 对 detached 的进程组发 SIGTERM（负数 pid 整组收到）。Windows 没有不依赖
 * 外部进程的优雅通道（taskkill 不带 /F 那条路被安全门的命令选项注入检查拦着，
 * 不为它新开 spawn），所以 Windows 这一档直接走 {@link killTree} 强杀——糙一点，
 * 但一定杀得掉，已收输出也照样交回。
 */
function terminateTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    killTree(child)
    return
  }
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/**
 * T15：后台作业进程的登记表与整树收尾。收尾只拿字符串键进来——
 * 进程对象不过作业表的手，整树机制（taskkill /T /F 或组强杀）留在本文件。
 */
const backgroundChildren = new Map<string, ChildProcess>()

/** T15/T20：登记一个常驻进程（后台作业经 trackKey 走 spawnShell 内的同一张表）。 */
export function trackBackgroundChild(key: string, child: ChildProcess): void {
  backgroundChildren.set(key, child)
}

/** T20：摘掉登记（进程自然退出或已收尾时调，防表里留死键）。 */
export function untrackBackgroundChild(key: string): void {
  backgroundChildren.delete(key)
}

/** T20：查一个登记过的进程（终端会话往输入口写字要用它）；键不存在返回 undefined。 */
export function trackedBackgroundChild(key: string): ChildProcess | undefined {
  return backgroundChildren.get(key)
}

/** 收掉登记过的后台作业进程（整树）；键不存在返回 false。 */
export function stopBackgroundChild(key: string): boolean {
  const child = backgroundChildren.get(key)
  if (child === undefined) return false
  backgroundChildren.delete(key)
  killTree(child)
  return true
}

/** T15：内核收摊时收掉全部还在跑的后台作业（tools-default 的卸载钩子调）。 */
export function stopAllBackgroundChildren(): void {
  for (const child of backgroundChildren.values()) killTree(child)
  backgroundChildren.clear()
}

/** spawnShell 的可选旁路（T15 后台作业用；bash 主路径不传，行为不变）。 */
export interface ShellRunOptions {
  /** 逐块原始输出回调（作业表的增量缓冲用；遮红仍在读取侧做）。 */
  onChunk?(chunk: string): void
  /** 进程退出回调（作业表据法定状态；拒绝路径走 Promise.reject）。 */
  onExit?(code: number | null): void
  /** spawn 失败回调（shell 起不来这类；正常退出不算）。 */
  onError?(message: string): void
  /** 登记键：给了键，这个进程就进后台作业登记表（{@link stopBackgroundChild} 能收它）。 */
  trackKey?: string
}

/**
 * 真正 spawn 并收输出。执行计划可能被沙箱的执行器缝改写
 * （容器后端会把 shell 换成 `docker run`），所以这里不认死 `powershell.exe`。
 *
 * T15：后台作业复用这一份——不挂 meaningful 超时（给一天的描述值）、
 * 不接取消信号，靠 onChunk 收增量、onExit 收退出码、trackKey 进登记表。
 */
export function spawnShell(
  plan: SpawnPlan,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
  options?: ShellRunOptions,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // 执行计划带了自定义 spawn（受限令牌这类 node spawn 表达不了的）就走它；
    // 默认路径与加这条缝之前完全一致。
    const child = plan.spawn
      ? plan.spawn()
      : spawn(plan.file, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          // stdin 直接关掉：等输入的命令立即失败退出，好过挂到超时才死；
          // POSIX 上 detached 让子命令自成进程组，超时能整组收掉。
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        })
    if (options?.trackKey !== undefined) backgroundChildren.set(options.trackKey, child)
    const untrack = (): void => {
      if (options?.trackKey !== undefined) backgroundChildren.delete(options.trackKey)
    }
    let output = ''
    const append = (chunk: Buffer | string): void => {
      const text = String(chunk)
      if (output.length < outputLimit * 2) output += text
      options?.onChunk?.(text)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    // T36：超时/取消不再把输出丢掉——先礼貌终止（POSIX SIGTERM，宽限 3 秒，到点强杀），
    // 等进程真正退出后把已收到的输出连同终止说明一起交回。编译错误印在前 20 秒、
    // 31 秒超时的场景，模型现在拿得到那 20 秒里说过的每句话。
    let done = false
    let reason: string | null = null
    let grace: NodeJS.Timeout | undefined
    let failsafe: NodeJS.Timeout | undefined
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      if (failsafe !== undefined) clearTimeout(failsafe)
      signal.removeEventListener('abort', onAbort)
      untrack()
      options?.onExit?.(code)
      const truncated = output.length > outputLimit ? `${output.slice(0, outputLimit)}…（已截断）` : output
      const body = truncated.trim()
      const lines: string[] = []
      if (reason !== null) lines.push(reason)
      if (code !== 0 && reason === null) lines.push(`退出码 ${String(code)}`)
      lines.push(body === '' ? (reason === null ? '（无输出）' : '（进程被终止，没有收到输出）') : body)
      resolvePromise(redact(lines.join('\n')))
    }
    const arm = (why: string): void => {
      reason = why
      terminateTree(child)
      // 宽限到点还没退就强杀；强杀后再等不到 close（极端：句柄被别的进程攥着）
      // 就把已收输出直接交回，不让整轮挂在僵尸进程上。
      grace = setTimeout(() => {
        killTree(child)
        failsafe = setTimeout(() => finish(null), FORCE_FAILSAFE_MS)
        failsafe.unref()
      }, KILL_GRACE_MS)
      grace.unref()
    }

    const timer = setTimeout(() => arm(`命令超时（${String(timeoutMs)}ms），已终止进程`), timeoutMs)

    const onAbort = (): void => {
      clearTimeout(timer)
      arm('命令被用户取消')
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      if (failsafe !== undefined) clearTimeout(failsafe)
      signal.removeEventListener('abort', onAbort)
      untrack()
      rejectPromise(error)
    })
    child.on('close', finish)
  })
}

/**
 * 执行一条命令：先问执行器缝拿最终执行计划，再 spawn，最后让改写过的那几位收尾。
 * 没有沙箱插件注册执行器时，计划就是上面的默认那份，行为与以前完全一致。
 * T15：`background` 旁路给后台作业用——同一套计划缝与环境脱敏，回调收增量与退出。
 */
async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
  background?: ShellRunOptions,
): Promise<string> {
  const { env } = scrubChildEnv(process.env)
  const base: SpawnPlan = isWin
    ? {
        file: 'powershell.exe',
        // T15 探针抓出来的老毛病：PowerShell -Command 不透传原生命令的退出码
        //（powershell.exe 自己只回 0/1）。命令末尾补一句显式 exit，把最后一条
        // 原生命令的退出码带出来；纯 cmdlet 命令没有 $LASTEXITCODE，行为不变。
        // 用换行而不是分号追加：command 以注释结尾时语句不会被注释吞掉。
        args: ['-NoProfile', '-Command', `${command}\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`],
        env,
        cwd,
      }
    : { file: 'sh', args: ['-c', command], env, cwd }
  const run = { command, cwd, timeoutMs, signal }
  const { plan, changed } = await planCommand(run, base)
  try {
    return await spawnShell(plan, timeoutMs, outputLimit, signal, background)
  } finally {
    await finishCommand(run, plan, changed)
  }
}

/**
 * T15：后台跑一条命令。与 {@link runShell} 同一套执行计划缝、环境脱敏与登记表，
 * 不占回合、不挂有效超时；增量输出与退出码经回调交回作业表，spawn 失败经 onError。
 */
export function runShellBackground(
  command: string,
  cwd: string,
  outputLimit: number,
  background: ShellRunOptions & { trackKey: string },
): void {
  void runShell(command, cwd, 86_400_000, outputLimit, new AbortController().signal, background).catch(
    (error: unknown) => {
      background.onError?.(error instanceof Error ? error.message : String(error))
    },
  )
}

/**
 * T20：起一个长命交互 shell（终端会话的进程原语）。shell 与参数都是固定字面量，
 * 不拼任何外部输入；环境与前台命令同一份脱敏。没有 tty（管道模式）——全屏程序
 * 跑不了，这是终端降级版的已知边界。进程原语不出本文件。
 */
export function spawnTerminalShell(cwd: string): ChildProcess {
  const { env } = scrubChildEnv(process.env)
  const options: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  }
  if (cwd !== '') options.cwd = cwd
  if (isWin) {
    return spawn('powershell.exe', ['-NoProfile', '-Command', '-'], options)
  }
  options.detached = true
  return spawn('bash', ['--noprofile', '--norc'], options)
}

/**
 * 造一个 bash 工具。预算由 tools-default 插件从配置取值传入（缺省 {@link BASH_DEFAULT_BUDGETS}），
 * 参数说明里的数值随预算走——模型看到的承诺与实际执行的一致。
 * T15：给了 `background` 旁路，bash 就带 `run_in_background` 参数——立即返回 job id，
 * 输出与终止走 job_output / job_list / job_kill。
 */
export function createBashTool(
  budgets: BashBudgets = BASH_DEFAULT_BUDGETS,
  background?: { launch(command: string, cwd: string): string },
): ToolEntry {
  return {
    name: 'bash',
    description: isWin
      ? '执行 PowerShell 命令（工作目录 = 会话目录）。只留给「非 shell 不可」的事：构建、安装、git、跑测试、查进程。' +
        '不要用 cat/head/tail 读文件（用 read），不要用 grep/rg/Get-ChildItem -Recurse 找代码（用 grep/glob），' +
        '不要用 echo 重定向或 heredoc 造文件（用 write），不要用 sed/awk 改文件（用 edit）。' +
        '一条命令里有 | ; && 时会被切成几段分别判定，任何一段危险整条就要问用户；带重定向或变量赋值的段不给走已授权规则。' +
        '耗时命令设 timeoutMs；构建/测试/起服务这类更长的活传 run_in_background 转后台，立即返回 job id。'
      : '执行 shell 命令（工作目录 = 会话目录）。只留给构建、安装、git、跑测试这类必须用 shell 的事；' +
        '读文件用 read，找代码用 grep/glob，改文件用 edit/write。' +
        '一条命令里有 | ; && 时会被切成几段分别判定，任何一段危险整条就要问用户。耗时命令设 timeoutMs；' +
        '更长的活传 run_in_background 转后台，立即返回 job id。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeoutMs: {
          type: 'number',
          description: `超时毫秒数（默认 ${budgets.timeoutMs}，上限 ${budgets.maxTimeoutMs}）`,
        },
        ...(background !== undefined
          ? {
              run_in_background: {
                type: 'boolean',
                description: 'true = 转入后台：立即返回 job id 不占回合，输出用 job_output 读，完成时自动通知',
              },
            }
          : {}),
        ...sandboxPermissionProperties,
      },
      required: ['command'],
    },
    risk: 'exec',
    async run(args, ctx) {
      if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command 必须是非空字符串')
      // 硬地板在工具自己这一层再过一遍：审批层被绕开（无头队友、脚本调用）也执行不了灾难命令。
      const verdict = classifyCommand(args.command)
      if (verdict.decision === 'deny') throw new Error(`命令被安全策略拒绝执行：${verdict.reason}`)
      // T15：后台旁路——同一道命令、同一套审批与硬地板，只是不占住回合。
      // 命令不带超时（那是后台的意义所在），取消信号也不接（打断回合不打断构建）。
      if (args.run_in_background === true) {
        if (background === undefined) throw new Error('后台作业表不可用（内置工具插件没带 background 旁路）')
        const id = await background.launch(args.command, ctx.cwd)
        return `已转入后台：${id}\n输出用 job_output(job_id="${id}") 读（增量），job_list 清点，完成时会自动收到通知。`
      }
      const requested = typeof args.timeoutMs === 'number' ? Math.floor(args.timeoutMs) : budgets.timeoutMs
      const timeoutMs = Math.min(Math.max(requested, 1000), budgets.maxTimeoutMs)
      const output = await runShell(args.command, ctx.cwd, timeoutMs, budgets.outputChars, ctx.signal)
      // 下载类命令的输出是外部内容：包裹围栏再进对话（先遮红后包裹，遮红在 spawnShell 里已完成）。
      if (NETWORK_FETCH_RE.test(args.command)) return wrapUntrusted('bash', output)
      return output
    },
  }
}

// ── T15：后台作业表与三件工具 ─────────────────────────────────────────────────
//
// 与 bash 工具同住一个文件的原因：作业的启动（runShellBackground）与收尾
// （stopBackgroundChild）和前台命令共用同一批进程原语，安全审计的进程边界
// 就在本文件收口——新文件里任何「命令 → shell」的通路都过不了候选扫描。

/** 单个作业的输出缓冲上限（字符）：超出从头部丢，日志类输出尾巴才是有用的那截。 */
export const JOB_OUTPUT_CAP = 100_000
/** job_output 不带 offset 时默认看的尾部窗口（字符）。 */
export const JOB_VIEW_CHARS = 4_000
/** 作业数上限：后台不是漏水的桶，超了就拒绝新作业。 */
export const JOB_MAX_COUNT = 50

export type JobStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface JobRecord {
  id: string
  command: string
  cwd: string
  status: JobStatus
  exitCode: number | null
  startedAt: number
  finishedAt?: number
  /** 缓冲里现在的输出（遮红在读口做，这里存原文）。 */
  output: string
  /** 因超限从头部丢掉的字符数：绝对偏移 = dropped + 本地下标。 */
  dropped: number
  /** 上次 job_output 读到的绝对位置（增量读用）。 */
  lastRead: number
  /** 命令会从网上拉内容（输出按不可信内容围栏）。 */
  networkFetch: boolean
}

/** 作业表可选项。 */
export interface JobTableOptions {
  /**
   * 完成通知。tools-default 接的是 agent.followup（排队提交一条消息叫模型回来）；
   * 自检脚本接的是自己的收集器。
   */
  notify(text: string): void
}

/** job_output 的单次读取结果。 */
export interface JobOutputView {
  id: string
  status: JobStatus
  exitCode: number | null
  /** 这次给到的文本（已遮红 + 按需围栏）。 */
  text: string
  /** 输出绝对总长（含已丢弃头部）。 */
  totalChars: number
  /** 这次给到的文本的绝对起点。 */
  from: number
  /** 头部被环形缓冲丢掉的字符数。 */
  droppedChars: number
  /** true = 已经读到现存输出的末尾。 */
  atEnd: boolean
}

/**
 * 后台作业表。一次 launch = 把命令交给 {@link runShellBackground}（与前台 bash
 * 同一条计划缝、同一份环境脱敏、同一张登记表）→ onChunk 收进缓冲 →
 * onExit/onError 定状态并通知。
 */
export class JobTable {
  private readonly jobs = new Map<string, JobRecord>()
  private counter = 0

  constructor(private readonly options: JobTableOptions) {}

  /** 当前作业数（含已结束的：读输出的依据都在表里）。 */
  get size(): number {
    return this.jobs.size
  }

  /** 仍在跑的作业 id（job_kill / 收摊清点用）。 */
  runningIds(): string[] {
    const ids: string[] = []
    for (const job of this.jobs.values()) if (job.status === 'running') ids.push(job.id)
    return ids
  }

  /**
   * 启动一个后台作业，立即返回 job id（不等进程结束）。
   * 命令分类与审批在 bash 工具入口已完成，这里不再判一遍（同一道命令，不同的等法）。
   */
  launch(command: string, cwd: string): string {
    if (this.jobs.size >= JOB_MAX_COUNT) {
      throw new Error(`后台作业已到 ${String(JOB_MAX_COUNT)} 个上限，先用 job_kill 收掉几个，或 job_list 清点`)
    }
    this.counter += 1
    const id = `job-${String(this.counter)}`
    const job: JobRecord = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      output: '',
      dropped: 0,
      lastRead: 0,
      networkFetch: NETWORK_FETCH_RE.test(command),
    }
    this.jobs.set(id, job)
    const append = (chunk: string): void => {
      if (job.status !== 'running') return
      job.output += chunk
      if (job.output.length > JOB_OUTPUT_CAP) {
        const drop = job.output.length - JOB_OUTPUT_CAP
        job.output = job.output.slice(drop)
        job.dropped += drop
      }
    }
    // 后台没有超时（那是后台的意义所在），也不接取消信号——打断回合不打断构建
    runShellBackground(command, cwd, JOB_OUTPUT_CAP, {
      trackKey: id,
      onChunk: append,
      onExit: (code) => {
        if (job.status !== 'running') return
        job.exitCode = code
        job.finishedAt = Date.now()
        job.status = code === 0 ? 'completed' : 'failed'
        this.options.notify(
          `后台作业 ${id}（${command.slice(0, 60)}${command.length > 60 ? '…' : ''}）${
            code === 0 ? '成功完成' : `失败（退出码 ${String(code)}）`
          }。用 job_output(job_id="${id}") 查看输出，job_list 清点全部作业。`,
        )
      },
      onError: (message) => {
        if (job.status !== 'running') return
        job.status = 'failed'
        job.finishedAt = Date.now()
        job.output += `\n[启动失败：${message}]`
        this.options.notify(`后台作业 ${id} 启动失败：${message}`)
      },
    })
    return id
  }

  /** 读一个作业的输出：offset 省略时从上次读到的位置续读（首次且输出短就从头给）。 */
  output(jobId: string, offset?: number): JobOutputView {
    const job = this.require(jobId)
    const total = job.dropped + job.output.length
    let from: number
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
      from = Math.floor(offset)
    } else if (job.lastRead > 0 || total <= JOB_VIEW_CHARS) {
      from = job.lastRead
    } else {
      from = total - JOB_VIEW_CHARS
    }
    if (from < job.dropped) from = job.dropped
    if (from > total) from = total
    const local = from - job.dropped
    const slice = job.output.slice(local, local + JOB_VIEW_CHARS)
    job.lastRead = Math.max(job.lastRead, from + slice.length)
    const atEnd = from + slice.length >= total
    let text = slice
    if (!atEnd) text = `${text}\n…（后面还有 ${String(total - from - slice.length)} 字符，用 offset=${String(job.lastRead)} 续读）`
    text = redact(text)
    if (job.networkFetch && text.trim() !== '') text = wrapUntrusted('job-output', text)
    return {
      id: job.id,
      status: job.status,
      exitCode: job.exitCode,
      text,
      totalChars: total,
      from,
      droppedChars: job.dropped,
      atEnd,
    }
  }

  /** 全部作业的清单（job_list 的数据源）。 */
  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  /** 把作业记为被终止（纯簿记；进程收尾由调用方调 {@link stopBackgroundChild}）。 */
  markKilled(jobId: string): JobRecord | undefined {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.status !== 'running') return job
    job.status = 'killed'
    job.finishedAt = Date.now()
    return job
  }

  private require(jobId: string): JobRecord {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      const known = [...this.jobs.keys()].slice(-5).join(', ')
      throw new Error(`没有这个后台作业：${jobId}${known === '' ? '（还没有任何作业）' : `（最近的作业：${known}）`}`)
    }
    return job
  }
}

/**
 * job_output / job_list / job_kill 三件工具（T15）。kill 的进程收尾走
 * {@link stopBackgroundChild}（登记表整树收尾），簿记走 {@link JobTable.markKilled}。
 */
export function createJobTools(table: JobTable): ToolEntry[] {
  return [
    {
      name: 'job_output',
      description:
        '读一个后台作业的输出（增量续读）。不带 offset 从上次读到的位置继续；'
        + '作业结束（完成/失败/被终止）后会附带退出码。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'job_list 里的作业 id，例如 job-1' },
          offset: { type: 'number', description: '从输出的第几个字符开始读（续读用回包里的提示值）' },
        },
        required: ['job_id'],
      },
      risk: 'read',
      async run(args) {
        const jobId = typeof args.job_id === 'string' ? args.job_id : ''
        if (jobId === '') throw new Error('job_id 必须是非空字符串')
        const view = table.output(jobId, typeof args.offset === 'number' ? args.offset : undefined)
        const status =
          view.status === 'running'
            ? '运行中'
            : view.status === 'completed'
              ? '已完成'
              : view.status === 'killed'
                ? '被终止'
                : `失败（退出码 ${String(view.exitCode ?? '?')}）`
        const body = view.text.trim() === '' ? '（还没有输出）' : view.text
        return `[${view.id}] ${status}\n\n${body}`
      },
    },
    {
      name: 'job_list',
      description: '清点全部后台作业：id、状态、已运行时长、命令。',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      async run() {
        const jobs = table.list()
        if (jobs.length === 0) return '（没有后台作业。启动：bash 带 run_in_background=true）'
        return jobs
          .map((job) => {
            const seconds = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)
            const state =
              job.status === 'running'
                ? '运行中'
                : job.status === 'completed'
                  ? '已完成'
                  : job.status === 'killed'
                    ? '被终止'
                    : `失败（退出码 ${String(job.exitCode ?? '?')}）`
            return `${job.id}  [${state}]  ${String(seconds)}s  ${job.command.slice(0, 80)}`
          })
          .join('\n')
      },
    },
    {
      name: 'job_kill',
      description: '终止一个还在跑的后台作业（整树收尾，已收输出保留，还能用 job_output 读）。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'job_list 里的作业 id，例如 job-1' },
        },
        required: ['job_id'],
      },
      risk: 'exec',
      async run(args) {
        const jobId = typeof args.job_id === 'string' ? args.job_id : ''
        if (jobId === '') throw new Error('job_id 必须是非空字符串')
        const job = table.get(jobId)
        if (job === undefined) throw new Error(`没有这个后台作业：${jobId}（job_list 先清点）`)
        if (job.status !== 'running') return `${jobId} 已经是 ${job.status}，不用再收`
        table.markKilled(jobId)
        const stopped = stopBackgroundChild(jobId)
        return stopped
          ? `${jobId} 正在终止（整树收尾，已收输出保留，可用 job_output 读到）`
          : `${jobId} 的进程已经不在了，作业记为被终止`
      },
    },
  ]
}

// ── T20：持久终端会话（降级版：管道会话 + 读写分离） ─────────────────────────
//
// 与作业表同住本文件的原因与 T15 一致：终端会话也是「模型可控输入 → shell 进程」
// 的通路，进程原语（{@link spawnTerminalShell} / 登记表 / 整树收尾）不出 bash.ts，
// 安全审计的进程边界在本文件收口。没有 PTY——全屏程序（vim / htop）跑不了，
// 这是降级版的已知边界；也没有中途打断（dsh 的 signal 动作）——管道模式下
// Windows 收不到 Ctrl+C，长命令要么等完要么 close 收掉整个会话重开。

/** 单个终端会话的输出缓冲上限（字符）：与后台作业同一量级。 */
export const TERM_OUTPUT_CAP = 100_000
/** terminal read 不带 offset 时默认看的尾部窗口（字符）。 */
export const TERM_VIEW_CHARS = 4_000
/** 会话数上限：终端页签不是无限开的，超了先收旧的。 */
export const TERM_MAX_COUNT = 8

export type TerminalStatus = 'running' | 'closed'

export interface TerminalRecord {
  id: string
  cwd: string
  status: TerminalStatus
  exitCode: number | null
  startedAt: number
  finishedAt?: number
  /** 缓冲里现在的输出（遮红在读口做，这里存原文）。 */
  output: string
  /** 因超限从头部丢掉的字符数：绝对偏移 = dropped + 本地下标。 */
  dropped: number
  /** 上次 read 读到的绝对位置（增量读用）。 */
  lastRead: number
}

/** terminal read 的单次读取结果（形状与 JobOutputView 同族）。 */
export interface TerminalOutputView {
  id: string
  status: TerminalStatus
  exitCode: number | null
  /** 这次给到的文本（已遮红）。 */
  text: string
  /** 输出绝对总长（含已丢弃头部）。 */
  totalChars: number
  /** 这次给到的文本的绝对起点。 */
  from: number
  /** 头部被环形缓冲丢掉的字符数。 */
  droppedChars: number
  /** true = 已经读到现存输出的末尾。 */
  atEnd: boolean
}

/**
 * 终端会话表。open 起一个长命交互 shell（stdin 打开、无超时），send 往里写、
 * read 增量读、close 走 {@link stopBackgroundChild} 整树收尾——进程登记与
 * 收尾原语完全复用 T15 那一套，本表只管簿记。
 *
 * 会话不接受模型指定的起始目录（工作目录进会话后 send 一句 cd 就行）——
 * 起 shell 的输入面越窄越好。
 */
export class TerminalTable {
  private readonly sessions = new Map<string, TerminalRecord>()
  private counter = 0

  get size(): number {
    return this.sessions.size
  }

  /** 开一个新会话，立即返回会话 id。shell 就地起（它不是一条命令，不经过 planCommand 缝）。 */
  open(): string {
    if (this.sessions.size >= TERM_MAX_COUNT) {
      throw new Error(`终端会话已到 ${String(TERM_MAX_COUNT)} 个上限，先用 terminal close 收掉几个，或 list 清点`)
    }
    this.counter += 1
    const id = `term-${String(this.counter)}`
    const record: TerminalRecord = {
      id,
      cwd: '',
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      output: '',
      dropped: 0,
      lastRead: 0,
    }
    this.sessions.set(id, record)
    // 不给模型指定起进程参数的面：会话从宿主进程的目录起，进会话后想在哪工作自己 cd
    const child = spawnTerminalShell('')
    trackBackgroundChild(id, child)
    const append = (chunk: Buffer | string): void => {
      if (record.status !== 'running') return
      record.output += String(chunk)
      if (record.output.length > TERM_OUTPUT_CAP) {
        const drop = record.output.length - TERM_OUTPUT_CAP
        record.output = record.output.slice(drop)
        record.dropped += drop
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error: Error) => {
      record.status = 'closed'
      record.finishedAt = Date.now()
      record.output += `\n[启动失败：${error.message}]`
      untrackBackgroundChild(id)
    })
    child.on('close', (code: number | null) => {
      if (record.status !== 'running') return
      record.status = 'closed'
      record.exitCode = code
      record.finishedAt = Date.now()
      untrackBackgroundChild(id)
    })
    return id
  }

  /** 读会话输出：offset 省略时从上次读到的位置续读（语义与 job_output 一致）。 */
  read(sessionId: string, offset?: number): TerminalOutputView {
    const record = this.require(sessionId)
    const total = record.dropped + record.output.length
    let from: number
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
      from = Math.floor(offset)
    } else if (record.lastRead > 0 || total <= TERM_VIEW_CHARS) {
      from = record.lastRead
    } else {
      from = total - TERM_VIEW_CHARS
    }
    if (from < record.dropped) from = record.dropped
    if (from > total) from = total
    const local = from - record.dropped
    const slice = record.output.slice(local, local + TERM_VIEW_CHARS)
    record.lastRead = Math.max(record.lastRead, from + slice.length)
    const atEnd = from + slice.length >= total
    let text = slice
    if (!atEnd) text = `${text}\n…（后面还有 ${String(total - from - slice.length)} 字符，用 offset=${String(record.lastRead)} 续读）`
    text = redact(text)
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exitCode,
      text,
      totalChars: total,
      from,
      droppedChars: record.dropped,
      atEnd,
    }
  }

  /**
   * 往会话 stdin 写一段文本；要执行的命令自己带换行。
   * 这里就是终端工具的本体语义：模型输入 → 长命 shell 的输入口（与 bash 工具的
   * 「命令 → spawn」同一本质，只是执行环境常驻）。写入前不判内容——判与放行
   * 都在工具层的守卫链上做，本表只管把字节送进管道。
   */
  send(sessionId: string, data: string): void {
    const record = this.require(sessionId)
    if (record.status !== 'running') {
      throw new Error(`终端会话 ${sessionId} 已经结束（exitCode ${String(record.exitCode)}），开个新的再发`)
    }
    const session = trackedBackgroundChild(sessionId)
    const stdin = session?.stdin ?? null
    if (stdin === null || stdin.destroyed) {
      throw new Error(`终端会话 ${sessionId} 的输入口已经关了`)
    }
    stdin.write(data)
  }

  /** 收掉一个会话（整树）；簿记走 close 状态。返回给模型看的一句话。 */
  close(sessionId: string): string {
    const record = this.require(sessionId)
    if (record.status !== 'running') return `终端会话 ${sessionId} 本来就已经结束`
    stopBackgroundChild(sessionId)
    record.status = 'closed'
    record.finishedAt = Date.now()
    return `终端会话 ${sessionId} 已收掉`
  }

  /** 全部会话的清单。 */
  list(): TerminalRecord[] {
    return [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  private require(sessionId: string): TerminalRecord {
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      const known = [...this.sessions.keys()].slice(-5).join(', ')
      throw new Error(`没有这个终端会话：${sessionId}${known === '' ? '（还没有任何会话）' : `（现有的会话：${known}）`}`)
    }
    return record
  }
}

/**
 * terminal 单件工具（T20）：open / read / send / close / list 五个动作。
 * 没挂 PTY（降级版）：全屏程序跑不了；也没有中途打断——长命令等完或 close 重开。
 */
export function createTerminalTool(table: TerminalTable): ToolEntry {
  return {
    name: 'terminal',
    description: isWin
      ? '开一个持久的交互 PowerShell 会话（没有 tty：vim/htop 这类全屏程序跑不了）。' +
        '适合「先激活环境、再连续跑几条命令」的场景——环境在会话里留着，一次不用重设。' +
        'open 开会话，send 写命令（自带换行才执行），read 读输出（增量），close 收掉，list 清点。' +
        '没有中途打断：跑歪了的命令等它结束，或 close 收掉会话重开。'
      : '开一个持久的交互 bash 会话（没有 tty：vim/htop 这类全屏程序跑不了）。' +
        '适合「先激活环境、再连续跑几条命令」的场景。open 开会话，send 写命令（自带换行才执行），' +
        'read 读输出（增量），close 收掉，list 清点。没有中途打断：跑歪了的命令等它结束，或 close 收掉会话重开。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'read', 'send', 'close', 'list'], description: '要做什么' },
        session_id: { type: 'string', description: '会话 id，例如 term-1；read/send/close 必填' },
        data: { type: 'string', description: 'send 必填：写进会话的文本；要执行的命令自带换行' },
        offset: { type: 'number', description: 'read 可选：从输出的第几个字符开始读（续读用回包里的提示值）' },
      },
      required: ['action'],
    },
    risk: 'exec',
    async run(args) {
      const action = String(args.action ?? '')
      switch (action) {
        case 'open': {
          const id = table.open()
          return `已开终端会话 ${id}。用 send(data="…\n") 发命令（自带换行才执行），read 读输出（启动需要一两秒，读空了稍等再读）。`
        }
        case 'read': {
          const view = table.read(String(args.session_id ?? ''), typeof args.offset === 'number' ? args.offset : undefined)
          const head = view.status === 'closed' ? `（会话已结束，exitCode ${String(view.exitCode)}）` : ''
          return `会话 ${view.id}${head}：\n${view.text}${view.atEnd ? '' : `\n（offset=${String(view.from + view.text.length)} 续读）`}`
        }
        case 'send': {
          const data = args.data
          if (typeof data !== 'string' || data === '') throw new Error('send 要带上 data（写进会话的文本，要执行的命令自带换行）')
          table.send(String(args.session_id ?? ''), data)
          return `已写进 ${String(args.session_id)}。用 read 读输出。`
        }
        case 'close':
          return table.close(String(args.session_id ?? ''))
        case 'list': {
          const sessions = table.list()
          if (sessions.length === 0) return '（还没有任何终端会话）'
          return sessions
            .map(
              (session) =>
                `- ${session.id}（${session.status}${session.status === 'closed' ? `，exitCode ${String(session.exitCode)}` : ''}）`,
            )
            .join('\n')
        }
        default:
          throw new Error(`不认识的 action「${action}」。要用的值：open / read / send / close / list`)
      }
    },
  }
}
