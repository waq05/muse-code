/**
 * diff 审查面板（对照 dsh ui-deliverables 的 ReviewTab + FileDiff，v1 只做 unified 视图）。
 *
 * 挂在主区右侧的并排栏：一轮「文件已更改」的文件清单 + 选中文件的差异段。
 * 数据全部来自轮尾卡带上的 `hunks`（宿主在工具执行层算好的 unified 差异），
 * 这里不读文件系统，也不管文件当前又变成了什么样——它审的是「那一刀改了什么」。
 *
 * @module desktop/renderer/DiffPane
 */
import { type JSX } from 'react'
import type { ChangedFileView, DiffHunkView } from '@dsc/runtime/contract.js'
import { FileIcon } from './file-icons.js'

/** 单个文件的 unified diff 渲染：hunk 头 + 行号两列 + 差异行。 */
function FileDiff({ file }: { file: ChangedFileView }): JSX.Element {
  return (
    <div className="diff-body">
      {file.truncated === true && (
        <p className="diff-note">改动较大，这里只显示了前一部分（完整改动以文件当前内容为准）。</p>
      )}
      {file.hunks.map((hunk, index) => (
        <div className="diff-hunk" key={String(index)}>
          <div className="diff-hunk-head">{`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`}</div>
          {hunk.lines.map((line, at) => (
            <DiffRow line={line} key={String(at)} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** 一行差异：旧行号 / 新行号 / 记号 / 内容，底色按增删着。 */
function DiffRow({ line }: { line: DiffHunkView['lines'][number] }): JSX.Element {
  const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
  return (
    <div className={`diff-line diff-${kind}`}>
      <span className="diff-no">{line.oldLine === null ? '' : String(line.oldLine)}</span>
      <span className="diff-no">{line.newLine === null ? '' : String(line.newLine)}</span>
      <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
      <span className="diff-text">{line.text}</span>
    </div>
  )
}

/**
 * 右侧审查栏。
 * @param props.files    这一轮的全部改动（顺序与轮尾卡一致）。
 * @param props.index    当前查看的文件下标。
 * @param props.onSelect 切换文件。
 * @param props.onOpen   打开文件进预览页签。
 * @param props.onClose  关闭整条右栏。
 */
export function DiffPane(props: {
  files: ChangedFileView[]
  index: number
  onSelect: (index: number) => void
  onOpen: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const file = props.files[props.index] ?? props.files[0]
  return (
    <aside className="diff-pane" data-diff-pane>
      <div className="diff-head">
        {props.files.length > 1 ? (
          <select
            className="diff-file-select"
            value={String(props.index)}
            onChange={(event) => props.onSelect(Number(event.target.value))}
            aria-label="选择要审查的文件"
          >
            {props.files.map((entry, at) => (
              <option key={entry.path} value={String(at)}>
                {entry.path}
              </option>
            ))}
          </select>
        ) : (
          file !== undefined && (
            <span className="diff-file-name" title={file.path}>
              {file.path}
            </span>
          )
        )}
        {file !== undefined && (
          <span className="changes-counts">
            <span className="changes-added">{`+${String(file.added)}`}</span>
            <span className="changes-removed">{`-${String(file.removed)}`}</span>
          </span>
        )}
        <span className="diff-tools">
          {file !== undefined && (
            <>
              <FileIcon name={file.path} size={15} />
              <button type="button" className="diff-tool" data-tip="在文件面板中打开" onClick={() => props.onOpen(file.path)}>
                打开
              </button>
            </>
          )}
          <button type="button" className="diff-tool" data-tip="关闭审查" onClick={props.onClose}>
            关闭
          </button>
        </span>
      </div>
      {file === undefined ? <p className="diff-note">这一轮没有可审查的改动。</p> : <FileDiff file={file} />}
    </aside>
  )
}
