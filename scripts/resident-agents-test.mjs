/**
 * 常驻多 agent（0.6.48 对齐 dsh）内核级直测：切会话不打断运行中的回合。
 *
 * 0.6.47 之前全局单 agent，切会话 = abort 当前轮 + 中止收尾的工具结果误写进新会话
 * 的日志（探针实锤的跨会话污染）。0.6.48 起每个会话一个常驻 agent：切换只换「当前
 * 查看」指向，后台回合跑完写回自己的日志；侧栏状态点/「已完成未读」徽标走
 * dsc/agent-status；完全闲下来又不是当前查看的 agent 就地收摊（写租约随之释放）。
 *
 * 断言七层：
 *   1. A 回合跑动中切到 B：A 不被中断（isRunning），B 视图 idle，侧栏亮 A 的 working 点；
 *   2. B 正常对话不受影响；A 的工具结果与结论落回 A 的日志，B 的日志零污染；
 *   3. 切回 A（回合还在跑）：会话对象复用常驻实例，turnState 补种成「回合中」；
 *   4. A 收工时没在看：侧栏翻成「已完成未读」（just-finished）；
 *   5. 闲下来又不是当前查看：agent 自动收摊（hasAgent=false，写租约释放，可重新 load）；
 *   6. 收摊后的会话仍能收到迟到的投递（followup 带 sessionId → 写进会话文件）；
 *   7. turn-start/turn-end 事件带会话归属；用量日志按发起回合的会话记账；
 *   8. 后台收工的首回合也拿到自动标题（0.6.49：标题按回合归属生成）；
 *   9. 后台在跑的会话按路径 interrupt 可停（回合 aborted 收尾）；
 *  10. 归档后台在跑的会话：先收摊常驻 agent（回合取消、排队丢弃）再挪文件（0.6.49）。
 *  11. 子代理 chip 作用域（0.6.65）：subagents 只收当前会话、干活中的队友，切会话/收工即空；
 *      全局 sessionStates 原样保留（/resume 行内状态点继续亮）。
 *  12. 名册僵尸（0.6.65）：上次进程没 settle 就退了的 working 记录，读路径改报 stopped。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/resident-agents-test.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// config 模块在 import 时就固定了 ~/.dsc 路径，临时 HOME 必须先于一切 lib 导入
const home = mkdtempSync(join(tmpdir(), 'dsc-resident-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 第 11 节要派真队友：subagent 插件 defaultDisabled，预写条目树打开它
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`,
  'utf8',
)

const { createKernel } = await import('../lib/host/kernel.js')
const { Session, archivedRoot } = await import('../lib/core/session.js')
const { readSessionMeta } = await import('../lib/core/session-meta.js')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

// ---- 假端点：按「请求里最后一条真用户消息 / 有无工具结果」分派，驱动真回合 ----
// 注意线上最后一条 user 是 env-facts 快照（「不是用户发言」），分派时要跳过它。
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

async function serve() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const realUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
      const lastText =
        typeof realUser?.content === 'string'
          ? realUser.content
          : Array.isArray(realUser?.content)
            ? realUser.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : ''
      const hasToolResult = messages.some((m) => m.role === 'tool')
      // 标题请求（session-title 插件的小模型调用）：认 system 提示词，回纯文本
      const isTitleRequest = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
      )
      let reply
      if (isTitleRequest) reply = sseText('常驻探针的后台会话标题')
      else if (lastText.includes('慢队友任务')) {
        await sleep(700) // 队友的回合：拖出「正在干活」的观察窗，让 chip 断言有东西可看
        reply = sseText('慢队友干完了')
      } else if (lastText.includes('派队友')) {
        // arguments 必须是 JSON 字符串（真实 SSE 形状），对象会让工具卡的 argsText 炸
        reply = sseToolCall('ts1', 'subagent', JSON.stringify({
          action: 'spawn',
          role: 'explorer',
          task: '慢队友任务：慢慢查一下 package.json 里的名字叫什么，一句话交差',
          background: true,
        }))
      } else if (hasToolResult) reply = sseText('A 的结论：工具返回了 slow ok')
      else if (lastText.includes('开跑')) {
        reply = sseToolCall('t1', 'slow_thing', '{}')
      } else if (lastText.includes('B 的问题')) reply = sseText('B 的回答')
      else reply = sseText('收到')
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

// 事件收集：回合事件带会话归属（0.6.48 的关键新载荷）
const turnSignals = []
const statusLog = []
ctx.on('dsc/turn-start', (signal) => turnSignals.push({ kind: 'start', ...signal }))
ctx.on('dsc/turn-end', (reason, signal) => turnSignals.push({ kind: 'end', reason, ...signal }))
ctx.on('dsc/agent-status', (p) => statusLog.push(`${p.path.split('\\').pop()?.slice(0, 8)}:${p.state}`))

// 慢工具：真实登记进注册表（risk=read 免审批卡），跑动中可观察
let toolStarted = false
let toolSessionId = null
const offTool = ctx.tools.register({
  name: 'slow_thing',
  description: '测试用慢工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async (_args, toolCtx) => {
    toolStarted = true
    // 工具上下文必须带会话身份（0.6.48：后台作业通知按它归属）
    toolSessionId = toolCtx.sessionId
    await sleep(600)
    return 'slow ok'
  },
})

const sessionA = ctx.session.current()
const sidA = sessionA.meta.id

console.log('1. A 回合跑动中切到 B')
{
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sidA) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('开跑')
  check('工具开跑且带上会话身份', await until(() => toolStarted && toolSessionId === sidA), `sessionId=${String(toolSessionId)}`)
  await ctx.session.open(undefined)
  const sessionB = ctx.session.current()
  check('切到 B 后 A 还在跑（不被打断）', ctx.agent.isRunning(sessionA.filePath), 'isRunning=false')
  check('切会话不再复用同一个会话对象', sessionB !== sessionA)
  check('B 视图是 idle', ctx.transcript.getSnapshot().status.turnState === 'idle')
  check('侧栏亮 A 的运行点', ctx.transcript.getSnapshot().sessionStates[sessionA.filePath] === 'working')
  await sleep(200)
  check('切走不产生 A 的 turn/end（不再中止）', !turnSignals.some((s) => s.kind === 'end' && s.sessionId === sidA), JSON.stringify(turnSignals))

  // 2. B 正常对话
  const endedB = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sessionB.meta.id) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('B 的问题')
  check('B 的回合正常收尾', (await endedB) === 'completed')
  await sleep(200) // 写走的是缓冲流，turn/end 到达时 jsonl 可能还没冲刷
  const bText = readFileSync(sessionB.filePath, 'utf8')
  check('B 的回答落进 B 的日志', bText.includes('B 的回答'))
  check('B 的日志零污染（没有 A 的工具结果与结论）', !bText.includes('slow ok') && !bText.includes('A 的结论'))

  // 3. 切回 A（回合还在跑）：复用常驻会话对象 + turnState 补种，随后立刻切去 B
  // （A 得在后台收工才能翻出「已完成未读」——收工时正看着它就不该有徽标）
  await ctx.session.open(sessionA.filePath)
  check('切回 A 复用常驻会话对象（不再 Session.load）', ctx.session.current() === sessionA)
  check('A 的视图补种成「回合中」', ['thinking', 'working'].includes(ctx.transcript.getSnapshot().status.turnState), `turnState=${ctx.transcript.getSnapshot().status.turnState}`)
  await ctx.session.open(sessionB.filePath)

  // 4. A 收工：结果写回 A 自己的日志；侧栏翻成「已完成未读」
  check('A 的回合在后台正常结束', (await ended) === 'completed')
  check(
    'A 收工且没在看 → 侧栏「已完成未读」',
    await until(() => ctx.transcript.getSnapshot().sessionStates[sessionA.filePath] === 'just-finished'),
    `状态序列=${statusLog.join(' | ')} 快照=${JSON.stringify(ctx.transcript.getSnapshot().sessionStates)} A=${sessionA.filePath.split('\\').pop()}`,
  )
  await sleep(200)
  const aText = readFileSync(sessionA.filePath, 'utf8')
  check('A 的工具结果落回 A 的日志', aText.includes('slow ok'))
  check('A 的结论落回 A 的日志', aText.includes('A 的结论'))

  // 5. 完全闲下来又不是当前查看：agent 自动收摊
  check(
    'A 的 agent 自动收摊（hasAgent=false）',
    await until(() => ctx.agent.hasAgent(sidA) === false),
  )
  check(
    '收摊后写租约释放（可重新加载）',
    await until(() => {
      try {
        const reloaded = Session.load(sessionA.filePath, true)
        reloaded.close()
        return true
      } catch {
        return false
      }
    }),
  )

  // 6. 收摊后的会话仍能收到迟到的投递
  ctx.agent.followup('晚到的通知', undefined, sidA)
  await sleep(200)
  const aText2 = readFileSync(sessionA.filePath, 'utf8')
  check('迟到的投递写进 A 的会话文件', aText2.includes('晚到的通知'), 'jsonl 无该文本')

  // 7. 事件归属与用量记账
  const aStart = turnSignals.find((s) => s.kind === 'start' && s.sessionId === sidA)
  const aEnd = turnSignals.find((s) => s.kind === 'end' && s.sessionId === sidA)
  check('turn-start 带会话归属（id + 路径）', aStart !== undefined && aStart.sessionPath === sessionA.filePath, JSON.stringify(aStart))
  check('A 的 turn-end 在切走之后才发、reason=completed', aEnd !== undefined && aEnd.reason === 'completed')
  const usageText = readFileSync(join(home, '.dsc', 'usage', 'usage.jsonl'), 'utf8')
  check('用量日志按发起回合的会话记账', usageText.includes(`"sid":"${sidA}"`) && usageText.includes(`"sid":"${sessionB.meta.id}"`))

  // 8. 后台收工的首回合也自动起名（0.6.49：标题按回合归属，不再只认当前查看）
  check(
    'A（后台收工）拿到自动标题',
    await until(() => readSessionMeta()[sidA]?.autoTitle !== undefined),
    JSON.stringify(readSessionMeta()[sidA]),
  )
  check('B（前台收工）拿到自动标题', readSessionMeta()[sessionB.meta.id]?.autoTitle !== undefined)

  // 9. 后台可停（0.6.49）：按路径 interrupt 后台在跑的会话
  await ctx.session.open(sessionA.filePath)
  const endedA2 = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sidA) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('开跑')
  check('A 的第二个回合开跑', await until(() => ctx.agent.isRunning(sessionA.filePath)))
  await ctx.session.open(undefined) // 切到新会话 C，A 转后台继续跑
  ctx.agent.interrupt(sessionA.filePath)
  check('按路径 interrupt 停下后台回合', await until(() => !ctx.agent.isRunning(sessionA.filePath)))
  check('被停的回合 reason=aborted', (await endedA2) === 'aborted')

  // 10. 归档后台在跑的会话：先收摊常驻 agent 再挪文件（0.6.49 stopActivity 语义）
  // （上一段 interrupt 后 A 闲下来已被收摊；重新打开再起一轮，让归档撞上「后台在跑」）
  await ctx.session.open(sessionA.filePath)
  const endedA3 = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sidA) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('开跑')
  check('A 的第三个回合开跑', await until(() => ctx.agent.isRunning(sessionA.filePath)))
  await ctx.session.open(undefined) // 切走，A 在后台跑着时归档它
  const archiveResult = await ctx.session.archive([sessionA.filePath])
  check('归档后台在跑的会话成功（先收摊再挪文件）', archiveResult.ok === true, JSON.stringify(archiveResult))
  check('归档停机的回合 reason=aborted', (await endedA3) === 'aborted')
  check('A 的 agent 已收摊', ctx.agent.hasAgent(sidA) === false)
  const { existsSync } = await import('node:fs')
  // moveSessionFile 的落点：archivedRoot/<原目录名>/<文件名>
  const archivedPathOf = (filePath) => join(archivedRoot(), basename(dirname(filePath)), basename(filePath))
  check(
    'A 的 jsonl 挪进归档区（原位置不存在）',
    !existsSync(sessionA.filePath) && existsSync(archivedPathOf(sessionA.filePath)),
    `原=${sessionA.filePath} 归档区=${archivedPathOf(sessionA.filePath)}`,
  )
  // 重试：已归档的跳过不算失败（半途而废的批量归档重试不再卡死）
  const retryResult = await ctx.session.archive([sessionA.filePath])
  check('重试归档已归档会话：跳过且 ok', retryResult.ok === true, JSON.stringify(retryResult))

  // 11. 状态栏子代理 chip 只认当前会话、还在干活的队友（0.6.65 收紧作用域）
  console.log('11. 子代理 chip 作用域：当前会话 + 干活中')
  {
    const { ensureBuiltinRoles } = await import('../lib/core/agent-roles.js')
    ensureBuiltinRoles()
    const parent = ctx.session.current() // 第 10 节切走后的新会话 C
    ctx.agent.followup('派队友')
    let mate
    check(
      '队友派出并开工',
      await until(() => {
        mate = ctx.get('team')?.list().find((m) => m.state === 'working' && m.sessionId === parent.meta.id)
        return mate !== undefined
      }),
      JSON.stringify(ctx.get('team')?.list()),
    )
    const midSnapshot = ctx.transcript.getSnapshot()
    check(
      '干活中的队友进 subagents（状态栏 chip 的数据源）',
      midSnapshot.subagents.length === 1
        && midSnapshot.subagents[0]?.sessionPath === mate.file
        && midSnapshot.subagents[0]?.state === 'working',
      JSON.stringify(midSnapshot.subagents),
    )
    check('全局 sessionStates 仍亮队友的点（/resume 行内状态点用）', midSnapshot.sessionStates[mate.file] === 'working')
    // 切到别的会话：chip 立刻消失（所有权过滤），全局面不跟着清（列表状态点还亮）
    await ctx.session.open(undefined)
    check('切走会话后 subagents 清空', ctx.transcript.getSnapshot().subagents.length === 0, JSON.stringify(ctx.transcript.getSnapshot().subagents))
    check('切走后全局 sessionStates 仍保留队友状态', ctx.transcript.getSnapshot().sessionStates[mate.file] === 'working')
    await ctx.session.open(parent.filePath)
    check(
      '队友收工后 subagents 清空、名册落 idle',
      await until(
        () =>
          ctx.transcript.getSnapshot().subagents.length === 0
          && ctx.get('team').list().find((m) => m.sessionId === parent.meta.id)?.state === 'idle',
      ),
      JSON.stringify({ sub: ctx.transcript.getSnapshot().subagents, team: ctx.get('team').list() }),
    )
  }

  // 12. 名册僵尸：上次进程没 settle 就退了的 working 记录，读路径改报 stopped（0.6.65）
  console.log('12. 名册僵尸读作 stopped')
  {
    const rosterDir = join(home, '.dsc', 'team')
    mkdirSync(rosterDir, { recursive: true })
    writeFileSync(
      join(rosterDir, 'roster.json'),
      `${JSON.stringify({
        teammates: [
          {
            name: 'zombie',
            role: 'explorer',
            state: 'working',
            task: '旧进程没 settle 就退了留下的记录',
            file: join(home, '.dsc', 'teammates', 'ghost.jsonl'),
            cwd: '/w',
            parent: 'lead',
            depth: 1,
            rounds: 1,
            startedAt: Date.now(),
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )
    const zombie = ctx.get('team').list().find((m) => m.name === 'zombie')
    check('僵尸记录读作 stopped（不再永远「干活」）', zombie !== undefined && zombie.state === 'stopped', JSON.stringify(zombie))
    check('僵尸不进状态栏 chip 列表', ctx.transcript.getSnapshot().subagents.every((chip) => chip.sessionPath !== zombie?.file))
  }

  // 收尾：B 的 agent 是当前查看的，跟着会话留到退出；显式退出收摊
  offTool()
  ctx.emit('dsc/exit')
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
await site.close()
process.exit(fail === 0 ? 0 : 1)
