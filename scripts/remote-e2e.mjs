/**
 * 远程控制的全链探针：在一个隔离的 HOME 里真拉起 headless 宿主，然后像手机那样
 * 走 HTTP 配对 + WebSocket 遥控，把宿主半边整条链验一遍（协议 v3）。
 *
 * 覆盖：
 *   - 静态页与 Host 检查（占位页 200 / 域名 Host 403 / 端口不符 403）
 *   - 配对：错码 5 次锁 1 小时（429）→ 重新生成 → 换到 token + deviceId；64KB 请求体上限
 *   - 票据：无 token 401 / 假票据 401 / 域名 Host 升级 403 / 一次性
 *   - WS v3：hello（protocolVersion 3 + pushPublicKey）+ 首发全量；submit 之后推增量帧
 *     （新条目在 added 里），客户端按 id 合并之后能看到
 *   - 断线重连：带 &lastSeq=N 补发断开期间错过的帧（逐字节与原帧一致）再转实时；
 *     lastSeq=0 / 没带 = 要全量
 *   - 上传：POST /api/upload 落盘一个文本文件 → submit 带上这个路径 → 路径进了会话流
 *   - 推送：预先粘好通知 Webhook → 制造 pendingApproval → 假服务收到 POST JSON（ntfy 风格）
 *     → 答完之后这一轮结束 → 再收一条「轮完成」
 *   - 推送路由：push 开关打开后 GET /api/push-key 给公钥、订阅入库、退订删除
 *   - 审批：模型要写受保护文件 → 卡片进快照 → 从浏览器答一次 → 审计里 source='web'
 *   - 白名单外的方法被拒；设置页拒收非 http(s) 的 Webhook 地址
 *   - 设备清单：每台设备两行（info + 吊销按钮），单独吊销一台 → 连接当场断开、清单少一台
 *   - 主控位：第二个宿主进程抢不到，只休眠
 *   - 启停：enabled 改 false → 端口不再监听、WS 连接被断开
 *
 * 假模型端点由本脚本自己起（OpenAI 兼容 SSE，不联网、不花钱），这样「审批卡」这条路
 * 才有真实的工具调用来触发——没有模型就没人去调 write。假 Webhook 服务同理。
 *
 * 运行：pnpm build && node scripts/remote-e2e.mjs
 *
 * @module dsc/scripts/remote-e2e
 */
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'

/** 隔离的家目录：用户真实的 ~/.dsc 一个字节都不写（惯例照 desktop/shots/*-seed.mjs）。 */
const home = 'D:\\dsc\\scripts\\.remote-e2e-home'
const repo = 'D:\\dsc'

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把一个目录下所有文本文件拼起来（用来确认某个字符串没有落盘）。 */
function collectText(dir) {
  let out = ''
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out += collectText(full)
    else out += readFileSync(full, 'utf8')
  }
  return out
}

/** 由系统挑一个空闲端口（先 listen 0 再关掉，紧接着给宿主用）。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createHttpServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 手机端的帧重放：全量帧覆盖，增量帧按条目 id 合并。
 *
 * 断言不能直接看 `frame.entries`——协议 v3 里只有全量帧带 entries，增量帧给的是
 * added / updated / removedIds。这一份就是「客户端该怎么消费」的可执行说明。
 */
function makeView() {
  const state = { seq: 0, sessionId: null, cwd: null, entries: [], liveEntries: [], meta: {} }
  return {
    state,
    apply(frame) {
      if (frame.type === 'snapshot') {
        state.seq = frame.seq
        state.sessionId = frame.sessionId
        state.cwd = frame.cwd
        state.entries = frame.entries
        state.liveEntries = frame.liveEntries ?? []
        state.meta = frame
      } else if (frame.type === 'delta') {
        state.seq = frame.seq
        const byId = new Map(state.entries.map((entry) => [entry.id, entry]))
        for (const entry of frame.added ?? []) byId.set(entry.id, entry)
        for (const entry of frame.updated ?? []) byId.set(entry.id, entry)
        for (const id of frame.removedIds ?? []) byId.delete(id)
        state.entries = [...byId.values()]
        state.liveEntries = frame.liveEntries ?? []
        state.meta = frame.meta ?? {}
        state.sessionId = state.meta.sessionId ?? state.sessionId
      }
    },
  }
}

const remotePort = await freePort()
const llmPort = await freePort()
const webhookPort = await freePort()
const probeTarget = join(home, 'AGENTS.md')
const auditFile = join(home, '.dsc', 'audit.jsonl')
const settingsFile = join(home, '.dsc', 'settings.json')
const webhookUrl = `http://127.0.0.1:${String(webhookPort)}/hook`

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc'), { recursive: true })
// Chromium 之类会去 %USERPROFILE%\AppData\Roaming 找配置；隔离目录按惯例先建好
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 远程控制 e2e 专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: e2e 假端点
    baseURL: http://127.0.0.1:${String(llmPort)}/v1
    apiKeyEnv: E2E_FAKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)
writeFileSync(
  settingsFile,
  `${JSON.stringify({ remote: { enabled: true, port: remotePort, lan: false } }, null, 2)}\n`,
  'utf8',
)

// ── 假模型端点：第一跳吐思考 + 正文 + 一次 write 工具调用（目标就是受保护文件） ──
const fakeLlm = createHttpServer((req, res) => {
  if (!(req.url ?? '').endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('fake: 只有 /chat/completions')
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    void (async () => {
      const secondHop = body.includes('"role":"tool"') || body.includes('"role": "tool"')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
      if (!secondHop) {
        // 思考分几段吐：宿主那边会折成「直播尾」，快照的 liveEntries 因此有内容可看，
        // 也顺便让这段直播多推出几帧（断线重连那条用例要靠它）
        for (const piece of ['先看', '一眼', '工作目录', '里的说明书']) {
          delta({ reasoning_content: piece })
          await sleep(180)
        }
        delta({ content: '我要改一下 AGENTS.md。' })
        await sleep(120)
        delta(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_write',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ file_path: probeTarget, content: '# e2e\n' }),
                },
              },
            ],
          },
          'tool_calls',
        )
        await sleep(80)
        send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 11, completion_tokens: 2 } })
      } else {
        delta({ reasoning_content: '被拒了，就此打住。' })
        await sleep(120)
        delta({ content: '好的，那我不动它。' })
        delta({}, 'stop')
        send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 22, completion_tokens: 3 } })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })().catch(() => {
      try {
        res.end()
      } catch {
        // 对端可能已经断了
      }
    })
  })
})
await new Promise((resolve) => fakeLlm.listen(llmPort, '127.0.0.1', resolve))

// ── 假 Webhook 服务：宿主推送打到这里来（ntfy 那种 POST JSON；也认 Bark 那种 GET） ──
const webhookHits = []
const fakeWebhook = createHttpServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    webhookHits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
  })
})
await new Promise((resolve) => fakeWebhook.listen(webhookPort, '127.0.0.1', resolve))

// ── 宿主进程（headless：stdio 协议就是桌面壳那一侧） ─────────────────────────
function startHost(label) {
  const child = spawn(process.execPath, ['lib/headless.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // 假端点的 key：provider 没有非空 key 时读配置会直接丢掉这个端点
      E2E_FAKE_KEY: 'e2e-fake-key',
      DSC_RESUME_SESSION: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { child, label, messages: [], stderr: '', buffer: '' }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk
    for (;;) {
      const index = state.buffer.indexOf('\n')
      if (index < 0) break
      const line = state.buffer.slice(0, index).trim()
      state.buffer = state.buffer.slice(index + 1)
      if (line === '') continue
      try {
        state.messages.push(JSON.parse(line))
      } catch {
        // 非 JSON 行（启动警告之类）忽略
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk
  })
  return state
}

/** 等一条满足条件的协议消息（先翻历史，再等新的）。 */
async function waitMessage(state, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = state.messages.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`${state.label} 等不到：${label}`)
    await sleep(40)
  }
}

let nextInvokeId = 1
/** 经 stdio 调 DscRuntime 的一个方法（桌面壳那条路）。 */
async function hostInvoke(state, method, args) {
  const id = nextInvokeId
  nextInvokeId += 1
  state.child.stdin.write(`${JSON.stringify({ type: 'invoke', id, method, args })}\n`)
  const message = await waitMessage(
    state,
    (item) => item.type === 'result' && item.id === id,
    `${method} 的应答`,
  )
  return message
}

function stopHost(state) {
  return new Promise((resolve) => {
    if (state.child.exitCode !== null) return resolve()
    state.child.once('close', resolve)
    try {
      state.child.stdin.write('{"type":"exit"}\n')
    } catch {
      // 已经退出了
    }
    setTimeout(() => {
      try {
        state.child.kill()
      } catch {
        // 已经退出了
      }
      resolve()
    }, 3000)
  })
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────────
function httpCall(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: remotePort,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.body === undefined ? {} : { 'content-length': Buffer.byteLength(options.body) }),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(options.body ?? undefined)
  })
}

/** 开一条 WS：攒下每条帧的原文与解析结果，并把它们喂给一个重放视图。 */
function openSocket(ticketOrUrl, wsOptions = {}) {
  const url = ticketOrUrl.startsWith('ws:')
    ? ticketOrUrl
    : `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(ticketOrUrl)}`
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsOptions)
    const frames = []
    const raws = []
    const view = makeView()
    socket.on('message', (data) => {
      const text = String(data)
      try {
        const frame = JSON.parse(text)
        frames.push(frame)
        raws.push(text)
        view.apply(frame)
      } catch {
        // 不认识的帧忽略
      }
    })
    socket.on('open', () => resolve({ socket, frames, raws, view }))
    socket.on('error', (error) => reject(error))
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${String(res.statusCode)}`)))
  })
}

/** 试一次升级，只回「成没成」，用来验拒绝那几条路。 */
function trySocket(ticketOrUrl, wsOptions = {}) {
  const url = ticketOrUrl.startsWith('ws:')
    ? ticketOrUrl
    : `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(ticketOrUrl)}`
  return new Promise((resolve) => {
    const socket = new WebSocket(url, wsOptions)
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    socket.on('open', () => {
      try {
        socket.close()
      } catch {
        // 已经断了
      }
      settle({ ok: true })
    })
    socket.on('error', (error) => settle({ ok: false, error: error.message }))
    socket.on('unexpected-response', (_req, res) => settle({ ok: false, error: `HTTP ${String(res.statusCode)}` }))
  })
}

/** 等一帧满足条件的帧。 */
async function waitFrame(frames, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = frames.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等不到帧：${label}`)
    await sleep(40)
  }
}

/** 等客户端重放视图满足条件（增量帧合并之后的样子）。 */
async function waitState(client, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(client.view.state)) return true
    if (Date.now() > deadline) throw new Error(`等不到视图状态：${label}`)
    await sleep(40)
  }
}

/** 等假 Webhook 服务收到一条满足条件的推送。 */
async function waitWebhook(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = webhookHits.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等不到 Webhook：${label}（收到 ${String(webhookHits.length)} 条）`)
    await sleep(50)
  }
}

const host = startHost('宿主')
let mobile = null
let keeper = null
let secondHost = null

try {
  // ── 1. 宿主起来了 ──────────────────────────────────────────────────────────
  console.log('宿主启动与静态页')
  await waitMessage(host, (item) => item.type === 'hello', 'hello 握手')
  const action = await hostInvoke(host, 'runSettingAction', ['remote', 'regenerate-code'])
  check('宿主挂载了「远程控制」设置分区，能生成配对码', action.ok === true, JSON.stringify(action))
  const codeMatch = /配对码：([A-Z2-9]{8})/.exec(action.ok === true ? String(action.value?.notice ?? '') : '')
  check('分区动作把 8 位配对码放在提示里（码只从设置页出去）', codeMatch !== null, JSON.stringify(action.value))

  const values = await hostInvoke(host, 'getSectionValues', ['remote'])
  check(
    '设置分区读得出开关 / 端口 / 局域网 / 推送 / Webhook 五项',
    values.ok === true &&
      values.value?.enabled === true &&
      values.value?.port === remotePort &&
      values.value?.push === false &&
      values.value?.notifyWebhook === '',
    JSON.stringify(values),
  )

  const badHook = await hostInvoke(host, 'setSettingValue', ['remote', 'notifyWebhook', 'javascript:alert(1)'])
  check(
    '设置页拒收非 http(s) 的 Webhook 地址（分区的 save 抛错，值没写进去）',
    badHook.ok === true && badHook.value?.ok === false && String(badHook.value?.error ?? '').includes('http'),
    JSON.stringify(badHook.value),
  )
  const setHook = await hostInvoke(host, 'setSettingValue', ['remote', 'notifyWebhook', webhookUrl])
  check('设置页存得下通知 Webhook（不带占位符 = ntfy 那种 POST JSON）', setHook.value?.ok === true, JSON.stringify(setHook.value))

  const page = await httpCall('/')
  const builtIndex = existsSync(join(repo, 'lib', 'remote', 'assets', 'index.html'))
  check(
    builtIndex ? 'GET / 把界面产物（index.html）伺服出去' : 'GET / 返回「资产未构建」占位页',
    page.status === 200 && (builtIndex ? page.body.includes('<div id="root"') : page.body.includes('资产未构建')),
    `${String(page.status)} ${page.body.slice(0, 80)}`,
  )
  if (builtIndex) {
    const assetName = /<script[^>]+src="\.\/([^"]+)"/.exec(page.body)?.[1] ?? ''
    const asset = await httpCall(`/${assetName}`)
    check(
      '静态资源按文件名伺服，Content-Type 认得出来',
      assetName !== '' && asset.status === 200 && String(asset.headers['content-type']).includes('javascript'),
      `${assetName} → ${String(asset.status)} ${String(asset.headers['content-type'])}`,
    )
  }
  const traversal = await httpCall('/%2e%2e/package.json')
  check('目录穿越被挡住（assets 目录之外一律 404）', traversal.status === 404, String(traversal.status))
  const badHost = await httpCall('/', { host: `evil.example.com:${String(remotePort)}` })
  check('Host 是域名时 403（DNS rebinding 挡在门口）', badHost.status === 403, String(badHost.status))
  const badPort = await httpCall('/', { host: '127.0.0.1:1' })
  check('Host 端口不符时 403', badPort.status === 403, String(badPort.status))

  // ── 2. 配对 ────────────────────────────────────────────────────────────────
  console.log('配对码 → 设备 token')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await httpCall('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ', name: '坏手机' }),
    })
    if (attempt < 4) check(`第 ${String(attempt + 1)} 次错码 401`, wrong.status === 401, String(wrong.status))
    else check('第 5 次错码仍然是 401', wrong.status === 401, String(wrong.status))
  }
  const locked = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeMatch?.[1] ?? '', name: '我的手机' }),
  })
  check('连错 5 次之后连对的码也被锁（429）', locked.status === 429, `${String(locked.status)} ${locked.body}`)

  const again = await hostInvoke(host, 'runSettingAction', ['remote', 'regenerate-code'])
  const freshCode = /配对码：([A-Z2-9]{8})/.exec(again.ok === true ? String(again.value?.notice ?? '') : '')?.[1] ?? ''
  check('被锁之后还能重新生成一张码', freshCode !== '' && freshCode !== codeMatch?.[1], freshCode)

  const pair = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: freshCode, name: '我的手机', deviceName: '我的手机' }),
  })
  const pairBody = JSON.parse(pair.body)
  const token = String(pairBody.token ?? '')
  check('对的码换到 token 与 deviceId', pair.status === 200 && typeof pairBody.token === 'string' && pairBody.deviceId !== '', pair.body)

  const tooBig = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: freshCode, name: 'x'.repeat(70 * 1024) }),
  })
  check('请求体超过 64KB 被拒（413）', tooBig.status === 413, `${String(tooBig.status)} ${tooBig.body}`)

  // ── 3. 票据 ────────────────────────────────────────────────────────────────
  console.log('一次性 WS 票据')
  const noAuth = await httpCall('/api/ticket', { method: 'POST' })
  check('不带 token 取票 401', noAuth.status === 401, String(noAuth.status))
  const badToken = await httpCall('/api/ticket', { method: 'POST', headers: { authorization: 'Bearer not-a-real-token' } })
  check('token 不认时取票 401', badToken.status === 401, String(badToken.status))

  /** 用当前设备 token 换一张一次性票据。 */
  const takeTicket = async (deviceToken) => {
    const res = await httpCall('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${deviceToken}` } })
    return { status: res.status, ticket: JSON.parse(res.body).ticket }
  }
  const firstTicket = await takeTicket(token)
  check('带对的 token 取到票据', firstTicket.status === 200 && typeof firstTicket.ticket === 'string' && firstTicket.ticket !== '')

  const bogus = await trySocket('不是票据')
  check('假票据升级被拒（401）', bogus.ok === false && bogus.error.includes('401'), JSON.stringify(bogus))
  const evilUpgrade = await trySocket(
    `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(firstTicket.ticket)}`,
    { headers: { host: `evil.example.com:${String(remotePort)}` } },
  )
  check('升级请求的 Host 是域名时被拒（403）', evilUpgrade.ok === false && evilUpgrade.error.includes('403'), JSON.stringify(evilUpgrade))

  // ── 4. WS：hello v3 + 首发全量 ─────────────────────────────────────────────
  console.log('WebSocket 会话')
  mobile = await openSocket(firstTicket.ticket)
  const hello = await waitFrame(mobile.frames, (frame) => frame.type === 'hello', 'hello')
  check(
    'hello 报了协议版本 3、端口、开放方法清单、pushPublicKey（推送没开 → null）',
    hello.protocolVersion === 3 &&
      hello.port === remotePort &&
      Array.isArray(hello.methods) &&
      hello.methods.includes('submit') &&
      hello.pushPublicKey === null,
    JSON.stringify({ ...hello, methods: hello.methods.length, pushPublicKey: String(hello.pushPublicKey) }),
  )
  const first = await waitFrame(mobile.frames, (frame) => frame.type === 'snapshot', '首发全量')
  check(
    '不带 lastSeq 的新连接：hello 之后紧跟一帧全量（full:true，字段铺平）',
    first.full === true &&
      first.seq >= 1 &&
      typeof first.cwd === 'string' &&
      first.cwd !== '' &&
      typeof first.sessionId === 'string' &&
      Array.isArray(first.entries) &&
      Array.isArray(first.liveEntries) &&
      typeof first.status === 'object' &&
      first.surfaces !== null,
    JSON.stringify({ seq: first.seq, full: first.full, cwd: first.cwd, sessionId: first.sessionId }),
  )

  const reuse = await trySocket(firstTicket.ticket)
  check('同一张票据不能再用第二次（一次性）', reuse.ok === false, JSON.stringify(reuse))

  // ── 5. 白名单 ──────────────────────────────────────────────────────────────
  const blockedCall = await new Promise((resolve) => {
    const id = 'blocked-1'
    mobile.frames.length = 0
    mobile.socket.send(JSON.stringify({ type: 'invoke', id, method: 'saveProvider', args: [{ name: 'x' }] }))
    void waitFrame(mobile.frames, (frame) => frame.type === 'result' && frame.id === id, '被拒的应答', 5000).then(resolve, () => resolve(null))
  })
  check(
    '白名单外的 saveProvider 被拒（带原因）',
    blockedCall !== null && blockedCall.ok === false && String(blockedCall.error).includes('不开放'),
    JSON.stringify(blockedCall),
  )

  // ── 6. 上传：真落盘，再把路径交给会话 ──────────────────────────────────────
  console.log('上传一个文本文件')
  const uploadBody = '这是从手机传上来的笔记\n第二行\n'
  const uploadNoToken = await httpCall('/api/upload?filename=x.txt', { method: 'POST', body: 'x' })
  check('上传不带 token → 401', uploadNoToken.status === 401, String(uploadNoToken.status))
  const uploadRes = await httpCall(`/api/upload?filename=${encodeURIComponent('../../笔记 1.txt')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
    body: uploadBody,
  })
  const uploaded = JSON.parse(uploadRes.body)
  check(
    'POST /api/upload 落盘一个文本文件（200 + path/size/name，文件名已安全化）',
    uploadRes.status === 200 &&
      uploaded.ok === true &&
      uploaded.size === Buffer.byteLength(uploadBody, 'utf8') &&
      uploaded.name === '笔记 1.txt' &&
      readFileSync(uploaded.path, 'utf8') === uploadBody,
    uploadRes.body,
  )
  check(
    '上传落在隔离 HOME 的 uploads 目录里（按天分目录，真实 ~/.dsc 不碰）',
    uploaded.path.startsWith(join(home, '.dsc', 'remote', 'uploads')) && /[\\/]\d{8}[\\/][0-9a-f]{8}-/.test(uploaded.path),
    uploaded.path,
  )

  // ── 7. submit：推的是增量帧 ────────────────────────────────────────────────
  console.log('submit 与增量帧')
  const submitId = 'submit-1'
  mobile.frames.length = 0
  mobile.raws.length = 0
  const submitText = `刚用手机传上来一个文件，路径是 ${uploaded.path}，读一下它。`
  mobile.socket.send(JSON.stringify({ type: 'invoke', id: submitId, method: 'submit', args: [submitText] }))
  const submitResult = await waitFrame(
    mobile.frames,
    (frame) => frame.type === 'result' && frame.id === submitId,
    'submit 的应答',
  )
  check('submit 调得通', submitResult.ok === true, JSON.stringify(submitResult))
  const addedFrame = await waitFrame(
    mobile.frames,
    (frame) =>
      frame.type === 'delta' &&
      Array.isArray(frame.added) &&
      frame.added.some((entry) => entry.kind === 'user' && String(entry.text).includes(uploaded.path)),
    '带刚提交那句话的增量帧',
  )
  check(
    '提交之后推的是增量帧：新条目在 added 里（seq 在推进）',
    addedFrame.full === false && addedFrame.seq > 1 && Array.isArray(addedFrame.removedIds),
    JSON.stringify({ seq: addedFrame.seq, added: addedFrame.added.length }),
  )
  check(
    '增量帧每帧带 meta 与 liveEntries（meta 里有会话身份与 surfaces）',
    typeof addedFrame.meta === 'object' &&
      addedFrame.meta !== null &&
      addedFrame.meta.sessionId === first.sessionId &&
      typeof addedFrame.meta.surfaces === 'object' &&
      Array.isArray(addedFrame.liveEntries),
    JSON.stringify(addedFrame.meta).slice(0, 120),
  )
  check(
    '客户端按 id 合并增量之后能看到这句话（附件路径也带上了）',
    await waitState(
      mobile,
      (state) => state.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes(uploaded.path)),
      '重放视图里出现刚提交那句话',
    ),
  )
  const liveFrame = await waitFrame(
    mobile.frames,
    (frame) => Array.isArray(frame.liveEntries) && frame.liveEntries.length > 0,
    '带直播尾的帧',
  )
  check(
    '直播尾单独放在 liveEntries 里（负 id）',
    liveFrame.liveEntries.every((entry) => entry.id < 0),
    JSON.stringify(liveFrame.liveEntries.map((entry) => entry.id)),
  )

  // ── 8. 断线重连：带 lastSeq 补帧 ──────────────────────────────────────────
  console.log('断线重连补帧')
  // 另外开一条连接当「旁观者」：它一直连着，把断开期间推出去的帧原样记下来
  const keeperTicket = await takeTicket(token)
  keeper = await openSocket(keeperTicket.ticket)
  await waitFrame(keeper.frames, (frame) => frame.type === 'snapshot', '旁观者的首发全量')
  const lastSeq = mobile.view.state.seq
  mobile.socket.close()
  await sleep(60)
  // 帧是会话流驱动的，所以拔线之后要真造出变化：桌面端在这段时间写一次设置
  // （settings 服务每次写入都会 touch 一次会话流，于是推出一帧）。
  // 不靠模型那几段直播来凑帧，是为了这条用例不跟模型的吐字节奏绑在一起。
  let written = null
  let seen = lastSeq
  for (let i = 0; i < 2; i += 1) {
    written = await hostInvoke(host, 'setSettingValue', ['remote', 'notifyWebhook', webhookUrl])
    await waitFrame(
      keeper.frames,
      (frame) => typeof frame.seq === 'number' && frame.seq > seen,
      `断开期间旁观者收到的第 ${String(i + 1)} 帧`,
    )
    seen = keeper.view.state.seq
  }
  check('断开期间会话流照推（桌面端改了两次设置 → 旁观者收到两帧）', written?.ok === true && seen > lastSeq, JSON.stringify({ lastSeq, seen }))
  const missed = keeper.frames
    .map((frame, index) => ({ frame, raw: keeper.raws[index] }))
    .filter((item) => typeof item.frame.seq === 'number' && item.frame.seq > lastSeq)
  check('拔掉手机之后帧流继续前进', missed.length >= 2, String(missed.length))

  const reconnectTicket = await takeTicket(token)
  mobile = await openSocket(
    `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(reconnectTicket.ticket)}&lastSeq=${String(lastSeq)}`,
  )
  await waitFrame(
    mobile.frames,
    () => mobile.frames.filter((frame) => frame.type !== 'hello').length >= missed.length,
    '补发的帧',
  )
  const replayedFrames = mobile.frames.filter((frame) => frame.type !== 'hello').slice(0, missed.length)
  const replayedRaws = mobile.raws.filter((_raw, index) => mobile.frames[index].type !== 'hello').slice(0, missed.length)
  check(
    '带 &lastSeq=N 重连：补发的正是断开期间错过的那几帧（seq 一一对应）',
    replayedFrames.length === missed.length && replayedFrames.every((frame, index) => frame.seq === missed[index].frame.seq),
    JSON.stringify({ want: missed.map((item) => item.frame.seq), got: replayedFrames.map((frame) => frame.seq) }),
  )
  check(
    '补的是原样的 JSON 文本（重发不重算：与当时推给旁观者的字节逐字相同）',
    replayedRaws.every((raw, index) => raw === missed[index].raw),
  )
  check(
    '补完之后转实时（seq 继续往前推）',
    await waitFrame(
      mobile.frames,
      (frame) => typeof frame.seq === 'number' && frame.seq > missed[missed.length - 1].frame.seq,
      '补完转实时',
    ) !== undefined,
  )
  const fullAgain = await openSocket(
    `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent((await takeTicket(token)).ticket)}&lastSeq=0`,
  )
  const firstAfterZero = await waitFrame(fullAgain.frames, (frame) => frame.type !== 'hello', 'lastSeq=0 的首帧')
  check(
    'lastSeq=0（或没带）= 明确要全量：hello 之后是一帧 full:true',
    firstAfterZero.type === 'snapshot' && firstAfterZero.full === true,
    JSON.stringify({ type: firstAfterZero.type, full: firstAfterZero.full }),
  )
  fullAgain.socket.close()

  // ── 9. 推送：审批卡从无到有 → 假 Webhook 收 JSON ───────────────────────────
  console.log('审批卡触发推送')
  const cardOk = await waitState(
    mobile,
    (state) => state.meta?.surfaces?.pendingApproval !== null && state.meta?.surfaces?.pendingApproval !== undefined,
    '审批卡进快照',
  )
  const approval = mobile.view.state.meta.surfaces.pendingApproval
  check('模型要动受保护文件 → 审批卡进了快照', cardOk && approval.toolName === 'write', JSON.stringify(approval))
  const hookHit = await waitWebhook(
    (hit) => hit.method === 'POST' && hit.body.includes('等待审批'),
    '审批推送',
  )
  const hookDoc = JSON.parse(hookHit.body)
  check(
    '审批卡从无到有 → 假 Webhook 服务收到 POST JSON（ntfy 风格）',
    hookHit.method === 'POST' && hookDoc.title === 'Muse Code 等待审批' && typeof hookDoc.body === 'string' && hookDoc.body !== '',
    hookHit.body,
  )
  check(
    '推送里的 url 是这台机器的访问地址（点了能回到遥控页）',
    hookDoc.url === `http://127.0.0.1:${String(remotePort)}/`,
    String(hookDoc.url),
  )

  // ── 10. 审批：浏览器点的那一下要落 source='web' ────────────────────────────
  console.log('审批来源标注')
  const answerId = 'answer-1'
  mobile.socket.send(JSON.stringify({ type: 'invoke', id: answerId, method: 'answerApproval', args: ['reject'] }))
  const answerResult = await waitFrame(
    mobile.frames,
    (frame) => frame.type === 'result' && frame.id === answerId,
    '审批应答',
  )
  check('从浏览器答得通', answerResult.ok === true, JSON.stringify(answerResult))

  await sleep(300)
  const auditLines = readFileSync(auditFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
  const decided = auditLines.filter((record) => record.kind === 'approval' && record.phase === 'decided')
  check(
    "审计里这次决定标了 source: 'web'",
    decided.length > 0 && decided.every((record) => record.source === 'web'),
    JSON.stringify(decided),
  )
  const asked = auditLines.filter((record) => record.kind === 'approval' && record.phase === 'asked')
  check('弹卡那条（asked）没有 source（还没人答）', asked.length > 0 && asked.every((record) => record.source === undefined))
  check(
    '被拒的工具卡也推到了客户端（按 id 合并之后看得到）',
    await waitState(
      mobile,
      (state) => state.entries.some((entry) => entry.kind === 'tool' && entry.call?.status === 'rejected'),
      '被拒的工具卡',
    ),
  )
  const sessionText = collectText(join(home, '.dsc', 'sessions'))
  check(
    '配对码没有落进会话记录（码只在设置页那张卡上出现）',
    sessionText !== '' && freshCode !== '' && !sessionText.includes(freshCode),
  )
  const turnHit = await waitWebhook(
    (hit) => hit.method === 'POST' && hit.body.includes('轮完成'),
    '轮完成推送',
    30_000,
  )
  const turnDoc = JSON.parse(turnHit.body)
  check(
    '一轮跑完（≥15 秒或本轮出现过审批卡）→ 第二条 Webhook：标题「Muse Code 轮完成」、正文「用时 Xs」',
    turnDoc.title === 'Muse Code 轮完成' && /^用时 \d+s$/.test(String(turnDoc.body)),
    turnHit.body,
  )

  // ── 11. 推送路由（真服务端上） ─────────────────────────────────────────────
  console.log('浏览器推送路由')
  const pushOn = await hostInvoke(host, 'setSettingValue', ['remote', 'push', true])
  check('设置页能打开浏览器推送（默认是关的）', pushOn.ok === true, JSON.stringify(pushOn))
  const pushKeyRes = JSON.parse((await httpCall('/api/push-key')).body)
  check(
    '推送开着之后 GET /api/push-key 给出 VAPID 公钥（不要 token）',
    pushKeyRes.ok === true && typeof pushKeyRes.publicKey === 'string' && pushKeyRes.publicKey.length > 80,
    JSON.stringify(pushKeyRes).slice(0, 80),
  )
  check(
    'VAPID 密钥落在隔离 HOME 的 push-keys.json 里',
    existsSync(join(home, '.dsc', 'remote', 'push-keys.json')),
  )
  const subscription = JSON.stringify({ endpoint: 'https://push.example/mobile', keys: { p256dh: 'pp', auth: 'aa' } })
  const subRes = JSON.parse(
    (await httpCall('/api/push-subscribe', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: subscription,
    })).body,
  )
  const subAgain = JSON.parse(
    (await httpCall('/api/push-subscribe', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: subscription,
    })).body,
  )
  check(
    '浏览器订阅入库并按 endpoint 去重（第二次 added:false，总数还是 1）',
    subRes.ok === true && subRes.added === true && subRes.total === 1 && subAgain.added === false && subAgain.total === 1,
    JSON.stringify([subRes, subAgain]),
  )
  // 假 endpoint 留着的话，后面的推送会真的去打网络（DNS 失败要等超时）：验完就退订
  const unsubRes = JSON.parse(
    (await httpCall('/api/push-unsubscribe', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/mobile' }),
    })).body,
  )
  check('退订删掉那一条', unsubRes.ok === true && unsubRes.removed === true, JSON.stringify(unsubRes))

  // ── 12. 设备清单：每台两行 + 单独吊销 ──────────────────────────────────────
  console.log('设备清单与单独吊销')
  const third = await hostInvoke(host, 'runSettingAction', ['remote', 'regenerate-code'])
  const thirdCode = /配对码：([A-Z2-9]{8})/.exec(third.ok === true ? String(third.value?.notice ?? '') : '')?.[1] ?? ''
  const pair2 = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: thirdCode, name: '第二台手机' }),
  })
  const pair2Body = JSON.parse(pair2.body)
  const token2 = String(pair2Body.token ?? '')
  const deviceId2 = String(pair2Body.deviceId ?? '')
  check('重新配对一台设备拿得到新 token', pair2.status === 200 && token2 !== '' && deviceId2 !== '', pair2.body)
  const ticket2 = await takeTicket(token2)
  mobile = await openSocket(ticket2.ticket)
  await waitFrame(mobile.frames, (frame) => frame.type === 'hello', '第二台手机的 hello')
  check('新设备能建起 WS 会话', mobile.frames.some((frame) => frame.type === 'snapshot'))

  /** 读设置分区当前的字段表（fields() 是动态的，刷新一次就是最新的设备清单）。 */
  const sectionFields = async () => {
    const res = await hostInvoke(host, 'getSettingsSections', [])
    const section = (res.value ?? []).find((item) => item.id === 'remote')
    return section?.fields ?? []
  }
  const fieldsBefore = await sectionFields()
  check(
    '设置分区里多出 v3 的三样：push 开关、notifyWebhook 输入框、test-push 按钮',
    fieldsBefore.some((field) => field.type === 'switch' && field.key === 'push') &&
      fieldsBefore.some((field) => field.type === 'text' && field.key === 'notifyWebhook') &&
      fieldsBefore.some((field) => field.type === 'button' && field.action === 'test-push'),
    JSON.stringify(fieldsBefore.map((field) => field.action ?? field.key ?? field.label)),
  )
  check(
    '每台设备两行：info（设备名 + 最近活跃/创建时间）+ revoke-device:<id> 吊销按钮',
    fieldsBefore.some(
      (field) => field.type === 'info' && field.label === '第二台手机' && String(field.text).includes('最近活跃') && String(field.text).includes('创建于'),
    ) && fieldsBefore.some((field) => field.type === 'button' && field.action === `revoke-device:${deviceId2}`),
    JSON.stringify(fieldsBefore.map((field) => field.action ?? field.label)),
  )
  const testPush = await hostInvoke(host, 'runSettingAction', ['remote', 'test-push'])
  check(
    'test-push 把两条腿的真实结果说出来（此时推送开着但没订阅、Webhook 配着）',
    testPush.ok === true &&
      String(testPush.value?.notice ?? '').includes('浏览器推送：库里还没有订阅的设备') &&
      String(testPush.value?.notice ?? '').includes('通知 Webhook：已发送'),
    JSON.stringify(testPush.value),
  )
  let kicked2 = false
  mobile.socket.on('close', () => {
    kicked2 = true
  })
  const revokeOne = await hostInvoke(host, 'runSettingAction', ['remote', `revoke-device:${deviceId2}`])
  check(
    '单独吊销这台设备：动作返回文案说明断了连接',
    revokeOne.ok === true && String(revokeOne.value?.notice ?? '').includes('已吊销「第二台手机」'),
    JSON.stringify(revokeOne.value),
  )
  for (let i = 0; i < 60 && !kicked2; i += 1) await sleep(50)
  check('这台设备已经建立的连接当场断开', kicked2)
  const fieldsAfter = await sectionFields()
  check(
    '刷新之后设备清单少一台（这台设备的吊销按钮没了，另一台还在）',
    !fieldsAfter.some((field) => field.action === `revoke-device:${deviceId2}`) &&
      fieldsAfter.some((field) => field.type === 'button' && String(field.action).startsWith('revoke-device:')),
    JSON.stringify(fieldsAfter.map((field) => field.action ?? field.label)),
  )
  const revokedTicket2 = await takeTicket(token2)
  check('被单独吊销的设备再也换不到票据（401）', revokedTicket2.status === 401, String(revokedTicket2.status))

  // ── 13. 按 token 吊销：旧 token 立刻失效，连着的手机当场断线 ────────────────
  console.log('吊销设备（按 token）')
  keeper.socket.close()
  keeper = null
  const keeperTicket2 = await takeTicket(token)
  mobile = await openSocket(keeperTicket2.ticket)
  await waitFrame(mobile.frames, (frame) => frame.type === 'hello', '重连上的 hello')
  let kicked = false
  mobile.socket.on('close', () => {
    kicked = true
  })
  const revoke = await httpCall(`/api/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
  check(
    '吊销接口认得这个 token',
    revoke.status === 200 && JSON.parse(revoke.body).revoked === true,
    revoke.body,
  )
  for (let i = 0; i < 60 && !kicked; i += 1) await sleep(50)
  check('已经连上的手机被当场踢下线（不是等它下次重连才发现）', kicked)
  const revokedTicket = await httpCall('/api/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  check('被吊销的 token 再也换不到票据（401）', revokedTicket.status === 401, String(revokedTicket.status))
  const revokeAgain = await httpCall(`/api/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
  check(
    '重复吊销给 revoked:false（不报错）',
    revokeAgain.status === 200 && JSON.parse(revokeAgain.body).revoked === false,
    revokeAgain.body,
  )

  // ── 14. 主控位：第二个宿主只能休眠 ─────────────────────────────────────────
  console.log('主控位仲裁')
  secondHost = startHost('第二宿主')
  const dormant = await waitMessage(
    secondHost,
    (item) =>
      item.type === 'snapshot' &&
      item.snapshot?.entries?.some((entry) => entry.kind === 'system' && String(entry.text).includes('主控位')),
    '第二宿主发现自己只能休眠',
    20_000,
  )
  check('第二宿主认出主控位被占，进去休眠（不抢端口）', dormant !== undefined)
  const stillServing = await httpCall('/')
  check('第一个宿主仍在伺服', stillServing.status === 200, String(stillServing.status))
  await stopHost(secondHost)
  secondHost = null

  // ── 15. 重新配对一台设备，用它验启停 ───────────────────────────────────────
  console.log('重新配对与开关变化')
  const fourth = await hostInvoke(host, 'runSettingAction', ['remote', 'regenerate-code'])
  const fourthCode = /配对码：([A-Z2-9]{8})/.exec(fourth.ok === true ? String(fourth.value?.notice ?? '') : '')?.[1] ?? ''
  const pair3 = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: fourthCode, name: '第三台手机' }),
  })
  const token3 = String(JSON.parse(pair3.body).token ?? '')
  check('吊销之后重新配对一台设备拿得到新 token', pair3.status === 200 && token3 !== '', pair3.body)
  const ticket3 = await takeTicket(token3)
  mobile = await openSocket(ticket3.ticket)
  await waitFrame(mobile.frames, (frame) => frame.type === 'hello', '第三台手机的 hello')
  check('新设备能建起 WS 会话', mobile.frames.some((frame) => frame.type === 'snapshot'))

  // ── 16. 启停：关掉开关 → 端口不听了、连接断了 ──────────────────────────────
  let closed = false
  mobile.socket.on('close', () => {
    closed = true
  })
  const disable = await hostInvoke(host, 'setSettingValue', ['remote', 'enabled', false])
  check('桌面设置页把开关关掉（setSettingValue 走得通）', disable.ok === true, JSON.stringify(disable))
  for (let i = 0; i < 60 && !closed; i += 1) await sleep(50)
  check('已经建立的 WS 连接被断开', closed)
  let refused = false
  try {
    await httpCall('/')
  } catch (error) {
    refused = String(error?.code ?? error) === 'ECONNREFUSED'
  }
  check('端口不再监听（新请求连不上）', refused)
  const savedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'))
  check('开关落到 settings.json 里了', savedSettings.remote?.enabled === false, JSON.stringify(savedSettings.remote))
  check(
    '推送开关与 Webhook 地址也落在 settings.json 里（读档之后还在）',
    savedSettings.remote?.push === true && savedSettings.remote?.notifyWebhook === webhookUrl,
    JSON.stringify(savedSettings.remote),
  )
} catch (error) {
  failures += 1
  total += 1
  console.log(`  FAIL  探针中途出错 — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (mobile !== null) {
    try {
      mobile.socket.close()
    } catch {
      // 已经断了
    }
  }
  if (keeper !== null) {
    try {
      keeper.socket.close()
    } catch {
      // 已经断了
    }
  }
  if (secondHost !== null) await stopHost(secondHost)
  await stopHost(host)
  fakeLlm.close()
  fakeWebhook.close()
  if (host.stderr.trim() !== '') console.log(`\n宿主 stderr：\n${host.stderr.trim()}`)
}

console.log(`\n${String(total - failures)}/${String(total)} 通过`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`隔离的 HOME 留在 ${home}（失败现场，方便翻 settings.json 与 audit.jsonl）`)
process.exit(failures === 0 ? 0 : 1)
