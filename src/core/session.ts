/**
 * 轻量会话存储：内存里就是 OpenAI 协议消息数组（llm 层零转换），磁盘上是
 * append-only JSONL（~/.dsc/sessions/<cwd 压缩>/<id>.jsonl）。恢复 = 逐行
 * 重放。对应 dsh 的 session-persistence-jsonl 的个人版最小实现——没有
 * 修复/投影/ignorable 语义（个人版不需要）。
 *
 * @module dsc/core/session
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatContentPart, ChatMessage, ToolCall } from './llm.js'

/** 会话元数据（jsonl 首行 + 列表投影）。 */
export interface SessionMeta {
  id: string
  cwd: string
  createdAt: number
  /** 首条用户消息截断（会话列表展示用），无用户消息时 undefined。 */
  title?: string
}

type SessionRecord =
  | ({ type: 'meta' } & SessionMeta)
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; reasoning: string; toolCalls?: ToolCall[] }
  | { type: 'tool'; callId: string; name: string; text: string; images?: string[]; error?: string }
  | { type: 'summary'; text: string }

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
  private readonly stream: ReturnType<typeof createWriteStream>

  private constructor(meta: SessionMeta, file: string, initialMessages: ChatMessage[] = []) {
    this.meta = meta
    this.file = file
    this.messages.push(...initialMessages)
    this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' })
  }

  /** 新建会话（写 meta 首行）。 */
  static create(cwd: string): Session {
    const meta: SessionMeta = { id: randomUUID(), cwd, createdAt: Date.now() }
    const dir = join(sessionsRoot(), slugCwd(cwd))
    mkdirSync(dir, { recursive: true })
    const session = new Session(meta, join(dir, `${meta.id}.jsonl`))
    session.write({ type: 'meta', ...meta })
    return session
  }

  /** 从 jsonl 重放恢复（system prompt 照样由 loop 加头）。 */
  static load(file: string): Session {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    let meta: SessionMeta | undefined
    const messages: ChatMessage[] = []
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
          messages.push({ role: 'user', content: record.text })
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
          messages.push({ role: 'tool', content, tool_call_id: record.callId })
          break
        }
        case 'summary':
          messages.push({ role: 'user', content: record.text })
          break
      }
    }
    if (meta === undefined) throw new Error(`会话文件缺少 meta 行：${file}`)
    return new Session(meta, join(sessionsRoot(), slugCwd(meta.cwd), `${meta.id}.jsonl`), messages)
  }

  appendUser(text: string): void {
    this.messages.push({ role: 'user', content: text })
    this.write({ type: 'user', text })
  }

  appendAssistant(text: string, reasoning: string, toolCalls: ToolCall[]): void {
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
    })
    this.write({
      type: 'assistant',
      text,
      reasoning,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    })
  }

  /**
   * 追加工具结果。output 为对象时支持附带图像（data URL），消息以多模态
   * content 数组落库（需端点支持视觉；JSONL 记录 text + images 两字段）。
   */
  appendTool(
    callId: string,
    name: string,
    output: string | { text: string; images?: string[] },
    error?: string,
  ): void {
    const text = typeof output === 'string' ? output : output.text
    const images = typeof output === 'string' ? undefined : output.images
    const content: string | ChatContentPart[] =
      images !== undefined && images.length > 0
        ? [
            { type: 'text', text },
            ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
          ]
        : text
    this.messages.push({ role: 'tool', content, tool_call_id: callId })
    this.write({ type: 'tool', callId, name, text, ...(images !== undefined && images.length > 0 ? { images } : {}) })
  }

  /** 压缩落库：替换内存历史并写 summary 标记（磁盘历史保留原文，重放时同样被折叠）。 */
  replaceWithSummary(summaryText: string, kept: ChatMessage[]): void {
    this.messages.length = 0
    this.messages.push(...kept)
    this.write({ type: 'summary', text: summaryText })
  }

  close(): void {
    this.stream.end()
  }

  get filePath(): string {
    return this.file
  }

  private write(record: SessionRecord): void {
    this.stream.write(`${JSON.stringify(record)}\n`)
  }
}

/** 列出全部会话（meta 来自首行，按 mtime 倒序；标题取首条用户记录）。 */
export function listSessions(): SessionMeta[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const metas: SessionMeta[] = []
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir)
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dirPath, file)
      try {
        const head = readFileSync(filePath, 'utf8').split(/\r?\n/, 8)
        const record = JSON.parse(head[0] ?? '') as SessionRecord
        if (record.type !== 'meta') continue
        const userLine = head.find((line) => line.startsWith('{"type":"user"'))
        const title =
          userLine !== undefined
            ? (JSON.parse(userLine) as { text: string }).text.replace(/\s+/g, ' ').trim().slice(0, 60)
            : undefined
        metas.push({ id: record.id, cwd: record.cwd, createdAt: record.createdAt, title })
      } catch {
        continue
      }
    }
  }
  return metas.sort((a, b) => b.createdAt - a.createdAt)
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
