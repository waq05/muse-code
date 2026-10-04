/**
 * 检查更新（设置「关于」分区的按钮）：从更新源拉最新版本号，与本包版本比较。
 *
 * 更新源是一个返回 JSON 的 GET 地址，认两种回包：
 *   - GitHub Releases API（`…/releases/latest`）：取 `tag_name` 与 `html_url`；
 *   - 自托管的简化回包 `{ "version": "0.6.18", "url": "https://…" }`。
 * 两种都只为读出「最新版本号 + 下载页」，不做下载与安装（那要签名与发布
 * channel，等真的开始对外发布再上 electron-updater 一类）。
 *
 * @module dsc/core/update-check
 */
import { DSC_VERSION } from './version.js'

/**
 * 更新源地址：GitHub Releases API（0.6.50 首次对外发布时回填，「检查更新」自此启用）。
 * 换自托管时给任意返回 `{version, url}` 的 JSON 地址即可。
 */
export const UPDATE_CHECK_URL = 'https://api.github.com/repos/waq05/muse-code/releases/latest'

/** fetch 的超时：更新源卡住也不能把设置动作挂死。 */
const TIMEOUT_MS = 10_000

/**
 * 按数字段比较两个 x.y.z 版本号（v 前缀容忍，段数不齐补零）。
 *
 * @returns 负 = a 更旧，0 = 相同，正 = a 更新；任一侧解析不出数字段返回 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^\s*v?(\d+(?:\.\d+)*)(?:[-+].*)?\s*$/.exec(value)
    if (match === null) return null
    return match[1].split('.').map((piece) => Number(piece))
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return null
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l - r
  }
  return 0
}

/** 更新源回包的宽松形状：字段名对得上才认，类型不对的一律当没有。 */
interface ReleaseInfo {
  version: string
  url: string
}

/** 从回包 JSON 里抠出「最新版本号 + 下载页」；认不出返回 null。 */
function parseRelease(body: unknown): ReleaseInfo | null {
  if (typeof body !== 'object' || body === null) return null
  const doc = body as Record<string, unknown>
  const version = doc.tag_name ?? doc.version
  const url = doc.html_url ?? doc.url
  if (typeof version !== 'string' || version === '') return null
  return { version, url: typeof url === 'string' ? url : '' }
}

/**
 * 跑一次检查。结果按设置动作回执的口径返回：
 *   - 未配置 / 失败 → `{ ok: false, error }`（错误就是给用户看的那句话）；
 *   - 已是最新 → `{ ok: true, notice }`；
 *   - 有新版 → `{ ok: true, notice, data: { kind: 'url', url } }`，桌面端据此打开发布页。
 *
 * @param sourceUrl - 覆盖 {@link UPDATE_CHECK_URL}（探针/测试缝；缺省用常量，行为不变）。
 */
export async function checkForUpdate(
  current: string = DSC_VERSION,
  sourceUrl: string = UPDATE_CHECK_URL,
): Promise<{ ok: true; notice: string; data?: { kind: 'url'; url: string } } | { ok: false; error: string }> {
  if (sourceUrl === '') {
    return { ok: false, error: '更新源还没配置：发布后把 Releases 地址填进 src/core/update-check.ts 的 UPDATE_CHECK_URL' }
  }
  let response: Response
  try {
    response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json, application/json' },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `检查失败：连不上更新源（${reason}）` }
  }
  if (!response.ok) {
    return { ok: false, error: `检查失败：更新源返回 ${response.status}（地址没配对或发布页还不存在）` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: '检查失败：更新源回的不是 JSON' }
  }
  const release = parseRelease(body)
  if (release === null) {
    return { ok: false, error: '检查失败：更新源回包里认不出版本号（要 tag_name 或 version 字段）' }
  }
  const comparison = compareVersions(release.version, current)
  if (comparison === null) {
    return { ok: false, error: `检查失败：版本号认不出（源=${release.version}，本地=${current}）` }
  }
  if (comparison <= 0) {
    return { ok: true, notice: `已是最新（${current}）` }
  }
  return {
    ok: true,
    notice: `发现新版 ${release.version}（当前 ${current}）`,
    data: release.url === '' ? undefined : { kind: 'url', url: release.url },
  }
}
