/**
 * 文件树的视图状态（对齐 dsh ui-sidebar-files 的 store.ts）：每个工作区根
 * （会话 cwd）一棵树——各层目录的 listing、展开集、滚动位。零 React，模块级
 * 缓存（进程内活一份）；FilesPane 收起重挂后从这里恢复，展开状态与滚动位
 * 原样回来。写入用不可变替换 + 订阅广播，React 侧 useSyncExternalStore 接。
 */

/** 一条目录项（fs-list 的回包行）。 */
export interface TreeEntry {
  name: string
  dir: boolean
  size: number
}

/** 一层目录现在的状态：loading / ready（listing + 截断标记）/ failed。 */
export type LevelState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: TreeEntry[]; truncated: boolean }
  | { kind: 'failed'; message: string }

/** 一棵树：根（cwd 绝对路径）+ 各层 + 展开集 + 滚动位。 */
export interface FilesTreeState {
  root: string
  levels: Record<string, LevelState>
  /** 已展开目录的绝对路径（根也在里面）。 */
  expanded: string[]
  scrollTop: number
}

const trees = new Map<string, FilesTreeState>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 取一棵树（没有就造一棵默认的：根展开、其余全收）。引用稳定，可作 snapshot。 */
export function getTree(cwd: string): FilesTreeState {
  let tree = trees.get(cwd)
  if (tree === undefined) {
    tree = { root: cwd, levels: {}, expanded: [cwd], scrollTop: 0 }
    trees.set(cwd, tree)
  }
  return tree
}

/** 订阅树变化（useSyncExternalStore 用）。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 不可变替换一棵树并广播。 */
function put(cwd: string, next: FilesTreeState): void {
  trees.set(cwd, next)
  emit()
}

/** 记一层目录的 listing（或失败）。 */
export function setLevel(cwd: string, path: string, level: LevelState): void {
  const tree = getTree(cwd)
  put(cwd, { ...tree, levels: { ...tree.levels, [path]: level } })
}

/** 展开/收起一个目录。展开不预写 loading——listing 由 TreeLevel 发现缺层后自己拉，
 *  收起再展开时已就绪的层直接用缓存（dsh 同款：levels 常驻，不随收起丢）。 */
export function toggleExpanded(cwd: string, path: string): void {
  const tree = getTree(cwd)
  const expanded = tree.expanded.includes(path)
    ? tree.expanded.filter((item) => item !== path)
    : [...tree.expanded, path]
  put(cwd, { ...tree, expanded })
}

/** 记滚动位（不广播——滚动只进 ref，卸载时写一次，dsh 同款）。 */
export function setScrollTop(cwd: string, scrollTop: number): void {
  const tree = getTree(cwd)
  trees.set(cwd, { ...tree, scrollTop })
}

/** 某层要不要拉（没有 listing 或已失败）。 */
export function needsLoad(cwd: string, path: string): boolean {
  const level = getTree(cwd).levels[path]
  return level === undefined || level.kind === 'failed'
}

/** 文件名的自然序（数字按值、大小写不敏感，目录排前）——渲染侧排序，对齐 dsh orderEntries。 */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export function orderEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.dir) - Number(left.dir)
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}
