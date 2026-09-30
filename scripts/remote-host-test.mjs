/**
 * 远程控制的单元探针：不起宿主、不联网，直接验数据层与两块纯逻辑。
 *
 * 覆盖：
 *   - 偏好：合法值 / 非法值（回落或夹取）/ 未知键（不搬进来）/ writePrefs 深合并
 *   - 配对：正确码换 token、错码 5 次锁 1 小时、过期码、明文码与明文 token 都不落盘、
 *           码一次性、吊销以后 token 不认
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const { RemotePairing, CODE_ALPHABET, CODE_LENGTH, CODE_TTL_MS, MAX_CODE_ATTEMPTS } = await import(
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

const pendingText = readFileSync(join(pairDir, 'pending.json'), 'utf8')
check('pending.json 里没有明文码（只有盐与哈希）', issued !== null && !pendingText.includes(issued.code))
check('pending.json 里存的是 sha256（64 位十六进制）', /"hash": "[0-9a-f]{64}"/.test(pendingText))

const wrong = pairing.verifyCode('ZZZZZZZZ', '我的手机')
check('错码返回 401', wrong.ok === false && wrong.status === 401, JSON.stringify(wrong))
for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) pairing.verifyCode('ZZZZZZZZ', '我的手机')
const locked = pairing.verifyCode(issued?.code ?? '', '我的手机')
check(
  `连错 ${String(MAX_CODE_ATTEMPTS)} 次之后锁 1 小时：连对的码也进不来（429）`,
  locked.ok === false && locked.status === 429,
  JSON.stringify(locked),
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

// 过期：注入假钟，码有效 1 小时
let clock = 1_000_000
const timeMachine = new RemotePairing({ dir: join(home, 'pairing-expire'), now: () => clock })
const expiring = timeMachine.issueCode()
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
{
  const { createRemoteServer } = await import('../lib/plugins/remote.js')
  const { createServer, request } = await import('node:http')
  // 由系统挑一个空闲端口：写死端口会和别人撞
  const stubPort = await new Promise((resolvePort) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolvePort(port))
    })
  })
  const served = []
  const server = createRemoteServer({
    port: stubPort,
    lan: false,
    throttleMs: 80,
    // 指到一个不存在的目录：界面还没构建时走的就是这一条
    assetsDir: join(home, '没有这个目录'),
    pairing,
    tickets,
    invoke: async () => null,
    snapshot: () => ({ sessionId: 's', cwd: 'c', entries: [], liveEntries: [], status: {}, surfaces: {}, sessions: [], sessionsLoading: false }),
    subscribe: () => () => {},
    notice: (text) => served.push(text),
  })
  await server.ready
  const get = (path, host) =>
    new Promise((resolveGet, rejectGet) => {
      const req = request({ host: '127.0.0.1', port: stubPort, path, headers: host === undefined ? {} : { host } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolveGet({ status: res.statusCode, body: text }))
      })
      req.on('error', rejectGet)
      req.end()
    })
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

console.log(`\n${String(total - failures)}/${String(total)} 通过`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`隔离的 HOME 留在 ${home}（失败现场，方便翻 pending.json 与 devices.json）`)
process.exit(failures === 0 ? 0 : 1)
