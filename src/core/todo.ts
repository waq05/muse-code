/**
 * 会话任务清单：模型自己维护、界面实时显示的那张单子。
 *
 * 语义抄两家的交集并各留一点长处：
 *   - 整表替换（Codex `update_plan`、DSH `todo_write` 都是整表，少一套增量 diff 协议）；
 *   - 条目带 id 和可选 parent（Hermes `tools/todo_tool.py:26-31`），有 id 才谈得上「只改状态」，
 *     有 parent 才显示得出「这一步是刚才那步的子任务」；
 *   - 每次真正变化的写入都让 revision +1，界面拿它拒绝过期帧（同文件 :32）；
 *   - 有上限：清单本身会被压缩后重新注入，不设上限就等于把压缩省下的token又吃回去。
 *
 * @module dsc/core/todo
 */
import type { TodoStatus as ContractTodoStatus } from '../contract.js'

/**
 * 任务状态；`cancelled` 是「决定不做了」，跟「没做完」不是一回事。
 * 类型就是 contract 的那个 TodoStatus（会话日志、界面、存储共用一份声明）。
 */
export type TodoStatus = ContractTodoStatus

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/** 单条任务正文长度上限（界面一行显示得下，压缩重注入也扛得住）。 */
export const MAX_TODO_CONTENT_CHARS = 300

/** 清单条数上限。 */
export const MAX_TODO_ITEMS = 64

/** 四态符号：界面和纯文本回显共用一套，模型看到的和用户看到的是同一件事。 */
export const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
  cancelled: '[~]',
}

/** 一条任务。数组下标就是优先级顺序。 */
export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  /** 父任务 id；省略 = 顶层任务。父不存在时这个字段会被丢掉（不报错，但界面按顶层显示）。 */
  parent?: string
}

/** 一次写入的结果：整表 + 新 revision + 对被静悄悄修掉的地方说的话。 */
export interface TodoWriteResult {
  items: TodoItem[]
  revision: number
  /** 校正说明（过长截断、父任务不存在、id 重复合并），原样回给模型。 */
  notes: string[]
}

/** 生成一个短 id（模型不给 id 时用）。 */
function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** 会话级清单存储：一个会话一份，切会话时换一份。 */
export class TodoStore {
  private items: TodoItem[] = []
  private revision = 0

  /** 当前整表（浅拷贝，调用方改不动内部）。 */
  read(): TodoItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  /** 当前版本号。 */
  get rev(): number {
    return this.revision
  }

  /** 清单是不是空的（空的时候界面不占位置）。 */
  get empty(): boolean {
    return this.items.length === 0
  }

  /**
   * 写入整表或按 id 合并。
   *
   * @param todos - 新任务列表（整表替换时是完整清单）。
   * @param merge - true = 只按 id 更新给出的字段并追加新条目；false（默认）= 整表替换。
   */
  write(todos: readonly unknown[], merge = false): TodoWriteResult {
    const notes: string[] = []
    const before = this.items
    if (merge) {
      this.items = this.mergeInto(this.items, todos, notes)
    } else {
      this.items = this.normalize(todos, notes)
    }
    if (this.items.length > MAX_TODO_ITEMS) {
      notes.push(`只保留前 ${MAX_TODO_ITEMS} 条，其余 ${this.items.length - MAX_TODO_ITEMS} 条已丢弃`)
      this.items = this.items.slice(0, MAX_TODO_ITEMS)
    }
    this.dropOrphanParents(notes)
    if (!sameList(before, this.items)) this.revision += 1
    return { items: this.read(), revision: this.revision, notes }
  }

  /** 从会话日志恢复（不走 revision 递增，保持恢复前后的版本一致）。 */
  restore(items: readonly unknown[]): void {
    const notes: string[] = []
    this.items = this.normalize(items, notes)
  }

  /** 清空（切会话、用户手动清）。 */
  clear(): void {
    if (this.items.length > 0) {
      this.items = []
      this.revision += 1
    }
  }

  /** 进度：完成数 / 有效总数（cancelled 不计入分母）。 */
  progress(): { done: number; total: number; active: string | null } {
    const counted = this.items.filter((item) => item.status !== 'cancelled')
    const active = counted.find((item) => item.status === 'in_progress')
    return {
      done: counted.filter((item) => item.status === 'completed').length,
      total: counted.length,
      active: active?.content ?? null,
    }
  }

  /**
   * 给模型看的纯文本（清单在压缩后要重新注入，靠这段把进度接回去）。
   */
  formatForPrompt(): string {
    if (this.items.length === 0) return ''
    const byParent = new Map<string, TodoItem[]>()
    for (const item of this.items) {
      const key = item.parent ?? ''
      const bucket = byParent.get(key)
      if (bucket === undefined) byParent.set(key, [item])
      else bucket.push(item)
    }
    const lines: string[] = []
    const render = (parentKey: string, indent: string): void => {
      for (const item of byParent.get(parentKey) ?? []) {
        lines.push(`${indent}${STATUS_MARKS[item.status]} ${item.id} ${item.content}`)
        render(item.id, `${indent}  `)
      }
    }
    render('', '')
    const { done, total } = this.progress()
    return `${lines.join('\n')}\n进度 ${done}/${total}`
  }

  /** 校验 + 补全（id 缺失自动补、正文过长截断、非法状态回落 pending）。 */
  private normalize(todos: readonly unknown[], notes: string[]): TodoItem[] {
    const out: TodoItem[] = []
    const seen = new Set<string>()
    for (const raw of todos) {
      const item = this.one(raw, notes)
      if (item === null) continue
      if (seen.has(item.id)) {
        notes.push(`id ${item.id} 出现两次，后一条已合并进前一条`)
        const prev = out.findIndex((candidate) => candidate.id === item.id)
        if (prev >= 0) out[prev] = item
        continue
      }
      seen.add(item.id)
      out.push(item)
    }
    return out
  }

  /** 合并写入：已有条目只改给出的字段，新条目校验后追加。 */
  private mergeInto(current: TodoItem[], todos: readonly unknown[], notes: string[]): TodoItem[] {
    // 先整体克隆：直接改 current 里的对象会让「写前写后是同一批对象」，
    // 下面 sameList 就看不出变化，版本号也就不会涨。
    const out = current.map((item) => ({ ...item }))
    const index = new Map(out.map((item) => [item.id, item]))
    for (const raw of todos) {
      const patch = raw as Record<string, unknown>
      const id = typeof patch?.id === 'string' ? patch.id.trim() : ''
      if (id === '') {
        notes.push('merge 模式必须给 id（否则不知道该改哪一条），这条已忽略')
        continue
      }
      const existing = index.get(id)
      if (existing === undefined) {
        const item = this.one(raw, notes)
        if (item === null) continue
        item.id = id
        index.set(id, item)
        out.push(item)
        continue
      }
      if (typeof patch.content === 'string' && patch.content.trim() !== '') {
        existing.content = this.cap(patch.content.trim(), notes)
      }
      if (typeof patch.status === 'string' && TODO_STATUSES.includes(patch.status as TodoStatus)) {
        existing.status = patch.status as TodoStatus
      } else if (patch.status !== undefined) {
        notes.push(`id ${id} 的状态 ${String(patch.status)} 不认识，保持 ${existing.status}`)
      }
      if ('parent' in patch) {
        const parent = typeof patch.parent === 'string' ? patch.parent.trim() : ''
        if (parent === '') delete existing.parent
        else existing.parent = parent
      }
    }
    return out
  }

  /** 校验并归一化单条。返回 null = 这条直接丢。 */
  private one(raw: unknown, notes: string[]): TodoItem | null {
    if (raw === null || typeof raw !== 'object') {
      notes.push('有一条任务不是对象，已忽略')
      return null
    }
    const doc = raw as Record<string, unknown>
    const content = typeof doc.content === 'string' ? doc.content.trim() : ''
    if (content === '') {
      notes.push('有一条任务正文是空的，已忽略')
      return null
    }
    let status: TodoStatus = 'pending'
    if (typeof doc.status === 'string' && TODO_STATUSES.includes(doc.status as TodoStatus)) {
      status = doc.status as TodoStatus
    } else if (doc.status !== undefined) {
      notes.push(`状态 ${String(doc.status)} 不认识，按 pending 处理（可选：${TODO_STATUSES.join(' / ')}）`)
    }
    const id = typeof doc.id === 'string' && doc.id.trim() !== '' ? doc.id.trim() : shortId()
    const parent = typeof doc.parent === 'string' && doc.parent.trim() !== '' ? doc.parent.trim() : undefined
    return { id, content: this.cap(content, notes), status, ...(parent !== undefined ? { parent } : {}) }
  }

  private cap(content: string, notes: string[]): string {
    if (content.length <= MAX_TODO_CONTENT_CHARS) return content
    notes.push(`有任务正文超过 ${MAX_TODO_CONTENT_CHARS} 字，已截断`)
    return `${content.slice(0, MAX_TODO_CONTENT_CHARS - 1)}…`
  }

  /** 父任务不存在的条目降级成顶层任务（不是错误，但要说一句）。 */
  private dropOrphanParents(notes: string[]): void {
    const ids = new Set(this.items.map((item) => item.id))
    let dropped = 0
    for (const item of this.items) {
      if (item.parent === undefined) continue
      if (!ids.has(item.parent) || item.parent === item.id) {
        delete item.parent
        dropped += 1
      }
    }
    if (dropped > 0) notes.push(`${dropped} 条任务的 parent 找不到对应任务，已按顶层任务显示`)
  }
}

function sameList(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.content !== y.content || x.status !== y.status || x.parent !== y.parent) return false
  }
  return true
}
