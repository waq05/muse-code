/**
 * Web Push 的浏览器侧动作：公钥解码、环境判定、订阅 / 退订、service worker 注册。
 *
 * 为什么把「环境判定」抽成纯函数（`pushBlockReason`）：手机上「为什么点不动推送」有一堆
 * 互不相干的原因（http 不是安全上下文 / iOS 没加到主屏幕 / 权限被拒 / 浏览器太老），
 * 判定是纯数据进纯文案出，可以在没有浏览器的自检里逐条验；真机上只是把全局读进来而已。
 *
 * 宿主那半边的契约（协议 v3）：
 *   GET  /api/push-key → {ok, publicKey}
 *   POST /api/push-subscribe（Bearer，体 = PushSubscription.toJSON()）
 *   POST /api/push-unsubscribe（Bearer，体 = {endpoint}）
 *   宿主推送开关关着时 hello 的 pushPublicKey 是 null（界面据此隐藏按钮）。
 */

/**
 * 订阅时用的应用服务器公钥：URL-safe base64 → 字节。
 *
 * 返回类型写死 `Uint8Array<ArrayBuffer>`：TS 5.7 起带缓冲类型的 `Uint8Array` 才算
 * 合法的 `BufferSource`，`Uint8Array<ArrayBufferLike>` 递不进 `applicationServerKey`。
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const normalised = base64.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 浏览器侧的全部外部依赖（都能注入，所以自检不用真浏览器）。 */
export interface PushEnvironment {
  /** https 或 localhost；http 的 IP 页面里浏览器既不给注册 SW 也不给推送。 */
  secureContext: boolean
  ios: boolean
  /** iOS 的「已添加到主屏幕」（独立窗口打开）。 */
  standalone: boolean
  notification: {
    permission: string
    requestPermission: () => Promise<string>
  } | null
  serviceWorker: {
    ready: Promise<ServiceWorkerRegistration>
  } | null
}

/** iOS 判定：iPad 从 iPadOS 13 起报 MacIntel，只能靠触摸点补判。 */
function isIosNavigator(nav: Navigator | null): boolean {
  if (nav === null) return false
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1
}

/** 独立窗口（加到主屏幕后打开）。 */
function isStandaloneWindow(win: Window | null): boolean {
  if (win !== null) {
    try {
      if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
        return true
      }
    } catch {
      // matchMedia 在极老的浏览器里可能抛：当作不是独立窗口。
    }
  }
  if (typeof navigator === 'undefined') return false
  // iOS Safari 专有的 navigator.standalone（display-mode 媒体查询它也认，这里双保险）。
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** 读真实环境；任何一项读不到都当「没有」。 */
export function readPushEnvironment(): PushEnvironment {
  const nav = typeof navigator === 'undefined' ? null : navigator
  const win = typeof window === 'undefined' ? null : window
  const notification =
    typeof Notification === 'undefined'
      ? null
      : {
          permission: Notification.permission,
          requestPermission: () => Notification.requestPermission(),
        }
  return {
    secureContext: win !== null && win.isSecureContext === true,
    ios: isIosNavigator(nav),
    standalone: isStandaloneWindow(win),
    notification,
    serviceWorker: nav !== null && 'serviceWorker' in nav ? nav.serviceWorker : null,
  }
}

/**
 * 现在能不能开推送；不能就给一句人话（能开返回 null）。
 *
 * 顺序是有讲究的：iOS 没加到主屏幕排在最前，因为这是 iPhone 上最常见、也最容易被忽略的一条；
 * 但文案里同时点了 https 这个前提，免得用户在 http 的 IP 页面上反复「添加到主屏幕」却不生效。
 */
export function pushBlockReason(env: PushEnvironment): string | null {
  if (env.ios && !env.standalone) {
    return 'iOS 上请先添加到主屏幕（Safari 的分享 → 添加到主屏幕），推送才能用；同时页面得是 https'
  }
  if (!env.secureContext) {
    return '当前不是安全上下文（https 或 localhost），浏览器不给注册 Service Worker，也就没有推送'
  }
  if (env.notification === null) return '这个浏览器不支持通知'
  if (env.serviceWorker === null) return '这个浏览器不支持 Service Worker'
  if (env.notification.permission === 'denied') {
    return '通知权限被拒过，请到浏览器/系统设置里重新允许后再试'
  }
  return null
}

/**
 * 等 service worker 就绪。
 *
 * 为什么不直接 `await serviceWorker.ready`：注册失败、被策略禁用、或页面不是首次加载时
 * 这个 Promise 可能永远不落地，界面就会卡在「处理中…」上。这里自己掐一个上限。
 */
async function awaitServiceWorker(
  env: PushEnvironment,
  timeoutMs = 10_000,
): Promise<ServiceWorkerRegistration> {
  const serviceWorker = env.serviceWorker
  if (serviceWorker === null) throw new Error('这个浏览器不支持 Service Worker')
  return await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Service Worker 还没就绪，刷新一次页面再试'))
    }, timeoutMs)
    serviceWorker.ready.then(
      (registration) => {
        clearTimeout(timer)
        resolve(registration)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
}

/**
 * 走完「要权限 → 等 SW → 订阅」，返回可以直接发给宿主的 JSON。
 * 失败一律抛 Error（文案给用户看）。
 */
export async function createPushSubscription(
  publicKey: string,
  env: PushEnvironment = readPushEnvironment(),
): Promise<PushSubscriptionJSON> {
  const blocked = pushBlockReason(env)
  if (blocked !== null) throw new Error(blocked)
  if (publicKey.trim() === '') throw new Error('宿主没有给推送公钥')

  const notification = env.notification
  if (notification === null) throw new Error('这个浏览器不支持通知')

  const permission = await notification.requestPermission()
  if (permission !== 'granted') throw new Error('没有拿到通知权限（可能被系统或浏览器拦下了）')

  const registration = await awaitServiceWorker(env)
  const subscription = await registration.pushManager.subscribe({
    // userVisibleOnly 必须为 true：iOS Safari 不接受静默推送，Chrome 也要求这个。
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })
  return subscription.toJSON()
}

/** 退掉本机的订阅（没有就返回 null）；返回退掉之前的那份 JSON。 */
export async function dropPushSubscription(
  env: PushEnvironment = readPushEnvironment(),
): Promise<PushSubscriptionJSON | null> {
  const registration = await awaitServiceWorker(env)
  const subscription = await registration.pushManager.getSubscription()
  if (subscription === null) return null
  const json = subscription.toJSON()
  await subscription.unsubscribe()
  return json
}

/**
 * 注册 service worker。
 *
 * 只在安全上下文（https / localhost）里注册：http 的 IP 页面里浏览器直接拒绝注册，
 * 硬注册只会在控制台留一条错。注册失败也不影响主流程——推送用不了，别的照常。
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (typeof window === 'undefined' || window.isSecureContext !== true) return
  try {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // 静默失败：界面上的推送按钮自己会说明原因。
    })
  } catch {
    // register 在个别老浏览器里会同步抛：同上。
  }
}
