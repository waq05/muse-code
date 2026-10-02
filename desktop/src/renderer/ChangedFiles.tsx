/**
 * 轮尾「文件已更改」聚合卡（对照 dsh ui-deliverables 的 ChangedFiles）。
 *
 * 数据是同一轮里成功落盘的文件改动（`kind: 'changes'` 逐刀条目 + `kind: 'turnDiff'`
 * 回合聚合条目）：有聚合条目就用它（同文件多刀一份准确差异，见宿主 Session 的回合
 * 基线），没有就回退 {@link mergeChangesByPath} 逐刀合并。界面只做聚合与展示，不碰
 * 文件系统——悬停预览也只用 hunks：行上停 500ms 出该文件的 diff（dsh HoverCard 的
 * preview 口径：不读盘、没有工作目录限制）。卡头点击展开文件清单；每行「审查」开
 * 右侧 diff 面板、「打开」进文件预览页签。超过 {@link COLLAPSED_ROWS} 行时列表折起，
 * 靠底部按钮放全。
 *
 * @module desktop/renderer/ChangedFiles
 */
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ChangedFileView } from '@dsc/runtime/contract.js'
import { FileIcon } from './file-icons.js'
import { displayPathOf } from './file-util.js'
import { DiffRows } from './DiffPane.js'
import { useHoverDelay } from './hover-delay.js'

/** 折叠阈值之下的行数（对照 dsh 的 COLLAPSED_ROWS = 4）。 */
const COLLAPSED_ROWS = 4

/**
 * 同一文件改了多刀时合并成一条（回退路径：轮中途没有聚合条目、或重启后重放的是
 * 逐刀日志）。增删行数相加、hunks 顺序拼接——第二刀的行号基于第一刀之后的文件，
 * 拼着看有偏差，历史会话里如实降级即可；实时回合走聚合条目，没有这个问题。
 */
export function mergeChangesByPath(files: ChangedFileView[]): ChangedFileView[] {
  const byPath = new Map<string, ChangedFileView>()
  for (const file of files) {
    const existing = byPath.get(file.path)
    if (existing === undefined) {
      byPath.set(file.path, { ...file })
      continue
    }
    existing.added += file.added
    existing.removed += file.removed
    existing.hunks = [...existing.hunks, ...file.hunks]
    if (file.status === 'added') existing.status = 'added'
    if (file.truncated === true) existing.truncated = true
  }
  return [...byPath.values()]
}

/** 增删计数（绿 + / 红 -；dsh 的 Counts 口径）。 */
function Counts({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="changes-counts">
      <span className="changes-added">{`+${String(added)}`}</span>
      <span className="changes-removed">{`-${String(removed)}`}</span>
    </span>
  )
}

/**
 * 悬停预览浮层（dsh HoverCard 的 preview 规格）：显示**该文件的 diff**——hunks 数据
 * 就在条目上，不读盘、没有工作目录限制；宽 = 聚合卡宽 − 48，锚上方优先、放不下落
 * 下方，maxHeight 420。挂在 body 下，不被聊天区的滚动/裁剪框住。
 *
 * Escape 关闭走 capture：审批卡在冒泡阶段监听 Esc=拒绝，预览开着时按 Esc 只该收预览。
 */
export function DiffHoverCard({
  file,
  anchor,
  cardWidth,
  cwd = '',
  onKeep,
  onClose,
}: {
  file: ChangedFileView
  anchor: DOMRect
  cardWidth: number
  /** 工作目录：头行显示相对路径，title 保留全路径。 */
  cwd?: string
  /** 鼠标移进卡里：取消「移开 100ms 后收卡」的倒计时，用户能与卡内容交互。 */
  onKeep: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const width = Math.max(320, Math.min(cardWidth - 48, window.innerWidth - 16))
  const maxHeight = Math.min(420, window.innerHeight - 24)
  // 上方放得下（按上限估）就贴行上方，否则落行下方；横向夹进视口
  const left = Math.min(Math.max(8, anchor.left - 24), Math.max(8, window.innerWidth - width - 8))
  const style: CSSProperties =
    anchor.top - 12 >= maxHeight
      ? { left: `${String(left)}px`, bottom: `${String(window.innerHeight - anchor.top + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
      : { left: `${String(left)}px`, top: `${String(anchor.bottom + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
  return createPortal(
    <div className="hover-preview" style={style} onMouseEnter={onKeep}>
      <div className="hover-preview-head">
        <FileIcon name={file.path} size={14} />
        <span className="hover-preview-name" title={file.path}>
          {displayPathOf(file.path, cwd)}
        </span>
        <span className="hover-preview-stat">
          {file.status === 'added' && <span className="diff-badge">新增</span>}
          <span className="changes-added">{`+${String(file.added)}`}</span>
          <span className="changes-removed">{`-${String(file.removed)}`}</span>
        </span>
      </div>
      <div className="hover-preview-diff">
        <DiffRows hunks={file.hunks} path={file.path} />
      </div>
    </div>,
    document.body,
  )
}

/**
 * 轮尾聚合卡。
 * @param props.files   这一轮的改动（聚合或逐刀合并后的清单，每文件一条）。
 * @param props.cwd     工作目录：文件行显示相对路径（title 保留全路径）。
 * @param props.onReview 点「审查」（或单文件时点卡头）：打开右侧 diff 面板并定位到该文件下标。
 *                       不传 = 只读视图（队友运行记录），审查入口整颗不画。
 * @param props.onOpen   点「打开」：进文件预览页签。不传时「打开」不画。
 */
export function ChangedFilesCard(props: {
  files: ChangedFileView[]
  cwd?: string
  onReview?: (index: number) => void
  onOpen?: (path: string) => void
}): JSX.Element | null {
  const files = props.files
  const [expanded, setExpanded] = useState(files.length <= COLLAPSED_ROWS)
  // 悬停预览：行上停够 500ms 才出卡（避免划过一路闪卡）；移开 100ms 后收，移进卡里续命。
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hoverDelay = useHoverDelay<ChangedFileView>()
  const { hover } = hoverDelay
  const armHover = (file: ChangedFileView, anchor: DOMRect): void => {
    hoverDelay.arm(file, anchor, cardRef.current?.offsetWidth ?? 480)
  }
  if (files.length === 0) return null
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const single = files.length === 1 ? files[0] : undefined
  const rows = expanded ? files : files.slice(0, COLLAPSED_ROWS)
  const reviewAt = props.onReview === undefined ? undefined : (index: number) => props.onReview?.(index)
  return (
    <div className="changes-card" ref={cardRef} data-changed-files data-single={single !== undefined || undefined}>
      <button
        type="button"
        className="changes-head"
        onClick={reviewAt === undefined ? undefined : () => reviewAt(files.indexOf(single ?? files[0]!))}
      >
        <span className="changes-tile">
          {single === undefined ? (
            <FileIcon name={files[0]?.path ?? ''} size={20} />
          ) : (
            <FileIcon name={single.path} size={20} />
          )}
        </span>
        <span className="changes-titles">
          <span className="changes-title">
            {single === undefined
              ? `${String(files.length)} 个文件已更改`
              : single.path.split(/[\\/]/).pop() ?? single.path}
          </span>
          <span className="changes-stat">
            <Counts added={added} removed={removed} />
            {reviewAt !== undefined && <span className="changes-hint">点击审查改动</span>}
          </span>
        </span>
      </button>
      {single === undefined && (
        <ul className="changes-list">
          {rows.map((file) => (
            <li
              key={file.path}
              className="changes-row-wrap"
              onMouseEnter={(event) => armHover(file, event.currentTarget.getBoundingClientRect())}
              onMouseLeave={hoverDelay.disarm}
            >
              <button
                type="button"
                className="changes-row"
                onClick={reviewAt === undefined ? undefined : () => reviewAt(files.indexOf(file))}
              >
                <span className="changes-path" title={file.path}>
                  {file.status === 'added' && <span className="changes-badge">新增</span>}
                  {displayPathOf(file.path, props.cwd ?? '')}
                </span>
                <Counts added={file.added} removed={file.removed} />
              </button>
              <span className="changes-act">
                {reviewAt !== undefined && (
                  <button type="button" className="changes-btn" onClick={() => reviewAt(files.indexOf(file))}>
                    审查
                  </button>
                )}
                {props.onOpen !== undefined && (
                  <button type="button" className="changes-btn" onClick={() => props.onOpen?.(file.path)}>
                    打开
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {single === undefined && files.length > COLLAPSED_ROWS && (
        <button type="button" className="changes-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : `展开全部 ${String(files.length)} 个文件`}
        </button>
      )}
      {single !== undefined && (
        <div className="changes-act changes-act-single">
          {reviewAt !== undefined && (
            <button type="button" className="changes-btn" onClick={() => reviewAt(0)}>
              审查
            </button>
          )}
          {props.onOpen !== undefined && (
            <button type="button" className="changes-btn" onClick={() => props.onOpen?.(single.path)}>
              打开
            </button>
          )}
        </div>
      )}
      {hover !== null && (
        <DiffHoverCard
          file={hover.item}
          anchor={hover.anchor}
          cardWidth={hover.cardWidth}
          cwd={props.cwd ?? ''}
          onKeep={hoverDelay.keep}
          onClose={hoverDelay.close}
        />
      )}
    </div>
  )
}
