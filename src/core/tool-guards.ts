/**
 * 工具守卫链的类型层：一次工具调用在动手之前要依次问谁、谁能拍板。
 *
 * 为什么要有这一层：循环原先按名字认识每个功能（`modeGate` 一个槽、审批一个参数、
 * 遮红一个槽），加一个拦截功能就得改循环；审批卡还要反过来查协作模式
 * （mode 已经依赖 approval，反向依赖在依赖图上就是环）。有了这条链，
 * 模式注册 order 10 的守卫、审批注册 order 30 的守卫，循环只说「问一下这条链」，
 * 谁也不认识谁。形状照 dsh 的 `guard/loop-tool-guards` 一条注册表的做法。
 *
 * 裁决的三种结果：
 *   deny  —— 当场拒，理由原样回给模型（链条到此为止）；
 *   pass  —— 免问直接执行，后面的守卫不再有机会反对（模式放行、审批允许都走这里）；
 *   defer —— 我不拦，问下一位；整条链都 defer 就等于交给循环照常执行。
 *
 * @module dsc/core/tool-guards
 */
import type { ToolRisk } from './tools.js'

/** 一次守卫裁决（deny / pass / defer 三种，见模块注释）。 */
export type ToolGuardVerdict = { action: 'deny'; reason: string } | { action: 'pass' } | { action: 'defer' }

/** 一次工具调用递给守卫链的事实。 */
export interface ToolGuardInput {
  toolName: string
  /** 工具自己声明的风险等级（core/tools.ts 的 ToolEntry.risk）。 */
  risk: ToolRisk
  /** 会话工作目录（绝对路径）。 */
  cwd: string
  /** 模型给的参数（已 JSON.parse）。 */
  args: Record<string, unknown>
  /** 从参数里认出来的写目标（绝对化后）；认不出来就没有。 */
  target?: string
  /** 从参数里认出来的命令原文；认不出来就没有。 */
  command?: string
  /** 这一轮的取消信号：要等人点卡的守卫拿它中止等待（用户按打断时用）。 */
  signal: AbortSignal
}

/** 注册进链条的一位守卫。 */
export interface ToolGuard {
  /** 归属键（一般写插件名），同 id 后注册者顶掉先注册者。 */
  id: string
  /** 小的先问。内置刻度：模式 10、审批 30。 */
  order: number
  /** 拍板；返回 Promise 的守卫会让工具执行等到它落定（审批卡就是这种）。 */
  decide(input: ToolGuardInput): ToolGuardVerdict | Promise<ToolGuardVerdict>
}

/** 工具结果进会话日志与回显之前的一道加工（遮红是内置唯一一位）。 */
export interface ToolObserver {
  id: string
  /** 小的先加工，后一位看到的是前一位的输出。 */
  order: number
  observe(toolName: string, text: string): string
}

/** 循环用的最小接口：只问结果，不知道链上有谁。 */
export interface ToolGuardChain {
  /** 依次问完守卫链：第一位给 deny 或 pass 的赢，都没意见就返回 defer。 */
  gate(input: ToolGuardInput): Promise<ToolGuardVerdict>
  /** 依次加工工具结果文本。 */
  observe(toolName: string, text: string): string
}

/** 按 order 再按 id 排（同 order 的顺序必须稳定，不然两次判定结果会飘）。 */
function byOrder<T extends { order: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))
}

/**
 * 守卫链的持有者：注册返回退订函数，插件卸载就在下一次判定前生效。
 * 链上没有守卫时 gate 恒返回 defer（工具照常执行），所以循环不依赖任何功能点在场。
 */
export class ToolGuardRegistry implements ToolGuardChain {
  private readonly guards = new Map<string, ToolGuard>()
  private readonly observers = new Map<string, ToolObserver>()

  /** 注册一位守卫；同 id 再注册会顶掉前一份，返回的退订函数只撤自己这一份。 */
  register(guard: ToolGuard): () => void {
    this.guards.set(guard.id, guard)
    return () => {
      if (this.guards.get(guard.id) === guard) this.guards.delete(guard.id)
    }
  }

  /** 注册一位结果加工者（同 id 顶掉，退订只撤自己）。 */
  registerObserver(observer: ToolObserver): () => void {
    this.observers.set(observer.id, observer)
    return () => {
      if (this.observers.get(observer.id) === observer) this.observers.delete(observer.id)
    }
  }

  /** 已注册的守卫（排好序，诊断与自检用）。 */
  get chain(): ToolGuard[] {
    return byOrder([...this.guards.values()])
  }

  async gate(input: ToolGuardInput): Promise<ToolGuardVerdict> {
    for (const guard of byOrder([...this.guards.values()])) {
      let verdict: ToolGuardVerdict
      try {
        verdict = await guard.decide(input)
      } catch (error) {
        // 安全链上抛错一律按拒处理（fail closed）：坏掉的守卫不该等于放行，
        // 原因原样回给模型与用户，比悄悄放过一次危险操作好收拾。
        const reason = error instanceof Error ? error.message : String(error)
        return { action: 'deny', reason: `守卫「${guard.id}」判定失败，这次调用先拒掉：${reason}` }
      }
      if (verdict.action !== 'defer') return verdict
    }
    return { action: 'defer' }
  }

  observe(toolName: string, text: string): string {
    let out = text
    for (const observer of byOrder([...this.observers.values()])) out = observer.observe(toolName, out)
    return out
  }
}

/** {@link toolApprovalGuard} 的入参。 */
export interface ApprovalGuardOptions {
  /** 这位守卫的归属键（内置审批用 `approval`，队友自带审批器时起别的名字）。 */
  id: string
  /** 问一次「这次可以动手吗」；true = 放行，false = 拒。 */
  approve: (input: ToolGuardInput) => Promise<boolean>
  /** 被拒时回给模型的那句话（会原样写进会话日志）。 */
  deniedReason: string
}

/**
 * 把「一个问人拿答案的裁决器」包成守卫：只读工具一律不问（defer 给下一位），
 * 问出来是「拒」就当场上报 deny，其余情况报 pass 让后面的守卫别再拦。
 *
 * 内置审批与队友自带的审批器都走这个包装，所以「读操作不弹卡、拒绝怎么回话」只写一遍。
 *
 * @param options - 见 {@link ApprovalGuardOptions}。
 */
export function toolApprovalGuard(options: ApprovalGuardOptions): ToolGuard {
  return {
    id: options.id,
    order: 30,
    async decide(input) {
      if (input.risk === 'read') return { action: 'defer' }
      const allowed = await options.approve(input)
      return allowed
        ? { action: 'pass' }
        : { action: 'deny', reason: options.deniedReason }
    },
  }
}
