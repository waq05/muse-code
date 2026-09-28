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
import type { RuntimeSnapshot } from '../contract.js'

/** 快照推送节流间隔。 */
const SNAPSHOT_THROTTLE_MS = 80

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

/** 允许经协议调用的 DscRuntime 方法白名单。 */
const INVOKABLE_METHODS = new Set([
  'submit',
  'interrupt',
  'openSession',
  'compact',
  'setModel',
  'setEffort',
  'refreshSessions',
  'listModels',
  'listPlugins',
  'setPluginEnabled',
  'listTeammates',
  'peekTranscript',
  'runCommand',
  'setPolicy',
  'dock',
  'answerApproval',
  // 会话库：归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉 / 界面偏好
  'archiveSessions',
  'listArchivedSessions',
  'restoreSessions',
  'purgeSessions',
  'renameSession',
  'setSessionPinned',
  'listUserMessages',
  'forkSession',
  'getUiPrefs',
  'setUiPrefs',
  // 技能中心
  'listSkills',
  'readSkill',
  'setSkillEnabled',
  'browseMarket',
  'installMarketSkill',
  'setMarketSources',
  // 设置界面
  'getSettingsSections',
  'getSectionValues',
  'setSettingValue',
  'runSettingAction',
  'getModelConfig',
  'saveProvider',
  'removeProvider',
  'setProviderKey',
  'setDefaultModel',
])

// ── 传输抽象 ──────────────────────────────────────────────────────────────────

interface Transport {
  /** 发送一条 runtime→host 消息。 */
  send(message: RuntimeToHostMessage): void
  /** 收到 host→runtime 消息。 */
  onMessage(handler: (message: HostToRuntimeMessage) => void): void
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
  return {
    send: (message) => writeRef.write(message),
    onMessage: (next) => {
      handler = next
    },
    dispose: () => {
      process.stdin.removeListener('data', onStdin)
      process.stdin.pause()
    },
  }
}

// ── 插件 ──────────────────────────────────────────────────────────────────────

export const hostStdioPlugin: Plugin.Object = {
  name: 'host-stdio',
  inject: ['ui'],
  apply(ctx) {
    const runtime = ctx.ui
    const transport = pickTransport()

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
      }, SNAPSHOT_THROTTLE_MS)
    }
    const unsubscribe = runtime.subscribe(scheduleSnapshot)

    // ---- 请求处理 ----
    const invoke = async (id: number, method: string, args: unknown[]): Promise<void> => {
      if (!INVOKABLE_METHODS.has(method)) {
        transport.send({ type: 'result', id, ok: false, error: `协议不允许调用的方法：${method}` })
        return
      }
      try {
        const value = await (runtime as unknown as Record<string, (...parts: unknown[]) => unknown>)[
          method
        ](...args)
        transport.send({ type: 'result', id, ok: true, value: value ?? null })
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
