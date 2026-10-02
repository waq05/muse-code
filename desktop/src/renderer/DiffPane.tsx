/**
 * diff 审查面板（对照 dsh ui-deliverables 的 ReviewTab + FileDiff，渲染细节参考
 * codex tui 的 diff_render：整块语法高亮、超限降级、行号 gutter + 全行底色）。
 *
 * 挂在主区右侧的并排栏：一轮「文件已更改」的文件清单 + 选中文件的差异段。
 * 数据全部来自轮尾卡带上的 `hunks`（宿主在工具执行层算好的差异）——这里不读文件系统，
 * 审的是「那一刀改了什么」的快照；要看文件当前内容走「打开」进预览页签。
 *
 * 视图状态都记忆在 localStorage：unified ⇄ split（`dsc.diffView`）、
 * 自动换行（`dsc.diffWrap`）、面板宽度（`dsc.diffPaneWidth`，左缘可拖）。
 *
 * @module desktop/renderer/DiffPane
 */
import { useEffect, useState, type JSX } from 'react'
import type { ChangedFileView, DiffHunkView, DiffLineView } from '@dsc/runtime/contract.js'
import { FileIcon } from './file-icons.js'
import { displayPathOf } from './file-util.js'
import { highlightLines, type HighlightedLine } from './diff-highlight.js'
import { readRootPx, readStoredPx, setRootVar, useWidthDrag, writeStoredPx } from './panels.js'

/** 视图 / 换行 / 宽度的 localStorage 键与 CSS 变量名。 */
const VIEW_KEY = 'dsc.diffView'
const WRAP_KEY = 'dsc.diffWrap'
const PANE_W_KEY = 'dsc.diffPaneWidth'
const PANE_W_VAR = '--dsc-diff-pane-w'
/** 面板宽度拖拽区间（px），与 CSS 的回退 clamp 同源。 */
const PANE_W_MIN = 320
const PANE_W_MAX = 900

/** 一行内容（高亮或纯文本回落，渲染共用）。 */
function LineText({ text, highlight }: { text: string; highlight?: HighlightedLine }): JSX.Element {
  if (highlight === undefined) return <span className="diff-text">{text}</span>
  return <span className="diff-text" dangerouslySetInnerHTML={{ __html: highlight.segments.join('') }} />
}

/** 一行差异（unified 视图）：旧行号 / 新行号 / 记号 / 内容，底色按增删着。 */
function DiffRow({ line, highlight }: { line: DiffLineView; highlight?: HighlightedLine }): JSX.Element {
  const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
  return (
    <div className={`diff-line diff-${kind}`}>
      <span className="diff-no">{line.oldLine === null ? '' : String(line.oldLine)}</span>
      <span className="diff-no">{line.newLine === null ? '' : String(line.newLine)}</span>
      <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
      <LineText text={line.text} highlight={highlight} />
    </div>
  )
}

/** split 视图的行对：左 = 旧文件（context+remove），右 = 新文件（context+add），缺的一侧补空。 */
interface SplitPair {
  left: DiffLineView | null
  right: DiffLineView | null
}

/**
 * 把 hunk 的行配成 split 行对：连续的 remove 段与 add 段按顺序 zip（多余一侧补空行），
 * context 行左右各一份。
 */
function hunkPairs(lines: DiffLineView[]): SplitPair[] {
  const pairs: SplitPair[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]!
    if (line.kind === 'context') {
      pairs.push({ left: line, right: line })
      at += 1
      continue
    }
    let removes = 0
    let cursor = at
    while (cursor < lines.length && lines[cursor]!.kind === 'remove') {
      removes += 1
      cursor += 1
    }
    let adds = 0
    while (cursor < lines.length && lines[cursor]!.kind === 'add') {
      adds += 1
      cursor += 1
    }
    const count = Math.max(removes, adds)
    for (let offset = 0; offset < count; offset += 1) {
      pairs.push({
        left: offset < removes ? lines[at + offset]! : null,
        right: offset < adds ? lines[at + removes + offset]! : null,
      })
    }
    at = cursor
  }
  return pairs
}

/** split 行的半边（一列）：行号 / 记号 / 内容，空半边画淡占位。 */
function HalfCell({
  line,
  show,
  highlight,
}: {
  line: DiffLineView | null
  show: 'old' | 'new'
  highlight?: HighlightedLine
}): JSX.Element {
  if (line === null) {
    return (
      <span className="diff-half diff-half-empty">
        <span className="diff-no" />
        <span className="diff-sign" />
        <span className="diff-text" />
      </span>
    )
  }
  const kind = line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'
  return (
    <span className={`diff-half diff-half-${kind}`}>
      <span className="diff-no">{(show === 'old' ? line.oldLine : line.newLine) ?? ''}</span>
      <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
      <LineText text={line.text} highlight={highlight} />
    </span>
  )
}

/**
 * 一份差异的行渲染（hunk 头 + unified/split 正文）。审查面板、工具卡的「将做的改动」、
 * 审批卡内嵌、悬停预览四处共用这一份（dsh 的 CHAT_DIFF 渲染口径：同一套行样式走天下）。
 *
 * 高亮是异步的——先出纯文本，tokens 回来后重绘；所有 hunk 的行按顺序拼成一段代码
 * 整块喂 shiki（保解析器跨行状态），按行映射回各处。`wrap` 控制长行折行还是横向滚，
 * 由各复用点自己决定（审查面板跟随头部开关；内嵌小窗一律横向滚，diff 折行反而难读）。
 */
export function DiffRows({
  hunks,
  path,
  split = false,
  wrap = false,
}: {
  hunks: DiffHunkView[]
  /** 文件路径：给 shiki 推断高亮语言；拿不到就传空串（不出高亮）。 */
  path: string
  split?: boolean
  wrap?: boolean
}): JSX.Element {
  const [highlights, setHighlights] = useState<HighlightedLine[] | null>(null)
  // 拼接放渲染体里、effect 认字符串：hunks 数组每次渲染都是新引用时也不会反复触发高亮。
  const code = hunks.map((hunk) => hunk.lines.map((line) => line.text).join('\n')).join('\n')
  useEffect(() => {
    let on = true
    setHighlights(null)
    void highlightLines(code, path).then((result) => {
      if (on) setHighlights(result)
    })
    return () => {
      on = false
    }
  }, [code, path])
  /** 当前 hunk 起始行在整块高亮结果里的下标。 */
  let cursor = 0
  return (
    <div className="diff-body" data-split={split || undefined} data-wrap={wrap || undefined}>
      {hunks.map((hunk, index) => {
        const head = cursor
        cursor += hunk.lines.length
        return <HunkBlock hunk={hunk} key={String(index)} split={split} highlights={highlights} head={head} />
      })}
    </div>
  )
}

/** 审查面板里单个文件：截断提示 + 差异正文。 */
function FileDiff({ file, split, wrap }: { file: ChangedFileView; split: boolean; wrap: boolean }): JSX.Element {
  return (
    <>
      {file.truncated === true && (
        <p className="diff-note">改动较大，这里只显示了前一部分（完整改动以文件当前内容为准）。</p>
      )}
      <DiffRows hunks={file.hunks} path={file.path} split={split} wrap={wrap} />
    </>
  )
}

/** 一个 hunk：头行 + 正文（unified 或 split）。 */
function HunkBlock({
  hunk,
  split,
  highlights,
  head,
}: {
  hunk: DiffHunkView
  split: boolean
  highlights: HighlightedLine[] | null
  head: number
}): JSX.Element {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head">{`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`}</div>
      {split ? (
        hunkPairs(hunk.lines).map((pair, at) => (
          <span className="diff-split-row" key={String(at)}>
            <HalfCell line={pair.left} show="old" highlight={highlights?.[head + at]} />
            <HalfCell line={pair.right} show="new" highlight={highlights?.[head + at]} />
          </span>
        ))
      ) : (
        hunk.lines.map((line, at) => (
          <DiffRow line={line} highlight={highlights?.[head + at]} key={String(at)} />
        ))
      )}
    </div>
  )
}

/**
 * 右侧审查栏。
 * @param props.files        这一轮的全部改动（合并去重后，顺序与轮尾卡一致）。
 * @param props.index        当前查看的文件下标。
 * @param props.cwd          工作目录：头部文件名显示相对路径（title 全路径）。
 * @param props.onSelect     切换文件。
 * @param props.onOpen       打开文件进预览页签（看当前内容）。
 * @param props.onOpenSystem 用系统默认程序打开文件；不传时按钮不画。
 * @param props.onClose      关闭整条右栏。
 */
export function DiffPane(props: {
  files: ChangedFileView[]
  index: number
  cwd?: string
  onSelect: (index: number) => void
  onOpen: (path: string) => void
  onOpenSystem?: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const [split, setSplit] = useState(() => localStorage.getItem(VIEW_KEY) === 'split')
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === 'wrap')
  // 挂载时把存档宽度回灌进 CSS 变量（flex-basis 走 var）；没存档就是 CSS 里的默认 clamp。
  useEffect(() => {
    const saved = readStoredPx(PANE_W_KEY, PANE_W_MIN, PANE_W_MAX)
    if (saved !== null) setRootVar(PANE_W_VAR, `${String(saved)}px`)
  }, [])
  const drag = useWidthDrag({
    getBase: () => readRootPx(PANE_W_VAR, 480),
    // 面板在右、热区在左缘：指针向左移（dx 为负）面板变宽，方向取反
    sign: -1,
    clamp: (px) => Math.min(PANE_W_MAX, Math.max(PANE_W_MIN, px)),
    onDrag: (px) => setRootVar(PANE_W_VAR, `${String(px)}px`),
    onCommit: (px) => writeStoredPx(PANE_W_KEY, px),
  })
  const resetWidth = (): void => {
    writeStoredPx(PANE_W_KEY, null)
    setRootVar(PANE_W_VAR, null)
  }
  const toggleSplit = (): void => {
    setSplit((current) => {
      localStorage.setItem(VIEW_KEY, current ? 'unified' : 'split')
      return !current
    })
  }
  const toggleWrap = (): void => {
    setWrap((current) => {
      localStorage.setItem(WRAP_KEY, current ? 'nowrap' : 'wrap')
      return !current
    })
  }
  const file = props.files[props.index] ?? props.files[0]
  return (
    <aside className="diff-pane" data-diff-pane>
      <div
        className="diff-resizer"
        {...drag}
        onDoubleClick={resetWidth}
        data-tip="拖拽调宽 · 双击复位"
        aria-label="调整审查面板宽度"
      />
      <div className="diff-head">
        {props.files.length > 1 ? (
          <select
            className="diff-file-select"
            value={String(props.index)}
            onChange={(event) => props.onSelect(Number(event.target.value))}
            aria-label="选择要审查的文件"
          >
            {props.files.map((entry, at) => (
              <option key={entry.path} value={String(at)} title={entry.path}>
                {displayPathOf(entry.path, props.cwd ?? '')}
              </option>
            ))}
          </select>
        ) : (
          file !== undefined && (
            <span className="diff-file-name" title={file.path}>
              {displayPathOf(file.path, props.cwd ?? '')}
            </span>
          )
        )}
        {file !== undefined && (
          <span className="changes-counts">
            {file.status === 'added' && <span className="diff-badge">新增</span>}
            <span className="changes-added">{`+${String(file.added)}`}</span>
            <span className="changes-removed">{`-${String(file.removed)}`}</span>
          </span>
        )}
        <span className="diff-tools">
          <button type="button" className="diff-tool" aria-pressed={split} data-tip="分栏 / 合并视图" onClick={toggleSplit}>
            {split ? '合并' : '分栏'}
          </button>
          <button type="button" className="diff-tool" aria-pressed={wrap} data-tip="长行自动换行" onClick={toggleWrap}>
            换行
          </button>
          {file !== undefined && (
            <>
              <FileIcon name={file.path} size={15} />
              {props.onOpenSystem !== undefined && (
                <button
                  type="button"
                  className="diff-tool"
                  data-tip="用系统默认程序打开"
                  onClick={() => props.onOpenSystem?.(file.path)}
                >
                  系统打开
                </button>
              )}
              <button
                type="button"
                className="diff-tool"
                data-tip="在文件面板中打开当前文件（审查内容是修改当时的快照）"
                onClick={() => props.onOpen(file.path)}
              >
                打开
              </button>
            </>
          )}
          <button type="button" className="diff-tool" data-tip="关闭审查" onClick={props.onClose}>
            关闭
          </button>
        </span>
      </div>
      {file === undefined ? (
        <p className="diff-note">这一轮没有可审查的改动。</p>
      ) : (
        <FileDiff file={file} split={split} wrap={wrap} />
      )}
    </aside>
  )
}
