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
import { spawn } from 'node:child_process'
import type { ToolEntry } from '../tools.js'
import { classifyCommand } from '../command-policy.js'
import { redact, scrubChildEnv } from '../secrets.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 8000

const isWin = process.platform === 'win32'

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const { env } = scrubChildEnv(process.env)
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd, env })
      : spawn('sh', ['-c', command], { cwd, env })
    let output = ''
    const append = (chunk: Buffer | string): void => {
      if (output.length < OUTPUT_LIMIT * 2) output += String(chunk)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`命令超时（${timeoutMs}ms）`))
    }, timeoutMs)

    const onAbort = (): void => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      rejectPromise(new Error('命令被用户取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const truncated = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}…（已截断）` : output
      const header = code === 0 ? '' : `退出码 ${code}\n`
      resolvePromise(redact(`${header}${truncated.trim() || '（无输出）'}`))
    })
  })
}

export const bashTool: ToolEntry = {
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
      timeoutMs: { type: 'number', description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}）` },
    },
    required: ['command'],
  },
  risk: 'exec',
  async run(args, ctx) {
    if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command 必须是非空字符串')
    // 硬地板在工具自己这一层再过一遍：审批层被绕开（无头队友、脚本调用）也执行不了灾难命令。
    const verdict = classifyCommand(args.command)
    if (verdict.decision === 'deny') throw new Error(`命令被安全策略拒绝执行：${verdict.reason}`)
    const requested = typeof args.timeoutMs === 'number' ? Math.floor(args.timeoutMs) : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(requested, 1000), MAX_TIMEOUT_MS)
    return runShell(args.command, ctx.cwd, timeoutMs, ctx.signal)
  },
}
