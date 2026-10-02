/**
 * 「将做的改动」推演：write / edit 正在执行、结果还没回来时（含审批等待期——
 * adapter 里两者同为 running），从调用参数 + 盘上现值算出这次调用将产生的 diff。
 * 对照 dsh：工具卡在执行前就把「将写入什么」以 diff 摊出来，审批等待期这正是
 * 决定批不批的关键信息（codex 的审批弹窗内嵌 diff 同理）。
 *
 * 推演分两级：
 * 1. 盘上现值读得到（fs-read，工作区内）→ 按工具语义推演写后的全文 → 真实 diff；
 *    edit 还能顺带发现「old 匹配不到 / 匹配多处」——真实执行大概率失败，卡上直接提示。
 * 2. 读不到（工作区外、文件太大、文件尚不存在）→ 回落参数本身：write 视为从空文件
 *    写入（多半真是新建），edit 显示 old→new 的参数差异（dsh 的参数推导口径）。
 *
 * @module desktop/renderer/intended-diff
 */
import { useEffect, useMemo, useState } from 'react'
import { diffLines } from '@dsc/runtime/core/diff-text.js'
import type { ChangedFileView, DiffHunkView, ToolCallView } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import type { ReadResult } from './file-util.js'

/** hunks 的总行数预算（与宿主 summarizeChange 的砍尾口径一致：超了从前往后留、标 truncated）。 */
const MAX_DIFF_LINES = 800

/** 从调用参数解析出的推演输入；解析不出来返回 null（卡上就不出 intended diff）。 */
export interface IntendedInput {
  /** 参数里的目标路径（可能是相对路径，转绝对由 {@link toAbsPath} 做）。 */
  path: string
  /** write 的整写内容 / edit 的替换后的那段文本（参数 `new`）。 */
  content: string
  /** 仅 edit：要被替换的原文（参数 `old`）。 */
  old?: string
}

/** 解析 write / edit 的入参；参数不齐（流式半截 JSON、缺字段）就返回 null。 */
export function parseIntended(name: string, argsText: string): IntendedInput | null {
  if (name !== 'write' && name !== 'edit') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsText)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const path = typeof args.path === 'string' ? args.path : ''
  if (path === '') return null
  if (name === 'write') {
    return typeof args.content === 'string' ? { path, content: args.content } : null
  }
  if (typeof args.old !== 'string' || typeof args.new !== 'string') return null
  return { path, content: args.new, old: args.old }
}

/** 相对路径拼到工作目录下（宿主工具 abs() 的同款判定：绝对形状直接用）。 */
export function toAbsPath(path: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) return path
  if (cwd === '') return path
  const sep = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${path}`
}

/** 「改前 → 改后」算成轮尾卡同款的差异视图；完全一致（写了个寂寞）时返回 null。 */
export function diffToView(path: string, before: string, after: string): ChangedFileView | null {
  const result = diffLines(before, after, 3)
  if (!result.ok || result.hunks.length === 0) return null
  const hunks: DiffHunkView[] = []
  let budget = MAX_DIFF_LINES
  for (const hunk of result.hunks) {
    if (budget <= 0) break
    const lines = hunk.lines.length <= budget ? hunk.lines : hunk.lines.slice(0, budget)
    hunks.push(lines.length === hunk.lines.length ? hunk : { ...hunk, lines })
    budget -= lines.length
  }
  return {
    path,
    added: result.added,
    removed: result.removed,
    hunks,
    ...(hunks.length < result.hunks.length ? { truncated: true } : {}),
    status: before === '' ? 'added' : 'modified',
  }
}

/** 推演结果。 */
export interface IntendedDiff {
  /** 目标绝对路径（fs-read / 打开预览都用它；展示层负责再相对化）。 */
  absPath: string
  /** 推演出的差异；两段内容一致时为 null。 */
  file: ChangedFileView | null
  /** 盘上现值没读到：diff 是从参数推的（edit 的 status「新增」徽标不显示——本来也不会有）。 */
  fellBack: boolean
  /** 仅 edit：old 在盘上匹配不到 / 匹配多处——真实执行会失败，卡上要提示。 */
  mismatch?: 'missing' | 'ambiguous'
}

/**
 * 工具卡的「将做的改动」hook：write / edit 且还在 running 时推演 diff，
 * 结果落地后（status 离开 running）返回 null，卡片回到「参数 + 结果」的常态。
 * proxy 不传（只读视图）就不推演——只读记录没有可用的桥。
 */
export function useIntendedDiff(
  call: ToolCallView,
  cwd: string,
  proxy: RuntimeProxy | undefined,
): IntendedDiff | null {
  const input = useMemo(() => parseIntended(call.name, call.argsText), [call.name, call.argsText])
  const [state, setState] = useState<IntendedDiff | null>(null)
  const absPath = input === null ? null : toAbsPath(input.path, cwd)
  useEffect(() => {
    if (input === null || absPath === null || call.status !== 'running' || proxy === undefined) {
      setState(null)
      return
    }
    let on = true
    setState(null)
    const apply = (before: string | null): void => {
      if (before !== null && input.old !== undefined) {
        const at = before.indexOf(input.old)
        if (at < 0) {
          setState({ absPath, file: diffToView(absPath, input.old, input.content), fellBack: false, mismatch: 'missing' })
          return
        }
        if (before.indexOf(input.old, at + 1) >= 0) {
          setState({ absPath, file: diffToView(absPath, input.old, input.content), fellBack: false, mismatch: 'ambiguous' })
          return
        }
      }
      const fellBack = before === null
      let after: string
      let effectiveBefore: string
      if (input.old === undefined) {
        // write：盘上读不到多半是新建文件——从空串起算，diff 呈现整篇新增
        effectiveBefore = before ?? ''
        after = input.content
      } else if (before !== null) {
        const at = before.indexOf(input.old)
        effectiveBefore = before
        after = before.slice(0, at) + input.content + before.slice(at + input.old.length)
      } else {
        // edit 回落：盘上现值拿不到，old→new 的参数差异是最诚实的下限
        effectiveBefore = input.old
        after = input.content
      }
      setState({ absPath, file: diffToView(absPath, effectiveBefore, after), fellBack })
    }
    void proxy
      .dock('fs-read', { file: absPath })
      .then((raw) => {
        if (!on) return
        const read = raw as ReadResult
        apply(read.kind === 'text' && typeof read.text === 'string' ? read.text : null)
      })
      .catch(() => {
        if (on) apply(null)
      })
    return () => {
      on = false
    }
  }, [absPath, call.status, input, proxy])
  return state
}
