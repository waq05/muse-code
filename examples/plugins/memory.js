/**
 * dsc 记忆插件（Hermes Agent 风格）：
 * - Prefetch：每轮用户消息到达时按相关性检索持久记忆，注入到消息历史头部
 *   （一条带 [dsc-memory] 标记的 system 消息，loop 组装请求时紧跟 system prompt）。
 * - 自动沉淀：每轮对话结束（working→idle）用当前模型提取 0-3 条值得长期记住的
 *   事实（偏好/项目/教训），去重后写入 ~/.dsc/memory/（按项目 cwd 分区）。
 * - 工具面：memory_search / memory_save / memory_forget / memory_list。
 * - 命令：/memory [show|clear|on|off]。
 *
 * 存储两层：~/.dsc/memory/index.json 结构化数据（检索源）+ MEMORY.md 人类可读索引。
 * 注入消息不落盘（Session 只持久化 appendUser/appendAssistant 的 record），
 * 会话恢复后由本插件重新注入。
 *
 * @module dsc/examples/plugins/memory
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '记忆'
export const description = 'Hermes 风格长期记忆：预取注入、自动沉淀、工具存取（按项目分区）'
export const apiVersion = 1
export const inject = ['tools', 'commands', 'transcript', 'session', 'llm']

const MAGIC = '[dsc-memory]'
const MAX_MEMORIES = 200
const EXTRACT_TIMEOUT_MS = 30000
const TYPES = ['preference', 'project', 'lesson', 'fact']

export function apply(ctx, config) {
  const cfg = {
    autoExtract: config?.autoExtract !== false,
    inject: config?.inject !== false,
    maxInject: Number(config?.maxInject) > 0 ? Number(config.maxInject) : 6,
  }

  // ---- 存储：~/.dsc/memory/index.json（项目 key → 记忆列表）+ MEMORY.md ----
  const root = join(homedir(), '.dsc', 'memory')

  const projectKey = () => {
    const key = ctx.session.current().meta.cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '')
    return key === '' ? 'default' : key
  }

  let cache = null
  const store = () => {
    if (cache !== null) return cache
    try {
      cache = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
    } catch {
      cache = {}
    }
    return cache
  }
  const persist = () => {
    if (cache === null) return
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'index.json'), JSON.stringify(cache, null, 2))
    writeFileSync(join(root, 'MEMORY.md'), renderMarkdown())
  }

  function renderMarkdown() {
    const lines = ['# dsc 长期记忆', '', '> 由 memory 插件自动维护；按项目分区。', '']
    for (const [key, items] of Object.entries(store())) {
      if (!Array.isArray(items) || items.length === 0) continue
      lines.push(`## ${key}`)
      for (const item of items) {
        lines.push(`- [${item.type}] ${item.content} \`(id: ${item.id.slice(0, 8)})\``)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  const itemsOf = (key) => {
    const data = store()
    if (!Array.isArray(data[key])) data[key] = []
    return data[key]
  }

  // ---- 检索：子串 / 词元 / 中文 bigram 混合打分 ----
  const normalize = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

  function tokens(text) {
    const out = []
    for (const word of normalize(text).match(/[a-z0-9]+/g) ?? []) out.push(word)
    // CJK bigram：中文无空格分词，用相邻两字近似
    const cjk = String(text ?? '').match(/[\u4e00-\u9fff]/g) ?? []
    for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1])
    return out
  }

  function score(query, content) {
    let total = 0
    if (normalize(content).includes(normalize(query))) total += 3
    const qTokens = [...new Set(tokens(query))]
    if (qTokens.length === 0) return total
    const cTokens = new Set(tokens(content))
    for (const token of qTokens) if (cTokens.has(token)) total += 1
    return total
  }

  function search(key, query, limit) {
    if (normalize(query) === '') return []
    return itemsOf(key)
      .map((item) => ({ item, s: score(query, item.content) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((entry) => entry.item)
  }

  function addMemory(key, type, content) {
    const text = normalize(content)
    if (text === '') return { ok: false, reason: '内容为空' }
    const items = itemsOf(key)
    for (const item of items) {
      const old = normalize(item.content)
      // 双向包含视为重复
      if (old.includes(text) || text.includes(old)) {
        item.createdAt = Date.now()
        persist()
        return { ok: true, reason: '已存在（刷新时间）' }
      }
    }
    items.push({
      id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      type: TYPES.includes(type) ? type : 'fact',
      content: String(content).trim().slice(0, 200),
      createdAt: Date.now(),
    })
    while (items.length > MAX_MEMORIES) items.shift()
    persist()
    return { ok: true }
  }

  // ---- 注入（Prefetch）：标记消息定位 → 更新或插入消息历史头部 ----
  function findInjected() {
    return ctx
      .session.current()
      .messages.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(MAGIC))
  }

  function injectMemories(items, header) {
    if (!cfg.inject) return
    const body =
      items.length === 0 ? '' : `\n${items.map((item, i) => `${i + 1}. [${item.type}] ${item.content}`).join('\n')}`
    const text =
      `${MAGIC} ${header}${body}\n` +
      '（与当前任务无关的内容可忽略；可用 memory_search 工具检索更多。）'
    const existing = findInjected()
    if (existing !== undefined) {
      existing.content = text
      return
    }
    ctx.session.current().messages.unshift({ role: 'system', content: text })
  }

  // ---- 快照监听：Prefetch（新用户消息）+ 沉淀（working→idle 边沿） ----
  let lastUserId = -1
  let lastTurnState = 'idle'
  let extracting = false

  const offSubscribe = ctx.transcript.subscribe(() => {
    let snap
    try {
      snap = ctx.transcript.getSnapshot()
    } catch {
      return
    }
    const entries = snap.entries ?? []
    const lastUser = [...entries].reverse().find((e) => e.kind === 'user')
    if (lastUser !== undefined && lastUser.id !== lastUserId) {
      lastUserId = lastUser.id
      const items = search(projectKey(), String(lastUser.text ?? '').slice(0, 400), cfg.maxInject)
      setTimeout(() => injectMemories(items, `长期记忆（按当前消息相关性检索，共 ${items.length} 条）`), 0)
    }
    const state = snap.status?.turnState ?? 'idle'
    if (lastTurnState === 'working' && state === 'idle' && cfg.autoExtract && !extracting) {
      const round = roundText(entries)
      if (round !== '') {
        ctx.transcript.system('[memory] 正在沉淀本轮对话…')
        setTimeout(() => void extract(round), 0)
      }
    }
    lastTurnState = state
  })

  /** 取最后一条用户消息起的本轮对话文本（用户 + 助手文本条目；排除 thinking/system/tool）。 */
  function roundText(entries) {
    const kinds = entries.map((e) => e.kind)
    const start = kinds.lastIndexOf('user')
    if (start < 0) return ''
    return entries
      .slice(start)
      .filter((e) => e.kind === 'user' || e.kind === 'text')
      .map((e) => `${e.kind === 'user' ? '用户' : '助手'}: ${String(e.text ?? '').slice(0, 800)}`)
      .join('\n')
      .slice(0, 3000)
  }

  // ---- 自动沉淀：回合结束后用当前模型提取 ----
  async function extract(round) {
    extracting = true
    try {
      const route = ctx.llm.route()
      const prompt = [
        '你是记忆提取器。从这段编程助手对话中提取值得跨会话长期记住的事实。',
        '只提取：用户的长期偏好、项目约束/事实、解决问题的关键教训。',
        '不要提取：一次性任务细节、寒暄、代码内容。',
        '输出 JSON 数组，每项 {"type":"preference|project|lesson|fact","content":"一句话，不超过60字"}；无可提取输出 []。',
        '只输出 JSON，不要其他文字。',
        '',
        '对话：',
        round,
      ].join('\n')
      const response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500,
          stream: false,
          ...(route.thinking !== undefined
            ? { thinking: { type: route.thinking === 'disabled' ? 'disabled' : 'enabled' } }
            : {}),
        }),
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      const match = content.match(/\[[\s\S]*\]/)
      if (match === null) return
      const parsed = JSON.parse(match[0])
      const key = projectKey()
      const added = []
      for (const item of Array.isArray(parsed) ? parsed : []) {
        if (typeof item?.content !== 'string' || item.content.trim() === '') continue
        const before = itemsOf(key).length
        const result = addMemory(key, String(item.type ?? 'fact'), item.content)
        if (result.ok && itemsOf(key).length > before) added.push(item.content.trim())
      }
      if (added.length > 0) {
        ctx.transcript.system(`[memory] 已记住 ${added.length} 条：${added.join('；')}`)
      }
    } catch (error) {
      // 静默失败：后台动作不打断主对话
      ctx.transcript.system(`[memory] 自动提取失败（${error instanceof Error ? error.message : String(error)}），本条跳过`)
    } finally {
      extracting = false
    }
  }

  // ---- 会话切换：重置 prefetch 状态并重新注入（注入消息不落盘） ----
  const offSession = ctx.on('dsc/session-open', () => {
    lastUserId = -1
    const items = [...itemsOf(projectKey())]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(5, cfg.maxInject))
    setTimeout(() => injectMemories(items, `长期记忆（最近记录，共 ${items.length} 条）`), 0)
  })

  // ---- 工具面 ----
  const offSearch = ctx.tools.register({
    name: 'memory_search',
    description: '在 dsc 长期记忆中按关键词检索（当前项目分区）。回答前想确认用户偏好/项目背景/历史教训时使用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词，如「测试 偏好」' } },
      required: ['query'],
    },
    risk: 'read',
    async run(args) {
      const items = search(projectKey(), String(args.query ?? ''), 10)
      if (items.length === 0) return '（无相关记忆）'
      return items.map((item) => `[${item.type}] ${item.content} (id: ${item.id.slice(0, 8)})`).join('\n')
    },
  })

  const offSave = ctx.tools.register({
    name: 'memory_save',
    description: '把一条值得跨会话记住的事实写入 dsc 长期记忆（用户偏好/项目约束/关键教训）。内容要一句话、自包含。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容（一句话，≤60字）' },
        type: { type: 'string', enum: TYPES, description: '记忆类型' },
      },
      required: ['content'],
    },
    risk: 'write',
    async run(args) {
      const result = addMemory(projectKey(), String(args.type ?? 'fact'), String(args.content ?? ''))
      if (!result.ok) throw new Error(result.reason ?? '写入失败')
      return `已保存：${String(args.content).trim().slice(0, 60)}${result.reason ? `（${result.reason}）` : ''}`
    },
  })

  const offForget = ctx.tools.register({
    name: 'memory_forget',
    description: '按 id 删除一条长期记忆（id 前 8 位即可）。用户要求忘记某事时使用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id（前缀即可）' } },
      required: ['id'],
    },
    risk: 'write',
    async run(args) {
      const prefix = String(args.id ?? '').trim()
      const items = itemsOf(projectKey())
      const index = items.findIndex((item) => item.id.startsWith(prefix))
      if (index < 0) throw new Error(`没有 id 前缀为 ${prefix} 的记忆`)
      const removed = items.splice(index, 1)[0]
      persist()
      return `已删除：[${removed.type}] ${removed.content}`
    },
  })

  const offList = ctx.tools.register({
    name: 'memory_list',
    description: '列出当前项目的全部长期记忆。',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run() {
      const items = itemsOf(projectKey())
      if (items.length === 0) return '（当前项目暂无记忆）'
      return items.map((item) => `[${item.type}] ${item.content} (id: ${item.id.slice(0, 8)})`).join('\n')
    },
  })

  // ---- 命令：/memory [show|clear|on|off] ----
  const offCommand = ctx.commands.register(
    {
      name: 'memory',
      args: '[show|clear|on|off]',
      description: '查看/管理长期记忆（show 全部、clear 清空、on/off 自动沉淀开关）',
    },
    ({ args, ui }) => {
      const sub = String(args[0] ?? '').toLowerCase()
      const key = projectKey()
      if (sub === 'clear') {
        store()[key] = []
        persist()
        ui.notice(`[memory] 已清空当前项目（${key}）的全部记忆`)
        return
      }
      if (sub === 'on' || sub === 'off') {
        cfg.autoExtract = sub === 'on'
        ui.notice(`[memory] 自动沉淀已${sub === 'on' ? '开启' : '关闭'}`)
        return
      }
      const items = itemsOf(key)
      if (items.length === 0) {
        ui.notice('[memory] 当前项目暂无记忆；对话中会自动沉淀，也可让模型调用 memory_save 保存')
        return
      }
      const shown = sub === 'show' ? items : items.slice(-5)
      ui.notice(
        `[memory] 当前项目（${key}）共 ${items.length} 条记忆${sub === 'show' ? '' : '（最近 5 条，show 查看全部）'}：\n` +
          shown.map((item) => `[${item.type}] ${item.content}`).join('\n'),
      )
    },
  )

  // ---- 启动注入（开场：最近记忆） ----
  if (cfg.inject && existsSync(join(root, 'index.json'))) {
    const items = [...itemsOf(projectKey())]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(5, cfg.maxInject))
    injectMemories(items, `长期记忆（最近记录，共 ${items.length} 条）`)
  }

  return () => {
    offSubscribe()
    offSession()
    offSearch()
    offSave()
    offForget()
    offList()
    offCommand()
    cache = null
  }
}
