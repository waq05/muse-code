/**
 * 侧栏会话列表的纯数据整形：工作区分组、组内排序、搜索过滤、显示名与时间文案。
 *
 * 为什么要单独一个模块：这些函数只吃数据、吐数据（不碰 React 状态、不碰拖拽），
 * 是 Sidebar 里唯一能脱离组件树独立推演的部分——抽出来，Sidebar 主组件只剩
 * 交互编排（拖拽 / 改名 / 菜单 / 展开态），分组规则改动也不用在一千行组件里找。
 *
 * 命名约定：分组键是会话的 `cwd`（见 workspace-order.ts 的模块注释），
 * 「工作区」是界面对它的称呼。
 *
 * @module desktop/renderer/sidebar-groups
 */
import type { ArchivedFilter, SessionGroupKey, SessionSortKey, SessionSummary } from '@dsc/runtime/contract.js'
import type { NestedPath } from './workspace-order.js'
import { nestByPath } from './workspace-order.js'

/** 一个工作区分组：分组键（会话 cwd）+ 该组排好序的会话 + 树分组的层级信息。 */
export interface WorkGroup extends NestedPath {
  sessions: SessionSummary[]
}

/** 工作区显示名的别名表（UiPrefsView.workspaceAliases）。 */
export type WorkspaceAliases = Record<string, string>

/** 手动排序档里每个工作区的会话顺序（UiPrefsView.sessionOrder）。 */
export type SessionOrder = Record<string, string[]>

/** 工作区手动顺序（UiPrefsView.workspaceOrder）。 */
export type WorkspaceOrder = string[]

/**
 * 工作区显示名：别名优先，没起别名就取路径最后一段。
 * （盘符根如 `D:\` 的最后一段是空串，回退全路径。）
 */
export function displayName(cwd: string, aliases: WorkspaceAliases): string {
  const alias = aliases[cwd]
  if (alias !== undefined && alias !== '') return alias
  const tail = lastSegment(cwd)
  return tail === '' ? cwd : tail
}

/** 取路径最后一段（两种分隔符都认；结尾是分隔符时给空串，由调用方兜底）。 */
export function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/** 相对时间文案（侧栏行尾）：刚刚 / N分钟 / N小时 / N天。 */
export function relative(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}小时`
  return `${String(Math.floor(hours / 24))}天`
}

/**
 * 会话行排序：置顶块照旧排最前（置顶时间倒序）；manual 档按 `sessionOrder`
 * 里拖出来的顺序走（dsh 的 reconcileManualOrder 语义——表里没有的会话按
 * 最近使用接在所属置顶块末尾），其余档按时间。cwd 缺省（单列表）没有拖拽序。
 */
export function orderedSessions(
  cwd: string | undefined,
  list: SessionSummary[],
  sort: SessionSortKey,
  sessionOrder: SessionOrder,
): SessionSummary[] {
  const sorted = [...list].sort((a, b) => {
    if ((a.pinnedAt ?? 0) !== (b.pinnedAt ?? 0)) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    return sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
  })
  if (sort !== 'manual' || cwd === undefined) return sorted
  const saved = sessionOrder[cwd]
  if (saved === undefined || saved.length === 0) return sorted
  const rank = new Map(saved.map((id, index) => [id, index]))
  // 置顶块约束：拖拽只在同一块内进行，落盘序也只在块内生效，两块之间仍是置顶在前。
  const weave = (part: SessionSummary[]): SessionSummary[] =>
    [...part].sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return 0
    })
  return [...weave(sorted.filter((session) => session.pinnedAt !== undefined)), ...weave(sorted.filter((session) => session.pinnedAt === undefined))]
}

/** 侧栏分组要的全部输入（都是值，不是 React 状态）。 */
export interface GroupInput {
  sessions: SessionSummary[]
  /** 「切过去还没发消息」的工作区也要出现在列表里。 */
  recentCwds: string[]
  /** 当前活动工作区（manual 档没排过序时活动组置顶）。 */
  cwd: string
  sort: SessionSortKey
  group: SessionGroupKey
  archived: ArchivedFilter
  /** 搜索词（已 trim + 小写；空串 = 不过滤）。 */
  trimmed: string
  aliases: WorkspaceAliases
  order: WorkspaceOrder
  sessionOrder: SessionOrder
}

/** 归档筛选：hide 只看活动区，only 只看归档区，show 两区并成一份列表。 */
function keepArchived(session: SessionSummary, archived: ArchivedFilter): boolean {
  if (archived === 'hide') return session.archivedAt === undefined
  if (archived === 'only') return session.archivedAt !== undefined
  return true
}

/**
 * 把会话库整理成侧栏要的工作区分组列表：
 * 归档筛选 → 分桶（cwd）→ 搜索过滤 → 组内排序 → 组间排序 → （tree 档）按目录前缀挂树。
 */
export function buildWorkGroups(input: GroupInput): WorkGroup[] {
  const { sessions, recentCwds, cwd, sort, group, archived, trimmed, aliases, order, sessionOrder } = input
  const map = new Map<string, SessionSummary[]>()
  // 只有「切过去还没发消息」的工作区没有会话，也要留在列表里；只看归档时它们没意义
  if (archived !== 'only') for (const dir of recentCwds) map.set(dir, [])
  for (const session of sessions) {
    if (!keepArchived(session, archived)) continue
    const key = session.cwd || '(未指定)'
    const list = map.get(key) ?? []
    list.push(session)
    map.set(key, list)
  }
  const match = (dir: string, list: SessionSummary[]): boolean =>
    trimmed === '' ||
    displayName(dir, aliases).toLowerCase().includes(trimmed) ||
    dir.toLowerCase().includes(trimmed) ||
    list.some((session) => (session.title ?? '新会话').toLowerCase().includes(trimmed))
  const visible = [...map.entries()].filter(([dir, list]) => match(dir, list))
  const rank = (dir: string): number => order.indexOf(dir)
  const lastUsed = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.updatedAt), 0)
  const lastCreated = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.createdAt), 0)
  const sorted = visible
    .map(([dir, list]) => [dir, orderedSessions(dir, list, sort, sessionOrder)] as [string, SessionSummary[]])
    .sort((a, b) => {
      if (sort === 'manual') {
        // 手动排过序就完全按手动顺序（活动组不再抢位）；没排过则活动组置顶，其余按最近使用
        if (order.length > 0) {
          const ra = rank(a[0])
          const rb = rank(b[0])
          if (ra !== rb) {
            if (ra < 0) return 1
            if (rb < 0) return -1
            return ra - rb
          }
        } else if ((a[0] === cwd) !== (b[0] === cwd)) {
          return a[0] === cwd ? -1 : 1
        }
        return lastUsed(b[1]) - lastUsed(a[1])
      }
      // 最近更新 / 创建时间这两档两级都按时间，不再人为把活动组顶上去
      return sort === 'created' ? lastCreated(b[1]) - lastCreated(a[1]) : lastUsed(b[1]) - lastUsed(a[1])
    })
  if (group !== 'tree') {
    return sorted.map(
      ([dir, list]): WorkGroup => ({ cwd: dir, sessions: list, depth: 0, parent: null, ancestors: [], hasChildren: false }),
    )
  }
  const lists = new Map(sorted)
  return nestByPath(sorted.map(([dir]) => dir)).map(
    (node): WorkGroup => ({ ...node, sessions: lists.get(node.cwd) ?? [] }),
  )
}
