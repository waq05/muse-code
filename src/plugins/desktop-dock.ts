/**
 * desktop-dock 插件：为桌面端 dock 面板提供工作区文件系统与 git 能力
 * （renderer 经 DscRuntime.dock(op, payload) 透传调用）。
 *
 * 安全边界：路径限定在宿主 cwd 内（fs-read 仅文本预览 ≤512KB）；git 全部
 * execFile 固定子命令 + safeArg 参数净化（拒绝选项注入），无 shell。
 *
 * @module dsc/plugins/desktop-dock
 */
import { execFile, spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ChildProcess } from 'node:child_process'

/** 受控执行 git（固定首参字面量 + 参数数组；无 shell）。超时由 execFile 自己收进程。 */
function git(cwd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolveDone, rejectDone) => {
    execFile(
      'git',
      args,
      // timeout 原来只在自己这层 reject，git 进程继续跑（2026-09-29 审查）：
      // 交给 execFile 的 timeout + killSignal，超时连进程一起收掉。
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== undefined && error !== null) {
          rejectDone(new Error(String(stderr || error.message).slice(0, 800)))
        } else {
          resolveDone(String(stdout))
        }
      },
    )
  })
}

/** 参数净化：拒绝空字节/换行与选项注入位。 */
function safeArg(value: unknown, allowNewline = false): string {
  const text = String(value ?? '')
  if (text.includes('\0')) throw new Error('非法参数')
  if (!allowNewline && text.includes('\n')) throw new Error('非法参数：含换行')
  if (text.startsWith('-')) throw new Error('非法参数：以 - 开头')
  return text
}

/** 支持的终端 shell（payload.shell 白名单；spawn 首参必须是字面量——安全扫描静态规则）。 */
function spawnShell(shell: string, cwd: string): ChildProcess {
  switch (shell) {
    case 'pwsh':
      return spawn('pwsh.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { cwd, windowsHide: true })
    case 'cmd':
      return spawn('cmd.exe', ['/Q', '/K'], { cwd, windowsHide: true })
    case 'bash':
      return spawn('bash.exe', ['--noprofile', '--norc'], { cwd, windowsHide: true })
    case 'node':
      return spawn('node.exe', ['-i'], { cwd, windowsHide: true })
    default:
      return spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { cwd, windowsHide: true })
  }
}

export const desktopDockPlugin: Plugin.Object = {
  name: 'desktop-dock',
  provide: 'dock',
  apply(ctx, config) {
    const cwd = (config as { cwd?: string } | undefined)?.cwd ?? process.cwd()

    // ---- 终端会话（管道模式：行缓冲输入由 renderer 负责，这里每行执行） ----
    const terms = new Map<string, ChildProcess>()
    let termSeq = 0

    const handle = async (op: string, payload: Record<string, unknown>): Promise<unknown> => {
      switch (op) {
        // ---- 终端（管道模式；无 tty，交互式全屏程序不可用） ----
        case 'term-spawn': {
          const id = `t${++termSeq}`
          const dir = resolve(cwd, safeArg(payload.cwd ?? '.', true))
          if (!inside(dir, cwd)) throw new Error('路径超出工作目录')
          // shell 白名单：非白名单值回落 PowerShell
          const shell = ['powershell', 'pwsh', 'cmd', 'bash', 'node'].includes(String(payload.shell ?? ''))
            ? String(payload.shell)
            : 'powershell'
          const child = spawnShell(shell, dir)
          terms.set(id, child)
          child.stdout?.on('data', (chunk: Buffer) => ctx.emit('dsc/dock-data', id, chunk.toString()))
          child.stderr?.on('data', (chunk: Buffer) => ctx.emit('dsc/dock-data', id, chunk.toString()))
          child.on('exit', (code) => {
            terms.delete(id)
            ctx.emit('dsc/dock-data', id, `\r\n[终端会话已退出（code ${code ?? 0}）]\r\n`)
          })
          return { id, shell }
        }
        case 'term-input': {
          const child = terms.get(String(payload.id ?? ''))
          if (child === undefined) throw new Error('终端会话不存在')
          child.stdin?.write(String(payload.data ?? ''))
          return { ok: true }
        }
        case 'term-kill': {
          const child = terms.get(String(payload.id ?? ''))
          if (child !== undefined) {
            terms.delete(String(payload.id ?? ''))
            child.kill()
          }
          return { ok: true }
        }

        // ---- 文件系统（限 cwd 内） ----
        case 'fs-list': {
          const dir = resolve(cwd, safeArg(payload.dir ?? '.'))
          if (!inside(dir, cwd)) throw new Error('路径超出工作目录')
          const entries = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith('.'))
            .map((entry) => {
              let size = 0
              if (!entry.isDirectory()) {
                try {
                  size = statSync(join(dir, entry.name)).size
                } catch {
                  size = 0
                }
              }
              return { name: entry.name, dir: entry.isDirectory(), size }
            })
          entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
          return { cwd: dir, entries }
        }
        case 'fs-read': {
          const file = resolve(cwd, safeArg(payload.file ?? '.'))
          if (!inside(file, cwd)) throw new Error('路径超出工作目录')
          const stat = statSync(file)
          if (stat.size > 512 * 1024) return { path: file, tooLarge: true, text: '' }
          return { path: file, tooLarge: false, text: readFileSync(file, 'utf8') }
        }

        // ---- git（execFile 固定子命令） ----
        case 'git-status': {
          // 空仓库（尚无任何提交）时 HEAD 不存在——显示占位分支名
          const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
            .then((out) => out.trim())
            .catch(() => '(无提交)')
          const porcelain = await git(cwd, ['status', '--porcelain=v1'])
          const staged: string[] = []
          const unstaged: string[] = []
          const untracked: string[] = []
          for (const line of porcelain.split('\n').filter((line) => line !== '')) {
            const code = line.slice(0, 2)
            const file = line.slice(3)
            if (code === '??') untracked.push(file)
            else {
              if (code[0] !== ' ' && code[0] !== '?') staged.push(`${code} ${file}`)
              if (code[1] !== ' ') unstaged.push(`${code} ${file}`)
            }
          }
          return { branch, staged, unstaged, untracked }
        }
        case 'git-stage': {
          const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => safeArg(file))
          await git(cwd, ['add', '--', ...files])
          return { ok: true }
        }
        case 'git-unstage': {
          const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => safeArg(file))
          await git(cwd, ['reset', 'HEAD', '--', ...files])
          return { ok: true }
        }
        case 'git-commit': {
          const text = safeArg(payload.message, true)
          if (text.trim() === '') throw new Error('提交信息为空')
          return { ok: true, output: (await git(cwd, ['commit', '-m', text])).slice(0, 1200) }
        }
        case 'git-log': {
          return {
            log: await git(cwd, ['log', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short', '-n', '30']),
          }
        }
        case 'git-diff': {
          const file = safeArg(payload.file)
          return { diff: (await git(cwd, ['diff', 'HEAD', '--', file])).slice(0, 20000) }
        }
        default:
          throw new Error(`dock 未知操作：${op}`)
      }
    }

    ctx.provide('dock', { handle })
    // 热卸载必须收干净（2026-09-29 审查）：终端子进程不杀会继续往 dsc/dock-data 吐输出。
    return () => {
      for (const child of terms.values()) {
        try {
          child.kill()
        } catch {
          // 已退出的进程 kill 会报错：忽略，目的已达到
        }
      }
      terms.clear()
    }
  },
}

/** 路径是否落在 root 内（Windows 大小写归一）。 */
function inside(path: string, root: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(resolve(root), resolve(path)).toLowerCase()
  return rel === '' || (!rel.startsWith('..') && !rel.split(/[\\/]/)[0]!.includes(':'))
}
