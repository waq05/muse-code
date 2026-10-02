/**
 * 工作区列表的纯函数：手动排序的落点（插到目标前/后、挪到末尾），以及
 * 「按工作区树」分组时按目录前缀算层级与祖先链。
 * 单独成文件是为了能脱离界面直接跑断言（见 `shots/order-check.mjs`）。
 *
 * 命名约定：这里的值本身是会话的 `cwd`（会话在哪个目录里开的）；「工作区」是
 * 界面对它的称呼——分组、拖拽排序、别名都按它。持久化键名沿用
 * `workspaceOrder` / `workspaceAliases`（老用户存档不动），代码里读到这两个键名
 * 想到「按 cwd 存的界面偏好」即可。
 *
 * @module desktop/renderer/workspace-order
 */

/** 树分组的一个节点：只讲结构，会话由调用方按 cwd 挂回来。 */
export interface NestedPath {
  cwd: string
  /** 缩进层级（0 = 最外层）。 */
  depth: number
  /** 挂在哪个祖先工作区下；没有祖先时为 null。 */
  parent: string | null
  /** 祖先链（从根到直接父）：任一个被折叠，这一层就不显示。 */
  ancestors: string[]
  /** 有没有子节点（决定默认展开与折叠联动）。 */
  hasChildren: boolean
}

/**
 * 把 `source` 从 `order` 里摘出来，插到 `target` 之前（after=false）或之后（after=true）。
 * `target` 不在列表里，或者顺序本来就一样时，原样返回。
 *
 * @param order 当前视觉顺序
 * @param source 要挪动的工作区目录
 * @param target 落点参照的工作区目录
 * @param after 落点在参照之后（鼠标停在参照行下半段）
 */
export function moveWithin(order: string[], source: string, target: string, after: boolean): string[] {
  if (source === target) return order
  const rest = order.filter((item) => item !== source)
  let at = rest.indexOf(target)
  if (at < 0) return order
  if (after) at += 1
  return [...rest.slice(0, at), source, ...rest.slice(at)]
}

/** 把 `source` 挪到列表末尾。 */
export function moveToEnd(order: string[], source: string): string[] {
  return [...order.filter((item) => item !== source), source]
}

/**
 * 按目录前缀把工作区挂成树（对照 dsh 的「按工作区树」）：每个工作区挂到最近的
 * 祖先工作区下，根节点保持传进来的顺序；父节点在前，子节点紧随其后。
 *
 * @param paths 已排好序的工作区目录
 * @returns 深度优先展开的节点列表，交给渲染层按 `depth` 缩进
 */
export function nestByPath(paths: string[]): NestedPath[] {
  const parentOf = (cwd: string): string | null => {
    let best: string | null = null
    for (const other of paths) {
      if (other === cwd || !isUnder(cwd, other)) continue
      if (best === null || other.length > best.length) best = other
    }
    return best
  }
  const children = new Map<string | null, string[]>()
  for (const cwd of paths) {
    const key = parentOf(cwd)
    const bucket = children.get(key) ?? []
    bucket.push(cwd)
    children.set(key, bucket)
  }
  const out: NestedPath[] = []
  const walk = (key: string | null, depth: number, ancestors: string[]): void => {
    for (const cwd of children.get(key) ?? []) {
      const kids = children.get(cwd) ?? []
      out.push({ cwd, depth, parent: key, ancestors, hasChildren: kids.length > 0 })
      walk(cwd, depth + 1, [...ancestors, cwd])
    }
  }
  walk(null, 0, [])
  return out
}

/** `child` 是不是 `parent` 目录下的子孙（大小写、`\` 与 `/`、末尾分隔符都不影响判定）。 */
export function isUnder(child: string, parent: string): boolean {
  const inner = normalizePath(child)
  const outer = normalizePath(parent)
  return outer !== '' && inner !== outer && inner.startsWith(`${outer}/`)
}

/** 路径归一化：统一成分隔符为 `/`、无尾部分隔符、小写的比较用形式。 */
function normalizePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}
