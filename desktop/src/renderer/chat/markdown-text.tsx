/**
 * 会话流里的 markdown 正文渲染：remark-gfm + 文件提及 chip。
 *
 * 为什么要单独一个模块：正文渲染带着自己的悬停状态（useHoverDelay）与 inline code
 * 改写规则（`pre`/`code` 两级覆盖），是 ChatView 里最独立的一块展示件——直播尾、
 * 定稿正文两处复用，改动不必在主组件 1200 行里找。
 *
 * @module desktop/renderer/chat/markdown-text
 */
import { cloneElement, isValidElement, type JSX, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChangedFileView } from '@dsc/runtime/contract.js'
import { DiffHoverCard } from '../ChangedFiles.js'
import { useHoverDelay } from '../hover-delay.js'
import { FileIcon } from '../file-icons.js'

/**
 * inline code 文本 ↔ 本轮改动文件的提及匹配（dsh producedFileMentions 的思路）：
 * 精确相等，或命中路径以分隔符结尾的后缀（`fs-tools.ts` 命中 `…/core/fs-tools.ts`）。
 * 带 `\n` 的不是 inline（fenced 块），短得像扩展名的（`md`）不会越过分隔符边界误命中。
 */
function matchMentionPath(text: string, paths: ReadonlyMap<string, ChangedFileView>): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.includes('\n')) return undefined
  if (paths.has(trimmed)) return trimmed
  for (const path of paths.keys()) {
    if (path.endsWith(`/${trimmed}`) || path.endsWith(`\\${trimmed}`)) return path
  }
  return undefined
}

/**
 * 一条助手正文的 markdown 渲染（会话流同款 remark-gfm），外加文件提及 chip：
 * inline code 命中本轮改动文件时变成可点的文件徽章——点击进预览页签，悬停停够
 * 半秒出该文件的 diff（与轮尾卡文件行同一份悬停预览，dsh 的 producedFileMentions
 * 也带 hover 预览）。块级 code 用 `pre` 覆盖给子元素打 `data-block` 标记来区分——
 * fenced 块没有 language- 类名时不能靠 className 判定，误判会把整块代码变成一颗 chip。
 */
export function MarkdownText({
  text,
  mentionPaths,
  onOpenFile,
  cwd = '',
}: {
  text: string
  mentionPaths: ReadonlyMap<string, ChangedFileView>
  onOpenFile?: (path: string) => void
  /** 工作目录：悬停预览头行显示相对路径。 */
  cwd?: string
}): JSX.Element {
  const hoverDelay = useHoverDelay<ChangedFileView>()
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre(props) {
            const { children, ...rest } = props
            const child = Array.isArray(children) ? children[0] : children
            return (
              <pre {...rest}>
                {isValidElement(child)
                  ? cloneElement(child as ReactElement<Record<string, unknown>>, { 'data-block': true })
                  : child}
              </pre>
            )
          },
          code(props) {
            const { className, children, node: _node, ...rest } = props
            const block = (rest as Record<string, unknown>)['data-block'] === true
            if (block || className !== undefined) return <code className={className} {...rest}>{children}</code>
            const hit = matchMentionPath(String(children ?? ''), mentionPaths)
            if (hit === undefined || onOpenFile === undefined) return <code {...rest}>{children}</code>
            return (
              <button
                type="button"
                className="mention-chip"
                title={hit}
                onClick={() => onOpenFile(hit)}
                onMouseEnter={(event) => {
                  const file = mentionPaths.get(hit)
                  if (file === undefined) return
                  // 卡宽取所在消息气泡的宽（dsh 的 preview 宽 = 触发卡宽 − 48）；
                  // 拿不到就用 520 的兜底。
                  const host = (event.currentTarget as HTMLElement).closest('.entry-text')
                  hoverDelay.arm(file, event.currentTarget.getBoundingClientRect(), (host?.clientWidth ?? 568) - 48)
                }}
                onMouseLeave={hoverDelay.disarm}
              >
                <FileIcon name={hit} size={13} />
                {hit.split(/[\\/]/).pop() ?? hit}
              </button>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {hoverDelay.hover !== null && (
        <DiffHoverCard
          file={hoverDelay.hover.item}
          anchor={hoverDelay.hover.anchor}
          cardWidth={hoverDelay.hover.cardWidth}
          cwd={cwd}
          onKeep={hoverDelay.keep}
          onClose={hoverDelay.close}
        />
      )}
    </>
  )
}
