/**
 * host-stdio 插件：把 `ui` 服务（DscRuntime）暴露为宿主协议（headless UI 桥）。
 * 桌面端 Electron 壳 spawn/拉起本插件所在的 headless 进程并双向通信。
 * stdout 只承载协议消息；非 JSON 行容错忽略。
 *
 * 双传输（自动探测，无需配置）：
 *   - **stdio**：每行一个 JSON。适用于 node lib/headless.js 直接跑（管道手测、
 *     远程壳等任意宿主）。
 *   - **parentPort**：Electron utilityProcess 拉起时进程带 `process.parentPort`，
 *     消息经结构化克隆直传（无序列化）。
 *
 * 消息（runtime→host）：hello（握手）、result（应答）、snapshot（80ms 节流全量）。
 * 消息（host→runtime）：invoke（调用 DscRuntime 方法）、exit（收尾并退进程）。
 *
 * @module dsc/plugins/host-stdio
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '../adapter/transcript.js'
import { isInvokableMethod } from '../core/host-methods.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { RuntimeSnapshot } from '../contract.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'host-stdio'

/** 快照推送节流间隔的缺省值（配置没给时用；界面靠它决定最多多久刷一帧）。 */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/**
 * 取快照推送节流间隔：夹在 16 毫秒到 1 秒之间。
 * 再小就是一帧一帧追着渲染器跑（白烧 CPU），再大就是点完按钮半天没反应。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readThrottle(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.snapshotThrottleMs)
  if (!Number.isFinite(num)) return DEFAULT_SNAPSHOT_THROTTLE_MS
  return Math.min(Math.max(Math.round(num), 16), 1_000)
}

/** 协议版本（破坏性变更时递增，宿主据此拒绝）。 */
export const HOST_PROTOCOL_VERSION = 2

// ── 消息类型 ──────────────────────────────────────────────────────────────────

export type HostToRuntimeMessage =
  | { type: 'invoke'; id: number; method: string; args?: unknown[] }
  | { type: 'exit' }

export type RuntimeToHostMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'snapshot'; snapshot: RuntimeSnapshot }
  /** 宿主 UI 动作请求（命令 handler 里的 openPicker 等）。 */
  | { type: 'ui'; action: 'open-picker' }
  /** dock 终端输出流（desktop-dock 服务 → 桌面端面板）。 */
  | { type: 'dock-data'; id: string; data: string }

// ── 传输抽象 ──────────────────────────────────────────────────────────────────

interface Transport {
  /** 发送一条 runtime→host 消息。 */
  send(message: RuntimeToHostMessage): void
  /** 收到 host→runtime 消息。 */
  onMessage(handler: (message: HostToRuntimeMessage) => void): void
  /**
   * 宿主那头还有人在吗（审批插件据此决定弹卡还是立刻按拒）。
   * 两条传输各自的判据：stdio 看 stdin 关没关，parentPort 由 Electron 管生命周期，恒为 true。
   */
  reachable(): boolean
  /** 收尾（移除监听、暂停 stdin）。 */
  dispose(): void
}

/** Electron utilityProcess 的父端口（形状局部声明，避免依赖 electron 类型）。 */
interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

function pickTransport(): Transport {
  const port = (process as typeof process & { parentPort?: ParentPortLike }).parentPort
  if (port !== undefined) {
    return {
      send: (message) => port.postMessage(message),
      onMessage: (handler) => {
        port.on('message', (event) => {
          const message = event.data as HostToRuntimeMessage
          if (message !== null && typeof message === 'object' && 'type' in message) {
            handler(message)
          }
        })
      },
      // 父端口存不存在由 Electron 决定，这中间接不到「窗口关了」的信号，按连着处理。
      reachable: () => true,
      dispose: () => {
        /* MessagePort 由 Electron 生命周期管理 */
      },
    }
  }
  return stdioTransport()
}

function stdioTransport(): Transport {
  let buffer = ''
  const write = (message: RuntimeToHostMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const writeRef = { write }
  let handler: ((message: HostToRuntimeMessage) => void) | null = null
  const onStdin = (chunk: string | Buffer): void => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const trimmed = line.trim()
      if (trimmed === '' || handler === null) continue
      let message: HostToRuntimeMessage
      try {
        message = JSON.parse(trimmed) as HostToRuntimeMessage
      } catch {
        continue // 非 JSON 行容错忽略
      }
      handler(message)
    }
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onStdin)
  // stdin 关了就是宿主那头没人了：审批卡再挂着也等不到答案（`node lib/headless.js` 手测结束就是这种）。
  let ended = false
  const onEnd = (): void => {
    ended = true
  }
  process.stdin.on('end', onEnd)
  process.stdin.on('close', onEnd)
  return {
    send: (message) => writeRef.write(message),
    onMessage: (next) => {
      handler = next
    },
    reachable: () => !ended,
    dispose: () => {
      process.stdin.removeListener('data', onStdin)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('close', onEnd)
      process.stdin.pause()
    },
  }
}

// ── 插件 ──────────────────────────────────────────────────────────────────────

export const hostStdioPlugin: Plugin.Object = {
  name: 'host-stdio',
  inject: ['ui'],
  apply(ctx, passed) {
    const runtime = ctx.ui
    const throttleMs = readThrottle(passed)
    const transport = pickTransport()

    // ---- 界面可达性 ----
    // 宿主那头还有人（stdio 的 stdin 没关 / parentPort 还在）就登记成「有人能回答审批卡」，
    // 审批插件据此决定是弹卡还是立刻按拒，不再白等一次审批超时。
    const offInteractive = ctx.provide('interactive', { kind: 'host' as const, reachable: () => transport.reachable() })

    // ---- 快照节流推送 ----
    let pendingSnapshot = false
    let timer: NodeJS.Timeout | null = null
    const scheduleSnapshot = (): void => {
      pendingSnapshot = true
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (!pendingSnapshot) return
        pendingSnapshot = false
        transport.send({ type: 'snapshot', snapshot: runtime.getSnapshot() })
      }, throttleMs)
    }
    const unsubscribe = runtime.subscribe(scheduleSnapshot)

    // ---- 请求处理 ----
    const invoke = async (id: number, method: string, args: unknown[]): Promise<void> => {
      if (!isInvokableMethod(method)) {
        transport.send({ type: 'result', id, ok: false, error: `协议不允许调用的方法：${method}` })
        return
      }
      try {
        // 方法名已经收窄成 DscRuntime 的键，参数是线上来的 unknown：
        // 通用调用只有这一处，靠 Reflect.apply 展开实参（渲染器那侧由 RuntimeProxy 的映射类型保证签名对得上）。
        const value = Reflect.apply(runtime[method], runtime, args)
        transport.send({ type: 'result', id, ok: true, value: (await value) ?? null })
      } catch (error) {
        transport.send({ type: 'result', id, ok: false, error: errText(error) })
      }
    }

    transport.onMessage((message) => {
      if (message.type === 'exit') {
        runtime.exit()
        return
      }
      if (message.type === 'invoke') void invoke(message.id, message.method, message.args ?? [])
    })

    ctx.on('dsc/exit', () => {
      unsubscribe()
      offInteractive()
      if (timer !== null) clearTimeout(timer)
      transport.dispose()
    })

    // 命令 handler 请求打开 UI 面板（如 /resume）——转发给宿主壳
    ctx.on('dsc/open-picker', () => {
      transport.send({ type: 'ui', action: 'open-picker' })
    })

    // dock 终端输出流
    ctx.on('dsc/dock-data', (id, data) => {
      transport.send({ type: 'dock-data', id, data })
    })

    // ---- 握手 + 初始快照 ----
    transport.send({ type: 'hello', protocolVersion: HOST_PROTOCOL_VERSION })
    scheduleSnapshot()
  },
}
