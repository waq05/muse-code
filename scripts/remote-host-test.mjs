/**
 * 远程控制的单元探针：不起宿主、不联网，直接验数据层与两块纯逻辑。
 *
 * 覆盖：
 *   - 偏好：合法值 / 非法值（回落或夹取）/ 未知键（不搬进来）/ writePrefs 深合并
 *   - 配对：正确码换 token、码有效期半小时、错码 5 次锁 1 小时、过期码、明文码与明文 token
 *           都不落盘、码一次性、吊销以后 token 不认
 *   - 票据：一次性、过期、认不出的票
 *   - 主控位：第二进程拿不到、让出后可再拿、主人死掉的锁能接管（真起子进程验的）
 *   - Host 头：IP 字面量 / localhost 放行，域名与端口不符拒绝
 *   - 远程白名单：凭据类与宿主生命周期方法必须不在里面
 *
 * 运行：pnpm build && node scripts/remote-host-test.mjs
 * （为什么要先 build：本仓库没有测试框架，脚本跑的是编译产物 lib/，
 *   理由是 TS 的 `.js` 说明符 node 自带剥离解析不了。）
 *
 * @module dsc/scripts/remote-host-test
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 隔离的家目录：用户真实的 ~/.dsc 一个字节都不写（惯例照 desktop/shots/*-seed.mjs）。 */
const home = 'D:\\dsc\\scripts\\.remote-host-test-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
mkdirSync(join(home, '.dsc'), { recursive: true })
// 必须在 import 核心之前换掉 HOME/USERPROFILE：设置的读写位置是按 homedir 算的。
process.env.HOME = home
process.env.USERPROFILE = home

const { readPrefs, writePrefs, REMOTE_PORT_DEFAULT, REMOTE_PORT_MIN, REMOTE_PORT_MAX } = await import(
  '../lib/core/prefs.js'
)
const { RemotePairing, CODE_ALPHABET, CODE_LENGTH, CODE_TTL_MS, CODE_LOCK_MS, MAX_CODE_ATTEMPTS } = await import(
  '../lib/core/remote/pairing.js'
)
const { TicketStore, TICKET_TTL_MS } = await import('../lib/core/remote/tickets.js')
const { RemoteOwnerLock } = await import('../lib/core/remote/owner.js')
const { REMOTE_METHODS, hostHeaderAllowed } = await import('../lib/plugins/remote.js')

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

/** 等一个条件成立（帧是按节流定时器异步出来的，只能等）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(5)
  }
}

const settingsFile = join(home, '.dsc', 'settings.json')
const writeSettings = (doc) => writeFileSync(settingsFile, `${JSON.stringify(doc)}\n`, 'utf8')

// ── 1. 偏好 ───────────────────────────────────────────────────────────────────
console.log('偏好（settings.json 的 remote 段）')

rmSync(settingsFile, { force: true })
check(
  '没有 settings.json 时 remote 是「关着 + 默认端口 17321 + 只绑本机」',
  (() => {
    const remote = readPrefs().remote
    return remote.enabled === false && remote.port === REMOTE_PORT_DEFAULT && remote.lan === false
  })(),
  JSON.stringify(readPrefs().remote),
)

writeSettings({ remote: { enabled: true, port: 20000, lan: true } })
check(
  '合法值原样读出来',
  (() => {
    const remote = readPrefs().remote
    return remote.enabled === true && remote.port === 20000 && remote.lan === true
  })(),
  JSON.stringify(readPrefs().remote),
)

writeSettings({ remote: { enabled: 'yes', port: '不是数字', lan: 1 } })
check(
  '非法类型回落默认（不是布尔/数字一律不认）',
  (() => {
    const remote = readPrefs().remote
    return remote.enabled === false && remote.port === REMOTE_PORT_DEFAULT && remote.lan === false
  })(),
  JSON.stringify(readPrefs().remote),
)

writeSettings({ remote: { port: 80 } })
check(`端口 80 夹到下限 ${String(REMOTE_PORT_MIN)}`, readPrefs().remote.port === REMOTE_PORT_MIN)
writeSettings({ remote: { port: 70000 } })
check(`端口 70000 夹到上限 ${String(REMOTE_PORT_MAX)}`, readPrefs().remote.port === REMOTE_PORT_MAX)
writeSettings({ remote: { unknownKey: '不认识', port: 18000 } })
check('remote 里的未知键不搬进偏好，认识的键照读', !('unknownKey' in readPrefs().remote) && readPrefs().remote.port === 18000)
check('顶层未知键也不进偏好', !('weird' in readPrefs()))

writePrefs({ remote: { enabled: true, port: 19000, lan: true } })
writePrefs({ remote: { ...readPrefs().remote, port: 19001 } })
check(
  'writePrefs 深合并 remote：只改端口不会把开关与 lan 抹掉',
  (() => {
    const remote = readPrefs().remote
    return remote.port === 19001 && remote.enabled === true && remote.lan === true
  })(),
  JSON.stringify(readPrefs().remote),
)
writeSettings({ remote: { enabled: true, port: 19002, lan: false, unknownKey: 'x' } })
writePrefs({ remote: { ...readPrefs().remote, lan: true } })
check(
  '写盘会把 remote 里的未知键清掉（写的是校验过的那份）',
  !readFileSync(settingsFile, 'utf8').includes('unknownKey'),
)

// 协议 v3 新增的两项：浏览器推送开关（默认关）与通知 Webhook（默认空 = 关）
rmSync(settingsFile, { force: true })
check(
  '没有 settings.json 时 push 是关的、notifyWebhook 是空串',
  readPrefs().remote.push === false && readPrefs().remote.notifyWebhook === '',
  JSON.stringify(readPrefs().remote),
)
writeSettings({ remote: { push: true, notifyWebhook: '  https://api.day.app/KEY/{title}/{body}?url={url}  ' } })
check(
  '合法的 push 与带占位符的 http(s) 地址原样读出来（地址两端空白被去掉）',
  (() => {
    const remote = readPrefs().remote
    return remote.push === true && remote.notifyWebhook === 'https://api.day.app/KEY/{title}/{body}?url={url}'
  })(),
  JSON.stringify(readPrefs().remote),
)
writeSettings({ remote: { push: 'yes', notifyWebhook: 'https://ntfy.sh/我的主题' } })
check(
  'push 只认真正的布尔（"yes" 不算开），没占位符的 https 地址照收',
  readPrefs().remote.push === false && readPrefs().remote.notifyWebhook === 'https://ntfy.sh/我的主题',
  JSON.stringify(readPrefs().remote),
)
for (const bad of ['javascript:alert(1)', 'ftp://example.com/hook', 'example.com/hook', '   ', 42, null, {}]) {
  writeSettings({ remote: { notifyWebhook: bad } })
  check(
    `非法的 notifyWebhook（${JSON.stringify(bad)}）回落空串 = 关掉`,
    readPrefs().remote.notifyWebhook === '',
    JSON.stringify(readPrefs().remote),
  )
}

// ── 2. 配对 ───────────────────────────────────────────────────────────────────
console.log('配对码与设备 token')

const pairDir = join(home, 'pairing')
const pairing = new RemotePairing({ dir: pairDir })
const issued = pairing.issueCode()
check(`发出来的码是 ${String(CODE_LENGTH)} 位`, issued !== null && issued.code.length === CODE_LENGTH, JSON.stringify(issued))
check(
  '码里只有无歧义字符（没有 O/0/I/1/l）',
  issued !== null && [...issued.code].every((char) => CODE_ALPHABET.includes(char)),
  issued?.code,
)
check('已经有一张没用的码时不再签发第二张', pairing.issueCode() === null)

// replace：桌面「连接手机」弹窗与它的「重新生成」走这条。旧码的明文只在上一张弹窗上、
// 宿主重画不出来，所以界面上要一直看得见一张有效码就只能换新的，且旧码必须当场作废。
const replaced = pairing.issueCode({ replace: true })
check('replace:true 时已有活码也照发新码', replaced !== null && replaced.code !== issued?.code, JSON.stringify(replaced))
check('replace 之后旧码当场作废（401）', pairing.verifyCode(issued?.code ?? '', '我的手机').ok === false)

const pendingText = readFileSync(join(pairDir, 'pending.json'), 'utf8')
check('pending.json 里没有明文码（只有盐与哈希）', issued !== null && !pendingText.includes(issued.code))
check('pending.json 里存的是 sha256（64 位十六进制）', /"hash": "[0-9a-f]{64}"/.test(pendingText))

const wrong = pairing.verifyCode('ZZZZZZZZ', '我的手机')
check('错码返回 401', wrong.ok === false && wrong.status === 401, JSON.stringify(wrong))
check(
  '配对失败的文案里没有「1 小时有效」这种码时效口径（码已改半小时）',
  wrong.ok === false && !wrong.error.includes('1 小时'),
  wrong.ok === false ? wrong.error : '',
)
for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) pairing.verifyCode('ZZZZZZZZ', '我的手机')
const locked = pairing.verifyCode(issued?.code ?? '', '我的手机')
check(
  `连错 ${String(MAX_CODE_ATTEMPTS)} 次之后锁 1 小时：连对的码也进不来（429）`,
  locked.ok === false && locked.status === 429,
  JSON.stringify(locked),
)
check(
  '锁码的 429 文案仍写「已锁 1 小时」（锁的时长没变）',
  locked.ok === false && locked.error.includes('已锁 1 小时'),
  locked.ok === false ? locked.error : '',
)
const relock = pairing.issueCode()
check('被锁的码不算「没用过」：还能再发一张新的', relock !== null && relock.code !== issued?.code)

const paired = pairing.verifyCode(relock?.code ?? '', '我的手机')
check('对的码换到设备 token', paired.ok === true && paired.token.length >= 32, JSON.stringify({ ok: paired.ok }))
check('同一个码不能再用第二次（一次性）', pairing.verifyCode(relock?.code ?? '', '我的手机').ok === false)

const devicesText = readFileSync(join(pairDir, 'devices.json'), 'utf8')
check('devices.json 里没有明文 token', paired.ok === true && !devicesText.includes(paired.token))
check('devices.json 里有 token 的 sha256 与设备名', /"tokenHash": "[0-9a-f]{64}"/.test(devicesText) && devicesText.includes('我的手机'))
const seen = paired.ok ? pairing.verifyToken(paired.token) : null
check('token 验得过，并带回设备名', seen !== null && seen.name === '我的手机', JSON.stringify(seen))
check('认不出的 token 给 null', pairing.verifyToken('不存在的 token') === null)
check(
  '吊销时把被吊销的设备带回来（服务端据此断开它的连接）',
  (paired.ok ? pairing.revoke(paired.token) : null)?.deviceId === paired.deviceId,
)
check('吊销之后就认不出了', pairing.verifyToken(paired.ok ? paired.token : '') === null)
check('吊销一个不认识的 token 给 null', pairing.revoke('不存在的 token') === null)

// 逐台吊销：设置页上每台设备一个「吊销」按钮走这条（只有 deviceId，没有 token）
{
  const devicePairing = new RemotePairing({ dir: join(home, 'pairing-devices') })
  const codeA = devicePairing.issueCode()
  const phoneA = devicePairing.verifyCode(codeA?.code ?? '', '手机 A')
  const codeB = devicePairing.issueCode()
  const phoneB = devicePairing.verifyCode(codeB?.code ?? '', '手机 B')
  const listed = devicePairing.devices()
  check(
    'devices() 给出 deviceId / name / createdAt / lastSeenAt（设备清单每台两行要用它）',
    listed.length === 2 &&
      listed.every(
        (device) =>
          typeof device.deviceId === 'string' &&
          device.deviceId !== '' &&
          typeof device.name === 'string' &&
          typeof device.createdAt === 'number' &&
          typeof device.lastSeenAt === 'number',
      ),
    JSON.stringify(listed),
  )
  const gone = devicePairing.revokeDevice(phoneA.ok === true ? phoneA.deviceId : '')
  check(
    '单独吊销一台：返回被吊销那台，清单少一台，另一台照旧',
    gone?.deviceId === phoneA.deviceId &&
      devicePairing.devices().length === 1 &&
      devicePairing.devices()[0]?.deviceId === phoneB.deviceId,
    JSON.stringify(devicePairing.devices()),
  )
  check(
    '被吊销那台的 token 认不出，另一台照常能用',
    devicePairing.verifyToken(phoneA.ok === true ? phoneA.token : '') === null &&
      devicePairing.verifyToken(phoneB.ok === true ? phoneB.token : '')?.deviceId === phoneB.deviceId,
  )
  check(
    '吊销一个不存在的 deviceId 给 null（重复吊销不报错）',
    devicePairing.revokeDevice('没有这台设备') === null && devicePairing.revokeDevice('') === null,
  )
}

// 过期：注入假钟，码有效半小时
let clock = 1_000_000
const timeMachine = new RemotePairing({ dir: join(home, 'pairing-expire'), now: () => clock })
const expiring = timeMachine.issueCode()
check(
  '码的有效期是半小时（CODE_TTL_MS = 1800000）',
  CODE_TTL_MS === 1_800_000 && expiring !== null && expiring.expiresAt - clock === CODE_TTL_MS,
  JSON.stringify({ ttl: CODE_TTL_MS, expiresAt: expiring?.expiresAt, clock }),
)
check(
  '锁码时长没跟着码改：连错超限照旧锁 1 小时（CODE_LOCK_MS = 3600000）',
  CODE_LOCK_MS === 3_600_000,
  String(CODE_LOCK_MS),
)
clock += CODE_TTL_MS + 1
const expired = timeMachine.verifyCode(expiring?.code ?? '', '旧手机')
check('过期的码换不到 token（401）', expired.ok === false && expired.status === 401, JSON.stringify(expired))

// ── 3. 票据 ───────────────────────────────────────────────────────────────────
console.log('一次性 WS 票据')

const tickets = new TicketStore()
const ticket = tickets.issue('device-1')
check('票据第一次用得通，并带回是哪台设备换的', tickets.redeem(ticket)?.deviceId === 'device-1')
check('同一张票据第二次用不通（一次性）', tickets.redeem(ticket) === null)
check('认不出的票据用不通', tickets.redeem('随便一张') === null)

let ticketClock = 0
const slowTickets = new TicketStore(TICKET_TTL_MS, () => ticketClock)
const oldTicket = slowTickets.issue('device-2')
ticketClock += TICKET_TTL_MS + 1
check('过期的票据用不通', slowTickets.redeem(oldTicket) === null)

// ── 4. 主控位 ─────────────────────────────────────────────────────────────────
console.log('主控位（.owner.json）')

const lockDir = join(home, 'lock')
const ownerUrl = pathToFileURL(join(process.cwd(), 'lib', 'core', 'remote', 'owner.js')).href
/** 起一个真子进程去抢同一把锁：拿不到就打 no。 */
const childTry = () =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { RemoteOwnerLock } = await import(${JSON.stringify(ownerUrl)});` +
        `const lock = new RemoteOwnerLock({ dir: ${JSON.stringify(lockDir)} });` +
        `process.stdout.write(lock.tryAcquire(17321) ? 'yes' : 'no')`,
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' },
  )

const lock = new RemoteOwnerLock({ dir: lockDir })
check('本进程先抢到主控位', lock.tryAcquire(17321) === true)
check('同一进程再抢一次还是自己（刷新端口）', lock.tryAcquire(17321) === true)
const second = childTry()
check('第二个进程抢不到（这就是休眠的依据）', second.stdout.trim() === 'no', `${second.stdout}${second.stderr}`)
lock.release()
const third = childTry()
check('本进程让出之后，第二个进程能拿到', third.stdout.trim() === 'yes', `${third.stdout}${third.stderr}`)
check(
  '主人已经不在的锁能被接管（pid 回收也骗不过启动指纹）',
  new RemoteOwnerLock({ dir: lockDir }).tryAcquire(17321) === true,
)

// ── 5. Host 头 ────────────────────────────────────────────────────────────────
console.log('Host 头校验（防 DNS rebinding）')
const port = 17321
check('127.0.0.1:端口 放行', hostHeaderAllowed('127.0.0.1:17321', port) === true)
check('localhost:端口 放行', hostHeaderAllowed('localhost:17321', port) === true)
check('局域网 IP 字面量放行（手机就是用这个地址连的）', hostHeaderAllowed('192.168.1.7:17321', port) === true)
check('[::1]:端口 放行', hostHeaderAllowed('[::1]:17321', port) === true)
check('域名拒绝（攻击者的网页就长这样）', hostHeaderAllowed('evil.example.com:17321', port) === false)
check('端口不符拒绝', hostHeaderAllowed('127.0.0.1:9999', port) === false)
check('没带端口拒绝', hostHeaderAllowed('127.0.0.1', port) === false)
check('没有 Host 头拒绝', hostHeaderAllowed(undefined, port) === false)

// ── 6. 服务端：静态目录不存在时的兜底页 ───────────────────────────────────────
console.log('HTTP 服务端（桩依赖）')

/** 由系统挑一个空闲端口（先 listen 0 再关掉，紧接着给桩服务用）。 */
async function freePort() {
  const { createServer } = await import('node:http')
  return await new Promise((resolvePort) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port
      probe.close(() => resolvePort(chosen))
    })
  })
}

/** 一个最小 HTTP 调用器：body 可以是字符串也可以是 Buffer（原始字节）。 */
function httpCall(port, path, options = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const headers = { ...(options.host === undefined ? {} : { host: options.host }), ...(options.headers ?? {}) }
    if (typeof options.body === 'string') headers['content-length'] = Buffer.byteLength(options.body)
    if (Buffer.isBuffer(options.body)) headers['content-length'] = options.body.length
    // requestModule 传的是 node:http 的 request 函数本身（不是模块对象）
    const send = options.requestModule
    const req = send(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolveCall({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', rejectCall)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

{
  const { createRemoteServer } = await import('../lib/plugins/remote.js')
  const { RemoteUploads } = await import('../lib/core/remote/uploads.js')
  const { request } = await import('node:http')
  // 由系统挑一个空闲端口：写死端口会和别人撞
  const stubPort = await freePort()
  const served = []
  const server = createRemoteServer({
    port: stubPort,
    lan: false,
    throttleMs: 80,
    // 指到一个不存在的目录：界面还没构建时走的就是这一条
    assetsDir: join(home, '没有这个目录'),
    pairing,
    tickets,
    uploads: new RemoteUploads({ dir: join(home, 'uploads-stub') }),
    invoke: async () => null,
    snapshot: () => ({ sessionId: 's', cwd: 'c', entries: [], liveEntries: [], status: {}, surfaces: {}, sessions: [], sessionsLoading: false }),
    subscribe: () => () => {},
    notice: (text) => served.push(text),
    pushEnabled: () => false,
    pushPublicKey: () => null,
    pushSubscribe: () => ({ ok: false, error: '桩不该被调到' }),
    pushUnsubscribe: () => false,
  })
  await server.ready
  const get = (path, host) => httpCall(stubPort, path, { host, requestModule: request })
  const home1 = await get('/')
  check(
    '静态目录不存在时 / 返回「资产未构建」占位页',
    home1.status === 200 && home1.body.includes('资产未构建'),
    `${String(home1.status)} ${home1.body.slice(0, 60)}`,
  )
  const missing = await get('/app-missing.js')
  check('别的路径找不到就 404', missing.status === 404, String(missing.status))
  const wrongHost = await get('/', `evil.example.com:${String(stubPort)}`)
  check('桩服务同样拦域名 Host（403）', wrongHost.status === 403, String(wrongHost.status))
  const uploadNoAuth = await httpCall(stubPort, '/api/upload?filename=a.txt', { method: 'POST', body: 'x', requestModule: request })
  check('上传也要过 Host 检查与 token 检查（没 token → 401，不是 403）', uploadNoAuth.status === 401, String(uploadNoAuth.status))
  server.close()
}

// ── 7. 远程白名单 ─────────────────────────────────────────────────────────────
console.log('远程方法白名单')
const blocked = [
  'saveProvider',
  'removeProvider',
  'setProviderKey',
  'setDefaultModel',
  'setSettingValue',
  'runSettingAction',
  'installMarketSkill',
  'setSkillEnabled',
  'setMarketSources',
  'dock',
  'runCommand',
  'exit',
]
check(
  '凭据 / 设置 / 宿主生命周期操作一概不在远程白名单里',
  blocked.every((method) => !REMOTE_METHODS.includes(method)),
  blocked.filter((method) => REMOTE_METHODS.includes(method)).join('、'),
)
check(
  '浏览端要用的那几个都在（提交 / 打断 / 切会话 / 答卡 / 看历史）',
  ['submit', 'interrupt', 'openSession', 'answerApproval', 'answerPlan', 'answerQuestion', 'listArchivedSessions'].every(
    (method) => REMOTE_METHODS.includes(method),
  ),
)

// ── 8. 帧流：全局 seq、增量 diff、锚帧节奏、重连补帧 ────────────────────────────
console.log('帧流：增量 diff 与锚帧节奏')
{
  const { RemoteFrameHub, FRAME_BUFFER_SIZE, FULL_ANCHOR_FRAMES, FULL_ANCHOR_MS } = await import(
    '../lib/core/remote/frames.js'
  )
  const entry = (id, text) => ({ id, kind: 'text', text })
  const snap = (entries, patch = {}) => ({
    sessionId: 's1',
    cwd: 'D:\\dsc',
    status: { turnState: 'idle' },
    surfaces: { pendingApproval: null },
    sessions: [],
    sessionsLoading: false,
    entries,
    liveEntries: [{ id: -1, kind: 'thinking', text: '想' }],
    ...patch,
  })
  const parsed = (frame) => JSON.parse(frame.text)

  let clock = 1_000_000
  const hub = new RemoteFrameHub({ now: () => clock })
  const first = hub.build(snap([entry(1, '第一条')]))
  const firstDoc = parsed(first)
  check(
    '第一帧一定是全量（客户端手里没有基准）',
    first.full === true && first.seq === 1 && firstDoc.type === 'snapshot' && firstDoc.full === true,
    JSON.stringify({ seq: first.seq, full: first.full }),
  )
  check(
    '全量帧把快照字段照 v2 原样铺平（不是塞在 meta 里）',
    firstDoc.sessionId === 's1' && firstDoc.cwd === 'D:\\dsc' && Array.isArray(firstDoc.entries) && firstDoc.entries.length === 1 && Array.isArray(firstDoc.liveEntries),
    JSON.stringify(firstDoc).slice(0, 120),
  )

  const added = hub.build(snap([entry(1, '第一条'), entry(2, '第二条')]))
  const addedDoc = parsed(added)
  check(
    '新出现的条目进 added（seq 继续递增，type=delta）',
    added.full === false && added.seq === 2 && addedDoc.type === 'delta' && addedDoc.full === false && addedDoc.added.length === 1 && addedDoc.added[0].id === 2,
    JSON.stringify(addedDoc).slice(0, 160),
  )
  check(
    '没动的条目既不在 added 也不在 updated；removedIds 是空的',
    addedDoc.updated.length === 0 && addedDoc.removedIds.length === 0,
    JSON.stringify(addedDoc),
  )
  check(
    'meta 每帧全量带（除 entries/liveEntries 外的快照字段原样打包）',
    addedDoc.meta.sessionId === 's1' && addedDoc.meta.cwd === 'D:\\dsc' && addedDoc.meta.status.turnState === 'idle' && 'surfaces' in addedDoc.meta && !('entries' in addedDoc.meta) && !('liveEntries' in addedDoc.meta),
    JSON.stringify(addedDoc.meta),
  )
  check(
    'liveEntries（负 id 直播尾）每帧全量带',
    addedDoc.liveEntries.length === 1 && addedDoc.liveEntries[0].id === -1,
    JSON.stringify(addedDoc.liveEntries),
  )

  const updated = parsed(hub.build(snap([entry(1, '第一条改了'), entry(2, '第二条')])))
  check(
    'JSON.stringify 不同的条目进 updated（按 id 认）',
    updated.added.length === 0 && updated.updated.length === 1 && updated.updated[0].id === 1 && updated.updated[0].text === '第一条改了',
    JSON.stringify(updated),
  )

  const removed = parsed(hub.build(snap([entry(1, '第一条改了')])))
  check(
    '消失的条目进 removedIds',
    removed.removedIds.length === 1 && removed.removedIds[0] === 2 && removed.updated.length === 0,
    JSON.stringify(removed),
  )

  // 锚帧之一：连续 N 帧 delta 之后至少一帧全量
  const frameHub = new RemoteFrameHub({ now: () => clock, anchorFrames: 3, anchorMs: 10_000_000 })
  const kinds = [frameHub.build(snap([entry(1, 'a')])), frameHub.build(snap([entry(1, 'b')])), frameHub.build(snap([entry(1, 'c')])), frameHub.build(snap([entry(1, 'd')])), frameHub.build(snap([entry(1, 'e')]))].map((frame) => frame.full)
  check(
    `连续 ${String(FULL_ANCHOR_FRAMES)} 帧 delta 之后必须再给一帧全量（这里把阈值调成 3 逐格看）`,
    JSON.stringify(kinds) === JSON.stringify([true, false, false, false, true]),
    JSON.stringify(kinds),
  )

  // 锚帧之二：距上一全量 30 秒
  const timeHub = new RemoteFrameHub({ now: () => clock, anchorFrames: 1000 })
  const timeKinds = []
  timeKinds.push(timeHub.build(snap([entry(1, 'a')])).full)
  clock += FULL_ANCHOR_MS - 1
  timeKinds.push(timeHub.build(snap([entry(1, 'b')])).full)
  clock += 1
  timeKinds.push(timeHub.build(snap([entry(1, 'c')])).full)
  check(
    `距上一全量不足 ${String(FULL_ANCHOR_MS / 1000)} 秒走增量，够 30 秒立刻补全量`,
    JSON.stringify(timeKinds) === JSON.stringify([true, false, true]),
    JSON.stringify(timeKinds),
  )

  // 锚帧之三：会话切换立刻全量
  const sessionHub = new RemoteFrameHub({ now: () => clock })
  sessionHub.build(snap([entry(1, 'a')]))
  check(
    '会话切换（sessionId 变号）立即发全量',
    sessionHub.build(snap([entry(1, 'a')], { sessionId: 's2' })).full === true,
  )

  // 环形缓冲与重连补帧
  const bufHub = new RemoteFrameHub({ now: () => clock, capacity: 4, anchorFrames: 1000 })
  const built = []
  for (let i = 0; i < 6; i += 1) built.push(bufHub.build(snap([entry(1, `第 ${String(i)} 版`)])))
  check(
    `环形缓冲只留最近 ${String(FRAME_BUFFER_SIZE)} 帧（这里容量调成 4 看得到滚动）`,
    bufHub.buffered === 4 && bufHub.oldestSeq === 3 && bufHub.newestSeq === 6,
    JSON.stringify({ buffered: bufHub.buffered, oldest: bufHub.oldestSeq, newest: bufHub.newestSeq }),
  )
  const resumed = bufHub.resume(3)
  check(
    'N 落在缓冲窗口内：按序补发 N 之后的所有帧，且是原样的 JSON 文本（重发不重算）',
    resumed !== null && resumed.length === 3 && resumed[0] === built[3].text && resumed[1] === built[4].text && resumed[2] === built[5].text,
    JSON.stringify(resumed?.length),
  )
  check('N 就是最新一帧时补发 0 帧（已经追上了）', (bufHub.resume(6) ?? null)?.length === 0)
  check('N 比缓冲里最老那帧还旧 → 接不上，回落全量（null）', bufHub.resume(2) === null)
  check('lastSeq 缺省或 0 → 要全量（null）', bufHub.resume(0) === null)
  check('N 比最新一帧还新（宿主重启过）→ 也回落全量，不能一帧不发', bufHub.resume(99) === null)
}

// ── 9. 上传：文件名安全化、落盘、配额淘汰 ──────────────────────────────────────
console.log('上传（文件名的安全化与配额）')
{
  const { RemoteUploads, safeUploadName, UPLOAD_MAX_BYTES, UPLOAD_QUOTA_BYTES } = await import(
    '../lib/core/remote/uploads.js'
  )
  check('单文件上限是 20MB、目录配额是 100MB', UPLOAD_MAX_BYTES === 20 * 1024 * 1024 && UPLOAD_QUOTA_BYTES === 100 * 1024 * 1024)
  check(
    '路径分隔符被剥掉（穿越攻击最后只剩文件名）',
    safeUploadName('../../evil.txt') === 'evil.txt' &&
      safeUploadName('..\\..\\Windows\\System32\\evil.exe') === 'evil.exe' &&
      safeUploadName('/etc/passwd') === 'passwd',
    JSON.stringify([safeUploadName('../../evil.txt'), safeUploadName('..\\..\\Windows\\System32\\evil.exe')]),
  )
  check(
    '控制字符与 Windows 非法字符被去掉',
    safeUploadName('a\u0000b<c>d:e"f|g?h*i.txt') === 'abcdefghi.txt',
    safeUploadName('a\u0000b<c>d:e"f|g?h*i.txt'),
  )
  check(
    '空名、纯点点、纯空白回落 upload',
    safeUploadName('') === 'upload' && safeUploadName('..') === 'upload' && safeUploadName('...') === 'upload' && safeUploadName('../..') === 'upload' && safeUploadName('   ') === 'upload',
    JSON.stringify([safeUploadName(''), safeUploadName('..'), safeUploadName('...'), safeUploadName('../..')]),
  )
  check(
    '扩展名保留、名字截到 80 字以内',
    safeUploadName('photo.PNG') === 'photo.PNG' && safeUploadName(`${'x'.repeat(200)}.txt`).length <= 84,
    safeUploadName(`${'x'.repeat(20)}.txt`),
  )
  check(
    'Windows 设备名被改写（CON / COM1 这些不能直接当文件名）',
    safeUploadName('CON') === '_CON' && safeUploadName('com1.txt') === '_com1.txt',
    JSON.stringify([safeUploadName('CON'), safeUploadName('com1.txt')]),
  )

  const dir = join(home, 'uploads-unit')
  const stamp = Date.UTC(2026, 0, 2, 3, 4, 5)
  const day = (at) => {
    const date = new Date(at)
    return `${String(date.getFullYear())}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  }
  const uploads = new RemoteUploads({ dir, now: () => stamp, quotaBytes: 300 })
  const saved = uploads.save('note.txt', Buffer.from('hello 远程', 'utf8'))
  check(
    '落盘成功：返回 path / size / name，目录按 yyyymmdd 分，文件名带 8 位随机前缀',
    saved.ok === true &&
      saved.size === Buffer.byteLength('hello 远程', 'utf8') &&
      saved.name === 'note.txt' &&
      saved.path.startsWith(join(dir, day(stamp))) &&
      /[0-9a-f]{8}-note\.txt$/.test(saved.path) &&
      readFileSync(saved.path, 'utf8') === 'hello 远程',
    JSON.stringify(saved),
  )
  const escaped = uploads.save('../../../evil.txt', Buffer.from('x'))
  check(
    '穿越文件名落盘后仍在当天目录里（没跑出 uploads 根）',
    escaped.ok === true && escaped.path.startsWith(join(dir, day(stamp))) && escaped.name === 'evil.txt' && !existsSync(join(home, 'evil.txt')),
    JSON.stringify(escaped),
  )
  const tooBig = uploads.save('big.bin', Buffer.alloc(UPLOAD_MAX_BYTES + 1))
  check('超过 20MB 直接拒（不落盘）', tooBig.ok === false && typeof tooBig.error === 'string', JSON.stringify(tooBig))

  // 配额：300 字节的目录，第三个 150 字节文件写进来时最旧那个要被淘汰
  const quotaDir = join(home, 'uploads-quota')
  const quota = new RemoteUploads({ dir: quotaDir, now: () => stamp, quotaBytes: 300 })
  const one = quota.save('one.bin', Buffer.alloc(150, 1))
  utimesSync(one.path, new Date(1_000_000), new Date(1_000_000))
  const two = quota.save('two.bin', Buffer.alloc(150, 2))
  utimesSync(two.path, new Date(2_000_000), new Date(2_000_000))
  const three = quota.save('three.bin', Buffer.alloc(150, 3))
  check(
    '超过目录配额时按最旧淘汰（writing 第三个 150B 之后第一个不见了）',
    three.ok === true && !existsSync(one.path) && existsSync(two.path) && existsSync(three.path) && quota.totalBytes() === 300,
    JSON.stringify({ total: quota.totalBytes(), files: quota.files().map((file) => file.path) }),
  )
  const tiny = new RemoteUploads({ dir: join(home, 'uploads-tiny'), now: () => stamp, quotaBytes: 10 })
  const only = tiny.save('only.bin', Buffer.alloc(20, 7))
  check('刚写下去的那个文件不会被这次淘汰带走（写前后各查一次）', only.ok === true && existsSync(only.path), JSON.stringify(only))
}

// ── 10. 浏览器推送：VAPID 密钥、订阅去重、失效订阅清理 ─────────────────────────
console.log('浏览器推送（Web Push）')
{
  const { RemotePush } = await import('../lib/core/remote/push.js')
  const dir = join(home, 'push-unit')
  const keysFile = join(dir, 'push-keys.json')
  const subsFile = join(dir, 'push-subs.json')
  const sent = []
  const failing = new Set()
  const push = new RemotePush({
    dir,
    now: () => 1_700_000_000_000,
    sender: async (subscription, payload) => {
      if (failing.has(subscription.endpoint)) {
        const error = new Error('订阅已经不在了')
        error.statusCode = 410
        throw error
      }
      sent.push({ endpoint: subscription.endpoint, payload })
    },
  })
  check('第一次用到才生成 VAPID 密钥（不是装上插件就生成）', !existsSync(keysFile))
  const publicKey = push.publicKey()
  check(
    'VAPID 密钥生成并原子落盘（公钥是 URL-safe base64）',
    publicKey !== null && publicKey.length > 80 && /^[A-Za-z0-9_-]+$/.test(publicKey) && existsSync(keysFile),
    publicKey ?? 'null',
  )
  const keyDoc = JSON.parse(readFileSync(keysFile, 'utf8'))
  check(
    'push-keys.json 里有 publicKey 与 privateKey，而且再读一次是同一份（不重新生成）',
    typeof keyDoc.publicKey === 'string' && typeof keyDoc.privateKey === 'string' && push.publicKey() === publicKey,
  )

  const sub1 = { endpoint: 'https://push.example/1', keys: { p256dh: 'p1', auth: 'a1' } }
  const sub2 = { endpoint: 'https://push.example/2', keys: { p256dh: 'p2', auth: 'a2' } }
  check('订阅入库（第一次是 added:true）', push.add(sub1, 'dev-1').added === true && push.count() === 1)
  const again = push.add(sub1, 'dev-1')
  check('同一个 endpoint 再来一次是更新不是新增（去重）', again.ok === true && again.added === false && again.total === 1)
  check('缺 keys.p256dh 的订阅被拒', push.add({ endpoint: 'https://push.example/3' }, 'dev-1').ok === false)
  check('缺 endpoint 的订阅被拒', push.add({ keys: { p256dh: 'p', auth: 'a' } }, 'dev-1').ok === false)
  push.add(sub2, 'dev-2')
  const subsDoc = JSON.parse(readFileSync(subsFile, 'utf8'))
  check(
    'push-subs.json 是数组，每条含 endpoint / keys / deviceId / createdAt',
    Array.isArray(subsDoc) &&
      subsDoc.length === 2 &&
      subsDoc[0].endpoint === 'https://push.example/1' &&
      subsDoc[0].keys.auth === 'a1' &&
      subsDoc[0].deviceId === 'dev-1' &&
      subsDoc[0].createdAt === 1_700_000_000_000,
    JSON.stringify(subsDoc),
  )
  const okSend = await push.send({ title: 'Muse Code 等待审批', body: 'write', url: 'http://127.0.0.1:17321/' })
  check(
    '发送走 sendNotification 那条路（这里注入假发送器）：两台各收一条',
    okSend.attempted === 2 && okSend.sent === 2 && okSend.dropped === 0 && sent.length === 2 && JSON.parse(sent[0].payload).title === 'Muse Code 等待审批',
    JSON.stringify(okSend),
  )
  failing.add('https://push.example/2')
  const dropped = await push.send({ title: 'x', body: 'y', url: 'z' })
  check(
    '404/410 的订阅当场从库里删掉（其余照发）',
    dropped.dropped === 1 && dropped.sent === 1 && push.count() === 1 && push.subscriptions()[0].endpoint === 'https://push.example/1',
    JSON.stringify({ dropped, count: push.count() }),
  )
  check('按 endpoint 退订', push.remove('https://push.example/1') === true && push.count() === 0 && push.remove('不存在的') === false)
  check('库里没有订阅时发送是空操作（不报错）', (await push.send({ title: 'x' })).attempted === 0)
}

// ── 11. 通知 Webhook：两种格式打到一个真的假服务上 ─────────────────────────────
console.log('通知 Webhook（Bark 占位符 GET / ntfy JSON POST）')
{
  const { createServer } = await import('node:http')
  const { sendWebhook, isHttpUrl, webhookHasPlaceholder } = await import('../lib/core/remote/notify.js')
  const received = []
  const fake = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
      if ((req.url ?? '').startsWith('/fail')) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('boom')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })
  })
  const fakePort = await new Promise((resolvePort) => fake.listen(0, '127.0.0.1', () => resolvePort(fake.address().port)))
  const base = `http://127.0.0.1:${String(fakePort)}`
  const message = { title: 'Muse Code 等待审批', body: 'write AGENTS.md', url: 'http://192.168.1.5:17321/' }

  const posted = await sendWebhook(`${base}/ntfy-topic`, message)
  const lastPost = received[received.length - 1]
  check(
    'URL 不带占位符 → POST JSON（ntfy 风格）',
    posted.ok === true && posted.mode === 'post' && lastPost.method === 'POST' && JSON.parse(lastPost.body).title === message.title && JSON.parse(lastPost.body).body === message.body && JSON.parse(lastPost.body).url === message.url,
    JSON.stringify(lastPost),
  )

  const got = await sendWebhook(`${base}/push/{title}/{body}?url={url}`, message)
  const lastGet = received[received.length - 1]
  const expectedPath =
    `/push/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}` +
    `?url=${encodeURIComponent(message.url)}`
  check(
    'URL 带占位符 → GET，且值先 encodeURIComponent 再替换（Bark 风格）',
    got.ok === true && got.mode === 'get' && lastGet.method === 'GET' && lastGet.url === expectedPath,
    `${String(lastGet.method)} ${String(lastGet.url)}`,
  )
  check(
    '占位符识别与地址校验是纯函数，设置页两处共用',
    webhookHasPlaceholder('https://x/{title}') === true && webhookHasPlaceholder('https://x/hook') === false &&
      isHttpUrl('https://x/y') === true && isHttpUrl('http://x/y') === true && isHttpUrl('javascript:alert(1)') === false && isHttpUrl('ftp://x/y') === false && isHttpUrl('x/y') === false,
  )

  const failed = await sendWebhook(`${base}/fail`, message)
  check('对面回 500 → ok:false（失败写 notice，不抛）', failed.ok === false && String(failed.error).includes('500'), JSON.stringify(failed))
  const refused = await sendWebhook('http://127.0.0.1:1/hook', message)
  check('连不上 → ok:false（不抛，宿主照常干活）', refused.ok === false && typeof refused.error === 'string', JSON.stringify(refused))
  const empty = await sendWebhook('   ', message)
  check('空地址 → ok:false', empty.ok === false)
  await new Promise((resolveClose) => fake.close(resolveClose))
}

// ── 12. HTTP + WS：上传路由、推送路由、全局 seq、lastSeq 补帧 ───────────────────
console.log('HTTP 与 WebSocket（上传 / 推送订阅 / 帧流）')
{
  const { createRemoteServer, REMOTE_PROTOCOL_VERSION } = await import('../lib/plugins/remote.js')
  const { RemoteUploads } = await import('../lib/core/remote/uploads.js')
  const { RemotePush } = await import('../lib/core/remote/push.js')
  const { request } = await import('node:http')
  const { WebSocket } = await import('ws')

  const stubPort = await freePort()
  const uploadDir = join(home, 'uploads-http')
  const pushDir = join(home, 'push-http')
  const uploads = new RemoteUploads({ dir: uploadDir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) })
  const pushStore = new RemotePush({ dir: pushDir, sender: async () => {} })
  const httpPairing = new RemotePairing({ dir: join(home, 'pairing-http') })
  const httpTickets = new TicketStore()
  let pushOn = false

  let snapshotState = {
    sessionId: 's1',
    cwd: 'D:\\dsc',
    status: { turnState: 'idle' },
    surfaces: {},
    sessions: [],
    sessionsLoading: false,
    entries: [{ id: 1, kind: 'text', text: '第一条' }],
    liveEntries: [],
  }
  const listeners = new Set()
  const server = createRemoteServer({
    port: stubPort,
    lan: false,
    // 节流调到最小：下面要连造 121 帧把环形缓冲滚一圈，靠它才跑得快
    throttleMs: 1,
    assetsDir: join(home, '没有这个目录'),
    pairing: httpPairing,
    tickets: httpTickets,
    uploads,
    invoke: async () => null,
    snapshot: () => snapshotState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notice: () => {},
    pushEnabled: () => pushOn,
    pushPublicKey: () => (pushOn ? pushStore.publicKey() : null),
    pushSubscribe: (payload, deviceId) => pushStore.add(payload, deviceId),
    pushUnsubscribe: (endpoint) => pushStore.remove(endpoint),
  })
  await server.ready
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }

  // 认一台设备：配对码换 token
  const issued = httpPairing.issueCode()
  const paired = httpPairing.verifyCode(issued?.code ?? '', '探针手机')
  const token = paired.ok === true ? paired.token : ''
  const auth = { authorization: `Bearer ${token}` }

  check('hello 报的协议版本是 3', REMOTE_PROTOCOL_VERSION === 3, String(REMOTE_PROTOCOL_VERSION))
  check('推送关着时 push-key 返回 publicKey:null', (await httpCall(stubPort, '/api/push-key', { requestModule: request })).body.includes('"publicKey":null'))
  const subOff = await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth, requestModule: request })
  check('推送关着时订阅端点回 403', subOff.status === 403, `${String(subOff.status)} ${subOff.body}`)
  const unsubOff = await httpCall(stubPort, '/api/push-unsubscribe', { method: 'POST', headers: auth, requestModule: request })
  check('推送关着时退订端点也回 403', unsubOff.status === 403, String(unsubOff.status))

  pushOn = true
  const pushKey = JSON.parse((await httpCall(stubPort, '/api/push-key', { requestModule: request })).body)
  check('推送开着时 push-key 给出 VAPID 公钥（不要 token）', pushKey.ok === true && typeof pushKey.publicKey === 'string' && pushKey.publicKey.length > 80, JSON.stringify(pushKey))
  const subNoAuth = await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', requestModule: request })
  check('订阅端点要设备 token（没有 → 401）', subNoAuth.status === 401, String(subNoAuth.status))
  const subscription = JSON.stringify({ endpoint: 'https://push.example/mobile', keys: { p256dh: 'pp', auth: 'aa' } })
  const sub1 = JSON.parse((await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth, body: subscription, requestModule: request })).body)
  const sub2 = JSON.parse((await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth, body: subscription, requestModule: request })).body)
  check(
    '订阅入库：第一次 added:true，同一个 endpoint 再来一次 added:false（总数还是 1）',
    sub1.ok === true && sub1.added === true && sub1.total === 1 && sub2.ok === true && sub2.added === false && sub2.total === 1,
    JSON.stringify([sub1, sub2]),
  )
  const unsub = JSON.parse((await httpCall(stubPort, '/api/push-unsubscribe', { method: 'POST', headers: auth, body: JSON.stringify({ endpoint: 'https://push.example/mobile' }), requestModule: request })).body)
  check('退订删掉那一条（removed:true）', unsub.ok === true && unsub.removed === true && pushStore.count() === 0, JSON.stringify(unsub))

  // 上传路由
  const noAuth = await httpCall(stubPort, '/api/upload?filename=a.txt', { method: 'POST', requestModule: request })
  check('上传不带 token → 401', noAuth.status === 401, String(noAuth.status))
  const noName = await httpCall(stubPort, '/api/upload', { method: 'POST', headers: auth, body: 'x', requestModule: request })
  check('上传不带 filename → 400', noName.status === 400, String(noName.status))
  const uploaded = JSON.parse(
    (await httpCall(stubPort, `/api/upload?filename=${encodeURIComponent('../../照片 1.png')}`, {
      method: 'POST',
      headers: auth,
      body: Buffer.from('PNG 假数据', 'utf8'),
      requestModule: request,
    })).body,
  )
  check(
    '上传成功：200 + {ok,path,size,name}，穿越文件名被安全化后落在 uploads 里',
    uploaded.ok === true &&
      uploaded.size === Buffer.byteLength('PNG 假数据', 'utf8') &&
      uploaded.name === '照片 1.png' &&
      uploaded.path.startsWith(uploadDir) &&
      readFileSync(uploaded.path, 'utf8') === 'PNG 假数据',
    JSON.stringify(uploaded),
  )
  const overLimit = await httpCall(stubPort, '/api/upload?filename=huge.bin', {
    method: 'POST',
    headers: auth,
    body: Buffer.alloc(20 * 1024 * 1024 + 1, 1),
    requestModule: request,
  })
  check('上传超过 20MB → 413（这条路由不受 64KB 上限约束，20MB 才拦）', overLimit.status === 413, `${String(overLimit.status)} ${overLimit.body}`)

  // WS：全局 seq 跨连接连续
  const openWs = (lastSeq) =>
    new Promise((resolveWs, rejectWs) => {
      const ticket = httpTickets.issue('dev-1')
      const suffix = lastSeq === undefined ? '' : `&lastSeq=${String(lastSeq)}`
      const socket = new WebSocket(`ws://127.0.0.1:${String(stubPort)}/ws?ticket=${encodeURIComponent(ticket)}${suffix}`)
      const frames = []
      socket.on('message', (data) => {
        frames.push({ text: String(data), frame: JSON.parse(String(data)) })
      })
      socket.on('open', () => resolveWs({ socket, frames }))
      socket.on('error', rejectWs)
    })
  const newestSeq = (client) => {
    let newest = 0
    for (const item of client.frames) if (typeof item.frame.seq === 'number' && item.frame.seq > newest) newest = item.frame.seq
    return newest
  }
  const frameOf = (client, seq) => client.frames.find((item) => item.frame.seq === seq)

  const first = await openWs()
  await waitFor(() => newestSeq(first) >= 1, '第一帧')
  const hello1 = first.frames[0].frame
  check(
    'hello：协议版本 3、端口、开放方法清单、pushPublicKey（推送开着 → 公钥字符串）',
    hello1.type === 'hello' && hello1.protocolVersion === 3 && hello1.port === stubPort && Array.isArray(hello1.methods) && hello1.methods.includes('submit') && typeof hello1.pushPublicKey === 'string' && hello1.pushPublicKey.length > 80,
    JSON.stringify({ ...hello1, methods: hello1.methods.length, pushPublicKey: String(hello1.pushPublicKey).slice(0, 12) }),
  )
  check('不带 lastSeq 的新连接：hello 之后紧跟一帧全量', frameOf(first, 1)?.frame.full === true && frameOf(first, 1)?.frame.type === 'snapshot')

  let sawSeq1 = newestSeq(first)
  const second = await openWs()
  await waitFor(() => newestSeq(second) > sawSeq1, '第二条连接触发的新帧')
  const forced = newestSeq(second)
  check(
    '全局 seq 跨连接连续：第二条连接把帧号接着往下推（不是各自从 1 数）',
    forced === sawSeq1 + 1 && frameOf(second, forced)?.frame.full === true,
    JSON.stringify({ first: sawSeq1, second: forced }),
  )
  // 两条连接各自一个 socket，帧到达的先后不一定：先等第一条也收到这一帧
  const seenByFirst = await waitFor(() => frameOf(first, forced) !== undefined, '第一条连接收到同一帧')
  check(
    '同一串帧发给所有连接（第一条连接也收到了第二条连接触发的那一帧，内容逐字节相同）',
    seenByFirst && frameOf(first, forced).text === frameOf(second, forced).text,
  )

  // 增量帧：改快照 → 下一帧是 delta，新条目进 added
  snapshotState = { ...snapshotState, entries: [...snapshotState.entries, { id: 2, kind: 'text', text: '第二条' }] }
  emit()
  const deltaSeq = forced + 1
  const deltaOk = await waitFor(() => frameOf(second, deltaSeq) !== undefined, 'delta 帧')
  const delta = frameOf(second, deltaSeq)?.frame
  check(
    '会话变化推的是增量帧（type=delta，added 里是那条新条目）',
    deltaOk && delta?.type === 'delta' && delta.full === false && delta.added.length === 1 && delta.added[0].id === 2 && delta.meta.sessionId === 's1',
    JSON.stringify(delta).slice(0, 200),
  )

  // lastSeq 重连补帧：窗口内照原样补
  const lastSeen = newestSeq(second)
  second.socket.close()
  await sleep(20)
  emit()
  const afterOne = await waitFor(() => newestSeq(first) > lastSeen, '断开期间第一帧')
  const midSeq = newestSeq(first)
  emit()
  const afterTwo = await waitFor(() => newestSeq(first) > midSeq, '断开期间第二帧')
  const topSeq = newestSeq(first)
  check('拔掉一条连接之后帧流继续前进（另一条还连着）', afterOne && afterTwo && topSeq === lastSeen + 2, JSON.stringify({ lastSeen, topSeq }))

  const third = await openWs(lastSeen)
  const replayed = await waitFor(() => newestSeq(third) >= topSeq, '补帧')
  const replayedFrames = third.frames.filter((item) => item.frame.type !== 'hello')
  check(
    'N 落在窗口内：补发 N 之后的所有缓冲帧，seq 与原帧一一对应',
    replayed && replayedFrames.length === 2 && replayedFrames[0].frame.seq === lastSeen + 1 && replayedFrames[1].frame.seq === lastSeen + 2,
    JSON.stringify(replayedFrames.map((item) => item.frame.seq)),
  )
  check(
    '补的是原样的 JSON 文本（重发不重算：与当时发给另一条连接的字节一致）',
    replayedFrames[0].text === frameOf(first, lastSeen + 1)?.text && replayedFrames[1].text === frameOf(first, lastSeen + 2)?.text,
  )
  emit()
  const liveSeq = topSeq + 1
  const live = await waitFor(() => frameOf(third, liveSeq) !== undefined, '补完转实时')
  check('补完帧之后转实时（后续新帧照常收到）', live && frameOf(third, liveSeq)?.frame.type === 'delta')

  // 环形缓冲：连造 121 帧，把最老那帧挤出窗口，然后用窗口外的 lastSeq 重连
  let rolled = newestSeq(first)
  for (let i = 0; i < 121; i += 1) {
    emit()
    const before = rolled
    const advanced = await waitFor(() => newestSeq(first) > before, `第 ${String(i + 1)} 帧`)
    if (!advanced) break
    rolled = newestSeq(first)
  }
  check(
    `连造 121 帧后缓冲滚过最老那帧（最新 seq = ${String(rolled)}，缓冲仍是 120 帧）`,
    rolled >= liveSeq + 121,
    String(rolled),
  )
  const outside = await openWs(1)
  await waitFor(() => newestSeq(outside) >= rolled + 1, '窗口外回落')
  const outsideFrames = outside.frames.filter((item) => item.frame.type !== 'hello')
  check(
    'lastSeq 在缓冲窗口之外 → 回落 hello + 一帧全量（不是一帧不发）',
    outsideFrames.length >= 1 && outsideFrames[0].frame.full === true && outsideFrames[0].frame.type === 'snapshot',
    JSON.stringify(outsideFrames.map((item) => ({ seq: item.frame.seq, full: item.frame.full, type: item.frame.type }))),
  )

  // 一条连接都没有时发生的变化：重连要补一帧全量对上
  for (const client of [first, third, outside]) client.socket.close()
  await sleep(30)
  emit()
  emit()
  const back = await openWs(rolled)
  const caught = await waitFor(() => frameOf(back, rolled + 2) !== undefined, '断线期间变化的全量补救')
  check(
    '一条连接都没有时发生的变化：重连补完缓冲帧之后必须再补一帧全量',
    caught && frameOf(back, rolled + 2)?.frame.full === true,
    JSON.stringify(back.frames.map((item) => ({ seq: item.frame.seq, type: item.frame.type, full: item.frame.full }))),
  )
  back.socket.close()
  server.close()
}


console.log(`\n${String(total - failures)}/${String(total)} 通过`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`隔离的 HOME 留在 ${home}（失败现场，方便翻 pending.json 与 devices.json）`)
process.exit(failures === 0 ? 0 : 1)
