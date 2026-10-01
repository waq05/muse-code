/*
 * Muse Code 遥控端的 service worker —— 只做一件事：把宿主推来的通知显示出来，
 * 点通知时聚焦/打开页面。
 *
 * 故意不写 fetch 处理器：这个产物由宿主按目录伺服、文件名带内容哈希，
 * 一旦在这里缓存，界面版本就会和宿主对不上（旧 JS 配新接口是最难查的一类问题）。
 * 也就是说：这个 SW 不参与离线，只管推送。
 *
 * 宿主的推送体是 JSON：{ title, body, url }。字段缺了就退回默认值，不让通知显示成空白。
 */

const DEFAULT_TITLE = 'Muse Code'
const DEFAULT_URL = '/'

/** 推来的数据尽量解析成 { title, body, url }；解析不出就把原文当正文。 */
function readPayload(event) {
  if (!event.data) return {}
  try {
    const parsed = event.data.json()
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    try {
      return { body: event.data.text() }
    } catch {
      return {}
    }
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event)
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : DEFAULT_TITLE
  const body = typeof payload.body === 'string' ? payload.body : ''
  const url = typeof payload.url === 'string' && payload.url !== '' ? payload.url : DEFAULT_URL
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // 图标与 SW 同目录（都是产物根），相对路径按 SW 脚本位置解析。
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // 通知带同一 tag：连着推两条时后一条替换前一条，不在通知中心堆一列。
      tag: 'muse-code',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  const target = new URL((data && data.url) || DEFAULT_URL, self.location.origin).href
  event.waitUntil(
    (async () => {
      // 已经开着这个页面就聚焦它（手机上就是切回那个标签/独立窗口），否则新开一个。
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue
        if (typeof client.focus === 'function') {
          await client.focus()
          return
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})
