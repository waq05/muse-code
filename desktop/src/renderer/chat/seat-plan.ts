/**
 * 会话流的座位计划：先把每一轮渲染成「用户消息 → 总开关 → 过程区 → 之后 → 页脚」
 * 这张表，再按 entries 原顺序把不属于任何轮的条目插回原位。
 *
 * 为什么要单独一个模块：阶段组的组体要包住「连续的那几条」，渲染必须按块产出；
 * 而哪些条目成组、页脚画在哪一条之后，都要先看完整轮才知道。这份计划是纯函数——
 * 自检可以直接打它（不需要挂 React）。
 *
 * 「哪些条目算过程区」的判据沿用 roundFold 给的那段下标区间，但**计划卡要单独摘出来**：
 * 它可能落在区间里面（夹在两条工具之间），而它是审批流的一部分——收起整轮不能把
 * 「等你点批准」一起藏掉（对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）。
 *
 * @module desktop/renderer/chat/seat-plan
 */
import type { ChangedFileView, TranscriptEntry } from '@dsc/runtime/contract.js'
import type { StepGroup, StepGrouping } from '../process-groups.js'
import { TURN_PROCESS_INDEPENDENT } from '../process-groups.js'
import type { RoundInfo } from '../turn-timing.js'
import type { RoundFold } from './round-fold.js'

/** 一条渲染块：一个独立过程条目，或者一个阶段组（组头 + 组体里的那几条）。 */
export type ChatBlock = { kind: 'row'; index: number } | { kind: 'group'; group: StepGroup; members: number[] }

/**
 * 一轮的座位：用户消息 → 整轮总开关 → 过程区 → 过程区之后 → 页脚。
 *
 * 为什么要先算出这张表再渲染，而不是边遍历边判：阶段组的组体要包住「连续的那几条」，
 * 于是渲染必须按块产出；而哪些条目成组、页脚画在哪一条之后，都要先看完整轮才知道。
 */
export interface RoundSeatPlan {
  round: RoundInfo
  /** 这一轮的过程折叠情况；没有过程内容时是 undefined。 */
  fold: RoundFold | undefined
  /** 用户消息在 entries 里的下标（永远可见，不参与任何折叠）。 */
  lead: number
  /** 整轮总开关画在过程区最前面吗（只有可折的定稿轮为真）。 */
  withFoldRow: boolean
  /** 过程区：整轮收起时整条挂 hidden（但仍在 DOM 里，Ctrl+F 能命中）。 */
  process: ChatBlock[]
  /** 过程区之后那几条（最终回答、计划卡）：永远可见。 */
  after: ChatBlock[]
  /**
   * 这一轮成功 write / edit 的实际改动（changes 条目的聚合）。
   * 条目本身不单独渲染——轮尾统一画一张「文件已更改」卡（dsh 的 turn-tail 位置），
   * 不参与整轮折叠。
   */
  changes: ChangedFileView[]
  /**
   * 回合聚合的改动（`turnDiff` 条目，同文件多刀一份准确差异）。有它优先用——
   * 没有（轮中途 / 重启后重放）才回退把 changes 逐刀合并（mergeChangesByPath）。
   */
  turnDiff: ChangedFileView[] | undefined
  /** 页脚画在这一轮末尾吗（还没回复的轮次不画）。 */
  withFoot: boolean
}

/** 渲染序列里的一项：不属于任何轮的条目，或者一整轮的座位。 */
export type ChatPlanItem = { kind: 'loose'; index: number } | { kind: 'seat'; seat: RoundSeatPlan }

/**
 * 按轮算出座位，再按 entries 的原顺序把不属于任何轮的条目插回原位。
 *
 * @param firstVisibleRound - 从第几轮开始画（更早的轮先不进 DOM，点「加载更早」再放出来）：
 *   分的是渲染量，不是数据量。
 */
export function buildSeatPlan(
  entries: readonly TranscriptEntry[],
  rounds: readonly RoundInfo[],
  roundFold: ReadonlyMap<number, RoundFold>,
  stepGrouping: StepGrouping,
  roundAt: ReadonlyMap<number, RoundInfo>,
  firstVisibleRound: number,
): ChatPlanItem[] {
  const seats = new Map<number, RoundSeatPlan>()
  for (const round of rounds) {
    if (round.index < firstVisibleRound) continue
    const fold = roundFold.get(round.index)
    const process: ChatBlock[] = []
    const after: ChatBlock[] = []
    // 这一轮的文件改动单独收走：条目不进过程区也不进 after，轮尾一张聚合卡代它出场。
    // turnDiff（回合聚合）是整轮一份；changes 是逐刀快照，聚合条目缺席时回退合并它们。
    const changes: ChangedFileView[] = []
    let turnDiff: ChangedFileView[] | undefined
    let withFoldRow = false
    // 总开关画在过程区第一条之前。没有过程内容时（hasContent 为假）改画在用户消息之后——
    // dsh 的整轮控件位置就是「该轮所有起始输入之后、最终答案之前」，那种轮那一行照样出现，
    // 只是画成不可点的（TurnProcessNodeView.tsx:19,44 的 disabled={!canCollapse}）。
    const foldRowAt = fold === undefined || !fold.foldable
      ? -1
      : fold.hasContent ? fold.startIndex : round.startIndex + 1
    for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
      const entry = entries[at]
      if (entry === undefined) continue
      if (entry.kind === 'changes') {
        changes.push(entry.file)
        continue
      }
      if (entry.kind === 'turnDiff') {
        turnDiff = entry.files
        continue
      }
      if (at === foldRowAt) withFoldRow = true
      const head = stepGrouping.headAt.get(at)
      if (head !== undefined) {
        const members: number[] = []
        for (let member = head.startIndex; member <= head.endIndex; member += 1) {
          members.push(member)
          const memberEntry = entries[member]
          if (memberEntry?.kind === 'changes') changes.push(memberEntry.file)
          else if (memberEntry?.kind === 'turnDiff') turnDiff = memberEntry.files
        }
        process.push({ kind: 'group', group: head, members })
        // 组里那几条已经收进组体，跳过（组头只画一次，画在这个块上）
        at = head.endIndex
        continue
      }
      const inProcess =
        fold !== undefined && fold.foldable && fold.hasContent
        && at >= fold.startIndex && at <= fold.endIndex
      // 独立节点不进过程区：收起整轮不能把「等你点批准」「这一轮出错了」也一起藏掉
      // （对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）
      if (inProcess && !TURN_PROCESS_INDEPENDENT.has(entry.kind)) process.push({ kind: 'row', index: at })
      else after.push({ kind: 'row', index: at })
    }
    seats.set(round.index, {
      round,
      fold,
      lead: round.startIndex,
      withFoldRow,
      process,
      after,
      changes,
      turnDiff,
      withFoot: round.answered,
    })
  }
  const items: ChatPlanItem[] = []
  entries.forEach((_entry, index) => {
    const round = roundAt.get(index)
    if (round === undefined) {
      // 不属于任何一轮：开场那条 system 提示、轮之间冒出来的错误提示或宿主通知
      items.push({ kind: 'loose', index })
      return
    }
    // 轮内的其它条目由这一轮的座位自己渲染；只在轮首插一次座位
    if (index !== round.startIndex) return
    const seat = seats.get(round.index)
    if (seat !== undefined) items.push({ kind: 'seat', seat })
  })
  return items
}
