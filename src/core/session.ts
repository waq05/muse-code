/**
 * 轻量会话存储：内存里就是 OpenAI 协议消息数组（llm 层零转换），磁盘上是
 * append-only JSONL（~/.dsc/sessions/<cwd 压缩>/<id>.jsonl）。恢复 = 逐行
 * 重放。对应 dsh 的 session-persistence-jsonl 的个人版最小实现——没有
 * 修复/投影/ignorable 语义（个人版不需要）。
 *
 * @module dsc/core/session
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatContentPart, ChatMessage, ToolCall } from './llm.js'
import type { CollaborationMode, PlanView, TodoItemView } from '../contract.js'
import type { GoalSnapshot } from './goal.js'
import { dropSessionMeta, patchSessionMeta, readSessionMeta } from './session-meta.js'
import type { SessionMetaRecord } from './session-meta.js'

/** 会话元数据（jsonl 首行 + 列表投影）。 */
export interface SessionMeta {
  id: string
  cwd: string
  createdAt: number
  /** 首条用户消息截断（会话列表展示用），无用户消息时 undefined。 */
  title?: string
}

/** 一条请求注入备忘（note 记录的内存形状）。 */
export interface SessionNote {
  id: string
  text: string
  ts?: number
}

type SessionRecord =
  | ({ type: 'meta' } & SessionMeta)
  /**
   * 下面四条都带 `ts`：这条记录写入磁盘的时刻（毫秒 epoch），同时也是内存里
   * 那条消息 `ChatMessage.ts` 的来源。为什么记在会话日志里而不是另存一份：
   * 恢复会话是逐行重放 jsonl，只有行内自带时间，历史消息才说得清「几点发的」，
   * 界面的每轮用时也才算得出来（见 contract.ts 的 TranscriptEntry.ts）。
   * 老日志没有这个字段，重放时按 undefined 处理。
   */
  | { type: 'user'; text: string; images?: string[]; ts?: number }
  | { type: 'assistant'; text: string; reasoning: string; toolCalls?: ToolCall[]; ts?: number }
  | { type: 'tool'; callId: string; name: string; text: string; images?: string[]; error?: string; ts?: number }
  | {
      type: 'summary'
      text: string
      /**
       * 摘要之外保留了尾部多少条消息（内存里的 `kept.length - 1`）。
       * 磁盘是 append-only，摘要之前的原始记录一条都没删，重放时只能靠这个数字
       * 知道该从末尾留下多少条（{@link Session.load} 的 `case 'summary'`）。
       * 老日志没有这个字段，按 0 处理。
       */
      keep?: number
      ts?: number
    }
  /**
   * 会话状态（模式、清单、计划、目标……）：一条记录一个条目，谁的功能谁自己写。
   * 存储层不认识具体功能，`id` 与负载类型见 {@link SessionStateMap}。
   */
  | { type: 'state'; id: string; payload: unknown }
  /**
   * 请求注入备忘（Model-visible ⟺ logged 的补丁）：插件投影往请求体里塞的、日志上
   * 本来没有的内容（LSP 写后诊断、生命周期钩子的话术）在此留底。备忘不进请求消息流、
   * 不参与重放折叠，恢复会话后经 `session.notes` 读出——模型看到的东西因此能从
   * 日志完整重建。老构建读到此类型会静默跳过（load 的 switch 没有 default）。
   */
  | { type: 'note'; id: string; text: string; ts?: number }
  /**
   * 下面四种是早先「一种功能一条记录」的写法，已经不再写入，
   * 只为读得回老会话日志而留着（{@link Session.load} 的兼容分支）。
   */
  | { type: 'mode'; mode: CollaborationMode }
  | { type: 'todo'; items: TodoItemView[] }
  | { type: 'plan'; plan: PlanView }
  | { type: 'goal'; goal: GoalSnapshot }

/**
 * 会话日志里的「状态」条目表：id → 那个功能点存的负载。
 *
 * 这些内容不发进请求体（协议里没有它们的位置），但恢复历史会话时必须在场。
 * 功能点想加自己的状态就用声明合并加一行，不必回来改存储层：
 * `declare module '../core/session.js' { interface SessionStateMap { memory: MyRecord } }`。
 */
export interface SessionStateMap {
  /** 协作模式（mode 插件写）。 */
  mode: CollaborationMode
  /** 任务清单整表，最后一条生效（todo 插件写）。 */
  todos: TodoItemView[]
  /** 最近一份计划及其评审结果（plan 插件写）。 */
  plan: PlanView
  /** 会话目标快照（goal 插件写）。 */
  goal: GoalSnapshot
  /**
   * 自我改进的记账（self-improve 插件写）：本轮复盘到哪个轮次、本会话读过哪些技能。
   *
   * 形状故意留成 `unknown`：core 层不该认识插件层的类型（依赖方向反过来就成环），
   * 读回来时由 `core/learnings/store.ts` 的 `normalizeLearningsState` 兜底。
   */
  learnings: unknown
  /**
   * 最近一次请求使用的系统提示词全文（agent 插件写，hash 去重——变了才写一条）。
   * 系统提示不进 user/assistant 消息流，靠这条状态记录补上「模型看到的提示词」：
   * 恢复会话后最后一条就是当前生效的那份（Model-visible ⟺ logged 的提示词半边）。
   */
  'system-prompt': { hash: string; text: string }
}

/**
 * 用户拒绝某次工具调用时，写进那条工具结果的固定回执文案（由 loop 的拒绝分支产出）。
 * 2026-02 之前的日志没有单独记 `error` 字段，{@link Session.load} 靠这句话把
 * 「已拒绝」的状态补回来；之后的日志直接读 `error`，这句话只用来兜老数据。
 */
export const REJECTED_TOOL_TEXT = '用户拒绝了这次工具调用。'

/** 工具结果的异常标记：`rejected` = 用户拒绝，`tool-error` = 工具执行报错（loop 写入）。 */
const REJECTED_TOOL_ERROR = 'rejected'

/** 压缩 cwd 为目录名：`C:\Users\waq` → `C-Users-waq`。 */
export function slugCwd(cwd: string): string {
  return cwd.replace(/[\\/:]+/g, '-')
}

export function sessionsRoot(): string {
  return join(homedir(), '.dsc', 'sessions')
}

/** 一个会话：内存消息 + 磁盘日志。 */
export class Session {
  readonly meta: SessionMeta
  /** 协议消息（不含 system prompt；system 由 loop 在请求组装时加头）。 */
  readonly messages: ChatMessage[] = []
  private readonly file: string
  /** 写入流。新会话在第一条日志真正落盘之前是 null，所以没发过消息的会话不留文件。 */
  private stream: ReturnType<typeof createWriteStream> | null = null
  /** meta 首行是否已经写进磁盘。 */
  private metaWritten: boolean
  /**
   * 工具调用的异常标记（callId → `rejected` / `tool-error`）。
   * OpenAI 协议里没有这个概念，所以它不挂在 `messages` 上（否则会被发进请求体），
   * 只在 jsonl 的 tool 记录里存一份，重放历史时单独交给 transcript 决定卡片状态。
   */
  readonly toolErrors = new Map<string, string>()
  /**
   * 会话状态条目（见 {@link SessionStateMap}）。
   * 不发进请求体，恢复历史会话时由 {@link Session.load} 逐行填回来。
   */
  private readonly stateById = new Map<string, unknown>()
  /** 请求注入备忘（note 记录）；恢复会话时从日志重放回来，经 {@link notes} 读出。 */
  private readonly noteLog: SessionNote[] = []

  private constructor(
    meta: SessionMeta,
    file: string,
    initialMessages: ChatMessage[] = [],
    restored = false,
    state?: ReadonlyMap<string, unknown>,
    initialNotes: SessionNote[] = [],
  ) {
    this.meta = meta
    this.file = file
    this.messages.push(...initialMessages)
    this.metaWritten = restored
    if (state !== undefined) for (const [id, payload] of state) this.stateById.set(id, payload)
    this.noteLog.push(...initialNotes)
  }

  /**
   * 新建会话：只在内存里，第一条日志写下去时磁盘上才出现这个文件。
   * @param file - 指定落盘路径（队友日志住在 `.teammates` 下，不进会话列表）；省略走默认。
   */
  static create(cwd: string, file?: string): Session {
    const meta: SessionMeta = { id: randomUUID(), cwd, createdAt: Date.now() }
    return new Session(meta, file ?? join(sessionsRoot(), slugCwd(cwd), `${meta.id}.jsonl`))
  }

  /**
   * 从 jsonl 重放恢复（system prompt 照样由 loop 加头）。
   * @param keepPath - true = 后续追加写回读进来的这个路径。
   *                   省略时按会话根目录重算路径（归档区里的文件因此会被"搬回"活动区，
   *                   这是历史行为，只有读别人家的日志才需要传 true）。
   */
  static load(file: string, keepPath = false): Session {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    let meta: SessionMeta | undefined
    const messages: ChatMessage[] = []
    const toolErrors = new Map<string, string>()
    const state = new Map<string, unknown>()
    const notes: SessionNote[] = []
    for (const line of lines) {
      let record: SessionRecord
      try {
        record = JSON.parse(line) as SessionRecord
      } catch {
        continue
      }
      switch (record.type) {
        case 'meta':
          meta = { id: record.id, cwd: record.cwd, createdAt: record.createdAt }
          break
        case 'user':
          messages.push({
            role: 'user',
            content:
              record.images !== undefined && record.images.length > 0
                ? [
                    { type: 'text', text: record.text },
                    ...record.images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
                  ]
                : record.text,
            // 老日志没有 ts：这里就是 undefined，界面据此降级（不显示时间/用时）
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          break
        case 'assistant': {
          messages.push({
            role: 'assistant',
            content: record.text,
            ...(record.reasoning !== '' ? { reasoning_content: record.reasoning } : {}),
            ...(record.toolCalls !== undefined && record.toolCalls.length > 0
              ? {
                  tool_calls: record.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          break
        }
        case 'tool': {
          const content: ChatContentPart[] | string =
            record.images !== undefined && record.images.length > 0
              ? [
                  { type: 'text', text: record.text },
                  ...record.images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
                ]
              : record.text
          messages.push({
            role: 'tool',
            content,
            tool_call_id: record.callId,
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          // 状态取自 error 字段；早于该字段的老日志按固定回执文案把「已拒绝」补回来
          const error = record.error ?? (record.text === REJECTED_TOOL_TEXT ? REJECTED_TOOL_ERROR : undefined)
          if (error !== undefined) toolErrors.set(record.callId, error)
          break
        }
        case 'summary': {
          // 摘要之前的原始记录还留在磁盘上（append-only），逐条读回来等于这次压缩白做；
          // 所以这里把已经读到的消息换成「摘要 + 末尾 keep 条」。尾部必须在清空之前取。
          // 老日志没有 keep 字段，按 0 走：结果是「摘要 + 摘要之后的记录」。这是刻意的向后兼容，
          // 比把摘要之前的原文整段读回来（压缩等于没压）好得多。
          const keep = record.keep ?? 0
          const tail = keep > 0 ? messages.slice(-keep) : []
          messages.length = 0
          messages.push({
            role: 'user',
            content: record.text,
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          messages.push(...tail)
          break
        }
        case 'state':
          state.set(record.id, record.payload)
          break
        case 'note':
          notes.push({ id: record.id, text: record.text, ts: record.ts })
          break
        // ↓ 老会话日志的兼容分支（这四种记录已不再写入），按现在的条目名归位
        case 'mode':
          state.set('mode', record.mode)
          break
        case 'todo':
          state.set('todos', record.items)
          break
        case 'plan':
          state.set('plan', record.plan)
          break
        case 'goal':
          state.set('goal', record.goal)
          break
      }
    }
    if (meta === undefined) throw new Error(`会话文件缺少 meta 行：${file}`)
    const session = new Session(
      meta,
      keepPath ? file : join(sessionsRoot(), slugCwd(meta.cwd), `${meta.id}.jsonl`),
      messages,
      true,
      state,
      notes,
    )
    for (const [callId, error] of toolErrors) session.toolErrors.set(callId, error)
    return session
  }

  /**
   * 追加用户消息。带图时消息以多模态 content 数组落库（要模型声明了照片输入才发得出去；
   * JSONL 记 text + images 两个字段，跟工具结果带图的写法一致）。
   *
   * `ts` 只写一份给内存与磁盘共用：界面按它显示「这条消息几点发的」，
   * 也是这一轮「用时」的起点（见 contract.ts 的 TranscriptEntry.ts）。
   */
  appendUser(text: string, images?: string[]): void {
    const withImages = images !== undefined && images.length > 0
    const ts = Date.now()
    this.messages.push({
      role: 'user',
      content: withImages
        ? [
            { type: 'text', text },
            ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
          ]
        : text,
      ts,
    })
    this.write({ type: 'user', text, ...(withImages ? { images } : {}), ts })
  }

  appendAssistant(text: string, reasoning: string, toolCalls: ToolCall[]): void {
    const ts = Date.now()
    this.messages.push({
      role: 'assistant',
      content: text,
      ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      ts,
    })
    this.write({
      type: 'assistant',
      text,
      reasoning,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ts,
    })
  }

  /**
   * 追加工具结果。output 为对象时支持附带图像（data URL），消息以多模态
   * content 数组落库（需端点支持视觉；JSONL 记录 text + images 两字段）。
   * error 是展示状态标记（`rejected` / `tool-error`），随 jsonl 一起落盘，
   * 但不进协议消息——重放历史时由 {@link Session.toolErrors} 提供给界面。
   */
  appendTool(
    callId: string,
    name: string,
    output: string | { text: string; images?: string[] },
    error?: string,
  ): void {
    const ts = Date.now()
    const text = typeof output === 'string' ? output : output.text
    const images = typeof output === 'string' ? undefined : output.images
    const content: string | ChatContentPart[] =
      images !== undefined && images.length > 0
        ? [
            { type: 'text', text },
            ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
          ]
        : text
    this.messages.push({ role: 'tool', content, tool_call_id: callId, ts })
    if (error !== undefined) this.toolErrors.set(callId, error)
    this.write({
      type: 'tool',
      callId,
      name,
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(error !== undefined ? { error } : {}),
      ts,
    })
  }

  /**
   * 压缩落库：内存里换成「摘要 + 保留的尾部」，磁盘上追加一条 summary 记录。
   *
   * `keep` 记下保留了多少条尾部消息：日志是 append-only，摘要之前的原始记录一条都不会删，
   * 重放时只能靠这个数字知道该从磁盘记录构建出的消息里留下末尾几条
   * （见 {@link Session.load} 的 `case 'summary'`）。
   * @param summaryText - 摘要正文（第一条保留消息的 content）。
   * @param kept - 压缩后内存里要留的消息，第一条就是摘要本身。
   */
  replaceWithSummary(summaryText: string, kept: ChatMessage[]): void {
    // 摘要那条是压缩现场新造的，补一个落盘时刻；尾部那些本来就在内存里，保持原时间不变
    // （不然压缩会把历史消息的时间全刷成「现在」）。
    const ts = Date.now()
    for (const message of kept) if (message.ts === undefined) message.ts = ts
    this.messages.length = 0
    this.messages.push(...kept)
    // 尾部不重新写盘：那得把 tool 记录的 name 字段反推回来，得不偿失。
    // kept[0] 是摘要本身，所以减一才是尾部条数。
    this.write({ type: 'summary', text: summaryText, keep: Math.max(kept.length - 1, 0), ts })
  }

  /**
   * 读一个会话状态条目（恢复历史会话时由日志重放填回）。
   * @param id - 条目名，见 {@link SessionStateMap}。
   * @returns 这个功能点最后写进去的负载；没写过就是 undefined。
   */
  state<K extends keyof SessionStateMap>(id: K): SessionStateMap[K] | undefined {
    // 负载从磁盘 JSON 里来，读的时候不重新校验（各功能点自己负责读懂自己存的东西，
    // 例如 GoalStore.restore 会挑坏值），这里只做条目名的查表。
    return this.stateById.get(id as string) as SessionStateMap[K] | undefined
  }

  /**
   * 写一个会话状态条目：内存里换掉，磁盘上追加一条（日志是 append-only，最后一条生效）。
   * @param id - 条目名，见 {@link SessionStateMap}。
   * @param payload - 这个功能点自己的负载。
   */
  appendState<K extends keyof SessionStateMap>(id: K, payload: SessionStateMap[K]): void {
    this.stateById.set(id as string, payload)
    this.write({ type: 'state', id: String(id), payload })
  }

  /** 已记录的请求注入备忘（note 记录），按写入顺序；恢复会话时从日志重放回来。 */
  notes(): readonly SessionNote[] {
    return this.noteLog
  }

  /**
   * 追加一条请求注入备忘（note 记录）：投影往请求体里塞的、日志上本来没有的内容
   * 必须在此留底，模型看到的东西才能从日志完整重建（dsh 的 Model-visible ⟺ logged）。
   * 备忘不参与重放折叠，界面暂不显示；多次调用按顺序各留一条。
   * @param id - 注入来源的投影名（例如 `lsp-write-diagnostics`）。
   * @param text - 注入的原文。
   */
  appendNote(id: string, text: string): void {
    const ts = Date.now()
    this.noteLog.push({ id, text, ts })
    this.write({ type: 'note', id, text, ts })
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }

  /** 日志有没有落盘：新建但还没发过消息的会话为 false（磁盘上没有它的文件）。 */
  get persisted(): boolean {
    return this.metaWritten
  }

  get filePath(): string {
    return this.file
  }

  private write(record: SessionRecord): void {
    // 第一条日志顺带补上 meta 首行：jsonl 的 append-only 顺序不能变
    if (this.metaWritten !== true) {
      this.metaWritten = true
      this.streamFor().write(`${JSON.stringify({ type: 'meta', ...this.meta })}\n`)
    }
    this.streamFor().write(`${JSON.stringify(record)}\n`)
  }

  /** 第一条日志要落盘时才建工作区目录、开写入流。 */
  private streamFor(): ReturnType<typeof createWriteStream> {
    if (this.stream === null) {
      mkdirSync(dirname(this.file), { recursive: true })
      const stream = createWriteStream(this.file, { flags: 'a', encoding: 'utf8' })
      // 磁盘满/权限错的 error 事件没人接会让进程以未捕获异常崩掉（2026-09-29）：
      // 丢掉这条流，下一条日志重新开——丢一条记录好过崩掉整个宿主。
      stream.on('error', () => {
        if (this.stream === stream) this.stream = null
      })
      this.stream = stream
    }
    return this.stream
  }
}

/**
 * 列表投影的一行：读一个 jsonl 文件得到的元数据 + sidecar 属性 + 文件路径。
 * `updatedAt` 来自文件 mtime（最后一次写入日志的时间），是「最近使用」的排序依据。
 */
export interface SessionListItem {
  /** 会话 uuid。 */
  id: string
  cwd: string
  /** 创建时间（meta 首行）。 */
  createdAt: number
  /** 最后一次写入的时间（文件 mtime）。 */
  updatedAt: number
  /** 展示标题：用户改过的标题优先，否则首条用户消息截断。 */
  title?: string
  /** 置顶时间；有值即置顶。 */
  pinnedAt?: number
  /** 归档时间；只在归档列表里有值。 */
  archivedAt?: number
  /** jsonl 的绝对路径（UI 侧的会话 id 就是它）。 */
  path: string
}

/** 归档区与回收站（都在 ~/.dsc 下，点开头的名字让正常列表自然跳过）。 */
export function archivedRoot(): string {
  return join(sessionsRoot(), '.archived')
}

export function trashRoot(): string {
  return join(homedir(), '.dsc', '.trash')
}

/** 回收站保留天数：超期的文件在下次访问归档区时清掉。 */
const TRASH_RETENTION_DAYS = 30

/** 列出全部会话（正常区；归档区与回收站不在内）。 */
export function listSessions(): SessionListItem[] {
  return scanSessions(sessionsRoot(), readSessionMeta())
}

/** 列出归档会话，按归档时间倒序；顺手清一次过期的回收站文件。 */
export function listArchivedSessions(): SessionListItem[] {
  sweepTrash()
  const metas = readSessionMeta()
  return scanSessions(archivedRoot(), metas)
    .map((item) => ({ ...item, archivedAt: metas[item.id]?.archivedAt ?? item.updatedAt }))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/**
 * 扫一个根目录下的 `<工作目录名>/<uuid>.jsonl`。
 * 跳过点开头的条目（`.archived` 归档区）和非目录（`meta.json` sidecar），
 * 单个文件读失败只丢这一条，不影响整个列表。
 */
function scanSessions(root: string, metas: Record<string, SessionMetaRecord>): SessionListItem[] {
  if (!existsSync(root)) return []
  const out: SessionListItem[] = []
  for (const dir of readdirSync(root)) {
    if (dir.startsWith('.')) continue
    const dirPath = join(root, dir)
    if (!statSync(dirPath).isDirectory()) continue
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      // 文件名就是 `<uuid>.jsonl`，sidecar 按 uuid 存，所以按文件名取属性
      const item = readSessionFile(join(dirPath, file), metas[basename(file, '.jsonl')])
      if (item !== null) out.push(item)
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** 读一个会话文件的前几行 + mtime；首行不是 meta（损坏/空文件）返回 null。 */
function readSessionFile(filePath: string, sidecar?: SessionMetaRecord): SessionListItem | null {
  try {
    const head = readFileSync(filePath, 'utf8').split(/\r?\n/, 8)
    const record = JSON.parse(head[0] ?? '') as SessionRecord
    if (record.type !== 'meta') return null
    const derived = head.find((line) => line.startsWith('{"type":"user"'))
    const title = sidecar?.title
      ?? (derived !== undefined
        ? (JSON.parse(derived) as { text: string }).text.replace(/\s+/g, ' ').trim().slice(0, 60)
        : undefined)
    return {
      id: record.id,
      cwd: record.cwd,
      createdAt: record.createdAt,
      updatedAt: statSync(filePath).mtimeMs,
      ...(title !== undefined ? { title } : {}),
      ...(sidecar?.pinnedAt !== undefined ? { pinnedAt: sidecar.pinnedAt } : {}),
      path: filePath,
    }
  } catch {
    return null
  }
}

/**
 * 队友（子智能体）运行记录的根目录。它放在会话根目录下的 `.teammates`，
 * 于是会话列表扫不到它（scanSessions 跳过点开头的条目），
 * 但路径校验仍认它是"自己家的日志"，桌面端可以只读打开它。
 */
export function teammateRoot(): string {
  return join(sessionsRoot(), '.teammates')
}

/** 会话文件必须落在 sessions 根下（归档区也算），才允许被这些操作碰到。 */
function assertSessionFile(filePath: string): string {
  const root = sessionsRoot()
  const resolved = join(filePath)
  if (!resolved.startsWith(root + '\\') && !resolved.startsWith(root + '/')) {
    throw new Error(`会话路径不在 ${root} 下：${filePath}`)
  }
  if (!resolved.endsWith('.jsonl') || !existsSync(resolved)) {
    throw new Error(`会话文件不存在：${filePath}`)
  }
  // 队友的运行记录是只读史料：归档、永久删除、分叉都不许对它下手。
  for (const sep of ['\\', '/']) {
    if (resolved.startsWith(teammateRoot() + sep)) {
      throw new Error(`这是队友的运行记录，不能归档、永久删除或分叉：${basename(filePath)}`)
    }
  }
  return resolved
}

/** 再加一条：只有活动区的会话能被归档，归档区里的要走恢复。 */
function assertLiveSessionFile(filePath: string): string {
  const resolved = assertSessionFile(filePath)
  if (resolved.startsWith(archivedRoot() + '\\') || resolved.startsWith(archivedRoot() + '/')) {
    throw new Error(`这个会话已经在归档区：${basename(filePath)}`)
  }
  return resolved
}

/** 把会话从当前位置移到 `from` 下同名层级，返回新路径。 */
function moveSessionFile(filePath: string, toRoot: string): string {
  const target = join(toRoot, basename(dirname(filePath)), basename(filePath))
  mkdirSync(dirname(target), { recursive: true })
  renameSync(filePath, target)
  return target
}

/** 归档一个会话：移进 `.archived/<工作目录名>/`，并在 sidecar 记归档时间。 */
export function archiveSession(filePath: string): string {
  const source = assertLiveSessionFile(filePath)
  const target = moveSessionFile(source, archivedRoot())
  patchSessionMeta(uuidOf(source), { archivedAt: Date.now() })
  return target
}

/** 恢复一个归档会话：移回正常区，清掉归档时间。 */
export function restoreSession(archivedPath: string): string {
  const source = join(archivedPath)
  if (!source.startsWith(archivedRoot()) || !existsSync(source)) throw new Error(`归档会话不存在：${archivedPath}`)
  const target = moveSessionFile(source, sessionsRoot())
  patchSessionMeta(uuidOf(source), { archivedAt: null })
  return target
}

/**
 * 永久删除一个会话：移进回收站 `.trash/<工作目录名>/`，超过
 * {@link TRASH_RETENTION_DAYS} 天后由 {@link sweepTrash} 清掉。
 * 会话内容不再出现在任何列表里，但文件还在磁盘上可手工救回。
 */
export function purgeSession(filePath: string): string {
  // 归档区和活动区都删得掉：设置页传进来的路径就在 .archived/ 里
  const source = assertSessionFile(filePath)
  const target = moveSessionFile(source, trashRoot())
  dropSessionMeta(uuidOf(source))
  return target
}

/** 清掉回收站里超过保留期的文件（按 mtime 判断），失败的文件留着下次再清。 */
export function sweepTrash(): number {
  const root = trashRoot()
  if (!existsSync(root)) return 0
  const deadline = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir)
    if (!statSync(dirPath).isDirectory()) continue
    for (const file of readdirSync(dirPath)) {
      const filePath = join(dirPath, file)
      try {
        if (statSync(filePath).mtimeMs >= deadline) continue
        unlinkSync(filePath)
        removed += 1
      } catch {
        // 被别的程序占用就留着下次清
      }
    }
  }
  return removed
}

/** 回收站里还留着多少个待清理文件（归档页拿来显示）。 */
export function countTrashFiles(): number {
  const root = trashRoot()
  if (!existsSync(root)) return 0
  let count = 0
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir)
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue
    count += readdirSync(dirPath).filter((file) => file.endsWith('.jsonl')).length
  }
  return count
}

/**
 * 分叉一个会话：复制日志到第 `beforeUserMessage` 条用户消息之前，
 * 首行 meta 换成新 uuid 与新创建时间，返回新文件路径。
 *
 * @param filePath 源会话 jsonl 路径
 * @param beforeUserMessage 以 0 起算的用户消息序号，分叉结果不含这一条及其之后
 */
export function forkSession(filePath: string, beforeUserMessage: number): string {
  const source = assertLiveSessionFile(filePath)
  const lines = readFileSync(source, 'utf8').split(/\r?\n/).filter((line) => line !== '')
  const first = JSON.parse(lines[0] ?? '') as SessionRecord
  if (first.type !== 'meta') throw new Error(`源会话首行不是 meta：${basename(source)}`)
  let seen = 0
  let cut = lines.length
  let found = false
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith('{"type":"user"')) continue
    if (seen === beforeUserMessage) {
      cut = index
      found = true
      break
    }
    seen += 1
  }
  if (!found) throw new Error(`这个会话没有第 ${beforeUserMessage + 1} 条用户消息，只有 ${seen} 条`)
  if (cut <= 1) throw new Error('分叉点之前没有任何消息，新会话会是空的')
  const meta: SessionMeta = { id: randomUUID(), cwd: first.cwd, createdAt: Date.now() }
  const target = join(sessionsRoot(), slugCwd(first.cwd), `${meta.id}.jsonl`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify({ type: 'meta', ...meta })}\n${lines.slice(1, cut).join('\n')}\n`, 'utf8')
  patchSessionMeta(meta.id, { forkedFrom: first.id })
  return target
}

/** 读一个会话里的用户消息（分叉菜单用它选分叉位置，下标一一对应）。 */
export function readUserMessages(filePath: string): string[] {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (!line.startsWith('{"type":"user"')) continue
    try {
      const record = JSON.parse(line) as { text: string }
      out.push(record.text.replace(/\s+/g, ' ').trim().slice(0, 50))
    } catch {
      // 坏行跳过，不影响其余可选位置
    }
  }
  return out
}

/** 文件名就是 `<uuid>.jsonl`，取 uuid 用来写 sidecar。 */
function uuidOf(filePath: string): string {
  return basename(filePath, '.jsonl')
}


/** 记录/读取 last-session 指针（--resume 无参时的目标）。 */
const LAST_FILE = join(homedir(), '.dsc', '.last-session')

export function saveLastSession(session: Session): void {
  mkdirSync(join(homedir(), '.dsc'), { recursive: true })
  writeFileSync(LAST_FILE, session.filePath, 'utf8')
}

export function loadLastSessionPath(): string | null {
  if (!existsSync(LAST_FILE)) return null
  return readFileSync(LAST_FILE, 'utf8').trim() || null
}
