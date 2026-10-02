/**
 * LSP 管理器：持有所有语言服务器实例，按 (服务器, 根) 串行、按 idle 回收、按破键退避。
 *
 * 为什么要单独一个模块：管理器是「池化与调度」策略（什么时候起进程、排队顺序、
 * 崩溃退避），client.ts 是「一个连接怎么说话」（spawn、握手、JSON-RPC、超时取消）。
 * 两件事的变更节奏完全不同——改排队策略不该在传输层的代码堆里找。层级关系：
 * manager → client（起实例），client 不反向依赖 manager。
 *
 * 外部只会调 {@link LspManager.query} / {@link LspManager.diagnostics} / status / servers / dispose。
 *
 * @module dsc/core/lsp/manager
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { errText } from '../err-text.js'
import { buildChildEnv } from '../mcp.js'
import {
  type LspDiagnosticsOutcome,
  type LspManagerOptions,
  type LspOperation,
  type LspQueryOutcome,
  type LspRuntimeValues,
  type LspStatusEntry,
  defaultRuntimeValues,
  LspInstance,
  LspQueryError,
} from './client.js'
import type { LspPosition } from './uri.js'
import {
  type LspServerDef,
  type LspServerInfo,
  describeServers,
  findProjectRoot,
  findServerForFile,
  installHint,
  resolveExecutable,
} from './servers.js'

// ── 池 + 串行队列 + idle 回收 + 破键退避 ─────────────────────────────────────

/** 池子里的一条记录。 */
interface InstanceRecord {
  key: string
  server: LspServerDef
  root: string
  instance: LspInstance
  /** 队列里还有活没干完的条数（有活就不回收）。 */
  inflight: number
  /** 最后一次用它的时刻（毫秒）。 */
  lastUsed: number
}

/** 一个 (服务器, 根) 的破键。 */
interface BrokenMark {
  until: number
  reason: string
}

/** 查询计划：找好了服务器与根，接下来只剩起进程/排队。 */
interface QueryPlan {
  server: LspServerDef
  root: string
  path: string
  key: string
  target: { file: string; shell: boolean }
}

/** 扩展名提示（降级文案里那句「没有认领 .xyz 的服务器」）。 */
function extensionHint(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : base
}

/**
 * LSP 管理器：持有所有实例、按 (服务器, 根) 串行、按 idle 回收、按破键退避。
 * 外部只会调 {@link LspManager.query} / {@link LspManager.diagnostics} / status / servers / dispose。
 */
export class LspManager {
  private readonly records = new Map<string, InstanceRecord>()
  private readonly starting = new Map<string, Promise<InstanceRecord>>()
  private readonly broken = new Map<string, BrokenMark>()
  /** 每个 key 的串行尾巴：排队是**同步**接上的，所以「写前基线」一定排在「写后查询」前面。 */
  private readonly tails = new Map<string, Promise<unknown>>()
  private reaper: NodeJS.Timeout | undefined
  private disposed = false
  private readonly env: Record<string, string>

  constructor(private readonly options: LspManagerOptions) {
    this.env = options.env?.() ?? buildChildEnv([], {}, process.env)
    this.scheduleSweep()
  }

  /**
   * 排下一次 idle 清扫。每次重算间隔（idle 一半，夹在 5 秒到 60 秒之间），
   * 所以用户在设置里把 idle 从 600 秒改成 30 秒之后，下一次清扫的节奏就跟着变了。
   */
  private scheduleSweep(): void {
    if (this.disposed) return
    const delay = Math.max(5_000, Math.min(60_000, Math.round(this.options.idleTimeoutMs() / 2)))
    const timer = setTimeout(() => {
      this.reaper = undefined
      void this.sweepIdle().finally(() => {
        this.scheduleSweep()
      })
    }, delay)
    // 挂着的清扫定时器不能把宿主进程钉住不退出
    timer.unref()
    this.reaper = timer
  }

  /** 现在生效的服务器表（连「PATH 里有没有」一起给）。 */
  servers(): LspServerInfo[] {
    return describeServers(this.options.servers(), this.env, process.cwd())
  }

  /** 每个服务器此刻的状态与实例数。 */
  status(): LspStatusEntry[] {
    const now = Date.now()
    const instancesByServer = new Map<string, string[]>()
    for (const record of this.records.values()) {
      const roots = instancesByServer.get(record.server.id) ?? []
      roots.push(record.root)
      instancesByServer.set(record.server.id, roots)
    }
    return this.options.servers().map((server) => {
      const mark = this.brokenIn(server.id, now)
      const roots = instancesByServer.get(server.id) ?? []
      const target = resolveExecutable(server.command, this.env, process.cwd())
      return {
        id: server.id,
        command: server.command,
        available: target !== undefined,
        instances: roots.length,
        roots,
        brokenSeconds: mark === null ? null : Math.max(0, Math.ceil((mark.until - now) / 1000)),
        ...(mark === null ? {} : { problem: mark.reason }),
      }
    })
  }

  /**
   * 一次查询。任何一步不行都给 `{ ok: false, reason }`，**不抛给调用方**。
   *
   * @param operation - 四个操作之一。
   * @param filePath - 目标文件（相对路径按 cwd 展开）。
   * @param line - 一基行号。
   * @param character - 一基列号。
   * @param position - 已经换算好的零基坐标。
   * @param cwd - 会话工作目录。
   * @param signal - 取消信号。
   */
  async query(
    operation: LspOperation,
    filePath: string,
    position: LspPosition,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<LspQueryOutcome> {
    const plan = this.plan(filePath, cwd)
    if (!plan.ok) return plan
    const blocked = this.brokenReason(plan.plan.key)
    if (blocked !== null) return { ok: false, reason: blocked, server: plan.plan.server.id }
    return await this.enqueue(plan.plan.key, async () => {
      const acquired = await this.acquire(plan.plan)
      if (!acquired.ok) {
        return {
          ok: false,
          reason: acquired.reason,
          server: plan.plan.server.id,
          ...(acquired.stderr === undefined ? {} : { stderr: acquired.stderr }),
        }
      }
      const record = acquired.record
      record.inflight += 1
      record.lastUsed = Date.now()
      try {
        const result = await record.instance.query(operation, plan.plan.path, position, signal)
        return { ok: true, ...result, server: plan.plan.server.id, root: plan.plan.root }
      } catch (error) {
        return await this.failed(plan.plan, record.instance, error)
      } finally {
        record.inflight -= 1
        record.lastUsed = Date.now()
      }
    })
  }

  /**
   * 一个文件此刻的诊断。`content` 给了就按它算（写前基线用写前的内容），没给就读盘。
   *
   * @param filePath - 目标文件（相对路径按 cwd 展开）。
   * @param cwd - 会话工作目录。
   * @param content - 想让服务器看到的文本；缺省读盘。
   * @param signal - 取消信号。
   */
  async diagnostics(
    filePath: string,
    cwd: string,
    content?: string,
    signal?: AbortSignal,
  ): Promise<LspDiagnosticsOutcome> {
    const plan = this.plan(filePath, cwd)
    if (!plan.ok) return plan
    const blocked = this.brokenReason(plan.plan.key)
    if (blocked !== null) return { ok: false, reason: blocked, server: plan.plan.server.id }
    return await this.enqueue(plan.plan.key, async () => {
      const acquired = await this.acquire(plan.plan)
      if (!acquired.ok) {
        return {
          ok: false,
          reason: acquired.reason,
          server: plan.plan.server.id,
          ...(acquired.stderr === undefined ? {} : { stderr: acquired.stderr }),
        }
      }
      const record = acquired.record
      record.inflight += 1
      record.lastUsed = Date.now()
      try {
        const items = await record.instance.diagnostics(plan.plan.path, content, signal)
        if (items === null) {
          return {
            ok: false,
            reason: `${plan.plan.server.id} 在 ${this.values().diagnosticsWaitMs}ms 内没给出诊断（可能还在建索引）`,
            server: plan.plan.server.id,
          }
        }
        return {
          ok: true,
          diagnostics: items,
          server: plan.plan.server.id,
          root: plan.plan.root,
        }
      } catch (error) {
        return await this.failed(plan.plan, record.instance, error)
      } finally {
        record.inflight -= 1
        record.lastUsed = Date.now()
      }
    })
  }

  /** 这个文件现在有没有可用的服务器（守卫据此决定要不要记基线，免得白起进程）。 */
  canServe(filePath: string, cwd: string): boolean {
    const plan = this.plan(filePath, cwd)
    return plan.ok && this.brokenReason(plan.plan.key) === null
  }

  /**
   * 收掉全部子进程与定时器。**同步**：disposer 与 `dsc/exit` 都在同步路径上，
   * 这里只发信号不等待——不退进程就会留一群语言服务器在后台（照 `plugins/mcp.ts:151-155` 的理由）。
   */
  dispose(): void {
    this.disposed = true
    if (this.reaper !== undefined) {
      clearTimeout(this.reaper)
      this.reaper = undefined
    }
    for (const record of this.records.values()) record.instance.terminateNow()
    this.records.clear()
    this.starting.clear()
    this.tails.clear()
  }

  private values(): LspRuntimeValues {
    return { ...defaultRuntimeValues(), ...this.options.values?.() }
  }

  /** 找服务器、找根、确认可执行文件都在；任何一步不行都给一句原因。 */
  private plan(
    filePath: string,
    cwd: string,
  ): { ok: true; plan: QueryPlan } | { ok: false; reason: string; server?: string } {
    const path = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
    if (!existsSync(path)) return { ok: false, reason: `文件不存在：${path}` }
    const servers = this.options.servers()
    const server = findServerForFile(servers, path)
    if (server === undefined) {
      return {
        ok: false,
        reason: `没有认领 ${extensionHint(path)} 的语言服务器（内置表里没有这种扩展名，可以在设置里用一行 JSON 追加）`,
      }
    }
    const target = resolveExecutable(server.command, this.env, process.cwd())
    if (target === undefined) {
      const hint = installHint(server.id)
      return {
        ok: false,
        server: server.id,
        reason:
          `PATH 里找不到 ${server.id} 服务器的可执行文件 ${server.command}` +
          `${hint === undefined ? '' : `（装法：${hint}）`}`,
      }
    }
    const root = findProjectRoot(path, server.markers)
    if (root === undefined) {
      return {
        ok: false,
        server: server.id,
        reason:
          `${path} 往上找不到 ${server.markers.slice(0, 3).join(' / ')} 这些标记，定不了项目根` +
          '（语言服务器需要一个工作区根才能建索引）',
      }
    }
    return {
      ok: true,
      plan: { server, root, path, key: `${server.id}\u0000${root}`, target },
    }
  }

  /** 破键还没解禁就给一句原因（带上还剩多久）。 */
  private brokenReason(key: string): string | null {
    const mark = this.broken.get(key)
    if (mark === undefined) return null
    const left = mark.until - Date.now()
    if (left <= 0) {
      this.broken.delete(key)
      return null
    }
    const [serverId, root] = key.split('\u0000')
    return `${serverId} 在 ${root} 上最近起不来，先不重试（还有 ${Math.ceil(left / 1000)} 秒）：${mark.reason}`
  }

  /** 某个服务器当前有没有破键（status 用）。 */
  private brokenIn(serverId: string, now: number): BrokenMark | null {
    for (const [key, mark] of this.broken) {
      if (!key.startsWith(`${serverId}\u0000`)) continue
      if (mark.until > now) return mark
      this.broken.delete(key)
    }
    return null
  }

  /** 记一笔破键（同一个 key 只留最长的那次，免得后来的短退避把长退避顶掉）。 */
  private markBroken(key: string, reason: string): void {
    const until = Date.now() + this.values().brokenRetryMs
    const current = this.broken.get(key)
    if (current !== undefined && current.until >= until) return
    this.broken.set(key, { until, reason })
  }

  /** 同步把这次操作接到该 key 的尾巴上：排队顺序 = 调用顺序（写前基线必须排在写后查询前面）。 */
  private enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(op, op)
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /**
   * 取实例：池子里有就用，没有就起一个。同一个 key 上的并发请求共用同一次启动。
   *
   * @returns 记录，或一句起不来的原因（起不来时已经记好破键）。
   */
  private async acquire(
    plan: QueryPlan,
  ): Promise<{ ok: true; record: InstanceRecord } | { ok: false; reason: string; stderr?: string }> {
    if (this.disposed) return { ok: false, reason: 'LSP 管理器已经收掉了' }
    const existing = this.records.get(plan.key)
    if (existing !== undefined && !existing.instance.dead) return { ok: true, record: existing }
    const pendingStart = this.starting.get(plan.key)
    if (pendingStart !== undefined) {
      try {
        return { ok: true, record: await pendingStart }
      } catch (error) {
        return { ok: false, ...this.startFailure(plan, error) }
      }
    }
    const start = this.startInstance(plan)
    this.starting.set(plan.key, start)
    try {
      return { ok: true, record: await start }
    } catch (error) {
      return { ok: false, ...this.startFailure(plan, error) }
    } finally {
      this.starting.delete(plan.key)
    }
  }

  private async startInstance(plan: QueryPlan): Promise<InstanceRecord> {
    const instance = new LspInstance({
      server: plan.server,
      root: plan.root,
      target: plan.target,
      env: this.env,
      values: this.values(),
      onExit: (reason) => {
        this.onInstanceExit(plan.key, instance, reason)
      },
    })
    try {
      // 握手失败要在这里就暴露：进了池子以后每条查询都得再等一次 30 秒才算知道它起不来。
      await instance.ready
    } catch (error) {
      instance.terminateNow()
      throw error
    }
    const record: InstanceRecord = {
      key: plan.key,
      server: plan.server,
      root: plan.root,
      instance,
      inflight: 0,
      lastUsed: Date.now(),
    }
    this.records.set(plan.key, record)
    return record
  }

  /** 启动失败的原因与 stderr 尾巴：两个都要回给调用方——尾巴是「为什么起不来」的唯一线索。 */
  private startFailure(plan: QueryPlan, error: unknown): { reason: string; stderr?: string } {
    const message = errText(error)
    const stderr = error instanceof LspQueryError ? error.stderr : undefined
    this.markBroken(plan.key, message)
    const [serverId, root] = [plan.server.id, plan.root]
    return {
      reason:
        `${serverId} 语言服务器在 ${root} 起不来：${message}` +
        `${stderr === undefined || stderr === '' ? '' : `\nstderr 尾巴：\n${stderr}`}`,
      ...(stderr === undefined || stderr === '' ? {} : { stderr }),
    }
  }

  /** 实例自己退了（崩溃、被杀、退出）：清槽 + 记破键。 */
  private onInstanceExit(key: string, instance: LspInstance, reason: string): void {
    const record = this.records.get(key)
    if (record !== undefined && record.instance === instance) this.records.delete(key)
    if (this.disposed) return
    this.markBroken(key, reason.split('\n')[0] ?? reason)
  }

  /** 一次操作失败：致命的（传输/超时）杀掉实例并记破键，非致命的只回一句话。 */
  private async failed(
    plan: QueryPlan,
    instance: LspInstance,
    error: unknown,
  ): Promise<{ ok: false; reason: string; server: string; stderr?: string }> {
    const message = errText(error)
    const stderr = instance.stderrTail()
    const fatal = error instanceof LspQueryError ? error.fatal : true
    if (fatal) {
      const record = this.records.get(plan.key)
      if (record !== undefined && record.instance === instance) this.records.delete(plan.key)
      this.markBroken(plan.key, message)
      instance.terminateNow()
    }
    return {
      ok: false,
      server: plan.server.id,
      reason: `${plan.server.id} 这次查询没成：${message}`,
      ...(stderr === '' ? {} : { stderr }),
    }
  }

  /**
   * 扫一遍 idle：超时没用过的实例收掉（有活干的不动）。
   *
   * 定时器调它；自检也直接调它（不然要干等 5 秒才轮到定时器）。
   */
  async sweepIdle(): Promise<void> {
    if (this.disposed) return
    const idleMs = this.options.idleTimeoutMs()
    const cutoff = Date.now() - idleMs
    const victims: InstanceRecord[] = []
    for (const record of this.records.values()) {
      if (record.inflight > 0 || record.lastUsed > cutoff) continue
      this.records.delete(record.key)
      victims.push(record)
    }
    for (const record of victims) await record.instance.shutdown()
  }
}
