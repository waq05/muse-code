/**
 * waiting 插件：provide `waiting` 服务——「正在等用户做决定」的登记表。
 *
 * 为什么要有这一层：目标自动续跑之前必须确认没有卡片挂着等用户点（不隔着一张审批卡硬推）。
 * 原先那段是任务面服务里一行 `ctx.approval.pendingView() !== null || plan !== null || question !== null`——
 * 一个功能点挨个认识其他三个功能点的卡片。改成登记制之后，每张卡自己登记「我在等人」，
 * 想往下推的人只问一句「有没有人在等」，谁也不认识谁。
 *
 * @module dsc/plugins/waiting
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { WaitingService } from '../services/types.js'

export const waitingPlugin: Plugin.Object = {
  name: 'waiting',
  provide: 'waiting',
  apply(ctx) {
    const waiters = new Map<string, () => boolean>()
    const service: WaitingService = {
      register(id, pending) {
        waiters.set(id, pending)
        return () => {
          if (waiters.get(id) === pending) waiters.delete(id)
        }
      },
      get ids() {
        return [...waiters.keys()]
      },
      get any() {
        for (const [id, pending] of waiters) {
          try {
            if (pending()) return true
          } catch {
            // 一个卡片自己算崩了不算「有人在等」：它已经答不了任何东西，
            // 拿这个当挡箭牌会把用户的续跑永久钉死。
            void id
          }
        }
        return false
      },
    }
    ctx.provide('waiting', service)
  },
}
