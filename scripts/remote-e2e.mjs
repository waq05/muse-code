/**
 * 远程控制的全链探针：在一个隔离的 HOME 里真拉起 headless 宿主，然后像手机那样
 * 走 HTTP 配对 + WebSocket 遥控，把批 A 的宿主半边整条链验一遍。
 *
 * 覆盖：
 *   - 静态页与 Host 检查（占位页 200 / 域名 Host 403）
 *   - 配对：错码 5 次锁 1 小时（429）→ 重新生成 → 换到 token + deviceId
 *   - 票据：无 token 401 / 假票据 401 / 域名 Host 升级 403 / 一次性
 *   - WS：hello + 首发全量快照；submit 之后直播尾与定稿条目都能推到快照
 *   - 审批：模型要写受保护文件 → 卡片进快照 → 从浏览器答一次 → 审计里 source='web'
 *   - 白名单外的方法被拒
 *   - 主控位：第二个宿主进程抢不到，只休眠
 *   - 启停：enabled 改 false → 端口不再监听、WS 连接被断开
 *
 * 假模型端点由本脚本自己起（OpenAI 兼容 SSE，不联网、不花钱），这样「审批卡」这条路
 * 才有真实的工具调用来触发——没有模型就没人去调 write。
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

const remotePort = await freePort()
const llmPort = await freePort()
const probeTarget = join(home, 'AGENTS.md')
const auditFile = join(home, '.dsc', 'audit.jsonl')
const settingsFile = join(home, '.dsc', 'settings.json')

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
        // 思考分几段吐：宿主那边会折成「直播尾」，快照的 liveEntries 因此有内容可看
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

/** 开一条 WS 并把收到的帧攒起来。 */
function openSocket(ticketOrUrl, wsOptions = {}) {
  const url = ticketOrUrl.startsWith('ws:')
    ? ticketOrUrl
    : `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(ticketOrUrl)}`
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsOptions)
    const frames = []
    socket.on('message', (data) => {
      try {
        frames.push(JSON.parse(String(data)))
      } catch {
        // 不认识的帧忽略
      }
    })
    socket.on('open', () => resolve({ socket, frames }))
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

/** 等一帧满足条件的快照。 */
async function waitFrame(frames, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = frames.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等不到快照：${label}`)
    await sleep(40)
  }
}

const host = startHost('宿主')
let mobile = null
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
    '设置分区读得出开关 / 端口 / 局域网三项',
    values.ok === true && values.value?.enabled === true && values.value?.port === remotePort,
    JSON.stringify(values),
  )

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

  const ticketRes = await httpCall('/api/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${String(pairBody.token)}` },
  })
  const ticket = JSON.parse(ticketRes.body).ticket
  check('带对的 token 取到票据', ticketRes.status === 200 && typeof ticket === 'string' && ticket !== '', ticketRes.body)

  const bogus = await trySocket('不是票据')
  check('假票据升级被拒（401）', bogus.ok === false && bogus.error.includes('401'), JSON.stringify(bogus))
  const evilUpgrade = await trySocket(
    `ws://127.0.0.1:${String(remotePort)}/ws?ticket=${encodeURIComponent(ticket)}`,
    { headers: { host: `evil.example.com:${String(remotePort)}` } },
  )
  check('升级请求的 Host 是域名时被拒（403）', evilUpgrade.ok === false && evilUpgrade.error.includes('403'), JSON.stringify(evilUpgrade))

  // ── 4. WS：hello + 首发快照 ────────────────────────────────────────────────
  console.log('WebSocket 会话')
  mobile = await openSocket(ticket)
  const hello = await waitFrame(mobile.frames, (frame) => frame.type === 'hello', 'hello')
  check(
    'hello 报了协议版本、端口与开放方法清单',
    hello.protocolVersion === 1 && hello.port === remotePort && Array.isArray(hello.methods) && hello.methods.includes('submit'),
    JSON.stringify(hello),
  )
  const first = await waitFrame(mobile.frames, (frame) => frame.type === 'snapshot', '首发快照')
  check(
    '首发快照带 seq / cwd / sessionId / entries / liveEntries / status',
    first.seq === 1 &&
      typeof first.cwd === 'string' &&
      first.cwd !== '' &&
      typeof first.sessionId === 'string' &&
      Array.isArray(first.entries) &&
      Array.isArray(first.liveEntries) &&
      typeof first.status === 'object' &&
      first.surfaces !== null,
    JSON.stringify({ seq: first.seq, cwd: first.cwd, sessionId: first.sessionId }),
  )

  const reuse = await trySocket(ticket)
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

  // ── 6. submit：直播尾与定稿条目都推到快照 ──────────────────────────────────
  console.log('submit 与快照推送')
  const submitId = 'submit-1'
  mobile.frames.length = 0
  mobile.socket.send(JSON.stringify({ type: 'invoke', id: submitId, method: 'submit', args: ['远程提交的一句话'] }))
  const submitResult = await waitFrame(
    mobile.frames,
    (frame) => frame.type === 'result' && frame.id === submitId,
    'submit 的应答',
  )
  check('submit 调得通', submitResult.ok === true, JSON.stringify(submitResult))
  const userFrame = await waitFrame(
    mobile.frames,
    (frame) =>
      frame.type === 'snapshot' &&
      Array.isArray(frame.entries) &&
      frame.entries.some((entry) => entry.kind === 'user' && entry.text === '远程提交的一句话'),
    '带刚提交那句话的快照',
  )
  check('提交的内容出现在后续快照里（seq 在推进）', userFrame.seq >= 2, String(userFrame.seq))
  const liveFrame = await waitFrame(
    mobile.frames,
    (frame) => frame.type === 'snapshot' && Array.isArray(frame.liveEntries) && frame.liveEntries.length > 0,
    '带直播尾的快照',
  )
  check(
    '直播尾单独放在 liveEntries 里（负 id）',
    liveFrame.liveEntries.every((entry) => entry.id < 0),
    JSON.stringify(liveFrame.liveEntries.map((entry) => entry.id)),
  )

  // ── 7. 审批：浏览器点的那一下要落 source='web' ─────────────────────────────
  console.log('审批来源标注')
  const cardFrame = await waitFrame(
    mobile.frames,
    (frame) => frame.type === 'snapshot' && frame.surfaces?.pendingApproval !== null && frame.surfaces?.pendingApproval !== undefined,
    '审批卡进快照',
  )
  check(
    '模型要动受保护文件 → 审批卡进了快照',
    cardFrame.surfaces.pendingApproval.toolName === 'write',
    JSON.stringify(cardFrame.surfaces.pendingApproval),
  )
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
  const toolResult = await waitFrame(
    mobile.frames,
    (frame) =>
      frame.type === 'snapshot' &&
      Array.isArray(frame.entries) &&
      frame.entries.some((entry) => entry.kind === 'tool' && entry.call?.status === 'rejected'),
    '被拒的工具卡',
  )
  check('被拒的工具卡也推到了快照', toolResult.seq >= 2)
  const sessionText = collectText(join(home, '.dsc', 'sessions'))
  check(
    '配对码没有落进会话记录（码只在设置页那张卡上出现）',
    sessionText !== '' && freshCode !== '' && !sessionText.includes(freshCode),
  )

  // ── 8. 吊销：旧 token 立刻失效，已经连上的手机当场断线 ────────────────────
  console.log('吊销设备')
  let kicked = false
  mobile.socket.on('close', () => {
    kicked = true
  })
  const revoke = await httpCall(`/api/revoke?token=${encodeURIComponent(String(pairBody.token))}`, { method: 'POST' })
  check(
    '吊销接口认得这个 token',
    revoke.status === 200 && JSON.parse(revoke.body).revoked === true,
    revoke.body,
  )
  for (let i = 0; i < 60 && !kicked; i += 1) await sleep(50)
  check('已经连上的手机被当场踢下线（不是等它下次重连才发现）', kicked)
  const revokedTicket = await httpCall('/api/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${String(pairBody.token)}` },
  })
  check('被吊销的 token 再也换不到票据（401）', revokedTicket.status === 401, String(revokedTicket.status))
  const revokeAgain = await httpCall(`/api/revoke?token=${encodeURIComponent(String(pairBody.token))}`, {
    method: 'POST',
  })
  check(
    '重复吊销给 revoked:false（不报错）',
    revokeAgain.status === 200 && JSON.parse(revokeAgain.body).revoked === false,
    revokeAgain.body,
  )

  // ── 9. 主控位：第二个宿主只能休眠 ──────────────────────────────────────────
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

  // ── 10. 重新配对一台设备，用它验启停 ───────────────────────────────────────
  console.log('重新配对与开关变化')
  const third = await hostInvoke(host, 'runSettingAction', ['remote', 'regenerate-code'])
  const thirdCode = /配对码：([A-Z2-9]{8})/.exec(third.ok === true ? String(third.value?.notice ?? '') : '')?.[1] ?? ''
  const pair2 = await httpCall('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: thirdCode, name: '第二台手机' }),
  })
  const token2 = JSON.parse(pair2.body).token
  check('吊销之后重新配对一台设备拿得到新 token', pair2.status === 200 && typeof token2 === 'string', pair2.body)
  const ticket2Res = await httpCall('/api/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${String(token2)}` },
  })
  mobile = await openSocket(JSON.parse(ticket2Res.body).ticket)
  await waitFrame(mobile.frames, (frame) => frame.type === 'hello', '第二台手机的 hello')
  check('新设备能建起 WS 会话', mobile.frames.some((frame) => frame.type === 'snapshot'))

  // ── 11. 启停：关掉开关 → 端口不听了、连接断了 ──────────────────────────────
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
  if (secondHost !== null) await stopHost(secondHost)
  await stopHost(host)
  fakeLlm.close()
  if (host.stderr.trim() !== '') console.log(`\n宿主 stderr：\n${host.stderr.trim()}`)
}

console.log(`\n${String(total - failures)}/${String(total)} 通过`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`隔离的 HOME 留在 ${home}（失败现场，方便翻 settings.json 与 audit.jsonl）`)
process.exit(failures === 0 ? 0 : 1)
