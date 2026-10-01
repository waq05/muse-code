/**
 * 扫码直达：把桌面端二维码 URL 上的配对码取出来，并且立刻从地址栏擦掉。
 *
 * 二维码长这样：`https://<宿主>/?code=ABCD1234`（桌面端「连接弹窗」生成，
 * 见宿主 remote 插件）。手机扫到之后落地在这个页面上，URL 里就带着码。
 *
 * 这里只做「取码 + 擦码」两件事，不碰网络、不碰 React——纯函数，
 * 所以 selfcheck 不用起浏览器就能把它跑一遍。组件那边只负责把返回的码填进输入框。
 *
 * 为什么不盲目相信 URL 里的值：这段 URL 可能来自任何地方（手改、旧书签、
 * 被转发的截图 OCR、群里贴的链接）。字符集或长度不合规就当成没有，
 * 绝不把奇怪字符串塞进输入框，也不把「无效」当成错误弹给用户看——安静地忽略最省事。
 */

import { PAIR_CODE_LENGTH } from './api.js'

/** 配对码只用字母数字（宿主发的是 8 位大写，这里大小写都收，填进去之前统一转大写）。 */
const PAIR_CODE_CHARSET = /^[0-9a-zA-Z]+$/

/** 只用到 replaceState 这一个方法，测试里给个假的就能跑。 */
export type HistoryLike = Pick<History, 'replaceState'>

/**
 * 清洗一段输入：只留字母数字并转大写，超长截到 8 位。
 *
 * 手输和扫码走的是同一条路径（LoginPage 的 onChange 与预填都调它），
 * 免得两处对「什么算合法字符」有两种说法。
 */
export function sanitizePairCode(raw: string): string {
  return raw
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase()
    .slice(0, PAIR_CODE_LENGTH)
}

/** 整段就是 8 位字母数字才算合规；多一位少一位都当没有。 */
export function isValidPairCode(raw: string): boolean {
  return raw.length === PAIR_CODE_LENGTH && PAIR_CODE_CHARSET.test(raw)
}

/**
 * 把 href 拆成「URL 里的 code」+「删掉 code 之后的路径」。
 *
 * 没有 code 参数时 clean 给 null——调用方据此判断「地址栏根本不用动」，
 * 免得每次进页面都白写一次历史记录。URL 解析不了时两个都是 null。
 */
function splitCodeFromHref(href: string): { code: string | null; clean: string | null } {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    // location.href 永远是绝对地址，走到这里说明调用方传错了：什么都不做最安全。
    return { code: null, clean: null }
  }
  // 用 has 而不是 get===null：`?code=`（空值）也算「地址栏里有码」，照样要擦。
  if (!url.searchParams.has('code')) return { code: null, clean: null }

  const cleaned = new URL(url.href)
  cleaned.searchParams.delete('code')
  return {
    code: url.searchParams.get('code'),
    // 只动查询串：path 与 hash 原样带上，否则会把锚点/#段路由一起抹掉。
    clean: `${cleaned.pathname}${cleaned.search}${cleaned.hash}`,
  }
}

/** 按 splitCodeFromHref 给的结果擦地址栏；擦不掉（极端浏览器策略）就安静算了。 */
function replaceWithoutCode(url: string, history: HistoryLike): void {
  try {
    history.replaceState(null, '', url)
  } catch {
    // 见 takePairCodeFromUrl 的说明：擦不掉也不影响用户正在做的事。
  }
}

/**
 * 只擦地址栏里的 code，不要它的值——给「已经配对过的手机」用。
 *
 * 为什么需要它：手机有 token 时 App 直接进遥控外壳，登录页根本不挂载，
 * 也就没人去擦这张码。手机记住凭据本来就是常态（改动 2 要显性化的就是这个），
 * 所以这条路必须有人管：码在宿主那边 30 分钟内有效，留在地址栏会被截屏分享带出去。
 */
export function stripPairCodeFromUrl(href: string, history: HistoryLike): void {
  const { clean } = splitCodeFromHref(href)
  if (clean === null) return
  replaceWithoutCode(clean, history)
}

/**
 * 从页面 URL 里取 `code` 参数，取到就先把它从地址栏擦掉，再返回。
 *
 * 顺序是有意的：先 erase 后 return。地址栏里留着配对码这件事本身就是个漏点——
 * 用户截屏、分享链接、把手机递给别人看，都会把这张码一起带出去；
 * 而码在擦掉之前就已经拿到了，所以擦除不影响预填。
 *
 * 返回值：
 *   - 合规的码 → 清洗后的大写码（预填用）；
 *   - URL 里根本没有 code → null（连历史记录都不动，没必要）；
 *   - 有 code 但不合规 → null，但**照样擦掉**（垃圾参数也没理由留在地址栏）。
 *
 * 擦除失败（极端浏览器策略）也照常返回码：这时用户马上要用它配对，
 * 不能因为地址栏擦不掉就不给他填。调用方不需要区分这两种情况。
 */
export function takePairCodeFromUrl(href: string, history: HistoryLike): string | null {
  const { code, clean } = splitCodeFromHref(href)
  if (clean === null || code === null) return null

  replaceWithoutCode(clean, history)

  if (!isValidPairCode(code)) return null
  return sanitizePairCode(code)
}
