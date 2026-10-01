/**
 * 通知 Webhook：把「等你审批」和「一轮跑完」这件事推到用户已有的手机上（Bark / ntfy
 * 这类现成 app），不用装本产品的 PWA，也不用管推送证书。
 *
 * 两种格式由 URL 自己决定（用户只要把地址粘进设置里，不用选模式）：
 *
 *   1. **URL 里带 `{title}` / `{body}` / `{url}` 占位符 → GET**（Bark 风格）。
 *      例：`https://api.day.app/你的KEY/{title}/{body}?url={url}`
 *      占位符的值先 `encodeURIComponent` 再替换，所以中文、空格、斜杠都不会把 URL 拆坏。
 *   2. **URL 里没有占位符 → POST JSON**（ntfy 风格）。
 *      body：`{"title":"…","body":"…","url":"…"}`。
 *      例：`https://ntfy.sh/你的主题`
 *
 * 规矩两条：超时 5 秒；失败只把原因**返回**给调用方（调用方写一条 notice），这里绝不抛。
 *
 * @module dsc/core/remote/notify
 */

/** 一次 Webhook 请求的超时（连不上、对面不响应都按失败算）。 */
export const WEBHOOK_TIMEOUT_MS = 5_000

/** 三个占位符；出现任意一个就走 GET 替换模式。 */
export const WEBHOOK_PLACEHOLDERS = ['{title}', '{body}', '{url}'] as const

/** 一条通知的内容。 */
export interface WebhookMessage {
  title: string
  body: string
  url: string
}

/** 发送结果：ok=false 时 error 是给人看的一句话。 */
export type WebhookResult = { ok: true; mode: 'get' | 'post' } | { ok: false; mode: 'get' | 'post'; error: string }

/** 地址是不是 http(s)（设置页校验与读档回落共用这一条）。 */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** URL 里有没有占位符（有 → GET 替换，没有 → POST JSON）。 */
export function webhookHasPlaceholder(raw: string): boolean {
  return WEBHOOK_PLACEHOLDERS.some((placeholder) => raw.includes(placeholder))
}

/** 把占位符换成值之后的最终 URL。 */
export function buildWebhookUrl(raw: string, message: WebhookMessage): string {
  return raw
    .replaceAll('{title}', encodeURIComponent(message.title))
    .replaceAll('{body}', encodeURIComponent(message.body))
    .replaceAll('{url}', encodeURIComponent(message.url))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface WebhookSendOptions {
  /** 换掉 fetch（自检脚本用得到；默认就是全局 fetch）。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 发一条 Webhook 通知。
 *
 * @param raw - 设置里的地址（调用方负责确认它不是空串）
 * @param message - 标题 / 正文 / 点击后打开的地址
 */
export async function sendWebhook(
  raw: string,
  message: WebhookMessage,
  options: WebhookSendOptions = {},
): Promise<WebhookResult> {
  const target = raw.trim()
  const mode: 'get' | 'post' = webhookHasPlaceholder(target) ? 'get' : 'post'
  if (target === '') return { ok: false, mode, error: '通知 Webhook 是空的' }
  if (!isHttpUrl(target)) return { ok: false, mode, error: '通知 Webhook 不是 http(s) 地址' }
  const doFetch = options.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS)
  try {
    const response =
      mode === 'get'
        ? await doFetch(buildWebhookUrl(target, message), { method: 'GET', signal })
        : await doFetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: message.title, body: message.body, url: message.url }),
            signal,
          })
    if (!response.ok) return { ok: false, mode, error: `对面回了 HTTP ${String(response.status)}` }
    return { ok: true, mode }
  } catch (error) {
    return { ok: false, mode, error: errorText(error) }
  }
}
