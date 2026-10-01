/**
 * dsh 工具定义 → dsc 工具条目的适配面（兼容层唯一认识 dsh 工具形状的地方）。
 *
 * dsh 的 ToolDefinition（`defineTool` 的产物）与 dsc 的 ToolEntry 在参数 schema 上
 * 同构（都是 JSON Schema 对象），差异在执行侧：
 *   dsh execute(args, exec) 返回「规范 JSON 值」，模型可见内容由 output.render 投影；
 *   dsc  run(args, ctx)   直接返回文本 / 文本+图像。
 * 适配层把 exec 缩成 dsc 拿得到的那两样（signal / cwd），把 render 的内容块折成文本；
 * risk 不是 dsh 概念，缺省 'exec'（每次都过审批卡），可被插件条目配置覆盖。
 *
 * @module dsc/core/dsh-compat/tools-facade
 */
import type { ToolEntry, ToolOutput } from '../tools.js'

/** dsh ToolDefinition 里兼容层认得的字段（其余字段照原样被忽略）。 */
export interface DshToolDefinitionLike {
  name: unknown
  description: unknown
  parameters: unknown
  execute?: unknown
  /** dsh 规定必填；兼容层对缺了它的定义容错（跳过投影直接字符串化）。 */
  output?: { render?: unknown } | unknown
  timeoutMs?: unknown
}

/** dsh 内容块的形状（render 的产物）。 */
interface DshContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** 插件条目树里关于 risk 的配置形状（值来自 JSON，宽松收进来再收敛）。 */
export interface DshRiskConfig {
  /** 这份插件所有工具的缺省 risk。 */
  risk?: unknown
  /** 按工具名覆盖。 */
  risks?: Record<string, unknown>
}

const RISKS = new Set(['read', 'write', 'exec'])

/** 判一个对象像不像 dsh 的 ToolDefinition（有 execute、没有 dsc 的 run）。 */
export function looksLikeDshToolDefinition(candidate: unknown): candidate is DshToolDefinitionLike {
  if (candidate === null || typeof candidate !== 'object') return false
  const record = candidate as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.execute === 'function' && typeof record.run !== 'function'
}

/** 把配置里的 risk 字样收敛成合法值；认不出就落回 'exec'（多问一次总比漏问强）。 */
function normalizeRisk(raw: unknown): ToolEntry['risk'] {
  return typeof raw === 'string' && RISKS.has(raw) ? (raw as ToolEntry['risk']) : 'exec'
}

function riskFor(definition: DshToolDefinitionLike, config: DshRiskConfig): ToolEntry['risk'] {
  if (config.risks !== undefined && typeof config.risks === 'object') {
    const own = config.risks[definition.name as string]
    if (own !== undefined) return normalizeRisk(own)
  }
  return normalizeRisk(config.risk)
}

/** 把 dsh render 的内容块折成 dsc 的工具输出：文本拼起来，图像块以占位说明。 */
function blocksToOutput(blocks: unknown, name: string): string | ToolOutput {
  if (!Array.isArray(blocks)) {
    return typeof blocks === 'string' ? blocks : JSON.stringify(blocks, null, 2)
  }
  const texts: string[] = []
  const images: string[] = []
  for (const block of blocks as DshContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'image') texts.push(`[图像块已省略：${name} 返回的图像 dsc 兼容层暂不投递]`)
    else texts.push(JSON.stringify(block, null, 2))
  }
  const text = texts.join('\n')
  return images.length > 0 ? { text, images } : text
}

/** 规范 JSON 值 → 文本（没有 render 时的兜底）。 */
function valueToText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/**
 * 把一个 dsh ToolDefinition 包成 dsc ToolEntry。转出来的工具：
 *   - 参数 schema 原样透传（两边同是 JSON Schema，llm 层怎么发就怎么发）；
 *   - execute 收到的 exec 只保证有 `signal`（dsc 的执行上下文没有 agent 身份那些字段）；
 *   - 声明了 timeoutMs 时到点放弃等待（协作式的：工具内部自己看 signal 才是真取消）。
 */
export function dshToolToEntry(definition: DshToolDefinitionLike, config: DshRiskConfig): ToolEntry {
  const name = typeof definition.name === 'string' ? definition.name : 'unknown'
  const execute = definition.execute as ((args: unknown, exec: unknown) => Promise<unknown>) | undefined
  const render =
    definition.output !== null && typeof definition.output === 'object'
      ? (definition.output as { render?: unknown }).render
      : undefined
  const renderFn = typeof render === 'function' ? (render as (args: unknown, value: unknown) => unknown) : undefined
  const timeoutMs = typeof definition.timeoutMs === 'number' && definition.timeoutMs > 0 ? definition.timeoutMs : undefined

  const run = async (args: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal }): Promise<string | ToolOutput> => {
    if (execute === undefined) throw new Error(`工具 ${name} 没有 execute 实现`)
    const exec = { signal: ctx.signal, cwd: ctx.cwd }
    const value = timeoutMs === undefined ? await execute(args, exec) : await withTimeout(execute(args, exec), name, timeoutMs)
    return renderFn !== undefined ? blocksToOutput(renderFn(args, value), name) : valueToText(value)
  }

  return {
    name,
    description: typeof definition.description === 'string' ? definition.description : '',
    parameters:
      definition.parameters !== null && typeof definition.parameters === 'object'
        ? (definition.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} },
    risk: riskFor(definition, config),
    run,
  }
}

async function withTimeout(promise: Promise<unknown>, name: string, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具 ${name} 超时（${timeoutMs}ms）`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * dsh `ctx.tools` 的兼容面：register 收 dsh ToolDefinition，其余成员一律响亮报错——
 * 静默装作支持只会让插件在更深处莫名坏掉。risk 映射每次注册时经 readConfig 现读，
 * 插件条目配置里改 risk 不必重挂。
 */
export function dshToolsFacade(register: (entry: ToolEntry) => () => void, readConfig: () => DshRiskConfig): unknown {
  const target = {
    register(definition: unknown): () => void {
      if (!looksLikeDshToolDefinition(definition)) {
        throw new Error('ctx.tools.register 收到的不是 dsh 风格的工具定义（要有 name/execute）')
      }
      return register(dshToolToEntry(definition, readConfig()))
    },
  }
  return new Proxy(target, {
    get(item, prop, receiver) {
      if (prop in item) return Reflect.get(item, prop, receiver)
      throw new Error(`dsc 兼容层只支持 ctx.tools.register，当前插件调用了 ctx.tools.${String(prop)}`)
    },
  })
}
