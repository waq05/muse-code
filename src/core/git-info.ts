/**
 * 工作区 git 收集（/review 命令的取数层）。
 *
 * 为什么独立成模块而不是长在 commands 插件里：渲染层会 import `lib/plugins/commands.js`
 * 里的补全函数，vite 把 `node:child_process` externalize 成浏览器代理模块——顶层 import
 * 一旦出现在 commands.js，渲染进程一启动就炸成白屏（0.6.26 实机探针抓到）。取数挪进
 * core 后，commands.js 的顶层不再碰 node 内置模块。
 *
 * 安全姿势照 codex /diff：execFile 固定子命令数组（无 shell、无拼接）；
 * `--no-textconv --no-ext-diff` 防文本转换与外部 diff driver 当场执行程序。
 *
 * @module dsc/core/git-info
 */
import { execFile } from 'node:child_process'

/** 审查 diff 塞进上下文的字符预算（约 1.5 万 token；超了从尾部截，头部是改动清单更值钱）。 */
export const REVIEW_DIFF_BUDGET = 60_000

/** 受控执行 git（execFile 固定首参字面量 + 参数数组；无 shell）。 */
export function gitExec(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveDone, rejectDone) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 15000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== undefined && error !== null) rejectDone(new Error(String(stderr || error.message).slice(0, 400)))
        else resolveDone(String(stdout))
      },
    )
  })
}

/**
 * 收集工作区未提交改动（codex /review 的 UncommittedChanges 目标）：
 * `git diff HEAD` 含已暂存改动；untracked 不进 diff（`git diff` 本来就不含它们），
 * 只列名单让模型自己 read。不是 git 仓库时返回 null。
 */
export async function collectWorkingTree(cwd: string): Promise<{ diff: string; untracked: string[] } | null> {
  try {
    const inside = (await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
  } catch {
    return null
  }
  const porcelain = await gitExec(cwd, ['status', '--porcelain=v1'])
  const untracked = porcelain
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((file) => file !== '')
  const raw = await gitExec(cwd, ['diff', 'HEAD', '--no-textconv', '--no-ext-diff'])
  const diff =
    raw.length > REVIEW_DIFF_BUDGET ? `${raw.slice(0, REVIEW_DIFF_BUDGET)}\n…（diff 过长，已从 ${String(REVIEW_DIFF_BUDGET)} 字符处截断）` : raw
  return { diff, untracked }
}
