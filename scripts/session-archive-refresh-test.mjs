/**
 * 归档后列表缓存自刷新的直测（0.6.49 报障：组菜单「删除工作区」之后侧栏的组不消失）。
 *
 * 事故形状：`session.archive` 把 jsonl 挪进 `.archived/`、写了 sidecar，但不重扫会话
 * 列表缓存——快照的 `sessions` 字段读的就是这份缓存（`plugins/transcript.ts` 的
 * `sessions: ctx.session.sessions`），于是归档成功的会话仍按活动区留在侧栏，用户看到
 * 的是「工作区删不掉」；再点一次那个会话行还会撞 ENOENT（文件已经被挪走了）。
 *
 * 断言：
 *   1. 归档前 refresh 后缓存里有两条活动会话；
 *   2. archive 返回后同一份缓存里不再有被归档的那条（不需要调用方再 refresh）；
 *   3. 归档后缓存里多出那条带 archivedAt 的记录（归档区可见）；
 *   4. 没有被归档的那条仍在活动区（没误伤）；
 *   5. archive 期间发过 dsc/changed（宿主据此推快照，侧栏才会跟着变）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/session-archive-refresh-test.mjs
 *
 * @module dsc/scripts/session-archive-refresh-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-archive-refresh-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { sessionPlugin } = await import('../lib/plugins/session.js')
const { sessionsRoot, slugCwd } = await import('../lib/core/session.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ---- 造两条活动会话：cwd 是临时工作目录，日志放 sessions/<slugCwd(cwd)>/ ----
const work = join(home, 'work')
mkdirSync(work, { recursive: true })
const dir = join(sessionsRoot(), slugCwd(work))
mkdirSync(dir, { recursive: true })

const writeSession = (id, text) => {
  const file = join(dir, `${id}.jsonl`)
  const lines = [
    { type: 'meta', id, cwd: work, createdAt: Date.now() },
    { type: 'user', text },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}
const keep = writeSession('11111111-1111-4111-8111-111111111111', '保留的会话')
const gone = writeSession('22222222-2222-4222-8222-222222222222', '要归档的会话')

// ---- 假 ctx：只给插件真正用到的那几个口子（provide / on / get / emit） ----
let service
const events = []
const ctx = {
  provide: (name, value) => {
    if (name === 'session') service = value
  },
  on: () => {},
  get: () => undefined,
  emit: (name) => {
    events.push(name)
  },
}
sessionPlugin.apply(ctx, { cwd: work, resumeSessionPath: keep })

check('apply 提供了 session 服务', typeof service?.archive === 'function')

await service.refresh()
const liveSessions = () => service.sessions.filter((item) => item.archivedAt === undefined)
check('归档前两条都在活动区', liveSessions().length === 2, `实际 ${String(liveSessions().length)}`)

events.length = 0
const result = await service.archive([gone])
check('archive 报成功', result.ok === true, JSON.stringify(result))

const live = liveSessions().map((item) => item.id)
check('归档后缓存里不再有它（活动区）', !live.includes(gone), live.join(', '))
check('归档后缓存里有它（带 archivedAt）',
  service.sessions.some((item) => item.id.endsWith(gone.slice(gone.lastIndexOf('\\') + 1)) && typeof item.archivedAt === 'number'))
check('没被归档的那条还在活动区', live.includes(keep), live.join(', '))
check('archive 期间发过 dsc/changed', events.includes('dsc/changed'), events.join(', '))

console.log(failures === 0 ? 'session-archive-refresh: ALL PASS' : `session-archive-refresh: ${String(failures)} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
