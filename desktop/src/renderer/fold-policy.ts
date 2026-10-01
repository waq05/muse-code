/**
 * 展示档位 → 能力表（逐格对照 dsh 的 ChatPresentationPolicy，
 * packages/client/ui-chat/src/client/presentation-policy.ts:24-53）。
 *
 * 为什么单独成一个文件、并且只 import type：这张表是整个折叠机制的「开关面板」，
 * 四种档位各开哪几项能力全靠它，所以它必须能被行为单测直接跑
 * （desktop/shots/step-groups-check.mjs 走 Node 的 type stripping 直接读源码）。
 * appearance.ts 那边会 import 浏览器全局（localStorage、document），拉不进单测，
 * 表放这里才测得到。
 *
 * 为什么渲染层读能力而不是比档位字符串：dsh 那篇文件的头注说得很清楚——
 * 「渲染层各自取一个字段，没有一个去比档位枚举，所以加一个档只改下面这张表」。
 * dsc 照做：ChatView 只读这四项。
 *
 * @module desktop/renderer/fold-policy
 */
import type { UiProcessFold } from '@dsc/runtime/contract.js'

/** 一个档位开启哪几项能力。 */
export interface ProcessFoldPolicy {
  /** 定稿轮把过程收成一行「用时 X」总开关。 */
  foldTurns: boolean
  /** 阶段分组：全部轮给组头 / 只有历史轮给组头 / 不给组头。 */
  stepGrouping: 'collapsed' | 'history' | 'none'
  /** 运行中的组头显示实时任务详情（「正在运行命令 · pnpm build」）。 */
  liveDetail: boolean
  /** 定稿的思考行显示首行摘要预览（跑动中永远显示，不受这一项管）。 */
  reasoningPreview: boolean
}

/**
 * 四档各自开哪几项能力；数值与 dsh 的 POLICIES 逐格对应。
 *
 * `detailed` 是 dsh 桌面端的实际默认档（ui-chat/src/client/apply.ts 里非 dsh 桌面端走它）：
 * 整轮照旧折叠，但 `stepGrouping` 是 `history`——只有已定稿的轮才分组，正在跑的那一轮直接摊开。
 */
export const PROCESS_FOLD_POLICIES: Readonly<Record<UiProcessFold, ProcessFoldPolicy>> = {
  compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: false },
  standard: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: true, reasoningPreview: true },
  detailed: { foldTurns: true, stepGrouping: 'history', liveDetail: true, reasoningPreview: true },
  verbose: { foldTurns: false, stepGrouping: 'none', liveDetail: false, reasoningPreview: true },
}

/**
 * 取某个档位的能力表；没传档位（只读视图不传 processFold）按标准档走。
 *
 * 返回的是上表里的常量对象，所以同一档位拿到的永远是同一个引用——下游的
 * `useMemo` / `memo` 不会因为这个函数被调用而白算一次。
 *
 * @param fold 过程折叠程度，未传时按 `standard`
 */
export function processFoldPolicy(fold: UiProcessFold | undefined): ProcessFoldPolicy {
  return PROCESS_FOLD_POLICIES[fold ?? 'standard']
}
