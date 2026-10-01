/**
 * remote-web 的自检：不起浏览器、不起宿主，用一个假 WebSocket + 假 fetch + 假 localStorage
 * 把遥控端跑一遍。
 *
 * 覆盖：
 *   - 归并（reduce.ts）：全量帧、增量帧的 added / updated / removedIds、id 乱序重排、
 *     补帧后按 seq 递增逐帧并入、meta 缺字段保留旧值、全量帧整份重置、认不出的帧忽略
 *   - 客户端（client.ts，假 socket）：取票据 → hello（protocolVersion / pushPublicKey）→
 *     全量帧 → 增量帧 → 更旧的帧丢弃 → lastSeq 落盘与重连时带上 &lastSeq= →
 *     断线退避与手动重试重新取票 → invoke 参数编码与结果落地 → submit 带图片 →
 *     上传（URL 与 Bearer 头）→ 推送登记/注销 → 票据 401 触发退回登录页
 *   - storage.ts：lastSeq 记录、非法值识别、配对后清零、设备名记忆
 *   - pairlink.ts：扫码直达（?code= 的合法/非法/缺省三态、擦地址栏、不自动提交、已配对手机那条兜底）
 *   - 登录页（LoginPage.tsx）：文案在场、焦点与默认设备名的接线；App.tsx 只在有凭据时擦码
 *   - push.ts：urlBase64ToUint8Array 与 Buffer 交叉核对、环境判定文案、订阅流程（假 SW）
 *   - attachments.ts：附件行拼装、体积估算与格式化、缩放尺寸、压缩（假 canvas）
 *   - 产物文件：manifest.json 的关键字段、sw.js 里 push / notificationclick 两条路都在
 *
 * 运行：node remote-web/selfcheck.mjs（或 remote-web 下 `pnpm selfcheck`）
 * 为什么能直接跑 TS：Node 24 自带类型擦除；源码里的导入说明符按打包器习惯写成 `.js`，
 * 所以下面用 registerHooks 把 `./x.js` 解析到 `./x.ts`（没有这一步 node 找不到文件）。
 *
 * @module dsc/remote-web/selfcheck
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 让 node 认 .js 说明符 → .ts 源文件 ────────────────────────────────────────

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      const base = context.parentURL ?? import.meta.url
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, base)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// ── 假浏览器环境（必须在 import 源码之前装好） ────────────────────────────────

let total = 0
let failures = 0
const check = (name, condition, detail = '') => {
  total += 1
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function jsonResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** 假 localStorage：storage.ts 只用到这四个方法。 */
const store = new Map()
const fakeStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    store.set(key, String(value))
  },
  removeItem: (key) => {
    store.delete(key)
  },
  clear: () => store.clear(),
}

globalThis.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  localStorage: fakeStorage,
  location: { origin: 'http://127.0.0.1:17321' },
  isSecureContext: false,
}

/** 假 WebSocket：把监听器存下来，测试手上一句一句地喂消息。 */
const sockets = []
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = FakeSocket.CONNECTING
    this.sent = []
    this.listeners = new Map()
    sockets.push(this)
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.emit('open', {})
  }

  /** 喂一条下行消息（对象会被 JSON 序列化，和真 WS 一样只有字符串）。 */
  push(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }

  send(raw) {
    this.sent.push(JSON.parse(raw))
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.emit('close', {})
  }
}
globalThis.WebSocket = FakeSocket

/** 假 fetch：按 URL 分派，票据状态可以临时改（验 401）。 */
const fetchCalls = []
let ticketCounter = 0
let ticketStatus = 200
/** 宿主的推送开关（关着时 push-subscribe 回 403、push-key 回 publicKey:null）。 */
let pushEnabled = true
globalThis.fetch = async (input, init = {}) => {
  const href = input instanceof URL ? input.href : typeof input === 'string' ? input : String(input.url)
  fetchCalls.push({ href, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
  if (href.includes('/api/ticket')) {
    if (ticketStatus !== 200) return jsonResponse({ ok: false, error: '票据无效或已用过' }, ticketStatus)
    ticketCounter += 1
    return jsonResponse({ ticket: `ticket-${ticketCounter}` }, 200)
  }
  if (href.includes('/api/upload')) return jsonResponse({ ok: true, path: '/tmp/收件箱/a.txt', size: 3, name: 'a.txt' }, 200)
  if (href.includes('/api/push-subscribe') || href.includes('/api/push-unsubscribe')) {
    if (!pushEnabled) return jsonResponse({ ok: false, error: '浏览器推送没开：先在电脑上「设置 → 远程控制」里打开' }, 403)
    return jsonResponse({ ok: true }, 200)
  }
  if (href.includes('/api/push-key')) {
    if (!pushEnabled) return jsonResponse({ ok: true, publicKey: null }, 200)
    return jsonResponse({ ok: true, publicKey: 'BKEY' }, 200)
  }
  return jsonResponse({ ok: false, error: `没有这条路由：${href}` }, 404)
}

// ── 载入源码 ─────────────────────────────────────────────────────────────────

const { applyFrame, mergeEntries, isFullFrame, isDeltaFrame } = await import('./src/lib/reduce.ts')
const { normalizeSessions } = await import('./src/lib/protocol.ts')
const {
  loadLastSeq,
  saveLastSeq,
  clearLastSeq,
  loadPushEndpoint,
  savePushEndpoint,
  clearPushEndpoint,
  loadDeviceName,
  saveCreds,
  clearCreds,
} = await import('./src/lib/storage.ts')
const { sanitizePairCode, isValidPairCode, takePairCodeFromUrl, stripPairCodeFromUrl } = await import('./src/lib/pairlink.ts')
const { RemoteClient } = await import('./src/lib/client.ts')
const {
  urlBase64ToUint8Array,
  pushBlockReason,
  createPushSubscription,
  dropPushSubscription,
} = await import('./src/lib/push.ts')
const {
  fitWithin,
  estimateDataUrlBytes,
  formatBytes,
  composeOutgoing,
  attachmentLines,
  compressImage,
  keepsAlpha,
  totalBytes,
  MAX_IMAGE_BYTES,
} = await import('./src/lib/attachments.ts')
const { encodeArgs } = await import('./src/lib/wire.ts')
const { fetchPushKey } = await import('./src/lib/api.ts')

const userEntry = (id, text) => ({ kind: 'user', id, text })
const textEntry = (id, text) => ({ kind: 'text', id, text })

// ── 1. 归并 ──────────────────────────────────────────────────────────────────

console.log('归并（协议 v3 的全量 / 增量帧）')

const fullFrame = {
  type: 'snapshot',
  seq: 1,
  full: true,
  cwd: 'D:\\proj',
  sessionId: 's-1',
  entries: [userEntry(1, '先看看这个'), textEntry(2, '好')],
  liveEntries: [],
  status: { turnState: 'working', model: 'm', effort: 'default' },
  surfaces: {},
  sessions: [{ id: 's-1', cwd: 'D:\\proj', createdAt: 1, updatedAt: 2 }],
}

const base = applyFrame(null, fullFrame)
check('全量帧：seq / cwd / 条目数都到位', base !== null && base.seq === 1 && base.cwd === 'D:\\proj' && base.entries.length === 2)
check('全量帧：字段缺（liveEntries 空）也不炸', base !== null && base.liveEntries.length === 0)

const delta = {
  type: 'delta',
  seq: 2,
  full: false,
  meta: { cwd: 'D:\\proj', sessionId: 's-1', status: { turnState: 'idle' }, surfaces: {} },
  added: [{ kind: 'system', id: 3, text: '系统提示' }],
  updated: [userEntry(1, '先看看这个（改过）')],
  removedIds: [2],
  liveEntries: [textEntry(9, '还在流的正文')],
}

const afterDelta = applyFrame(base, delta)
check(
  '增量帧：added 追加 + updated 按 id 替换 + removedIds 删除',
  afterDelta !== null &&
    afterDelta.entries.map((entry) => entry.id).join(',') === '1,3' &&
    afterDelta.entries[0].text === '先看看这个（改过）',
  JSON.stringify(afterDelta?.entries),
)
check('增量帧：liveEntries 是全量替换', afterDelta !== null && afterDelta.liveEntries.length === 1 && afterDelta.liveEntries[0].id === 9)
check('增量帧：meta 覆盖 status（turnState 变 idle）', afterDelta !== null && afterDelta.status?.turnState === 'idle')
check('增量帧：seq 取帧顶层的值', afterDelta !== null && afterDelta.seq === 2)
check(
  '增量帧：meta 没带 sessions 时保留旧值（比契约的展开宽一档）',
  afterDelta !== null && afterDelta.sessions.length === 1 && afterDelta.sessions[0].id === 's-1',
)

const unsorted = applyFrame(afterDelta, {
  type: 'delta',
  seq: 3,
  full: false,
  meta: {},
  added: [textEntry(7, 'g'), textEntry(5, 'e')],
  updated: [],
  removedIds: [],
  liveEntries: [],
})
check(
  '条目按 id 升序稳定排列（added 乱序也给顺序）',
  unsorted !== null && unsorted.entries.map((entry) => entry.id).join(',') === '1,3,5,7',
  JSON.stringify(unsorted?.entries.map((entry) => entry.id)),
)

const replay = [4, 5, 6].reduce(
  (state, id) =>
    applyFrame(state, {
      type: 'delta',
      seq: id,
      full: false,
      meta: { status: { turnState: 'working' } },
      added: [textEntry(id, `第 ${id} 条`)],
      updated: [],
      removedIds: [],
      liveEntries: [],
    }),
  unsorted,
)
check('补帧逐条并入（seq 递增的三条 delta 全落地）', replay !== null && replay.entries.length === 6 && replay.seq === 6)

const reset = applyFrame(replay, {
  type: 'snapshot',
  seq: 20,
  full: true,
  entries: [textEntry(1, '重建之后的唯一一条')],
  liveEntries: [],
  status: { turnState: 'idle' },
  surfaces: {},
})
check(
  '全量帧整份重置（旧条目、旧 cwd 都不留）',
  reset !== null && reset.entries.length === 1 && reset.cwd === null && reset.seq === 20,
)

check(
  '认不出的帧返回 null（调用方保持原状态）',
  applyFrame(reset, { type: 'turn', phase: 'end' }) === null && applyFrame(reset, 'nope') === null,
)
check(
  'v2 的宿主（只有 type:snapshot、没有 full 字段）照样当全量',
  isFullFrame({ type: 'snapshot' }) === true && isDeltaFrame({ type: 'snapshot' }) === false,
)
check(
  'full:false 的帧按增量解析（哪怕 type 写得不一样）',
  isDeltaFrame({ type: 'delta', full: false }) === true,
)
check(
  '同 id 重复出现时按后者覆盖（不让一个 id 画两行）',
  mergeEntries([userEntry(1, '旧')], [userEntry(1, '新')], [], []).length === 1 &&
    mergeEntries([userEntry(1, '旧')], [userEntry(1, '新')], [], [])[0].text === '新',
)
check('updated 里本地没有的 id 也收下（补帧从中间开始时）', mergeEntries([], [], [textEntry(4, 'x')], []).length === 1)

// ── 2. 帧序号 ────────────────────────────────────────────────────────────────

console.log('帧序号（lastSeq 的落盘与清零）')

store.clear()
check('本地没有记录时读出来是 null', loadLastSeq() === null)
saveLastSeq(7)
check('写完能读回来', loadLastSeq() === 7)
saveLastSeq(-1)
check('负数不写进去（仍然读到 7）', loadLastSeq() === 7)
fakeStorage.setItem('dsc.remote.lastSeq', 'abc')
check('被改坏的值当没有', loadLastSeq() === null)
saveLastSeq(12)
clearLastSeq()
check('清零之后读出来是 null', loadLastSeq() === null)
check('推送端点：存了能读、清了没有', (() => {
  savePushEndpoint('https://push.example/e1')
  const saved = loadPushEndpoint()
  clearPushEndpoint()
  return saved === 'https://push.example/e1' && loadPushEndpoint() === null
})())

// ── 3. 客户端（假 socket） ────────────────────────────────────────────────────

console.log('客户端（假 socket + 假 fetch）')

store.clear()
sockets.length = 0
fetchCalls.length = 0
ticketCounter = 0
ticketStatus = 200

let signOutReason = null
const client = new RemoteClient({
  token: 'tok-1',
  onUnauthorized: () => {
    signOutReason = '登录已失效，请重新配对设备'
  },
})
client.start()
await flush()
check('启动先取票据，再建 WS（URL 带一次性 ticket）', fetchCalls[0]?.href.endsWith('/api/ticket') === true && sockets[0]?.url.includes('ticket=ticket-1') === true, sockets[0]?.url)
check('本地没有历史时不带 lastSeq（等宿主发全量）', sockets[0]?.url.includes('lastSeq') === false)

const first = sockets[0]
check('建连过程中状态是 connecting', client.getState().conn === 'connecting')
first.open()
check('open 之后状态是 open，epoch 自增', client.getState().conn === 'open' && client.getState().epoch === 1)

first.push({ type: 'hello', protocolVersion: 3, pushPublicKey: 'BKEY', methods: ['submit'] })
check('hello：protocolVersion 记下来', client.getState().protocolVersion === 3)
check('hello：pushPublicKey 记下来（推送按钮据此显示）', client.getState().pushPublicKey === 'BKEY')

first.push(fullFrame)
check('全量帧：视图有内容了', client.getState().snapshot?.entries.length === 2)
check('全量帧：seq 落盘', loadLastSeq() === 1)

first.push(delta)
check(
  '增量帧：条目与 status 都并进来了',
  client.getState().snapshot?.entries.length === 2 && client.getState().snapshot?.status?.turnState === 'idle',
)
check('增量帧：seq 落盘到 2', loadLastSeq() === 2)

first.push({ ...delta, seq: 1, added: [textEntry(99, '这是一条迟到的旧帧')] })
check('更旧的帧被丢掉（条目没有被回滚 / 追加）', client.getState().snapshot?.entries.length === 2 && loadLastSeq() === 2)

const readCall = client.invoke('refreshSessions', [])
check(
  'invoke：实参表编码（id 是数字；零参数不发明 args 字段）',
  first.sent[0]?.type === 'invoke' &&
    typeof first.sent[0]?.id === 'number' &&
    first.sent[0]?.method === 'refreshSessions' &&
    first.sent[0]?.args === undefined,
  JSON.stringify(first.sent[0]),
)
first.push({ type: 'result', id: first.sent[0].id, ok: true, result: [{ id: 's-2', cwd: 'D:\\proj', title: '会话二' }] })
check('invoke：结果能取回来并归一化', normalizeSessions(await readCall).length === 1)
check(
  'wire.ts 的 encodeArgs：一个参数 → args[一个]；两个参数 → args[两个]',
  JSON.stringify(encodeArgs('submit', ['文本'])) === '{"args":["文本"]}' &&
    JSON.stringify(encodeArgs('submit', ['文本', ['data:image/jpeg;base64,AA']])) === '{"args":["文本",["data:image/jpeg;base64,AA"]]}',
)

const submitPromise = client.submit('带张图', ['data:image/jpeg;base64,AA'])
// 断线时挂着的调用会被拒，这里只关心发出去的报文，所以先把拒绝咽掉。
submitPromise.catch(() => {})
const submitMessage = first.sent.find((message) => message.method === 'submit')
check(
  'submit：图片走第二个实参（submit(text, images)）',
  JSON.stringify(submitMessage?.args) === '["带张图",["data:image/jpeg;base64,AA"]]',
  JSON.stringify(submitMessage?.args),
)
check('submit 之后立刻算在跑（排队中提示）', client.getState().busy === true)
first.push({ type: 'result', id: submitMessage.id, ok: true })
await submitPromise

const interruptPromise = client.interrupt()
interruptPromise.catch(() => {})
const interruptMessage = first.sent.find((message) => message.method === 'interrupt')
first.push({ type: 'result', id: interruptMessage.id, ok: true })
await interruptPromise
check('interrupt 之后进「正在停止…」', client.getState().stopping === true)
first.push({ ...delta, seq: 3 })
check('新帧一到，停止态复位', client.getState().stopping === false)

fetchCalls.length = 0
const uploadCall = client.upload({ name: 'a.txt', size: 3, type: 'text/plain' })
const uploadResult = await uploadCall
const uploadFetch = fetchCalls.find((call) => call.href.includes('/api/upload'))
check(
  '上传：POST /api/upload?filename=…，头带 Bearer，体是原始字节',
  uploadFetch?.method === 'POST' &&
    uploadFetch.href.includes('filename=a.txt') &&
    uploadFetch.headers.authorization === 'Bearer tok-1' &&
    uploadFetch.body?.name === 'a.txt',
  JSON.stringify({ href: uploadFetch?.href, headers: uploadFetch?.headers }),
)
check('上传：拿到宿主给的路径', uploadResult.path === '/tmp/收件箱/a.txt' && uploadResult.size === 3)

fetchCalls.length = 0
await client.pushSubscribe({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } })
await client.pushUnsubscribe('https://push.example/e1')
const subscribeCall = fetchCalls.find((call) => call.href.includes('/api/push-subscribe'))
const unsubscribeCall = fetchCalls.find((call) => call.href.includes('/api/push-unsubscribe'))
check(
  '推送登记：POST /api/push-subscribe，体是订阅 JSON',
  subscribeCall?.method === 'POST' &&
    subscribeCall.headers.authorization === 'Bearer tok-1' &&
    JSON.parse(subscribeCall.body).endpoint === 'https://push.example/e1',
)
check(
  '推送注销：POST /api/push-unsubscribe，体是 {endpoint}',
  unsubscribeCall?.method === 'POST' && JSON.parse(unsubscribeCall.body).endpoint === 'https://push.example/e1',
)

first.close()
check('断线后排重连（状态是 reconnecting，带退避）', client.getState().conn === 'reconnecting' && client.getState().retryAt !== null)

// 宿主把推送开关关了（403）不能当成「凭据失效」——那会把用户莫名其妙踢回配对页
pushEnabled = false
const pushOffError = await client.pushSubscribe({ endpoint: 'https://push.example/e2' }).then(
  () => null,
  (error) => error.message,
)
check(
  '推送开关关着（403）：抛出宿主的人话文案，而不是当凭据失效',
  typeof pushOffError === 'string' && pushOffError.includes('浏览器推送没开') && client.getState().unauthorized === false,
  `${String(pushOffError)} / unauthorized=${String(client.getState().unauthorized)}`,
)
const keyOffError = await fetchPushKey('http://127.0.0.1:17321', 'tok-1').then(
  () => null,
  (error) => error.message,
)
check('推送开关关着：GET /api/push-key 的 publicKey:null 翻成人话', keyOffError === '电脑端的推送开关关着（没有公钥）', String(keyOffError))
pushEnabled = true
const beforeRetry = fetchCalls.filter((call) => call.href.endsWith('/api/ticket')).length
client.retryNow()
await flush()
const second = sockets[sockets.length - 1]
check(
  '手动重试：重新取一张票据，WS 带上本地最大 seq 补帧',
  second !== first &&
    fetchCalls.filter((call) => call.href.endsWith('/api/ticket')).length === beforeRetry + 1 &&
    second.url.includes('lastSeq=3'),
  second?.url,
)
second.open()
second.push({ ...fullFrame, seq: 4 })
check('补帧后的实时帧照常落地', client.getState().snapshot?.seq === 4 && loadLastSeq() === 4)
client.stop()
check('stop 之后不再重连', client.getState().conn === 'closed')

// 宿主进程重启：seq 从头开始，重连后第一帧的全量必须无条件收下（否则界面永远停在旧内容）
store.clear()
saveLastSeq(500)
sockets.length = 0
fetchCalls.length = 0
const restarted = new RemoteClient({ token: 'tok-2' })
restarted.start()
await flush()
const third = sockets[0]
check('重连带的是本地记着的旧位点', third.url.includes('lastSeq=500') === true)
third.open()
third.push({ ...fullFrame, seq: 1 })
check(
  '宿主重启后 seq 回退：重连第一帧的全量照样收下（整体重置）',
  restarted.getState().snapshot?.seq === 1 && loadLastSeq() === 1,
)
restarted.stop()

// 宿主重启后如果第一帧是增量（位点已经不可信）：清位点、重连一次、要一份全新的全量
store.clear()
saveLastSeq(900)
sockets.length = 0
fetchCalls.length = 0
const stale = new RemoteClient({ token: 'tok-4' })
stale.start()
await flush()
const staleSocket = sockets[0]
staleSocket.open()
const staleTickets = fetchCalls.filter((call) => call.href.endsWith('/api/ticket')).length
staleSocket.push({
  type: 'delta',
  seq: 3,
  full: false,
  meta: {},
  added: [textEntry(1, '不该被并进来')],
  updated: [],
  removedIds: [],
  liveEntries: [],
})
await flush()
check('位点比宿主新：这一帧不并进视图', stale.getState().snapshot === null)
check(
  '位点比宿主新：清掉位点并重连（换新连接、不再带 lastSeq）',
  (() => {
    const latest = sockets[sockets.length - 1]
    const tickets = fetchCalls.filter((call) => call.href.endsWith('/api/ticket')).length
    return (
      loadLastSeq() === null &&
      latest !== staleSocket &&
      tickets === staleTickets + 1 &&
      latest.url.includes('lastSeq') === false
    )
  })(),
)
stale.stop()

// 票据 401 → 退回登录页
store.clear()
sockets.length = 0
fetchCalls.length = 0
ticketStatus = 401
signOutReason = null
const revoked = new RemoteClient({
  token: 'tok-3',
  onUnauthorized: () => {
    signOutReason = '登录已失效，请重新配对设备'
  },
})
revoked.start()
await flush()
check(
  '票据 401：置 unauthorized 并回调（App 据此退回登录页）',
  revoked.getState().unauthorized === true && signOutReason === '登录已失效，请重新配对设备',
)
revoked.stop()
ticketStatus = 200

// ── 4. 推送 ──────────────────────────────────────────────────────────────────

console.log('Web Push（公钥解码 + 环境判定 + 订阅流程）')

fetchCalls.length = 0
const fallbackKey = await fetchPushKey('http://127.0.0.1:17321', 'tok-1')
check(
  'GET /api/push-key：兜底拉公钥（带 Bearer，取 publicKey）',
  fallbackKey === 'BKEY' &&
    fetchCalls[0]?.href.endsWith('/api/push-key') === true &&
    fetchCalls[0]?.headers.authorization === 'Bearer tok-1',
  JSON.stringify(fetchCalls[0]),
)

const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const decoded = urlBase64ToUint8Array(key)
const reference = Uint8Array.from(Buffer.from(key.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
check(
  'urlBase64ToUint8Array：与 node 的 base64 解码逐字节一致（含 URL-safe 字符与缺补位）',
  decoded.length === reference.length && decoded.every((byte, index) => byte === reference[index]),
  `${decoded.length} vs ${reference.length}`,
)
check(
  'urlBase64ToUint8Array：AQAB → 01 00 01',
  JSON.stringify(Array.from(urlBase64ToUint8Array('AQAB'))) === '[1,0,1]',
)

const grantedEnv = {
  secureContext: true,
  ios: false,
  standalone: false,
  notification: { permission: 'default', requestPermission: async () => 'granted' },
  serviceWorker: {
    ready: Promise.resolve({
      pushManager: {
        async subscribe(options) {
          grantedEnv.subscribeOptions = options
          return { toJSON: () => ({ endpoint: 'https://push.example/e9', keys: { p256dh: 'p', auth: 'a' } }) }
        },
        async getSubscription() {
          return null
        },
      },
    }),
  },
}
const subscriptionJson = await createPushSubscription('AQAB', grantedEnv)
check('订阅：userVisibleOnly 为 true（iOS 与 Chrome 都要求）', grantedEnv.subscribeOptions?.userVisibleOnly === true)
check(
  '订阅：applicationServerKey 是解码后的字节',
  grantedEnv.subscribeOptions?.applicationServerKey instanceof Uint8Array &&
    Array.from(grantedEnv.subscribeOptions.applicationServerKey).join(',') === '1,0,1',
)
check('订阅：返回的就是 PushSubscription.toJSON()', subscriptionJson.endpoint === 'https://push.example/e9')
check('退订：本机没有订阅时返回 null 而不是抛错', (await dropPushSubscription(grantedEnv)) === null)

check(
  '环境判定：iOS 没加到主屏幕 → 提示里带「请先添加到主屏幕」',
  (pushBlockReason({ secureContext: true, ios: true, standalone: false, notification: { permission: 'default' }, serviceWorker: {} }) ?? '').includes('请先添加到主屏幕'),
)
check(
  '环境判定：http（不是安全上下文）→ 说明要 https / localhost',
  (pushBlockReason({ secureContext: false, ios: false, standalone: false, notification: { permission: 'default' }, serviceWorker: {} }) ?? '').includes('https'),
)
check(
  '环境判定：权限被拒 → 提示去设置里重新允许',
  (pushBlockReason({ secureContext: true, ios: false, standalone: false, notification: { permission: 'denied' }, serviceWorker: {} }) ?? '').includes('权限'),
)
check('环境判定：都满足时返回 null（可以开）', pushBlockReason(grantedEnv) === null)
check(
  '环境判定：没有 Notification 的浏览器 → 「不支持通知」',
  (pushBlockReason({ secureContext: true, ios: false, standalone: false, notification: null, serviceWorker: {} }) ?? '').includes('不支持通知'),
)

// ── 5. 附件 ──────────────────────────────────────────────────────────────────

console.log('附件（文本拼装 + 体积 + 压缩）')

check('没有附件时正文原样（顺手去掉两端空白）', composeOutgoing('  你好  ', []) === '你好')
check(
  '一个附件：正文后空一行，随之 [附件] 路径',
  composeOutgoing('你好', ['/tmp/a.txt']) === '你好\n\n[附件] /tmp/a.txt',
  JSON.stringify(composeOutgoing('你好', ['/tmp/a.txt'])),
)
check(
  '多个附件：一行一个 [附件]',
  composeOutgoing('你好', ['/tmp/a.txt', 'D:\\b.png']) === '你好\n\n[附件] /tmp/a.txt\n[附件] D:\\b.png',
)
check('只有附件没有正文：只发附件行', composeOutgoing('', ['/tmp/a.txt']) === '[附件] /tmp/a.txt')
check('空白路径不算附件', attachmentLines(['   ', '']).length === 0)
check(
  '体积格式化：B / KB / MB',
  formatBytes(512) === '512 B' && formatBytes(2048) === '2.0 KB' && formatBytes(20 * 1024) === '20 KB' && formatBytes(3.5 * 1024 * 1024) === '3.5 MB',
)
check(
  'data URL 字节估算：base64 按 3/4 算，去掉补位',
  estimateDataUrlBytes('data:image/jpeg;base64,AAAA') === 3 &&
    estimateDataUrlBytes('data:image/jpeg;base64,AAA=') === 2 &&
    estimateDataUrlBytes('data:image/jpeg;base64,AA==') === 1,
)
check('附件总量按给定大小求和（非法值不计）', totalBytes([1024, 2048, -5, Number.NaN]) === 3072)
check(
  '缩放：长边 3064 → 1568（等比取整）',
  JSON.stringify(fitWithin(3064, 2048)) === JSON.stringify({ width: 1568, height: 1048 }),
  JSON.stringify(fitWithin(3064, 2048)),
)
check('缩放：比上限小的原样（只缩不放）', JSON.stringify(fitWithin(800, 600)) === JSON.stringify({ width: 800, height: 600 }))
check('缩放：竖图按高定长边', JSON.stringify(fitWithin(100, 4000)) === JSON.stringify({ width: 39, height: 1568 }))
check('缩放：0 尺寸兜底成 1px（canvas 不接受 0）', JSON.stringify(fitWithin(0, 0)) === JSON.stringify({ width: 1, height: 1 }))
check('只对 PNG 保留 PNG（透明），其余走 JPEG', keepsAlpha('image/png') === true && keepsAlpha('image/jpeg') === false)

/** 假 canvas 环境：记下要了多大、用什么格式导出。 */
function fakeCompressEnv({ width, height, dataUrl }) {
  const record = { canvas: null, exported: null }
  return {
    record,
    env: {
      loadImage: async () => ({ width, height, source: { fake: true } }),
      createCanvas: (w, h) => {
        record.canvas = { width: w, height: h }
        return {
          width: w,
          height: h,
          toDataURL: (type, quality) => {
            record.exported = { type, quality }
            return dataUrl
          },
        }
      },
      drawImage: () => {},
    },
  }
}

const bigImage = fakeCompressEnv({
  width: 3064,
  height: 2048,
  dataUrl: `data:image/jpeg;base64,${'A'.repeat(4000)}`,
})
const compressed = await compressImage({ type: 'image/jpeg' }, 'image/jpeg', bigImage.env)
check(
  '压缩：canvas 建的是 1568x1048（长边缩到 1568）',
  bigImage.record.canvas?.width === 1568 && bigImage.record.canvas?.height === 1048,
)
check(
  '压缩：JPEG 用 0.85 质量导出',
  bigImage.record.exported?.type === 'image/jpeg' && bigImage.record.exported?.quality === 0.85,
)
check('压缩：返回压缩后的字节数与尺寸', compressed.bytes === 3000 && compressed.width === 1568)

const pngImage = fakeCompressEnv({ width: 400, height: 200, dataUrl: 'data:image/png;base64,AAAA' })
await compressImage({ type: 'image/png' }, 'image/png', pngImage.env)
check('压缩：PNG 仍导出 PNG（保住透明）', pngImage.record.exported?.type === 'image/png')

const hugeImage = fakeCompressEnv({
  width: 100,
  height: 100,
  dataUrl: `data:image/jpeg;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) / 3) * 4)}`,
})
const hugeError = await compressImage({ type: 'image/jpeg' }, 'image/jpeg', hugeImage.env).then(
  () => null,
  (error) => error.message,
)
check('压缩：压完还超单张 4MB → 抛错并说清上限', typeof hugeError === 'string' && hugeError.includes('4.0 MB'), String(hugeError))

// ── 6. 登录页（扫码直达 + 设备记忆） ─────────────────────────────────────────

console.log('登录页（扫码直达 + 设备记忆）')

/** 假的 history：把 replaceState 的实参记下来，用来断言地址栏被擦成了什么。 */
function fakeHistory() {
  const calls = []
  return {
    calls,
    replaceState: (data, unused, url) => {
      calls.push({ data, unused, url })
    },
  }
}

check(
  '清洗：只留字母数字、转大写、截到 8 位（手输与扫码走同一条路）',
  sanitizePairCode(' ab-cd 12_34 ') === 'ABCD1234' && sanitizePairCode('abcdefghij') === 'ABCDEFGH',
  `${sanitizePairCode(' ab-cd 12_34 ')} / ${sanitizePairCode('abcdefghij')}`,
)
check(
  '合规判定：只有 8 位字母数字才算（少一位、多一位、带符号都不算）',
  isValidPairCode('ABCD1234') === true &&
    isValidPairCode('ABCD123') === false &&
    isValidPairCode('ABCD12345') === false &&
    isValidPairCode('ABCD-123') === false,
)

const legalHistory = fakeHistory()
const prefilled = takePairCodeFromUrl('https://host.example:17321/?code=ABCD1234', legalHistory)
check('合法 code：取出来就是预填值', prefilled === 'ABCD1234', String(prefilled))
check(
  '合法 code：地址栏的 code 被 replaceState 擦掉（截屏/分享都不带走这张码）',
  legalHistory.calls.length === 1 && legalHistory.calls[0]?.url === '/',
  JSON.stringify(legalHistory.calls.map((call) => call.url)),
)

const mixedHistory = fakeHistory()
const mixed = takePairCodeFromUrl('https://h/?code=abcd1234&from=qr#top', mixedHistory)
check('小写码照样收，预填前统一成大写', mixed === 'ABCD1234', String(mixed))
check(
  '擦码只删 code：其余查询串与 hash 原样保留',
  mixedHistory.calls[0]?.url === '/?from=qr#top',
  String(mixedHistory.calls[0]?.url),
)

for (const bad of ['ABCD123', 'ABCD12345', 'ABCD-123', '<img src=x>', '']) {
  const badHistory = fakeHistory()
  const got = takePairCodeFromUrl(`https://h/?code=${encodeURIComponent(bad)}`, badHistory)
  check(
    `非法 code「${bad}」：静默忽略（不预填），但照样从地址栏擦掉`,
    got === null && badHistory.calls.length === 1 && String(badHistory.calls[0]?.url).includes('code') === false,
    `got=${String(got)} url=${String(badHistory.calls[0]?.url)}`,
  )
}

const noCodeHistory = fakeHistory()
check(
  'URL 里没有 code：返回 null，且不碰历史记录',
  takePairCodeFromUrl('https://h/?from=qr', noCodeHistory) === null && noCodeHistory.calls.length === 0,
)
check('URL 解析不出来（不是绝对地址）：安静返回 null', takePairCodeFromUrl(':::不是地址', fakeHistory()) === null)

const stripHistory = fakeHistory()
stripPairCodeFromUrl('https://h/?code=ABCD1234&from=qr#top', stripHistory)
check(
  '已配对手机走的那条路：stripPairCodeFromUrl 只擦码、其余原样（登录页不挂载也有人擦）',
  stripHistory.calls.length === 1 && stripHistory.calls[0]?.url === '/?from=qr#top',
  String(stripHistory.calls[0]?.url),
)
const stripNoneHistory = fakeHistory()
stripPairCodeFromUrl('https://h/?from=qr', stripNoneHistory)
check('stripPairCodeFromUrl：没有 code 时不动历史记录', stripNoneHistory.calls.length === 0)

/*
 * 下面这几条读 LoginPage.tsx 的源码来断言「接线」：selfcheck 里没有 DOM，
 * 起不了 React 组件，所以文案与调用点按源码核对（和本文件核对 sw.js 的做法一致）。
 * 纯逻辑（取码、擦码、清洗）上面已经用真函数跑过了，这里只补「页面确实用了它」。
 */
const loginSource = readFileSync(fileURLToPath(new URL('./src/pages/LoginPage.tsx', import.meta.url)), 'utf8')
check('登录页：挂载时调 takePairCodeFromUrl 取码（扫码直达接线到位）', loginSource.includes('takePairCodeFromUrl(window.location.href, window.history)'))
check('登录页：手输也走同一个清洗函数 sanitizePairCode', loginSource.includes('sanitizePairCode(event.target.value)'))

/** 抠出扫码直达那段效果的函数体（从调用点切到 `}, [])`），用它证明「只设状态、不发请求」。 */
const effectStart = loginSource.indexOf('takePairCodeFromUrl(')
const effectEnd = effectStart < 0 ? -1 : loginSource.indexOf('}, [])', effectStart)
const effectBody = effectStart < 0 || effectEnd < 0 ? null : loginSource.slice(effectStart, effectEnd)
const autoSubmitHit = effectBody === null ? '没抠到效果块' : (effectBody.match(/\bpair\(|handleSubmit\(/) ?? [''])[0]
check('扫码到达不自动提交（这段效果里没有 pair( / handleSubmit(）', effectBody !== null && autoSubmitHit === '', autoSubmitHit)
check('扫码到达停一步：焦点给到设备名输入框', (effectBody ?? '').includes('deviceNameRef.current?.focus()'))
check(
  '设备名默认值来自记忆（loadDeviceName 优先，空才用「我的手机」）',
  loginSource.includes("useState(() => loadDeviceName() || '我的手机')"),
)
check('被踢回来的 notice 仍然照原样渲染（最显眼那条）', loginSource.includes('<p className="login-notice">{notice}</p>'))

const appSource = readFileSync(fileURLToPath(new URL('./src/App.tsx', import.meta.url)), 'utf8')
check(
  'App 兜一道：有凭据（登录页不挂载）时擦掉地址栏的码，没凭据时留给登录页预填',
  appSource.includes('stripPairCodeFromUrl(window.location.href, window.history)') &&
    appSource.includes('if (creds !== null)'),
)

store.clear()
saveCreds({ token: 'tok-memory', deviceId: 'dev-1', deviceName: '书房的手机' })
check('设备记忆：配对过的设备名被记住（下次进登录页当默认值）', loadDeviceName() === '书房的手机', loadDeviceName())
clearCreds()
check('清凭据不动设备名（重新配对时默认值还在）', loadDeviceName() === '书房的手机', loadDeviceName())
store.clear()

check('登录页文案：说清「配对一次，这台设备以后打开即直连」', loginSource.includes('配对一次，这台设备以后打开即直连，不用重复输码'))
check(
  '登录页文案：配对码有效期与批 A 对齐（半小时），没有「1 小时」',
  loginSource.includes('半小时内有效') && loginSource.includes('1 小时') === false,
)

/** remote-web 下所有源文件（含 .tsx）：配对码相关文案不许再写「1 小时」。 */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(full) : [full]
  })
}

const hourHits = sourceFiles(fileURLToPath(new URL('./src', import.meta.url))).filter((file) =>
  /1\s*小时/.test(readFileSync(file, 'utf8')),
)
check(
  'remote-web 全量源文件里没有「1 小时」（锁码那 1 小时是锁，文案在宿主 src/ 那侧）',
  hourHits.length === 0,
  hourHits.join(', '),
)

// ── 7. PWA 产物文件 ──────────────────────────────────────────────────────────

console.log('PWA 产物（manifest / service worker）')

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./public/manifest.json', import.meta.url)), 'utf8'))
check('manifest：name 是 Muse Code', manifest.name === 'Muse Code')
check('manifest：standalone 启动', manifest.display === 'standalone')
check('manifest：主题色/底色取深色档的值', manifest.theme_color === '#0f1013' && manifest.background_color === '#0f1013')
check(
  'manifest：192 与 512 两档图标都在',
  manifest.icons?.some((icon) => icon.sizes === '192x192') === true &&
    manifest.icons?.some((icon) => icon.sizes === '512x512') === true,
)
check(
  '图标文件确实在 public/ 下（构建时会被拷进产物）',
  existsSync(fileURLToPath(new URL('./public/icon-192.png', import.meta.url))) &&
    existsSync(fileURLToPath(new URL('./public/icon-512.png', import.meta.url))),
)

const serviceWorker = readFileSync(fileURLToPath(new URL('./src/sw.js', import.meta.url)), 'utf8')
check('sw：push 事件里会 showNotification', serviceWorker.includes("addEventListener('push'") && serviceWorker.includes('showNotification'))
check(
  'sw：notificationclick 会聚焦页面或 openWindow（点通知回会话页）',
  serviceWorker.includes("addEventListener('notificationclick'") && serviceWorker.includes('openWindow'),
)

// ── 收尾 ─────────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${total - failures}/${total} 条断言通过`)
if (failures > 0) process.exitCode = 1
