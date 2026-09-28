/**
 * bash 工具：在会话目录里执行 shell 命令。win32 走 PowerShell 7（缺省
 * powershell.exe），POSIX 走 sh；stdout/stderr 合并返回，超时与长度封顶。
 *
 * @module dsc/core/tools/bash
 */
import { spawn } from 'node:child_process'
import type { ToolEntry } from '../tools.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 8000

const isWin = process.platform === 'win32'

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd })
      : spawn('sh', ['-c', command], { cwd })
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
      resolvePromise(`${header}${truncated.trim() || '（无输出）'}`)
    })
  })
}

export const bashTool: ToolEntry = {
  name: 'bash',
  description:
    process.platform === 'win32'
      ? '执行 PowerShell 命令（工作目录 = 会话目录）。用于列目录、跑脚本、查系统状态等；耗时命令设 timeoutMs。'
      : '执行 shell 命令（工作目录 = 会话目录）。用于列目录、跑脚本、查系统状态等；耗时命令设 timeoutMs。',
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
    const requested = typeof args.timeoutMs === 'number' ? Math.floor(args.timeoutMs) : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(requested, 1000), MAX_TIMEOUT_MS)
    return runShell(args.command, ctx.cwd, timeoutMs, ctx.signal)
  },
}
