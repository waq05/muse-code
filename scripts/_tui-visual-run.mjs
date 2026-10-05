/**
 * TUI 视觉走查启动器（开发辅助，不进测试电池）：隔离 DSC_HOME + 假 OpenAI 端点
 * 驱动真 TUI，回包是富 markdown（标题/粗体/表格/列表/行内代码/链接），把渲染层
 * 的差距直接暴露在实机截图里。思考流用 reasoning_content 驱动。
 *
 * 用法：node scripts/_tui-visual-run.mjs   （Ctrl+C 两次退出；HOME 全程隔离）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsc-visual-'))
// migrate.ts 的配置/会话路径钉在 homedir()（Windows = USERPROFILE）；DSC_HOME 的
// 语义是「.dsc 目录本身」——三件套一起设才是完全隔离（与 resident-agents-test 同款）。
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
process.env.FAKE_KEY = 'k'
process.env.NO_COLOR = ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MARKDOWN_REPLY = [
  '## 结论',
  '**晴到多云**，全天无雨；西北风 `3-4 级`，白天体感舒适，适合出门。',
  '',
  '两路数据对照：',
  '',
  '| 项目 | 国内源（中国天气网） | 国际源（Open-Meteo） |',
  '| --- | --- | --- |',
  '| 气温 | 14 ℃ ~ 25 ℃（市区） | 11 ℃ ~ 24 ℃ |',
  '| 降水概率 | 未提供 | 0%（逐时 0-2mm） |',
  '| 风向风力 | 西北风 3-4 级转微风 | 315° 西北风 12 km/h |',
  '',
  '- **工作目录**：`D:\\dsc`，真要动文件我会先确认位置，别误伤',
  '- [数据来源](https://weather.example.com) 已核对，查询时刻 `2026-10-06 01:18`',
  '',
  '1. 国内源是市区观测站预报值，国际源是网格模式插值',
  '2. 降水两家一致，可以放心不带伞',
  '',
  '想让我接着干什么？例如「看看某个项目的结构」或者「修个报错」，我直接上。',
].join('\n')

const sseDeltas = (deltas) =>
  deltas
    .map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
    .join('')
const sseEnd = () =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9_876, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 9_700 } } })}\n\n` +
  'data: [DONE]\n\n'

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
    } catch {}
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const isTitle = messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('标题'),
    )
    if (isTitle) {
      res.end(sseDeltas([{ content: '视觉走查的会话标题' }]) + sseEnd())
      return
    }
    // 思考流 → markdown 正文，分两段写出（finish 只在最后，别把回合提前收掉）
    const contentChunks = MARKDOWN_REPLY.match(/[\s\S]{1,60}/g) ?? []
    res.write(
      sseDeltas([
        { reasoning_content: '用户问天气。' },
        { reasoning_content: '两家信源已核对，直接给合并结论。' },
      ]),
    )
    await sleep(900)
    res.write(sseDeltas(contentChunks.map((content) => ({ content }))))
    res.end(sseEnd())
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })
writeFileSync(
  join(dscHome, 'config.yaml'),
  [
    'providers:',
    '  fake:',
    '    displayName: FakeLLM',
    `    baseURL: http://127.0.0.1:${port}`,
    '    apiKeyEnv: FAKE_KEY',
    '    models:',
    '      - id: m',
    '        name: fake-flash',
    '        contextWindow: 1000000',
    '        maxTokens: 4096',
    'defaultProvider: fake',
    'defaultModel: m',
    '',
  ].join('\n'),
  'utf8',
)

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
console.log(`[visual] DSC_HOME=${home}`)
console.log(`[visual] fake endpoint http://127.0.0.1:${port}`)
const child = spawn(process.execPath, [join(pkgRoot, 'bin', 'dsc.js')], {
  stdio: 'inherit',
  env: process.env,
  cwd: pkgRoot,
})
child.on('exit', (code) => {
  server.close()
  process.exit(code ?? 0)
})
