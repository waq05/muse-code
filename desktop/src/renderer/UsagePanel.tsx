/**
 * 用量统计（设置 → 用量统计）：对照 dsh「使用统计」页的构图——
 * 顶部一排汇总卡，然后是 GitHub 式的 Token 活动热力图、每日 Token 趋势
 * 折线图（按模型分线）、模型用量环形图。数据来自宿主的 usageStats()
 * （~/.dsc/usage/usage.jsonl 的聚合投影）。
 *
 * 图全用内联 SVG / CSS 网格手画，不引图表库：格子、折线、环带都是简单形状，
 * 颜色全部走 --dsc-* 令牌，深浅主题自动跟随。
 *
 * @module desktop/renderer/UsagePanel
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import type { UsageDayView, UsageModelView, UsageStatsView } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { toastErr } from './components/toast.js'
import { IconChart, IconRefresh } from './icons.js'

/** 折线与环形的取色顺序：品牌蓝打头，后面用语义色顶上。
 *  深色主题的 --dsc-purple 本身是蓝（#7aaaff，见 tokens.css），排第三会和品牌蓝撞色，
 *  所以第三位给 orange，purple 只当第四条的兜底。 */
const SERIES_COLORS = [
  'var(--dsc-accent)',
  'var(--dsc-green)',
  'var(--dsc-orange)',
  'var(--dsc-purple)',
]

/** 数字压成中文习惯的「万 / 亿」（对齐 dsh 的 6.5 亿 / 449.3万）。 */
function fmtTokens(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 1 : 2)} 亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 1 : 1)} 万`
  return String(value)
}

function fmtDate(dateKey: string): string {
  const [, month, day] = dateKey.split('-')
  return `${Number(month)} 月 ${Number(day)} 日`
}

// ── 热力图 ────────────────────────────────────────────────────────────────────

/** 格子边长与间距（px）：设置面板正文宽度约 690px，53 列刚好放下。 */
const CELL = 10
const GAP = 3

type Cell = { day: UsageDayView; level: number } | null

/** 热力图格子：0 = 空档，1..4 = 由少到多。颜色档位见 styles.css 的 .hm-l*。 */
function buildCells(days: UsageDayView[]): { columns: Cell[][]; months: { column: number; label: string }[] } {
  const max = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens))
  const level = (day: UsageDayView): number => {
    const tokens = day.inputTokens + day.outputTokens
    if (tokens <= 0) return 0
    const ratio = tokens / max
    if (ratio > 0.66) return 4
    if (ratio > 0.33) return 3
    if (ratio > 0.1) return 2
    return 1
  }
  const columns: Cell[][] = []
  let current: Cell[] = []
  const months: { column: number; label: string }[] = []
  let lastMonth = -1
  /** 一天进列（真实数据与前置空档都走这条），满了就整列收进 columns。 */
  const pushDay = (cell: Cell, date: Date): void => {
    if (date.getMonth() !== lastMonth) {
      // 月份切换处记一列（列里只要还有一格就能挂标签）
      if (current.length < 7) months.push({ column: columns.length, label: `${date.getMonth() + 1}月` })
      lastMonth = date.getMonth()
    }
    current.push(cell)
    if (current.length === 7) {
      columns.push(current)
      current = []
    }
  }
  // 窗口从今天回溯一整年、对齐到周日（GitHub 的列从周日开始）：
  // 数据只覆盖其中一段，前面的空档也照常铺格子、标月份，热力图才是一张
  // 完整的年历，而不是孤零零贴着左边的一小列。数据早于窗口时以数据起点为准。
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const firstDate = new Date(`${days[0]!.date}T12:00:00`)
  const windowStart = new Date(today.getTime() - 52 * 7 * 86400000)
  const alignedStart = new Date(Math.min(firstDate.getTime(), windowStart.getTime()))
  alignedStart.setDate(alignedStart.getDate() - alignedStart.getDay())
  for (let at = new Date(alignedStart); at < firstDate; at.setDate(at.getDate() + 1)) {
    pushDay(null, new Date(at.getTime()))
  }
  for (const day of days) {
    pushDay({ day, level: level(day) }, new Date(`${day.date}T12:00:00`))
  }
  if (current.length > 0) columns.push(current)
  return { columns, months }
}

function Heatmap(props: { days: UsageDayView[] }): JSX.Element {
  const { columns, months } = useMemo(() => buildCells(props.days), [props.days])
  return (
    <div className="hm">
      <div className="hm-months" style={{ marginLeft: 26 }}>
        {months.map((month) => (
          <span key={`${month.column}-${month.label}`} style={{ left: month.column * (CELL + GAP) }}>
            {month.label}
          </span>
        ))}
      </div>
      <div className="hm-body">
        <div className="hm-weekdays">
          <span style={{ gridRow: 2 }}>一</span>
          <span style={{ gridRow: 4 }}>三</span>
          <span style={{ gridRow: 6 }}>五</span>
        </div>
        <div className="hm-grid" role="img" aria-label="Token 活动热力图">
          {columns.map((column, columnIndex) =>
            column.map((cell, rowIndex) => {
              if (cell === null) return <span key={`${columnIndex}-${rowIndex}`} className="hm-cell hm-l0" />
              const tokens = cell.day.inputTokens + cell.day.outputTokens
              return (
                <span
                  key={`${columnIndex}-${rowIndex}`}
                  className={`hm-cell hm-l${String(cell.level)}`}
                  title={`${cell.day.date} · ${fmtTokens(tokens)} tokens · ${String(cell.day.turns)} 轮`}
                />
              )
            }),
          )}
        </div>
      </div>
      <div className="hm-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`hm-cell hm-l${String(level)}`} />
        ))}
        <span>多</span>
      </div>
    </div>
  )
}

// ── 趋势折线 ──────────────────────────────────────────────────────────────────

const CHART_W = 640
const CHART_H = 210
const CHART_PAD = { left: 52, right: 12, top: 12, bottom: 26 }

/** 把 y 轴上限取到 1/2/2.5/5 × 10^k，刻度线读起来不别扭。 */
function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * power >= value) return factor * power
  }
  return 10 * power
}

function TrendChart(props: { days: UsageDayView[]; models: UsageModelView[] }): JSX.Element {
  const shown = props.models.slice(0, SERIES_COLORS.length)
  const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right
  const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
  const ceiling = niceCeiling(Math.max(1, ...props.days.map((day) => day.inputTokens + day.outputTokens)))
  const x = (index: number): number =>
    CHART_PAD.left + (props.days.length === 1 ? innerW / 2 : (index / (props.days.length - 1)) * innerW)
  const y = (tokens: number): number => CHART_PAD.top + innerH - (tokens / ceiling) * innerH
  const lineFor = (modelKey: string): string =>
    props.days
      .map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(day.byModel[modelKey] ?? 0).toFixed(1)}`)
      .join(' ')
  const labelEvery = Math.max(1, Math.round(props.days.length / 8))
  return (
    <div className="trend">
      <div className="trend-legend">
        {shown.map((model, index) => (
          <span key={model.key} className="trend-legend-item" title={model.key}>
            <i style={{ background: SERIES_COLORS[index] }} />
            {model.key.split('/').pop()}
          </span>
        ))}
        {shown.length === 0 && <span className="trend-legend-item">这段时间没有请求</span>}
      </div>
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="trend-svg" role="img" aria-label="每日 Token 趋势">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1={CHART_PAD.left}
              x2={CHART_W - CHART_PAD.right}
              y1={y(ceiling * ratio)}
              y2={y(ceiling * ratio)}
              className="trend-grid"
            />
            <text x={CHART_PAD.left - 6} y={y(ceiling * ratio) + 3} className="trend-tick" textAnchor="end">
              {fmtTokens(ceiling * ratio)}
            </text>
          </g>
        ))}
        <line x1={CHART_PAD.left} x2={CHART_W - CHART_PAD.right} y1={y(0)} y2={y(0)} className="trend-axis" />
        {shown.map((model, seriesIndex) => (
          <path key={model.key} d={lineFor(model.key)} className="trend-line" style={{ stroke: SERIES_COLORS[seriesIndex] }} />
        ))}
        {props.days.map((day, index) => {
          const shownAt = index % labelEvery === 0 || index === props.days.length - 1
          return (
            <g key={day.date}>
              {shownAt && (
                <text x={x(index)} y={CHART_H - 8} className="trend-tick" textAnchor="middle">
                  {fmtDate(day.date)}
                </text>
              )}
              <circle
                cx={x(index)}
                cy={y(day.inputTokens + day.outputTokens)}
                r="5"
                fill="transparent"
              >
                <title>{`${fmtDate(day.date)} · ${fmtTokens(day.inputTokens + day.outputTokens)} tokens · ${String(day.turns)} 轮`}</title>
              </circle>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── 模型环形图 ────────────────────────────────────────────────────────────────

function Donut(props: { models: UsageModelView[] }): JSX.Element {
  const total = props.models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0)
  if (total <= 0) return <div className="settings-empty">还没有模型用量。</div>
  const radius = 66
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div className="donut-row">
      <svg viewBox="0 0 170 170" className="donut-svg" role="img" aria-label="模型用量占比">
        <circle cx="85" cy="85" r={radius} className="donut-track" />
        {props.models.map((model, index) => {
          const share = (model.inputTokens + model.outputTokens) / total
          const dash = share * circumference
          const element = (
            <circle
              key={model.key}
              cx="85"
              cy="85"
              r={radius}
              className="donut-seg"
              style={{
                stroke: SERIES_COLORS[index % SERIES_COLORS.length],
                strokeDasharray: `${String(Math.max(dash - 2, 1))} ${String(circumference - Math.max(dash - 2, 1))}`,
                strokeDashoffset: -offset,
              }}
            />
          )
          offset += dash
          return element
        })}
        <text x="85" y="81" className="donut-total" textAnchor="middle">
          {fmtTokens(total)}
        </text>
        <text x="85" y="99" className="donut-unit" textAnchor="middle">
          tokens
        </text>
      </svg>
      <div className="donut-legend">
        {props.models.map((model, index) => {
          const tokens = model.inputTokens + model.outputTokens
          const share = tokens / total
          return (
            <div key={model.key} className="donut-legend-item" title={model.key}>
              <i style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
              <div className="donut-legend-text">
                <span className="donut-legend-name">{model.key.split('/').pop()}</span>
                <span className="donut-legend-sub">
                  {fmtTokens(tokens)} tokens · {String(model.turns)} 轮
                </span>
              </div>
              <span className="donut-legend-pct">{`${Math.round(share * 100)}%`}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 页面本体 ──────────────────────────────────────────────────────────────────

type Range = 7 | 30

export function UsagePanel(props: { proxy: RuntimeProxy }): JSX.Element {
  const [stats, setStats] = useState<UsageStatsView | null>(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState<Range>(7)

  const reload = (): void => {
    props.proxy
      .usageStats()
      .then(setStats)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(reload, [props.proxy])

  if (error !== '') {
    return (
      <div className="settings-empty">
        用量统计读取失败：{error}
        <button className="text-btn" onClick={reload} style={{ marginLeft: 8 }}>
          重试
        </button>
      </div>
    )
  }
  if (stats === null) return <div className="settings-empty">正在读取用量记录…</div>
  if (stats.sinceTs === null) {
    return (
      <div className="settings-empty usage-empty">
        <IconChart size={22} />
        还没有任何用量记录。
        <p>自此版本起，每次模型请求都会记录输入与输出 token、模型和时间，使用一段时间后此处将显示统计。</p>
      </div>
    )
  }

  const total = stats.totalInputTokens + stats.totalOutputTokens
  const trendDays = stats.days.slice(-range)
  const cards: { label: string; value: string }[] = [
    { label: '累计 Token', value: fmtTokens(total) },
    { label: '单日峰值 Token', value: stats.peakDay === null ? '—' : fmtTokens(stats.peakDay.inputTokens + stats.peakDay.outputTokens) },
    { label: '活跃天数', value: `${String(stats.activeDays)} 天` },
    { label: '当前连续', value: `${String(stats.currentStreakDays)} 天` },
    { label: '最长连续', value: `${String(stats.longestStreakDays)} 天` },
  ]

  return (
    <div className="usage">
      <div className="usage-cards">
        {cards.map((card) => (
          <div key={card.label} className="usage-card">
            <div className="usage-card-value">{card.value}</div>
            <div className="usage-card-label">{card.label}</div>
          </div>
        ))}
      </div>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>Token 活动</h3>
          <span className="usage-block-hint" title={`${fmtDate(stats.days[0]!.date)} 至今 · 累计 ${fmtTokens(total)} tokens`}>
            最近一年
          </span>
        </div>
        <Heatmap days={stats.days} />
      </section>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>每日 Token 趋势</h3>
          <div className="dsc-segmented" role="group">
            {([7, 30] as Range[]).map((value) => (
              <button key={value} type="button" className="dsc-segmented__btn" aria-selected={range === value} onClick={() => setRange(value)}>
                {value === 7 ? '近 7 日' : '近 30 日'}
              </button>
            ))}
          </div>
        </div>
        <TrendChart days={trendDays} models={stats.models} />
      </section>

      <section className="usage-block">
        <div className="usage-block-head">
          <h3>模型用量</h3>
        </div>
        <Donut models={stats.models} />
      </section>

      <div className="usage-foot">
        <span>
          自 {fmtDate(stats.days[0]!.date)} 起记录 · 共 {String(stats.totalTurns)} 轮请求 · 记录在 ~/.dsc/usage/usage.jsonl
        </span>
        <button className="text-btn" onClick={reload}>
          <IconRefresh size={13} /> 刷新
        </button>
      </div>
    </div>
  )
}
