/**
 * 轮尾「文件已更改」聚合卡（对照 dsh ui-deliverables 的 ChangedFiles）。
 *
 * 数据是同一轮里成功 write / edit 的实际改动（`kind: 'changes'` 条目，
 * 宿主在工具执行层算好 diff 挂上来的）——界面只做聚合与展示，不碰文件系统。
 * 卡头点击展开文件清单；每行「审查」开右侧 diff 面板、「打开」进文件预览页签。
 * 超过 {@link COLLAPSED_ROWS} 行时列表折起，靠底部按钮放全。
 *
 * @module desktop/renderer/ChangedFiles
 */
import { useState, type JSX } from 'react'
import type { ChangedFileView } from '@dsc/runtime/contract.js'
import { FileIcon } from './file-icons.js'

/** 折叠阈值之下的行数（对照 dsh 的 COLLAPSED_ROWS = 4）。 */
const COLLAPSED_ROWS = 4

/** 这一轮的全部改动聚合出来的合计。 */
export interface ChangesTotal {
  files: ChangedFileView[]
  added: number
  removed: number
}

/** 同一轮 changes 条目的合计（纯函数，ChatView 聚合时用）。 */
export function sumChanges(files: ChangedFileView[]): ChangesTotal {
  let added = 0
  let removed = 0
  for (const file of files) {
    added += file.added
    removed += file.removed
  }
  return { files, added, removed }
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
 * 轮尾聚合卡。
 * @param props.total   同一轮的合计（见 {@link sumChanges}）。
 * @param props.onReview  点「审查」（或单文件时点卡头）：打开右侧 diff 面板并定位到该文件下标。
 *                        不传 = 只读视图（队友运行记录），审查入口整颗不画。
 * @param props.onOpen    点「打开」：进文件预览页签。不传时「打开」不画。
 */
export function ChangedFilesCard(props: {
  total: ChangesTotal
  onReview?: (index: number) => void
  onOpen?: (path: string) => void
}): JSX.Element | null {
  const { files, added, removed } = props.total
  const [expanded, setExpanded] = useState(files.length <= COLLAPSED_ROWS)
  if (files.length === 0) return null
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
            <li key={file.path} className="changes-row-wrap">
              <button
                type="button"
                className="changes-row"
                onClick={reviewAt === undefined ? undefined : () => reviewAt(files.indexOf(file))}
              >
                <span className="changes-path" title={file.path}>
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
    </div>
  )
}
