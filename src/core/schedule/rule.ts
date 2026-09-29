/**
 * 定时任务的选择器：六种触发规则的解析、下一次触发时刻的计算，以及「本地墙上时刻 ↔ 绝对时刻」
 * 的换算。整份文件是纯函数——不碰文件系统、不读 ctx、不缓存任何跨任务状态（时区格式化器除外），
 * 所以能脱离宿主单独跑自检。
 *
 * 为什么这么设计：
 *   1. **时间一律用绝对毫秒数（epoch ms）表示**，人读的「09:30」只在解析和显示时出现。
 *      存绝对时刻能让「机器睡了两小时」和「时区改了」这两件事都变成一次减法。
 *   2. **没有 Temporal**（Node 24 才有），所以用 `Intl.DateTimeFormat` 反解时区偏移：
 *      把某一瞬间按目标时区格式化出墙上时刻，再和 UTC 的同一串数字相减，差就是偏移。
 *      时区库（如 luxon）会引入 npm 依赖，dsc 插件不许带依赖，所以走内置 ICU。
 *   3. **DST 两条规则是入参，不是副作用**：gap（夏令时跳表里不存在的本地时刻）算「没有这一次」，
 *      返回 null 让调用方跳过；overlap（秋天重复的那一小时）只取较早的那一次。
 *      这两个规则写在 wallTimeToInstant 里，所有选择器共用，不许各自再判一遍。
 *
 * @module dsc/core/schedule/rule
 */

/** 六种选择器。 */
export type ScheduleRuleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'

/** 六种选择器的名字（给工具描述与报错文案用）。 */
export const SCHEDULE_RULE_KINDS: readonly ScheduleRuleKind[] = ['after', 'at', 'every', 'daily', 'weekly', 'cron']

/** `every` 的间隔下限（秒）：比一分钟更密的提醒用提醒本身没有意义，只会烧模型额度。 */
export const MIN_EVERY_SECONDS = 60

/** 一次性任务（after / at）错过后的补跑宽限：两分钟。 */
export const ONE_SHOT_GRACE_MS = 120_000

/** 周期任务补跑宽限的下限。 */
export const MIN_GRACE_MS = 120_000

/** 周期任务补跑宽限的上限（两小时）。 */
export const MAX_GRACE_MS = 2 * 3600_000

/**
 * 五字段 Vixie cron 展开后的允许值集合。
 * 存展开结果而不是原文：每跑一次 tick 都要判几十次，现展开太浪费。
 */
export interface CronFields {
  minute: readonly number[]
  hour: readonly number[]
  dayOfMonth: readonly number[]
  month: readonly number[]
  /** 0=周日 … 6=周六（原文里的 7 已经归一成 0）。 */
  dayOfWeek: readonly number[]
  /** 日字段不是 `*`：Vixie 的「日与周是或的关系」要靠这两个标记才判得准。 */
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

/** 一条触发规则。`anchorMs` 是「这个间隔从哪一刻起算」，建任务时钉死，避免重启后漂移。 */
export type ScheduleRule =
  | { kind: 'after'; seconds: number; anchorMs: number }
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; seconds: number; anchorMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'cron'; expression: string; fields: CronFields }

/** 解析结果：失败带一句能直接给用户看的原因。 */
export type RuleParseResult = { ok: true; rule: ScheduleRule } | { ok: false; error: string }

/** 一次扫描最多推进多少格（按天整段跳，所以 4000 格足够覆盖十几年）。 */
const CRON_SCAN_LIMIT = 4_000

/** 一周七天的中文名，下标 1~7（1=周一）。 */
const WEEKDAY_NAMES: readonly string[] = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 墙上时刻（不带时区的那串数字）。 */
interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

// ── 时区工具 ──────────────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>()
const zoneValidCache = new Map<string, boolean>()

/** 取（并缓存）某个时区的格式化器。每建一个都很贵，而 nextRunAt 会反复用到。 */
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

/** 这个 IANA 时区名认不认识（`Intl` 不认就抛 RangeError）。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false
  const cached = zoneValidCache.get(timeZone)
  if (cached !== undefined) return cached
  let ok = true
  try {
    formatterOf(timeZone)
  } catch {
    ok = false
  }
  zoneValidCache.set(timeZone, ok)
  return ok
}

/** 本机系统时区；拿不到就 UTC（宁可跑偏也不要启动失败）。 */
export function systemTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && isValidTimeZone(zone)) return zone
  } catch {
    // 环境缺 ICU：下面的 UTC 兜底
  }
  return 'UTC'
}

/** 某一瞬间在目标时区里的墙上时刻。 */
export function localWall(instantMs: number, timeZone: string): WallTime {
  const parts = formatterOf(timeZone).formatToParts(new Date(instantMs))
  const pick = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    // 有些 ICU 版本在 h23 下仍会把午夜给成 "24"，取模兜住。
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 墙上时刻按 UTC 读出来的毫秒数（纯日历算术用，不代表真实瞬间）。 */
function wallToNaiveMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
}

/**
 * 某一瞬间在目标时区的偏移（毫秒）：`本地墙上时刻 - UTC 时刻`。
 * 只取到秒——格式化器不给毫秒，带毫秒进来会多出一个亚秒误差。
 */
export function offsetAt(instantMs: number, timeZone: string): number {
  const base = Math.floor(instantMs / 1000) * 1000
  return wallToNaiveMs(localWall(base, timeZone)) - base
}

/** 这个瞬间在目标时区读出来的墙上时刻是不是 wall。 */
function sameWall(instantMs: number, wall: WallTime, timeZone: string): boolean {
  const got = localWall(Math.floor(instantMs / 1000) * 1000, timeZone)
  return (
    got.year === wall.year &&
    got.month === wall.month &&
    got.day === wall.day &&
    got.hour === wall.hour &&
    got.minute === wall.minute &&
    got.second === wall.second
  )
}

/**
 * 本地墙上时刻 → 绝对时刻。
 *
 * DST 两条规则都在这里：
 *   - **gap**（春天跳表那一小时里的时刻，例如 America/New_York 3 月某天的 02:30）：
 *     没有任何瞬间的墙上时刻等于它，返回 `null`。调用方据此「跳过这一次」。
 *   - **overlap**（秋天重复的那一小时，例如 11 月某天的 01:30 出现两次）：
 *     两个候选都合法，取较早的那个（`Math.min`）。
 *
 * 候选怎么来：真实瞬间 t 满足 `t = naive - offset(t)`，而一个时区在两天内几乎不会变两次偏移，
 * 所以在 naive 前后各取几个采样点，把采样到的偏移各试一遍，再用「格式化回去是否相等」验证。
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string): number | null {
  const naive = wallToNaiveMs(wall)
  const offsets = new Set<number>()
  for (const hours of [-26, -2, 0, 2, 26]) offsets.add(offsetAt(naive + hours * 3600_000, timeZone))
  let best: number | null = null
  for (const offset of offsets) {
    const candidate = naive - offset
    if (!sameWall(candidate, wall, timeZone)) continue
    if (best === null || candidate < best) best = candidate
  }
  return best
}

/** 把绝对时刻按目标时区写成 `YYYY-MM-DD HH:MM:SS ±HH:MM`。 */
export function formatInstant(instantMs: number, timeZone: string): string {
  const wall = localWall(instantMs, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const totalMinutes = Math.round(offsetAt(instantMs, timeZone) / 60_000)
  const sign = totalMinutes < 0 ? '-' : '+'
  const abs = Math.abs(totalMinutes)
  return (
    `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ` +
    `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

// ── 墙上时刻的日历算术 ────────────────────────────────────────────────────────

/** 从一个 UTC 读出值的 Date 折回墙上时刻。 */
function fromUtcDate(date: Date): WallTime {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }
}

/** 加 n 天（保留时分秒；跨月跨年由 Date 自己算）。 */
function addDays(wall: WallTime, days: number): WallTime {
  const date = new Date(wallToNaiveMs({ ...wall, hour: 0, minute: 0, second: 0 }))
  date.setUTCDate(date.getUTCDate() + days)
  return { ...fromUtcDate(date), hour: wall.hour, minute: wall.minute, second: wall.second }
}

/** 下一分钟（秒归零）。 */
function minuteAfter(wall: WallTime): WallTime {
  const date = new Date(wallToNaiveMs({ ...wall, second: 0 }))
  date.setUTCMinutes(date.getUTCMinutes() + 1)
  return fromUtcDate(date)
}

/** 下一个整点。 */
function nextHourStart(wall: WallTime): WallTime {
  const date = new Date(wallToNaiveMs({ ...wall, minute: 0, second: 0 }))
  date.setUTCHours(date.getUTCHours() + 1)
  return fromUtcDate(date)
}

/** 明天零点。 */
function nextDayStart(wall: WallTime): WallTime {
  const date = new Date(wallToNaiveMs({ ...wall, hour: 0, minute: 0, second: 0 }))
  date.setUTCDate(date.getUTCDate() + 1)
  return fromUtcDate(date)
}

/** 下个月一号零点。 */
function nextMonthStart(wall: WallTime): WallTime {
  return fromUtcDate(new Date(Date.UTC(wall.year, wall.month, 1, 0, 0, 0)))
}

/** 这个日期是星期几，1=周一 … 7=周日（ISO 口径）。 */
export function isoWeekday(wall: WallTime): number {
  const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
  return ((day + 6) % 7) + 1
}

// ── 文本解析 ──────────────────────────────────────────────────────────────────

/**
 * 把 `90` / `90s` / `5m` / `2h` / `1d` / `1h30m` 这类写法读成秒数。
 * 不认的返回 null（调用方负责给报错文案）。
 */
export function parseDurationSeconds(text: string): number | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, '')
  if (raw === '') return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const single = /^(\d+)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(raw)
  if (single !== null) {
    const unit = single[2]!
    const factor = unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : unit.startsWith('h') ? 3_600 : 86_400
    return Number(single[1]) * factor
  }
  const compound = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (
    compound !== null &&
    (compound[1] !== undefined || compound[2] !== undefined || compound[3] !== undefined)
  ) {
    return Number(compound[1] ?? 0) * 3_600 + Number(compound[2] ?? 0) * 60 + Number(compound[3] ?? 0)
  }
  return null
}

/** 把 `HH:MM` / `H:MM` / `HH:MM:SS` 读成时分（秒直接丢掉：定时任务精确到分钟就够了）。 */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const matched = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim())
  if (matched === null) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 把星期几读成 ISO 编号（1=周一 … 7=周日）；认数字、英文三字母缩写与中文写法。 */
export function parseWeekday(text: string): number | null {
  const raw = text.trim().toLowerCase()
  if (/^[1-7]$/.test(raw)) return Number(raw)
  const english = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(raw.slice(0, 3))
  if (english >= 0) return english + 1
  const chinese = /^(?:周|星期|礼拜)\s*([一二三四五六日天])$/.exec(text.trim())
  if (chinese !== null) {
    const day = chinese[1]!
    if (day === '日' || day === '天') return 7
    return '一二三四五六'.indexOf(day) + 1
  }
  return null
}

/**
 * 解析五字段 Vixie cron（分钟 小时 日 月 周）。
 *
 * 明确拒绝：秒字段（六段）、`L` / `W` / `#` / `?`、月名与周名缩写、`@daily` 这类宏。
 * 为什么拒：这些是 Quartz / cronitor 方言或 GNU 扩展，dsc 只做 Vixie 那一种——
 * 同一份表达式在不同实现下的行为不一样，宁可当场报错也不猜。
 */
export function parseCron(expression: string): { ok: true; fields: CronFields } | { ok: false; error: string } {
  const raw = expression.trim()
  if (raw === '') return { ok: false, error: 'cron 表达式不能是空的' }
  if (raw.startsWith('@')) {
    return { ok: false, error: `不支持 ${raw} 这类宏，请写五字段表达式，例如 0 9 * * *` }
  }
  const parts = raw.split(/\s+/)
  if (parts.length !== 5) {
    return {
      ok: false,
      error:
        parts.length === 6
          ? '只认五字段 Vixie cron（分钟 小时 日 月 周），秒字段不支持：把秒那一段去掉，或并进分钟'
          : `五字段 Vixie cron 要 5 段（分钟 小时 日 月 周），收到 ${parts.length} 段：${raw}`,
    }
  }
  for (const part of parts) {
    if (/[LW#?]/.test(part)) {
      return { ok: false, error: `不支持 L / W / # / ? 这些扩展写法（收到 ${part}）` }
    }
    if (/[A-Za-z]/.test(part)) {
      return { ok: false, error: `不支持月名 / 周名缩写（收到 ${part}），请用数字：1=一月、0 或 7=周日` }
    }
  }
  const lows = [0, 0, 1, 1, 0]
  const highs = [59, 23, 31, 12, 7]
  const labels = ['分钟', '小时', '日', '月', '周']
  const columns: number[][] = []
  for (let index = 0; index < 5; index += 1) {
    const expanded = expandCronField(parts[index]!, lows[index]!, highs[index]!)
    if (!expanded.ok) {
      return { ok: false, error: `${labels[index]}字段「${parts[index]}」:${expanded.error}` }
    }
    columns.push(expanded.values)
  }
  // 周字段 0 和 7 都是周日，归一成 0 再去重排序。
  const dayOfWeek = [...new Set(columns[4]!.map((value) => value % 7))].sort((left, right) => left - right)
  return {
    ok: true,
    fields: {
      minute: columns[0]!,
      hour: columns[1]!,
      dayOfMonth: columns[2]!,
      month: columns[3]!,
      dayOfWeek,
      dayOfMonthRestricted: parts[2] !== '*',
      dayOfWeekRestricted: parts[4] !== '*',
    },
  }
}

/** 展开一段 cron 字段（`*`、`a`、`a-b`、`a,b`、带 `/step` 的各种组合）。 */
function expandCronField(
  text: string,
  min: number,
  max: number,
): { ok: true; values: number[] } | { ok: false; error: string } {
  const values = new Set<number>()
  for (const piece of text.split(',')) {
    if (piece === '') return { ok: false, error: '列表里有空的项' }
    const slash = piece.split('/')
    if (slash.length > 2) return { ok: false, error: '斜杠只能有一个' }
    const body = slash[0]!
    const stepText = slash[1]
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return { ok: false, error: `步长「${stepText}」不是数字` }
      step = Number(stepText)
      if (step <= 0) return { ok: false, error: '步长要大于 0' }
    }
    let from = min
    let to = max
    if (body !== '*') {
      const dash = body.split('-')
      if (dash.length > 2) return { ok: false, error: '范围只能写成 a-b' }
      if (dash.length === 2) {
        if (!/^\d+$/.test(dash[0]!) || !/^\d+$/.test(dash[1]!)) {
          return { ok: false, error: '范围两端都要是数字' }
        }
        from = Number(dash[0])
        to = Number(dash[1])
      } else {
        if (!/^\d+$/.test(body)) return { ok: false, error: `「${body}」不是数字` }
        from = Number(body)
        // Vixie 的写法：`5/15` 等于 `5-max/15`；光写 `5` 就只有 5 这一个值。
        to = stepText === undefined ? from : max
      }
    }
    if (from < min || to > max || from > to) {
      return { ok: false, error: `取值要在 ${min}~${max} 之间，且左端不大于右端` }
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  if (values.size === 0) return { ok: false, error: '没有可用的取值' }
  return { ok: true, values: [...values].sort((left, right) => left - right) }
}

/** 解析 `at` 后面的时刻：带时区标识按绝对时刻读，不带就按任务时区的墙上时刻读。 */
function parseAtInstant(text: string, timeZone: string, nowMs: number): { ok: true; atMs: number } | { ok: false; error: string } {
  const raw = text.trim()
  if (raw === '') return { ok: false, error: 'at 后面要写时刻，例如 at:2026-03-09T09:30 或 at:2026-03-09T09:30:00Z' }
  // 只有 HH:MM：按今天算，已经过了就明天（「今天 18:00 提醒我」这种最顺手的写法）。
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    const clock = parseClock(raw)
    if (clock === null) return { ok: false, error: `「${raw}」不是合法时刻（小时 0~23、分钟 0~59）` }
    const today = localWall(nowMs, timeZone)
    for (const offset of [0, 1]) {
      const day = addDays({ ...today, hour: clock.hour, minute: clock.minute, second: 0 }, offset)
      const instant = wallTimeToInstant(day, timeZone)
      if (instant !== null && instant > nowMs) return { ok: true, atMs: instant }
    }
    return { ok: false, error: `算不出 ${raw} 对应的时刻（位于夏令时跳表的那一小时？）` }
  }
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)
  if (hasZone) {
    const parsed = Date.parse(raw)
    if (Number.isNaN(parsed)) return { ok: false, error: `「${raw}」不是一个能读懂的时刻` }
    return { ok: true, atMs: parsed }
  }
  const matched =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw)
  if (matched === null) {
    return { ok: false, error: `「${raw}」不是一个能读懂的时刻，请写 2026-03-09T09:30 或 2026-03-09T09:30:00Z` }
  }
  const wall: WallTime = {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
    hour: Number(matched[4] ?? 0),
    minute: Number(matched[5] ?? 0),
    second: Number(matched[6] ?? 0),
  }
  if (wall.month > 12 || wall.day > 31 || wall.hour > 23 || wall.minute > 59 || wall.second > 59) {
    return { ok: false, error: `「${raw}」里的日期或时刻越界了` }
  }
  const instant = wallTimeToInstant(wall, timeZone)
  if (instant === null) {
    return { ok: false, error: `${raw} 这个本地时刻在 ${timeZone} 不存在（夏令时跳表的那一小时），换一个时刻` }
  }
  return { ok: true, atMs: instant }
}

/**
 * 解析一条选择器文本。
 *
 * 认两种写法：带冒号的 `every:5m`，和空格分开的 `every 5m`（cron 一定是后者）。
 * 单独写五段 cron 表达式（`30 9 * * *`）也认——模型最容易这么写。
 *
 * @param text - 用户 / 模型给的选择器
 * @param timeZone - 任务时区（`at` 这种墙上时刻要靠它换算）
 * @param nowMs - 现在（`after` 的起算点、`at` 的「是否已过去」判定都靠它；显式传入才好测）
 */
export function parseRule(text: string, timeZone: string, nowMs: number): RuleParseResult {
  const raw = text.trim()
  if (raw === '') {
    return { ok: false, error: `选择器不能是空的。六种写法：${SCHEDULE_RULE_KINDS.join(' / ')}` }
  }
  if (!isValidTimeZone(timeZone)) {
    return { ok: false, error: `时区「${timeZone}」不认识，请写 IANA 名字，例如 Asia/Shanghai` }
  }
  // 切出「关键字」和「后面那一串」：先看首个冒号，再看首个空白，谁在前用谁。
  const colonAt = raw.indexOf(':')
  const spaceAt = raw.search(/\s/)
  let head = raw
  let rest = ''
  if (colonAt >= 0 && (spaceAt < 0 || colonAt < spaceAt)) {
    head = raw.slice(0, colonAt)
    rest = raw.slice(colonAt + 1)
  } else if (spaceAt >= 0) {
    head = raw.slice(0, spaceAt)
    rest = raw.slice(spaceAt + 1)
  }
  const kind = head.trim().toLowerCase()
  switch (kind) {
    case 'after': {
      const seconds = parseDurationSeconds(rest)
      if (seconds === null || seconds <= 0) {
        return { ok: false, error: 'after 后面要写正数时长，例如 after:90s / after:5m / after:2h' }
      }
      return { ok: true, rule: { kind: 'after', seconds: Math.round(seconds), anchorMs: nowMs } }
    }
    case 'at': {
      const parsed = parseAtInstant(rest, timeZone, nowMs)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      if (parsed.atMs <= nowMs) {
        return { ok: false, error: `at 的那个时刻已经过去了（${formatInstant(parsed.atMs, timeZone)}），要定将来就往后写` }
      }
      return { ok: true, rule: { kind: 'at', atMs: parsed.atMs } }
    }
    case 'every': {
      const seconds = parseDurationSeconds(rest)
      if (seconds === null || seconds < MIN_EVERY_SECONDS) {
        return {
          ok: false,
          error: `every 的间隔至少 ${MIN_EVERY_SECONDS} 秒（收到「${rest || '空'}」）；更密的提醒请用别的方式`,
        }
      }
      return { ok: true, rule: { kind: 'every', seconds: Math.round(seconds), anchorMs: nowMs } }
    }
    case 'daily': {
      const clock = parseClock(rest)
      if (clock === null) return { ok: false, error: 'daily 后面要写 HH:MM，例如 daily:09:30' }
      return { ok: true, rule: { kind: 'daily', hour: clock.hour, minute: clock.minute } }
    }
    case 'weekly': {
      const fields = rest.trim().split(/\s+/)
      // `weekly:mon 09:30` 与 `weekly:mon:09:30` 都认。
      const pieces = fields.length >= 2 ? fields : rest.trim().split(':')
      if (pieces.length < 2) {
        return { ok: false, error: 'weekly 后面要写「星期几 时刻」，例如 weekly:mon 09:30' }
      }
      const weekday = parseWeekday(pieces[0]!)
      if (weekday === null) return { ok: false, error: `认不出星期几「${pieces[0]}」，写 1~7、mon~sun 或 周一~周日` }
      const clock = parseClock(pieces.slice(1).join(':'))
      if (clock === null) return { ok: false, error: `认不出时刻「${pieces.slice(1).join(' ')}」，写 HH:MM` }
      return { ok: true, rule: { kind: 'weekly', weekday, hour: clock.hour, minute: clock.minute } }
    }
    case 'cron': {
      const parsed = parseCron(rest)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return { ok: true, rule: { kind: 'cron', expression: rest.trim(), fields: parsed.fields } }
    }
    default: {
      // 没写关键字：整串当 cron 试一次（`30 9 * * *` 是模型最顺手的写法）。
      const parsed = parseCron(raw)
      if (parsed.ok) return { ok: true, rule: { kind: 'cron', expression: raw, fields: parsed.fields } }
      return {
        ok: false,
        error: `认不出选择器「${kind}」。六种写法：after:5m（多久后一次）/ at:2026-03-09T09:30（绝对时刻一次）/ every:30m（间隔，至少 ${MIN_EVERY_SECONDS} 秒）/ daily:09:30 / weekly:mon 09:30 / cron:0 9 * * *（五字段 Vixie）`,
      }
    }
  }
}

// ── 下一次触发时刻 ────────────────────────────────────────────────────────────

/** 这条规则是不是「只跑一次」。 */
export function isOneShot(rule: ScheduleRule): boolean {
  return rule.kind === 'after' || rule.kind === 'at'
}

/**
 * 严格晚于 `fromMs` 的下一次触发时刻；算不出来（一次性任务已经过期、cron 永远不匹配）返回 null。
 *
 * `every` 与 `after` 都以规则里的 `anchorMs` 为栅格起点，不用 `fromMs` 递推——
 * 进程重启、tick 抖动都不会让「每 30 分钟」漂成 30 分零 7 秒。
 */
export function nextRunAt(rule: ScheduleRule, timeZone: string, fromMs: number): number | null {
  switch (rule.kind) {
    case 'after': {
      const at = rule.anchorMs + rule.seconds * 1_000
      return at > fromMs ? at : null
    }
    case 'at':
      return rule.atMs > fromMs ? rule.atMs : null
    case 'every': {
      const period = rule.seconds * 1_000
      if (fromMs < rule.anchorMs) return rule.anchorMs
      return rule.anchorMs + (Math.floor((fromMs - rule.anchorMs) / period) + 1) * period
    }
    case 'daily':
      return nextDaily(rule, timeZone, fromMs)
    case 'weekly':
      return nextWeekly(rule, timeZone, fromMs)
    case 'cron':
      return nextCron(rule.fields, timeZone, fromMs)
  }
}

/** 每天 HH:MM 的下一次；当天那个时刻在跳表里不存在（gap）就顺延到第二天。 */
function nextDaily(rule: { hour: number; minute: number }, timeZone: string, fromMs: number): number | null {
  const today = localWall(fromMs, timeZone)
  // 最多往后看 8 天：正常一天就命中，gap 最多连跳一两次，8 天足够判出「这个时区的这一天根本没有 02:30」。
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = addDays({ ...today, hour: rule.hour, minute: rule.minute, second: 0 }, offset)
    const instant = wallTimeToInstant(day, timeZone)
    if (instant !== null && instant > fromMs) return instant
  }
  return null
}

/** 每周几 HH:MM 的下一次；同样对 gap 顺延。 */
function nextWeekly(
  rule: { weekday: number; hour: number; minute: number },
  timeZone: string,
  fromMs: number,
): number | null {
  const today = localWall(fromMs, timeZone)
  for (let offset = 0; offset <= 21; offset += 1) {
    const day = addDays({ ...today, hour: rule.hour, minute: rule.minute, second: 0 }, offset)
    if (isoWeekday(day) !== rule.weekday) continue
    const instant = wallTimeToInstant(day, timeZone)
    if (instant !== null && instant > fromMs) return instant
  }
  return null
}

/** Vixie 的「日 / 周」判定：两个字段都不是 `*` 时是**或**的关系，只有一个受限时就按那一个。 */
function cronDayMatches(fields: CronFields, wall: WallTime): boolean {
  const dayOfMonth = fields.dayOfMonth.includes(wall.day)
  const dayOfWeek = fields.dayOfWeek.includes(isoWeekday(wall) % 7)
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dayOfMonth || dayOfWeek
  if (fields.dayOfMonthRestricted) return dayOfMonth
  if (fields.dayOfWeekRestricted) return dayOfWeek
  return true
}

/**
 * cron 的下一次触发。从「当前本地墙上时刻的下一分钟」起逐格推进：月不对整月跳、日不对整天跳、
 * 小时不对整点跳，所以 `0 0 29 2 *`（四年一次）也不会退化成逐分钟死循环。
 *
 * 墙上时刻算出来以后交给 wallTimeToInstant 落成绝对时刻：gap 里的那一分钟返回 null，
 * 自然被跳过（这就是「DST gap 跳过该次」）；overlap 时函数返回较早那一次，
 * 扫描从较早的瞬间往后走，因此重复的那一小时只会命中一次。
 */
function nextCron(fields: CronFields, timeZone: string, fromMs: number): number | null {
  let wall = minuteAfter(localWall(fromMs, timeZone))
  for (let guard = 0; guard < CRON_SCAN_LIMIT; guard += 1) {
    if (!fields.month.includes(wall.month)) {
      wall = nextMonthStart(wall)
      continue
    }
    if (!cronDayMatches(fields, wall)) {
      wall = nextDayStart(wall)
      continue
    }
    if (!fields.hour.includes(wall.hour)) {
      wall = nextHourStart(wall)
      continue
    }
    if (!fields.minute.includes(wall.minute)) {
      wall = minuteAfter(wall)
      continue
    }
    const instant = wallTimeToInstant({ ...wall, second: 0 }, timeZone)
    if (instant !== null && instant > fromMs) return instant
    wall = minuteAfter(wall)
  }
  return null
}

/**
 * 两次触发之间大概隔多久（毫秒）；一次性任务返回 null。
 * 补跑宽限取它的一半，所以只要个「大概」，cron 就现算相邻两次。
 */
export function periodMs(rule: ScheduleRule, timeZone: string, fromMs: number): number | null {
  switch (rule.kind) {
    case 'after':
    case 'at':
      return null
    case 'every':
      return rule.seconds * 1_000
    case 'daily':
      return 86_400_000
    case 'weekly':
      return 7 * 86_400_000
    case 'cron': {
      const first = nextRunAt(rule, timeZone, fromMs)
      if (first === null) return null
      const second = nextRunAt(rule, timeZone, first)
      return second === null ? null : second - first
    }
  }
}

/**
 * 错过多久之内还算「来得及补跑」。半周期，夹在 120s~2h；一次性任务固定 120s。
 * 为什么要夹：`every:1m` 的任务补跑窗口不该是 30 秒（tick 都来不及），
 * `daily` 的任务也不该给 12 小时（早上 9 点的提醒晚上 9 点才弹就成骚扰了）。
 */
export function graceMs(rule: ScheduleRule, timeZone: string, fromMs: number): number {
  const period = periodMs(rule, timeZone, fromMs)
  if (period === null) return ONE_SHOT_GRACE_MS
  return Math.min(Math.max(Math.round(period / 2), MIN_GRACE_MS), MAX_GRACE_MS)
}

// ── 给人看的文案 ──────────────────────────────────────────────────────────────

/** 把秒数写成「30 秒 / 5 分钟 / 2 小时 / 1 天 3 小时」这种人话。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600)
    const rest = Math.floor((seconds % 3_600) / 60)
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
  }
  const days = Math.floor(seconds / 86_400)
  const rest = Math.floor((seconds % 86_400) / 3_600)
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`
}

/** 规则的一句话描述（不含「下次什么时候」——那个要按当前时刻现算）。 */
export function describeRule(rule: ScheduleRule, timeZone: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  switch (rule.kind) {
    case 'after':
      return `${formatDuration(rule.seconds)}后跑一次`
    case 'at':
      return `只跑一次 · ${formatInstant(rule.atMs, timeZone)}`
    case 'every':
      return `每 ${formatDuration(rule.seconds)}`
    case 'daily':
      return `每天 ${pad(rule.hour)}:${pad(rule.minute)}`
    case 'weekly':
      return `每${WEEKDAY_NAMES[rule.weekday] ?? `周${rule.weekday}`} ${pad(rule.hour)}:${pad(rule.minute)}`
    case 'cron':
      return `cron ${rule.expression}`
  }
}

/** 「下次 2026-03-09 09:30:00 +08:00（Asia/Shanghai）」；没有下一次就说明白原因。 */
export function describeNext(rule: ScheduleRule, timeZone: string, nextMs: number | null): string {
  if (nextMs === null) {
    return isOneShot(rule) ? '已经跑完（一次性任务）' : '算不出下一次触发时刻，请检查规则'
  }
  return `下次 ${formatInstant(nextMs, timeZone)}（${timeZone}）`
}

// ── 反序列化 ──────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 把磁盘上读回来的东西收敛成一条合法规则；认不出就返回 null（调用方跳过这条任务并记账）。
 * 磁盘上的文件是用户能手改的，属于不可信输入，所以每个字段都要过一遍。
 */
export function normalizeRule(value: unknown): ScheduleRule | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'after':
    case 'every': {
      if (!isFiniteNumber(raw.seconds) || raw.seconds <= 0) return null
      if (!isFiniteNumber(raw.anchorMs)) return null
      if (raw.kind === 'every' && raw.seconds < MIN_EVERY_SECONDS) return null
      return { kind: raw.kind, seconds: Math.round(raw.seconds), anchorMs: Math.round(raw.anchorMs) }
    }
    case 'at': {
      if (!isFiniteNumber(raw.atMs) || raw.atMs <= 0) return null
      return { kind: 'at', atMs: Math.round(raw.atMs) }
    }
    case 'daily': {
      if (!isFiniteNumber(raw.hour) || !isFiniteNumber(raw.minute)) return null
      if (raw.hour < 0 || raw.hour > 23 || raw.minute < 0 || raw.minute > 59) return null
      return { kind: 'daily', hour: Math.floor(raw.hour), minute: Math.floor(raw.minute) }
    }
    case 'weekly': {
      if (!isFiniteNumber(raw.weekday) || raw.weekday < 1 || raw.weekday > 7) return null
      if (!isFiniteNumber(raw.hour) || !isFiniteNumber(raw.minute)) return null
      if (raw.hour < 0 || raw.hour > 23 || raw.minute < 0 || raw.minute > 59) return null
      return { kind: 'weekly', weekday: Math.floor(raw.weekday), hour: Math.floor(raw.hour), minute: Math.floor(raw.minute) }
    }
    case 'cron': {
      const expression = typeof raw.expression === 'string' ? raw.expression : ''
      const parsed = parseCron(expression)
      if (!parsed.ok) return null
      return { kind: 'cron', expression: expression.trim(), fields: parsed.fields }
    }
    default:
      return null
  }
}
