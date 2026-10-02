/**
 * 在线模型发现（T23，对标 dsh 设置页「Fetch available models」）：
 * `GET {baseUrl}/models` 拉端点上可用的模型清单，填进模型配置省手填。
 *
 * 路径约定与对话请求一致（chat 是 `baseUrl + /chat/completions`，这里就是
 * `baseUrl + /models`）：配置里 baseUrl 带到哪一级，这里跟到哪一级。
 * 解析认三种形状：OpenAI `{data:[{id}]}`、ollama `{models:[{name}]}`、纯字符串数组。
 *
 * @module dsc/core/model-discovery
 */

/** 拉取超时（毫秒）：模型发现是设置页的手动动作，不该让人等太久。 */
const DISCOVERY_TIMEOUT_MS = 15_000

/**
 * 从 /models 应答里抽出模型 id 清单（纯函数，探针直测）。
 * 认不得的形状返回空数组——让调用方报「没解析出模型」，不猜。
 */
export function parseModelsResponse(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const doc = body as { data?: unknown; models?: unknown }
  const rows: unknown[] =
    Array.isArray(doc.data) ? doc.data
    : Array.isArray(doc.models) ? doc.models
    : Array.isArray(body) ? body
    : []
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row === 'string' && row !== '') {
      ids.push(row)
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const entry = row as { id?: unknown; name?: unknown }
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (id !== '') ids.push(id)
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * 拉一个端点的模型清单。HTTP 非 2xx 或形状认不得时抛错（消息可直接展示）。
 */
export async function discoverModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  let response: Response
  try {
    response = await fetch(url, {
      headers: apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`连不上 ${url}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`${url} 回了 HTTP ${String(response.status)}：${(await response.text()).slice(0, 200)}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`${url} 的应答不是 JSON`)
  }
  const models = parseModelsResponse(body)
  if (models.length === 0) throw new Error(`${url} 的应答里没解析出模型清单（认 OpenAI data[] / ollama models[] 形状）`)
  return models
}
