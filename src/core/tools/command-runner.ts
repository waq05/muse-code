/**
 * 命令执行器缝：bash 工具在真正 `spawn` 之前问一次注册表，拿到最终的执行计划。
 *
 * 为什么要有这条缝：策略层的沙箱（路径白名单、受保护路径、命令前缀规则）挂在守卫链上
 * 就够了，它只做「拒 / 放行」；但**真隔离**必须换掉整个执行体——把
 * `powershell -NoProfile -Command <用户命令>` 换成
 * `docker run --network none -v <工作区>:/work …`。守卫链改不了 argv，所以单开这一条缝。
 *
 * 缝是可选注册的：**没有注册者时执行计划就是原来的那一份**，bash 工具行为与加这条缝之前
 * 完全一致（沙箱插件关着、或沙箱选了进程内策略后端时走的都是这条路）。
 *
 * @module dsc/core/tools/command-runner
 */

import type { ChildProcess } from 'node:child_process'

/** 一次待执行命令的事实（注册者据此决定要不要换执行体）。 */
export interface CommandRun {
  /** 要执行的命令原文（shell 语法，未拆分）。 */
  command: string
  /** 会话工作目录（绝对路径）。 */
  cwd: string
  /** 这次调用的超时毫秒数。 */
  timeoutMs: number
  /** 这一轮的取消信号。 */
  signal: AbortSignal
}

/**
 * 自定义 spawn：`file/args/env/cwd` 表达不了的执行计划（受限令牌的
 * `CreateProcessAsUserW`、容器运行时 API 这类）从这里走。
 *
 * 返回值按 node:child_process 的 `ChildProcess` 最小形状给：
 * `pid`（taskkill 树杀靠它）、可读的 `stdout`/`stderr`、`error`/`close` 事件。
 * spawn 本身同步返回，失败不抛——照 node 的惯例 emit `error`。
 */
export type CustomSpawn = () => ChildProcess

/** 最终的进程启动计划（bash 工具照着它 spawn）。 */
export interface SpawnPlan {
  /** 可执行文件。 */
  file: string
  /** 参数数组（不经 shell，避免二次解析）。 */
  args: string[]
  /** 子进程环境变量。 */
  env: Record<string, string | undefined>
  /** 子进程工作目录。 */
  cwd: string
  /**
   * 自定义 spawn（可选）：给了它，bash 工具就不走 `spawn(file, args, …)`，
   * 改调这里。`file/args/env/cwd` 此刻只是给后续执行器与诊断看的「计划描述」。
   */
  spawn?: CustomSpawn
}

/**
 * 命令执行器：`plan` 返回改写后的计划，返回 null 表示「我不改，按上一位的结果来」。
 * `plan` 抛错按「拒绝执行」处理（坏掉的围栏不该等于放行）。
 */
export interface CommandRunner {
  /** 归属键（一般写插件名），同 id 后注册者顶掉先注册者。 */
  id: string
  /** 小的先问；后一位看到的是前一位改写后的计划。 */
  order: number
  plan(run: CommandRun, current: SpawnPlan): SpawnPlan | null | Promise<SpawnPlan | null>
  /** 进程收尾（容器后端用它删临时容器）；失败只记不抛。 */
  done?(run: CommandRun, plan: SpawnPlan): void | Promise<void>
}

interface Entry {
  runner: CommandRunner
  plan: SpawnPlan
}

const runners = new Map<string, CommandRunner>()

/** 注册一位命令执行器；返回退订函数。同 id 后注册者顶掉先注册者。 */
export function registerCommandRunner(runner: CommandRunner): () => void {
  runners.set(runner.id, runner)
  return () => {
    if (runners.get(runner.id) === runner) runners.delete(runner.id)
  }
}

/** 当前链上的执行器（按询问顺序；自检与诊断用）。 */
export function commandRunnerIds(): string[] {
  return [...runners.values()].sort(byOrder).map((runner) => runner.id)
}

function byOrder(a: CommandRunner, b: CommandRunner): number {
  return a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order
}

/**
 * 依次问执行器，得到最终执行计划。
 *
 * 第二个返回值是「谁改写过」：有改写说明这次命令不是在宿主上直跑的
 * （容器后端会用到），调用方拿它给结果加一行事实说明。
 *
 * @param run - 待执行命令的事实。
 * @param base - 默认计划（bash 工具自己那份）。
 */
export async function planCommand(
  run: CommandRun,
  base: SpawnPlan,
): Promise<{ plan: SpawnPlan; changed: string[] }> {
  const changed: string[] = []
  let current = base
  for (const runner of [...runners.values()].sort(byOrder)) {
    const next = await runner.plan(run, current)
    if (next !== null && next !== undefined) {
      current = next
      changed.push(runner.id)
    }
  }
  return { plan: current, changed }
}

/** 通知全部执行器一次命令已收尾（只有改写过的那几位在乎）。 */
export async function finishCommand(run: CommandRun, plan: SpawnPlan, changed: readonly string[]): Promise<void> {
  for (const id of changed) {
    const runner = runners.get(id)
    if (runner?.done === undefined) continue
    try {
      await runner.done(run, plan)
    } catch {
      // 收尾失败不该影响工具结果：容器/临时资源留一份不致命，报错反而会把正常结果吞掉
    }
  }
}

/** 自检用：把注册表清空（生产路径不该调用）。 */
export function resetCommandRunners(): void {
  runners.clear()
}
