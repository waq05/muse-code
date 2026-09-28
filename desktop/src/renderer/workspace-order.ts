/**
 * 工作区手动排序的两个纯函数：插到某个目标之前/之后，或者挪到末尾。
 * 单独成文件是为了能脱离界面直接跑断言（见 `shots/order-check.mjs`）。
 *
 * @module desktop/renderer/workspace-order
 */

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
