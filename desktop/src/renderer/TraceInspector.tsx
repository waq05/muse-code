/**
 * 轨迹页的检查器：点开一条记录后从右侧滑出的详情面板（对照 dsh 的检查器）。
 *
 * 分区按需求的顺序来：输入 → 输出 → 思考全文 → 计时 → 用量。每一步的口径都是
 * 「有真值才画数，缺就写未记录」——尤其计时：`startedAt` / `durationMs` 老会话与 running
 * 都没有，这里显示「未记录」，不拿条目的 `ts` 冒充发起时刻（`ts` 是最后写入时刻）。
 *
 * 用户消息条目给的是附件区（`entry.images` 缩略图网格）：缩略图复用对话页现成的
 * `.entry-user-images` 图片通道，点开进放大浮层。
 *
 * 关闭方式：右上角 × 与点遮罩（遮罩在 TraceView 里，跟面板同层）。
 *
 * @module desktop/renderer/TraceInspector
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { TranscriptEntry } from '@dsc/runtime/contract.js'
import { IconClose, IconCopy } from './icons.js'
import { toastErr, toastOk } from './components/toast.js'
import { formatClock } from './turn-timing.js'
import { KIND_LABEL, entryUsage, formatClockSeconds, formatTraceDuration, prettyMaybeJson } from './trace-format.js'
import { formatTokens } from './token-estimate.js'

export function TraceInspector(props: {
  entry: TranscriptEntry
  /** 这一条属于第几轮（1 基显示用）；开场步骤与压缩摘要没有轮次，是 null。 */
  round: number | null
  /**
   * 这条条目的 usage 是不是本轮的整轮真值（轮内最后一条带 usage 的条目）。
   * 不是真值也不编：分区里说明「这是累计到这条为止的值」，避免把中间值读成整轮量。
   */
  usageIsRoundTotal: boolean
  onClose: () => void
}): JSX.Element {
  const { entry } = props
  const [zoom, setZoom] = useState<string | null>(null)

  // Esc 与 × 同一条退路：键盘用户不该被迫去点右上角。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setZoom(null)
      props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const usage = entryUsage(entry)
  const usageTotal = usage === null ? null : usage.inputTokens + usage.outputTokens

  const title =
    entry.kind === 'tool'
      ? `${entry.call.name}${props.round === null ? '' : ` · 第 ${String(props.round + 1)} 轮`}`
      : entry.kind === 'user' && props.round !== null
        ? `第 ${String(props.round + 1)} 轮`
        : entry.kind === 'plan'
          ? entry.plan.title
          : ''

  return (
    <aside
      className="trace-inspector"
      data-trace-inspector={String(entry.id)}
      data-kind={entry.kind}
      role="dialog"
      aria-modal="true"
      aria-label="这一条记录的检查器"
    >
      <div className="ti-head">
        <span className="ti-kind">{entry.kind === 'text' ? '正文' : KIND_LABEL[entry.kind]}</span>
        {title !== '' && <span className="ti-title">{title}</span>}
        <button
          type="button"
          className="ti-close"
          data-trace-inspector-close="1"
          data-tip="关闭检查器（Esc 也行）"
          aria-label="关闭检查器"
          onClick={props.onClose}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="ti-body">
        {entry.kind === 'user' && (
          <Section label="消息原文">
            <pre className="ti-code" data-trace-code="user-text">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'user' && (
          <Section label={`附件${entry.images === undefined ? '' : `（${String(entry.images.length)}）`}`}>
            {entry.images === undefined || entry.images.length === 0 ? (
              <div className="ti-empty">这条消息没有附件。</div>
            ) : (
              <Attachments images={entry.images} onZoom={setZoom} />
            )}
          </Section>
        )}

        {entry.kind === 'tool' && <ArgsSection argsText={entry.call.argsText} />}

        {entry.kind === 'tool' && (
          <Section label="输出">
            {entry.call.resultText === undefined || entry.call.resultText === '' ? (
              <div className="ti-empty">
                {entry.call.status === 'running'
                  ? '这次调用还在跑，结果还没回来。'
                  : entry.call.status === 'preparing'
                    ? '这次调用还在准备中（参数没到齐），结果还没回来。'
                    : '这次调用没有输出。'}
              </div>
            ) : (
              <Block text={entry.call.resultText} marker="result" />
            )}
          </Section>
        )}

        {entry.kind === 'thinking' && (
          <Section label="思考全文">
            <pre className="ti-code" data-trace-code="thinking">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'system' && (
          <Section label="通知原文">
            <pre className="ti-code" data-trace-code="system">
              {entry.text}
            </pre>
          </Section>
        )}

        {entry.kind === 'plan' && (
          <Section label="计划全文">
            <pre className="ti-code" data-trace-code="plan">
              {entry.plan.text}
            </pre>
          </Section>
        )}

        <Section label="计时">
          <dl className="ti-facts">
            {entry.kind === 'tool' ? (
              <Fact
                label="发起时刻"
                value={formatClockSeconds(entry.call.startedAt ?? null) ?? '未记录'}
                title="宿主收到 tool/call 那一刻；老会话没有这个字段"
              />
            ) : (
              <Fact
                label="记录时刻"
                value={formatClockSeconds(entry.ts === undefined ? null : entry.ts) ?? '未记录'}
                title="这条条目最后一次写入的时刻（HH:mm:ss）"
              />
            )}
            <Fact
              label="耗时"
              value={
                entry.kind === 'tool'
                  ? (formatTraceDuration(entry.call.durationMs ?? null) ?? '未记录')
                  : '未记录'
              }
              title="结果到达时刻 − 发起时刻；只有工具调用记这个数，缺就写未记录，不编数"
            />
            {entry.kind === 'tool' && (
              <Fact
                label="结果时刻"
                value={formatClock(entry.ts === undefined ? null : entry.ts) ?? '未记录'}
                title="条目 ts：拿到结果那一刻刷新的最后写入时刻"
              />
            )}
          </dl>
        </Section>

        <Section label="用量">
          {usage === null ? (
            <div className="ti-empty">未记录（老会话或重放路径没有用量事件）。</div>
          ) : (
            <dl className="ti-facts">
              <Fact label="输入" value={`${formatTokens(usage.inputTokens)} tok`} />
              <Fact label="输出" value={`${formatTokens(usage.outputTokens)} tok`} />
              <Fact
                label="合计"
                value={`${formatTokens(usageTotal ?? 0)} tok`}
                title={
                  props.usageIsRoundTotal
                    ? '本轮的整轮真值：这一轮所有模型请求的 prompt + completion 之和'
                    : '这是本轮累计到这条为止的值，整轮真值落在本轮最后一条带用量的记录上'
                }
              />
            </dl>
          )}
        </Section>
      </div>

      {zoom !== null && (
        <div
          className="trace-lightbox"
          data-trace-lightbox="1"
          role="dialog"
          aria-modal="true"
          aria-label="放大查看贴图"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="放大的贴图" />
          <button
            type="button"
            className="ti-close lightbox-close"
            data-tip="关闭放大视图"
            aria-label="关闭放大视图"
            onClick={(event) => {
              event.stopPropagation()
              setZoom(null)
            }}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
    </aside>
  )
}

/** 分区壳子：标题 + 内容，标题右侧可以挂工具条（复制 / 格式化）。 */
function Section({
  label,
  children,
  extra,
}: {
  label: string
  children: ReactNode
  extra?: ReactNode
}): JSX.Element {
  return (
    <section className="ti-sec">
      <div className="ti-sec-head">
        <span className="ti-label">{label}</span>
        {extra}
      </div>
      {children}
    </section>
  )
}

/** 计时与用量的一行读数。 */
function Fact({ label, value, title }: { label: string; value: string; title?: string }): JSX.Element {
  return (
    <div className="ti-fact" title={title} data-trace-fact={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * 入参区：带「格式化」开关与「复制参数」。
 *
 * 格式化开关只在原文真的能解析成 JSON 时给出——半截 JSON（模型偶尔吐的那种）点了也不会有
 * 变化，给一个点了没反应的开关比不给更糟。
 */
function ArgsSection({ argsText }: { argsText: string }): JSX.Element {
  const pretty = prettyMaybeJson(argsText)
  /** 能解析才默认美化；原样就是美化结果时开关初始为「原样」。 */
  const [formatted, setFormatted] = useState(pretty.formatted)
  const shown = formatted && pretty.formatted ? pretty.text : argsText

  const copy = (): void => {
    // 复制的是**原文**：JSON 美化过的那份带缩进，粘到别处反而多出空白。
    void navigator.clipboard.writeText(argsText).then(
      () => {
        toastOk('已复制参数原文')
      },
      () => {
        toastErr('复制失败：剪贴板不可用')
      },
    )
  }

  return (
    <Section
      label="输入"
      extra={
        <span className="ti-tools">
          {pretty.formatted && (
            <button
              type="button"
              className="ti-btn"
              data-trace-format-toggle="args"
              data-state={formatted ? 'pretty' : 'raw'}
              data-tip="在原文与缩进美化之间切换（原文才是模型真正发出的那串）"
              onClick={() => setFormatted((current) => !current)}
            >
              {formatted ? '原文' : '格式化'}
            </button>
          )}
          <button
            type="button"
            className="ti-btn"
            data-trace-copy-args="1"
            data-tip="复制参数原文（不带缩进）"
            onClick={copy}
          >
            <IconCopy size={12} />
            复制参数
          </button>
        </span>
      }
    >
      <Block text={shown} marker="args" formatted={formatted && pretty.formatted} />
    </Section>
  )
}

/** 原文块：父组件给什么画什么（格式化与否是 ArgsSection 的状态），等宽字体、可横向滚动。
 *  这里绝不能再自己美化一遍——那样「切回原文」会被悄悄格式化回去，开关就失效了。 */
function Block({
  text,
  marker,
  formatted = false,
}: {
  text: string
  marker: string
  formatted?: boolean
}): JSX.Element {
  return (
    <pre className="ti-code" data-trace-code={marker} data-formatted={formatted ? '1' : '0'}>
      {text}
    </pre>
  )
}

/** 附件缩略图网格：图片通道复用对话页的 .entry-user-images（尺寸与圆角同款）。 */
function Attachments({
  images,
  onZoom,
}: {
  images: string[]
  onZoom: (url: string) => void
}): JSX.Element {
  return (
    <div className="entry-user-images ti-shots" data-trace-attachments={String(images.length)}>
      {images.map((url, index) => (
        <button
          key={index}
          type="button"
          className="ti-shot"
          data-trace-shot={String(index)}
          data-tip="点开看原图"
          onClick={() => onZoom(url)}
        >
          <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
        </button>
      ))}
    </div>
  )
}
