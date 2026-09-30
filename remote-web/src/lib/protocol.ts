/**
 * 协议归一化：把 WS 上收到的 `unknown`（可能是别的版本、可能缺字段）洗成组件能直接读的形状。
 *
 * 为什么单独一层：宿主插件（批 A）会先于界面演进，快照里加字段、少字段都不该让界面白屏。
 * 这里的原则是「宁缺勿炸」——认不出的条目直接丢掉、缺的字段填 null/空数组，
 * 绝不抛异常，也绝不猜一个假值（例如没 usage 就返回 null，让界面不显示那一行）。
 */

import type {
  ArchivedPage,
  ArchivedSessionView,
  ApprovalRequestView,
  AskOptionView,
  AskQuestionItem,
  AskUserView,
  PlanView,
  RemoteSnapshot,
  RemoteSurfaces,
  SessionSummary,
  StatusView,
  ToolCallView,
  ToolStatus,
  TodoItemView,
  TodoView,
  TranscriptEntry,
  TurnState,
} from './types.js'

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickString(source: Rec, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key])
    if (value !== null) return value
  }
  return null
}

function pickNumber(source: Rec, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(source[key])
    if (value !== null) return value
  }
  return null
}

// ── 条目 ────────────────────────────────────────────────────────────────────

const TOOL_STATUSES: readonly ToolStatus[] = ['running', 'done', 'failed', 'rejected']

function normalizeToolCall(raw: unknown): ToolCallView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const name = pickString(source, 'name', 'toolName') ?? 'tool'
  const statusRaw = pickString(source, 'status')
  const status: ToolStatus =
    statusRaw !== null && (TOOL_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ToolStatus)
      : 'running'
  const call: ToolCallView = {
    callId: pickString(source, 'callId', 'id') ?? '',
    name,
    argsText: pickString(source, 'argsText', 'args') ?? '',
    status,
  }
  const resultText = pickString(source, 'resultText', 'result')
  if (resultText !== null) call.resultText = resultText
  const startedAt = pickNumber(source, 'startedAt')
  if (startedAt !== null) call.startedAt = startedAt
  const durationMs = pickNumber(source, 'durationMs')
  if (durationMs !== null) call.durationMs = durationMs
  return call
}

function normalizePlan(raw: unknown): PlanView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const decisionRaw = pickString(source, 'decision')
  const decision =
    decisionRaw === 'approved' || decisionRaw === 'rejected' ? decisionRaw : 'pending'
  return {
    file: pickString(source, 'file') ?? '',
    title: pickString(source, 'title') ?? '',
    text: pickString(source, 'text') ?? '',
    decision,
  }
}

/**
 * 把一条原始条目洗成 TranscriptEntry；认不出 kind 就返回 null（调用方丢掉）。
 *
 * 注意 `id`：宿主每次重建快照都从 1 重新发号，所以 id 只能当「同一份快照内的键」用，
 * 不能跨快照比较。
 */
export function normalizeEntry(raw: unknown): TranscriptEntry | null {
  const source = asRecord(raw)
  if (source === null) return null
  const kind = pickString(source, 'kind')
  const id = pickNumber(source, 'id') ?? 0
  const ts = pickNumber(source, 'ts')
  const usage = source['usage']
  const usageView = (() => {
    const record = asRecord(usage)
    if (record === null) return undefined
    const inputTokens = pickNumber(record, 'inputTokens', 'input')
    const outputTokens = pickNumber(record, 'outputTokens', 'output')
    if (inputTokens === null && outputTokens === null) return undefined
    return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
  })()

  switch (kind) {
    case 'user': {
      const entry: TranscriptEntry = { kind: 'user', id, text: pickString(source, 'text') ?? '' }
      const images = asArray(source['images']).filter((item): item is string => typeof item === 'string')
      if (images.length > 0) entry.images = images
      if (ts !== null) entry.ts = ts
      const compaction = normalizeCompaction(source['compaction'])
      if (compaction !== undefined) entry.compaction = compaction
      return entry
    }
    case 'thinking': {
      const entry: TranscriptEntry = { kind: 'thinking', id, text: pickString(source, 'text') ?? '' }
      if (ts !== null) entry.ts = ts
      return entry
    }
    case 'text': {
      const entry: TranscriptEntry = { kind: 'text', id, text: pickString(source, 'text') ?? '' }
      if (ts !== null) entry.ts = ts
      if (usageView !== undefined) entry.usage = usageView
      return entry
    }
    case 'tool': {
      const call = normalizeToolCall(source['call'] ?? source['tool'])
      if (call === null) return null
      const entry: TranscriptEntry = { kind: 'tool', id, call }
      if (ts !== null) entry.ts = ts
      if (usageView !== undefined) entry.usage = usageView
      return entry
    }
    case 'plan': {
      const plan = normalizePlan(source['plan'])
      if (plan === null) return null
      const entry: TranscriptEntry = { kind: 'plan', id, plan }
      if (ts !== null) entry.ts = ts
      return entry
    }
    case 'system': {
      const entry: TranscriptEntry = { kind: 'system', id, text: pickString(source, 'text') ?? '' }
      if (ts !== null) entry.ts = ts
      const compaction = normalizeCompaction(source['compaction'])
      if (compaction !== undefined) entry.compaction = compaction
      return entry
    }
    default:
      return null
  }
}

function normalizeCompaction(raw: unknown): { count: number } | undefined {
  const source = asRecord(raw)
  if (source === null) return undefined
  const count = pickNumber(source, 'count')
  if (count === null) return undefined
  return { count }
}

function normalizeEntries(raw: unknown): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const item of asArray(raw)) {
    const entry = normalizeEntry(item)
    if (entry !== null) out.push(entry)
  }
  return out
}

// ── 审批 / 计划 / 提问 / 任务 ───────────────────────────────────────────────

const RISKS = ['low', 'medium', 'high', 'critical'] as const
const SCOPES = ['once', 'session', 'always'] as const

function normalizeApproval(raw: unknown): ApprovalRequestView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const riskRaw = pickString(source, 'risk')
  const risk = riskRaw !== null && (RISKS as readonly string[]).includes(riskRaw)
    ? (riskRaw as ApprovalRequestView['risk'])
    : 'medium'
  const scopes = asArray(source['scopes'])
    .map((item) => asString(item))
    .filter((item): item is (typeof SCOPES)[number] =>
      item !== null && (SCOPES as readonly string[]).includes(item),
    )
  const suggestedRuleRaw = source['suggestedRule']
  const suggestedRule = Array.isArray(suggestedRuleRaw)
    ? suggestedRuleRaw.filter((item): item is string => typeof item === 'string')
    : null
  return {
    id: pickString(source, 'id') ?? 'approval',
    toolName: pickString(source, 'toolName', 'name') ?? '',
    argsSummary: pickString(source, 'argsSummary', 'summary') ?? '',
    reason: pickString(source, 'reason') ?? '',
    risk,
    suggestedRule,
    hardline: asBoolean(source['hardline']) ?? false,
    // scopes 缺失时不编造：交给组件按「全给」渲染（批 A 没给就等于没限制）。
    scopes: scopes.length > 0 ? scopes : [...SCOPES],
    policy: pickString(source, 'policy') ?? '',
    mode: pickString(source, 'mode') ?? '',
  }
}

function normalizeAskOption(raw: unknown): AskOptionView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const label = pickString(source, 'label')
  if (label === null) return null
  const description = pickString(source, 'description')
  return description === null ? { label } : { label, description }
}

function normalizeAskQuestion(raw: unknown): AskQuestionItem | null {
  const source = asRecord(raw)
  if (source === null) return null
  const question = pickString(source, 'question')
  if (question === null) return null
  const item: AskQuestionItem = {
    question,
    options: asArray(source['options'])
      .map(normalizeAskOption)
      .filter((option): option is AskOptionView => option !== null),
    multiSelect: asBoolean(source['multiSelect']) ?? false,
    allowFreeText: asBoolean(source['allowFreeText']) ?? true,
  }
  const header = pickString(source, 'header')
  if (header !== null) item.header = header
  return item
}

function normalizeAskUser(raw: unknown): AskUserView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const question = pickString(source, 'question') ?? ''
  const view: AskUserView = {
    id: pickString(source, 'id') ?? 'question',
    question,
    options: asArray(source['options'])
      .map(normalizeAskOption)
      .filter((option): option is AskOptionView => option !== null),
    multiSelect: asBoolean(source['multiSelect']) ?? false,
    allowFreeText: asBoolean(source['allowFreeText']) ?? true,
  }
  const header = pickString(source, 'header')
  if (header !== null) view.header = header
  const questions = asArray(source['questions'])
    .map(normalizeAskQuestion)
    .filter((item): item is AskQuestionItem => item !== null)
  if (questions.length > 0) view.questions = questions
  return view
}

function normalizeTodo(raw: unknown): TodoView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const items: TodoItemView[] = []
  for (const item of asArray(source['items'])) {
    const record = asRecord(item)
    if (record === null) continue
    const statusRaw = pickString(record, 'status')
    const status: TodoItemView['status'] =
      statusRaw === 'in_progress' || statusRaw === 'completed' || statusRaw === 'cancelled'
        ? statusRaw
        : 'pending'
    const view: TodoItemView = {
      id: pickString(record, 'id') ?? String(items.length),
      content: pickString(record, 'content') ?? '',
      status,
    }
    const parent = pickString(record, 'parent')
    if (parent !== null) view.parent = parent
    items.push(view)
  }
  return {
    items,
    revision: pickNumber(source, 'revision') ?? 0,
    done: pickNumber(source, 'done') ?? 0,
    total: pickNumber(source, 'total') ?? items.length,
    active: pickString(source, 'active'),
  }
}

function normalizeSurfaces(raw: unknown): RemoteSurfaces {
  const source = asRecord(raw) ?? {}
  return {
    pendingApproval: normalizeApproval(source['pendingApproval']),
    pendingPlan: normalizePlan(source['pendingPlan']),
    pendingQuestion: normalizeAskUser(source['pendingQuestion']),
    // 契约里写的是 pendingTodos，宿主 core 用的是 todos：两个键都认。
    pendingTodos: normalizeTodo(source['pendingTodos'] ?? source['todos']),
  }
}

// ── 状态 / 会话 / 快照 ─────────────────────────────────────────────────────

const TURN_STATES: readonly TurnState[] = ['idle', 'thinking', 'working', 'awaiting-approval']

function normalizeStatus(raw: unknown): StatusView | null {
  const source = asRecord(raw)
  if (source === null) return null
  const turnRaw = pickString(source, 'turnState')
  const turnState: TurnState =
    turnRaw !== null && (TURN_STATES as readonly string[]).includes(turnRaw)
      ? (turnRaw as TurnState)
      : 'idle'
  const usageRecord = asRecord(source['usage'])
  const usage =
    usageRecord === null
      ? null
      : {
          inputTokens: pickNumber(usageRecord, 'inputTokens', 'input') ?? 0,
          outputTokens: pickNumber(usageRecord, 'outputTokens', 'output') ?? 0,
        }
  const effortRaw = pickString(source, 'effort')
  return {
    sessionId: pickString(source, 'sessionId'),
    model: pickString(source, 'model') ?? '',
    effort: (effortRaw ?? 'default') as StatusView['effort'],
    turnState,
    usage,
  }
}

function normalizeSession(raw: unknown): SessionSummary | null {
  const source = asRecord(raw)
  if (source === null) return null
  const id = pickString(source, 'id', 'path')
  if (id === null) return null
  const session: SessionSummary = {
    id,
    cwd: pickString(source, 'cwd') ?? '',
    createdAt: pickNumber(source, 'createdAt') ?? 0,
    updatedAt: pickNumber(source, 'updatedAt') ?? 0,
  }
  const title = pickString(source, 'title')
  if (title !== null) session.title = title
  const pinnedAt = pickNumber(source, 'pinnedAt')
  if (pinnedAt !== null) session.pinnedAt = pinnedAt
  const archivedAt = pickNumber(source, 'archivedAt')
  if (archivedAt !== null) session.archivedAt = archivedAt
  return session
}

/** 会话列表兼容两种来源：快照的 `sessions` 字段、refreshSessions 的返回值。 */
export function normalizeSessions(raw: unknown): SessionSummary[] {
  const list = asArray(raw)
  const out: SessionSummary[] = []
  for (const item of list) {
    const session = normalizeSession(item)
    if (session !== null) out.push(session)
  }
  return out
}

/** 归档页归一化；认不出就返回空页（界面照常画一个空状态）。 */
export function normalizeArchivedPage(raw: unknown): ArchivedPage {
  const source = asRecord(raw) ?? {}
  const items: ArchivedSessionView[] = []
  for (const item of asArray(source['items'])) {
    const record = asRecord(item)
    if (record === null) continue
    const path = pickString(record, 'path', 'id')
    if (path === null) continue
    const view: ArchivedSessionView = {
      path,
      cwd: pickString(record, 'cwd') ?? '',
      createdAt: pickNumber(record, 'createdAt') ?? 0,
      updatedAt: pickNumber(record, 'updatedAt') ?? 0,
      archivedAt: pickNumber(record, 'archivedAt') ?? 0,
    }
    const title = pickString(record, 'title')
    if (title !== null) view.title = title
    items.push(view)
  }
  return {
    items,
    trashDir: pickString(source, 'trashDir') ?? '',
    trashCount: pickNumber(source, 'trashCount') ?? 0,
  }
}

/**
 * 把 WS 上的快照洗成 RemoteSnapshot。
 *
 * 兼容两种骨架：
 *   - 直播尾单独给（`liveEntries`，批 A 的契约）；
 *   - 直播尾已经并进 `entries`（宿主 core 的 RuntimeSnapshot 就是合并好的）。
 * 两种情况界面的渲染方式一样，所以这里统一成「entries + liveEntries 两个数组」，
 * 不合并——合并会丢掉「哪几条还在长」这个信息，渲染直播尾时要用来做 key 区分。
 */
export function normalizeSnapshot(raw: unknown): RemoteSnapshot | null {
  const source = asRecord(raw)
  if (source === null) return null
  const entries = normalizeEntries(source['entries'])
  const liveEntries = normalizeEntries(source['liveEntries'])
  const sessions = normalizeSessions(source['sessions'])
  return {
    seq: pickNumber(source, 'seq') ?? 0,
    cwd: pickString(source, 'cwd'),
    sessionId: pickString(source, 'sessionId'),
    entries,
    liveEntries,
    status: normalizeStatus(source['status']),
    surfaces: normalizeSurfaces(source['surfaces'] ?? source['surface']),
    sessions,
  }
}

// ── 派生读取器 ─────────────────────────────────────────────────────────────

/** 历史 + 直播尾，按渲染顺序拼好。 */
export function allEntries(snapshot: RemoteSnapshot | null): TranscriptEntry[] {
  if (snapshot === null) return []
  return [...snapshot.entries, ...snapshot.liveEntries]
}

/**
 * 本轮 usage：取「最后一条带 usage 的条目」的值（同轮里靠后的条目挂的是到那一刻为止的
 * 累计，最后一条就是整轮真值）；一条都没有时退回 status.usage；都没有就 null。
 */
export function currentTurnUsage(snapshot: RemoteSnapshot | null): { inputTokens: number; outputTokens: number } | null {
  if (snapshot === null) return null
  const entries = allEntries(snapshot)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && (entry.kind === 'text' || entry.kind === 'tool') && entry.usage !== undefined) {
      return entry.usage
    }
  }
  return snapshot.status?.usage ?? null
}
