/**
 * 上行 invoke 的参数编码 —— **全项目唯一一处**决定 `args` 长什么样的地方。
 *
 * 契约只写了上行是 `{type:'invoke', id, method, args?}`，这里按「运行时方法的实参表」发：
 * 一个参数 → `args: [值]`，零个参数 → 整个字段省略。这不是猜的，宿主的既有协议就是这么走：
 *
 *   - `src/plugins/host-stdio.ts`：消息类型写的是 `args?: unknown[]`，
 *     收到后 `Reflect.apply(runtime[method], runtime, message.args ?? [])`——按形参表展开；
 *   - `desktop/src/renderer/bridge.ts`：桌面端也是 `call('answerApproval', answer)` 这样
 *     一个参数一个位置地发（`invoke(method: string, args?: unknown[])`）。
 *
 * 遥控端与桌面端、宿主 stdio 共用同一套参数口径，所以这边不需要另立规则。
 *
 * 万一哪天桥接层改成按「单个值」解，改动只有这里一行：把 `encodeArgs` 换成 `asSingleValue`。
 * 另外读取类方法（没有副作用）在报参数错的错误时会自动用另一种编码重试一次，
 * 见 client.ts 的 invoke——这是给集成期留的缓冲，不是长期机制。
 */

/** 把实参表编成上行消息要带的字段（返回对象会被展开进 invoke 消息）。 */
export type ArgEncoder = (method: string, args: readonly unknown[]) => Record<string, unknown>

/** 默认编码：实参表原样发；零参数时不带 args 字段。 */
export const encodeArgs: ArgEncoder = (_method, args) => (args.length === 0 ? {} : { args: [...args] })

/**
 * 备用编码：只取第一个实参，直接当单个值发。
 * 零参数时给一个显式的空数组——「字段缺失」与「字段是空数组」在某些实现里判定不同，
 * 换这一种再试才有意义（否则两种情况发出的字节完全一样，重试等于白试）。
 */
export const asSingleValue: ArgEncoder = (_method, args) => {
  if (args.length === 0) return { args: [] }
  if (args.length === 1) return { args: args[0] }
  return { args: [...args] }
}
