/**
 * 轮尾「文件已更改」聚合卡（对照 dsh ui-deliverables 的 ChangedFiles）。
 *
 * 数据是同一轮里成功落盘的文件改动（`kind: 'changes'` 逐刀条目 + `kind: 'turnDiff'`
 * 回合聚合条目）：有聚合条目就用它（同文件多刀一份准确差异，见宿主 Session 的回合
 * 基线），没有就回退 {@link mergeChangesByPath} 逐刀合并。界面只做聚合与展示，不碰
 * 文件系统——唯一的例外是悬停预览卡：行上停 500ms 会经 fs-read 读文件头几行给你看。
 * 卡头点击展开文件清单；每行「审查」开右侧 diff 面板、「打开」进文件预览页签。
 * 超过 {@link COLLAPSED_ROWS} 行时列表折起，靠底部按钮放全。
 *
 * @module desktop/renderer/ChangedFiles
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ChangedFileView } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { FileIcon } from './file-icons.js'
import { basenameOf, type ReadResult } from './file-util.js'
import { highlightLines, type HighlightedLine } from './diff-highlight.js'

/** 折叠阈值之下的行数（对照 dsh 的 COLLAPSED_ROWS = 4）。 */
const COLLAPSED_ROWS = 4
/** 悬停多久才出预览卡（ms）：短了划过就闪，长了像坏了。 */
const HOVER_DELAY_MS = 500
/** 预览卡最多显示的行数。 */
const PREVIEW_ROWS = 24

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

/** 悬停预览浮层：文件头几行 + 打开入口（挂在 body 下，不被聊天区的滚动/裁剪框住）。 */
function HoverPreview({
  anchor,
  read,
  error,
  preview,
  onOpen,
}: {
  anchor: DOMRect
  read: ReadResult | null
  error: string
  preview: HighlightedLine[] | null
  onOpen?: (path: string) => void
}): JSX.Element | null {
  // 读失败也要出卡：用户等了 500ms，一条「读不到」的说明好过无声无息。
  // read 与 error 都还是空 = 读取中：先把卡壳画出来（骨架），内容到了再填。
  if (read === null && error === '') {
    return createPortal(
      <div className="hover-preview" style={{ left: `${String(anchor.right + 8)}px`, top: `${String(anchor.top)}px` }}>
        <p className="hover-preview-loading">读取中…</p>
      </div>,
      document.body,
    )
  }
  const lines = (read?.text ?? '').split(/\r?\n/)
  const width = 520
  // 优先出现在行的右侧放不下（贴右缘）时改放左侧；纵向夹进视口。
  const flip = anchor.right + width + 16 > window.innerWidth
  const left = flip ? Math.max(8, anchor.left - width - 8) : Math.min(anchor.right + 8, window.innerWidth - width - 8)
  const top = Math.min(Math.max(8, anchor.top), Math.max(8, window.innerHeight - 320))
  return createPortal(
    <div className="hover-preview" style={{ left: `${String(left)}px`, top: `${String(top)}px`, width: `${String(width)}px` }}>
      <div className="hover-preview-head">
        <FileIcon name={read?.path ?? ''} size={14} />
        <span className="hover-preview-name" title={read?.path ?? ''}>
          {basenameOf(read?.path ?? '')}
        </span>
        {read?.tooLarge !== true && read?.text !== undefined && (
          <span className="hover-preview-stat">{`共 ${String(lines.length)} 行`}</span>
        )}
      </div>
      {error !== '' && read === null && <p className="hover-preview-loading">{`读取失败：${error}`}</p>}
      <pre className="hover-preview-body">
        {lines.slice(0, PREVIEW_ROWS).map((line, at) => (
          <div className="hover-preview-line" key={String(at)}>
            {preview !== null && preview[at] !== undefined ? (
              <span dangerouslySetInnerHTML={{ __html: preview[at]!.segments.join('') }} />
            ) : (
              line || ' '
            )}
          </div>
        ))}
        {lines.length > PREVIEW_ROWS && (
          <div className="hover-preview-more">{`… 前 ${String(PREVIEW_ROWS)} 行，共 ${String(lines.length)} 行`}</div>
        )}
      </pre>
      {onOpen !== undefined && (
        <button type="button" className="hover-preview-open" onClick={() => onOpen(read?.path ?? '')}>
          打开文件
        </button>
      )}
    </div>,
    document.body,
  )
}

/**
 * 轮尾聚合卡。
 * @param props.files   这一轮的改动（聚合或逐刀合并后的清单，每文件一条）。
 * @param props.onReview 点「审查」（或单文件时点卡头）：打开右侧 diff 面板并定位到该文件下标。
 *                       不传 = 只读视图（队友运行记录），审查入口整颗不画。
 * @param props.onOpen   点「打开」：进文件预览页签。不传时「打开」不画。
 * @param props.proxy    悬停预览卡读文件头用；不传就不出预览卡（只读视图）。
 */
export function ChangedFilesCard(props: {
  files: ChangedFileView[]
  onReview?: (index: number) => void
  onOpen?: (path: string) => void
  proxy?: RuntimeProxy
}): JSX.Element | null {
  const files = props.files
  const [expanded, setExpanded] = useState(files.length <= COLLAPSED_ROWS)
  // 悬停预览：行上停够 500ms 才去读文件（避免划过一路触发读盘），读一次缓存住。
  const [hover, setHover] = useState<{ path: string; anchor: DOMRect } | null>(null)
  const [read, setRead] = useState<ReadResult | null>(null)
  const [readError, setReadError] = useState('')
  const [preview, setPreview] = useState<HighlightedLine[] | null>(null)
  const timerRef = useRef<number | null>(null)
  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (hover === null) return
    // 换了文件要重新读；同一文件复用缓存。
    if (readFor.current === hover.path && read !== null) return
    setRead(null)
    setReadError('')
    setPreview(null)
    readFor.current = hover.path
    let on = true
    void props.proxy
      ?.dock('fs-read', { file: hover.path })
      .then((data) => {
        if (!on) return
        const result = data as ReadResult
        setRead(result)
        const text = result.text ?? ''
        void highlightLines(text.split(/\r?\n/).slice(0, PREVIEW_ROWS).join('\n'), hover.path).then((lines) => {
          if (on) setPreview(lines)
        })
      })
      .catch((cause: unknown) => {
        if (on) setReadError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      on = false
    }
  }, [hover, props.proxy, read])
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )
  const armHover = (file: ChangedFileView, anchor: DOMRect): void => {
    if (props.proxy === undefined) return
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setHover({ path: file.path, anchor })
    }, HOVER_DELAY_MS)
  }
  const disarmHover = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    setHover(null)
  }
  if (files.length === 0) return null
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const single = files.length === 1 ? files[0] : undefined
  const rows = expanded ? files : files.slice(0, COLLAPSED_ROWS)
  const reviewAt = props.onReview === undefined ? undefined : (index: number) => props.onReview?.(index)
  return (
    <div className="changes-card" data-changed-files data-single={single !== undefined || undefined}>
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
              onMouseLeave={disarmHover}
            >
              <button
                type="button"
                className="changes-row"
                onClick={reviewAt === undefined ? undefined : () => reviewAt(files.indexOf(file))}
              >
                <span className="changes-path" title={file.path}>
                  {file.status === 'added' && <span className="changes-badge">新增</span>}
                  {file.path}
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
        <HoverPreview anchor={hover.anchor} read={read} error={readError} preview={preview} onOpen={props.onOpen} />
      )}
    </div>
  )
}
