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
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { stripBaseline, type FileChangeSummary } from './tools.js'
import { summarizeChange } from './tools/fs-tools.js'

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

/**
 * /review 的审查消息组装（T18：主会话回落轮与审查队友的任务描述共用这一份）。
 * 独立成纯函数便于脱离命令体系直测；挪进本模块是因为「收集」与「组装」同域，
 * 而 commands.js 的顶层不许出现 node 内置模块 import。
 */
export function reviewMessage(collected: { diff: string; untracked: string[] }, focus: string): string {
  const lines = [
    '请审查当前工作区的未提交改动。逐个文件过 diff：正确性问题、边界条件、安全问题、'
      + '与项目既有约定（如 AGENTS.md）冲突的地方；给出具体文件与行级的意见。没有问题就明说没有。',
  ]
  if (focus !== '') lines.push(`关注点：${focus}`)
  if (collected.diff !== '') {
    lines.push('', '## 未提交改动（git diff HEAD --no-textconv --no-ext-diff）', '', collected.diff)
  } else {
    lines.push('', '## 未提交改动', '', '（没有已跟踪文件的改动，只有未跟踪的新文件）')
  }
  if (collected.untracked.length > 0) {
    lines.push('', '## 未跟踪文件（diff 里没有，逐个 read 后再评）', ...collected.untracked.map((file) => `- ${file}`))
  }
  return lines.join('\n')
}

// ── T42：回合首尾快照（轮尾「文件已更改」卡对 bash/脚本改动的兜底）─────────────

/** 一轮最多补多少个 git 兜底条目（防一个脚本扫动几千个文件把轮尾卡撑爆）。 */
const MAX_GIT_TURN_FILES = 20

/**
 * 回合起点的 git 状态快照：仓库根 + porcelain 一行一条。非 git 仓库、git 跑不动
 * （超时/没装）一律返回 null——兜底只在确定拿得到的时候参与，绝不挡回合本身。
 */
export async function snapshotGitStatus(cwd: string): Promise<{ root: string; lines: string[] } | null> {
  try {
    const inside = (await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
    const root = (await gitExec(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const lines = (await gitExec(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all']))
      .split('\n')
      .filter((line) => line !== '')
    return { root, lines }
  } catch {
    return null
  }
}

/** porcelain 一行 → { 状态码, 仓库根相对路径 }；rename 的 `old -> new` 取 new 一侧。 */
function parsePorcelain(line: string): { code: string; path: string } | null {
  if (line.length < 4) return null
  const code = line.slice(0, 2)
  let path = line.slice(3)
  const arrow = path.indexOf(' -> ')
  if (arrow >= 0) path = path.slice(arrow + 4)
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return { code, path }
}

/**
 * 对比回合首尾快照，把「第一方 write/edit 之外」动过的文件补成变更条目（bash、
 * sed、构建脚本改的文件也要进轮尾卡，用户不能看到「无更改」而工作区其实变了）。
 *
 * 口径：porcelain 状态码变了才算本回合动的——回合开始前就脏着的文件「又改了一刀」
 * 在这里看不出来，这是相对 dsh scratch-index 方案的已知盲区。`already` 里的路径跳过
 * （write/edit 已经记了更准的「回合前全文」基线）。基线内容：已跟踪取 HEAD 版本，
 * 未跟踪取空串（整篇新增）。删除（盘上已无此文件）跳过——diff 面板没有「删除」的展示形态。
 */
export async function collectGitTurnChanges(
  cwd: string,
  before: { root: string; lines: string[] } | null,
  after: { root: string; lines: string[] } | null,
  already: readonly string[],
): Promise<FileChangeSummary[]> {
  if (before === null || after === null || before.root !== after.root) return []
  const startState = new Map<string, string>()
  for (const line of before.lines) {
    const parsed = parsePorcelain(line)
    if (parsed !== null) startState.set(parsed.path, parsed.code)
  }
  const taken = new Set(already.map((path) => path.toLowerCase()))
  const out: FileChangeSummary[] = []
  for (const line of after.lines) {
    if (out.length >= MAX_GIT_TURN_FILES) break
    const parsed = parsePorcelain(line)
    if (parsed === null || parsed.code === ' D' || parsed.code === 'D ') continue
    const startCode = startState.get(parsed.path)
    if (startCode === parsed.code) continue // 状态没变：要么没动，要么回合前就脏着（盲区）
    const abs = join(after.root, parsed.path)
    if (taken.has(abs.toLowerCase())) continue
    const baseline =
      startCode === undefined
        ? '' // 回合开始时不存在（未跟踪的新文件）：整篇算新增
        : await gitExec(cwd, ['show', `HEAD:${parsed.path}`]).catch(() => '')
    const current = await fsp.readFile(abs, 'utf8').catch(() => null)
    if (current === null) continue
    const change = summarizeChange(abs, baseline, current)
    if (change !== undefined) out.push(stripBaseline(change))
  }
  return out
}
