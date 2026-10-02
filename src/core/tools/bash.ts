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
import { spawn, type ChildProcess } from 'node:child_process'
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
const NETWORK_FETCH_RE = /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)(\.exe)?\b/i

/**
 * 收掉一整棵进程树（2026-09-29）：`child.kill` 只杀直系子进程——
 * Windows 上 powershell.exe 被杀后里面跑的构建工具会变孤儿继续跑；
 * POSIX 上 `sh -c` 收到 SIGKILL 也不会转发给孙进程。
 * Windows 用 taskkill /T；POSIX 用 detached 进程组负数 pid 全组杀。
 */
function killTree(child: ChildProcess): void {
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
 * 真正 spawn 并收输出。执行计划可能被沙箱的执行器缝改写
 * （容器后端会把 shell 换成 `docker run`），所以这里不认死 `powershell.exe`。
 */
function spawnShell(plan: SpawnPlan, timeoutMs: number, outputLimit: number, signal: AbortSignal): Promise<string> {
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
    let output = ''
    const append = (chunk: Buffer | string): void => {
      if (output.length < outputLimit * 2) output += String(chunk)
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
      rejectPromise(error)
    })
    child.on('close', finish)
  })
}

/**
 * 执行一条命令：先问执行器缝拿最终执行计划，再 spawn，最后让改写过的那几位收尾。
 * 没有沙箱插件注册执行器时，计划就是上面的默认那份，行为与以前完全一致。
 */
async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
): Promise<string> {
  const { env } = scrubChildEnv(process.env)
  const base: SpawnPlan = isWin
    ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', command], env, cwd }
    : { file: 'sh', args: ['-c', command], env, cwd }
  const run = { command, cwd, timeoutMs, signal }
  const { plan, changed } = await planCommand(run, base)
  try {
    return await spawnShell(plan, timeoutMs, outputLimit, signal)
  } finally {
    await finishCommand(run, plan, changed)
  }
}

/**
 * 造一个 bash 工具。预算由 tools-default 插件从配置取值传入（缺省 {@link BASH_DEFAULT_BUDGETS}），
 * 参数说明里的数值随预算走——模型看到的承诺与实际执行的一致。
 */
export function createBashTool(budgets: BashBudgets = BASH_DEFAULT_BUDGETS): ToolEntry {
  return {
    name: 'bash',
    description: isWin
      ? '执行 PowerShell 命令（工作目录 = 会话目录）。只留给「非 shell 不可」的事：构建、安装、git、跑测试、查进程。' +
        '不要用 cat/head/tail 读文件（用 read），不要用 grep/rg/Get-ChildItem -Recurse 找代码（用 grep/glob），' +
        '不要用 echo 重定向或 heredoc 造文件（用 write），不要用 sed/awk 改文件（用 edit）。' +
        '一条命令里有 | ; && 时会被切成几段分别判定，任何一段危险整条就要问用户；带重定向或变量赋值的段不给走已授权规则。' +
        '耗时命令设 timeoutMs。'
      : '执行 shell 命令（工作目录 = 会话目录）。只留给构建、安装、git、跑测试这类必须用 shell 的事；' +
        '读文件用 read，找代码用 grep/glob，改文件用 edit/write。' +
        '一条命令里有 | ; && 时会被切成几段分别判定，任何一段危险整条就要问用户。耗时命令设 timeoutMs。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeoutMs: {
          type: 'number',
          description: `超时毫秒数（默认 ${budgets.timeoutMs}，上限 ${budgets.maxTimeoutMs}）`,
        },
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
      const requested = typeof args.timeoutMs === 'number' ? Math.floor(args.timeoutMs) : budgets.timeoutMs
      const timeoutMs = Math.min(Math.max(requested, 1000), budgets.maxTimeoutMs)
      const output = await runShell(args.command, ctx.cwd, timeoutMs, budgets.outputChars, ctx.signal)
      // 下载类命令的输出是外部内容：包裹围栏再进对话（先遮红后包裹，遮红在 spawnShell 里已完成）。
      if (NETWORK_FETCH_RE.test(args.command)) return wrapUntrusted('bash', output)
      return output
    },
  }
}
