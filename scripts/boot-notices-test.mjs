/**
 * 启动提示只展示一次（0.6.64）的确定性测试：
 *   1. bootNoticeOnce helper 直测——同 key 同文不再发、变文重发、不同 key 互不影响、状态落盘；
 *   2. 同一 HOME 连续两次 createKernel（resumeSessionPath: 'auto'，真实入口同款）——
 *      第一次转录里有「会话横幅」与「沙箱已就绪」，第二次被抑制。
 *
 * 运行：node scripts/boot-notices-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/boot-notices-test
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-boot-notices-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

console.log('── helper 直测：同文不发、变文重发 ──')
const { bootNoticeOnce } = await import('../lib/core/boot-notices.js')
check('首次展示返回 true', bootNoticeOnce('probe', '文本A') === true)
check('同 key 同文返回 false', bootNoticeOnce('probe', '文本A') === false)
check('同 key 变文返回 true', bootNoticeOnce('probe', '文本B') === true)
check('不同 key 互不影响', bootNoticeOnce('probe2', '文本B') === true)
check('状态落在 ~/.dsc/boot-notices.json', existsSync(join(home, '.dsc', 'boot-notices.json')))

console.log('── 双次内核启动：第二次横幅与沙箱提示被抑制 ──')
const { createKernel, emitStartupNotes } = await import('../lib/host/kernel.js')

// 预置一个可恢复的会话（'auto' 恢复要求 jsonl 真实存在，否则静默开新会话——
// 新会话的横幅文本不同，重发是正确行为，就测不出「同会话抑制」了）
const sessionId = 'aa11bb22-cc33-dd44-ee55-ff6677889900'
const sessionDir = join(home, '.dsc', 'sessions', 'D-w')
mkdirSync(sessionDir, { recursive: true })
const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: 'meta', id: sessionId, cwd: 'D:\\w', createdAt: 1 })}\n${JSON.stringify({ type: 'user', text: '你好' })}\n`,
  'utf8',
)
writeFileSync(join(home, '.dsc', '.last-session'), sessionFile, 'utf8')

const entryTexts = (kernel) => {
  // transcript 服务的 getSnapshot 就是运行时快照（TUI 订阅的同一份）
  return ((kernel.transcript?.getSnapshot() ?? {}).entries ?? []).map((entry) => String(entry.text ?? ''))
}
const hasBanner = (texts) => texts.some((text) => text.includes('· 模型'))
const hasSandbox = (texts) => texts.some((text) => text.includes('沙箱已就绪'))

// boot.ts/headless.ts 的真实顺序：createKernel → emitStartupNotes（横幅在这里写）
const kernel1 = await createKernel({ config: {}, resumeSessionPath: 'auto' })
emitStartupNotes(kernel1, null, { providers: {} })
await sleep(400)
const texts1 = entryTexts(kernel1)
check('首次启动有会话横幅（会话 xxx · 模型 yyy）', hasBanner(texts1), JSON.stringify(texts1.slice(0, 6)))
check('首次启动有沙箱就绪提示', hasSandbox(texts1), JSON.stringify(texts1.slice(0, 6)))

const kernel2 = await createKernel({ config: {}, resumeSessionPath: 'auto' })
emitStartupNotes(kernel2, null, { providers: {} })
await sleep(400)
const texts2 = entryTexts(kernel2)
check('第二次启动横幅被抑制', !hasBanner(texts2), JSON.stringify(texts2.slice(0, 6)))
check('第二次启动沙箱提示被抑制', !hasSandbox(texts2), JSON.stringify(texts2.slice(0, 6)))

console.log('')
if (failures === 0) {
  console.log('启动提示电池：全部通过')
} else {
  console.log(`启动提示电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
