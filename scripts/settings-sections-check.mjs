/**
 * 设置分区投影自检：内置分区 / 插件贡献分区 / 声明了 inSettings 的「插件代管但归设置页」分区。
 *
 * 为什么单独立一张网：桌面端设置页只列 `builtin: true` 的分区，而 remote 插件注册的
 * 「远程控制」分区原先 builtin 为 false，又不属于插件中心那档（remote 插件由 boot/headless
 * 直接挂载，没有插件卡），于是两头落空——设置的入口在界面上根本点不开。这一批给
 * `SettingsService.registerSection` 加了第二参 `{ inSettings: true }`，投影的 `builtin`
 * 取 `section.inSettings === true || 原判定`。
 *
 * 断言三件事：
 *   1. 远程控制分区在 listSections 里 builtin=true（桌面端因此过滤得到它）；
 *   2. 插件中心的清单（listPlugins）不受影响：注册前后逐字节一致，投影里也不多出 inSettings 字段；
 *   3. 不传第二参的插件分区照旧 builtin=false（外部插件不会因此挤进设置页）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/settings-sections-check.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const shotHome = mkdtempSync(join(tmpdir(), 'dsc-settings-sections-'))
process.env.HOME = shotHome
process.env.USERPROFILE = shotHome
mkdirSync(join(shotHome, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(shotHome, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { remotePlugin } = await import('../lib/plugins/remote.js')

let failures = 0
function check(label, condition, extra = '') {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

/** 分区投影的字段是 IPC 契约，多一个字段就等于改了协议——这里按名单核对。 */
const VIEW_KEYS = 'builtin,custom,fields,groups,id,order,subtitle,title'

const kernel = await createKernel({ config: {}, resumeSessionPath: undefined })
const pluginsBefore = kernel.ui.listPlugins()
const sectionsBefore = kernel.settings.sections()

console.log('── 内核自己的分区照旧内置 ──')
for (const id of ['general', 'models', 'skills', 'archive', 'usage', 'about']) {
  const view = sectionsBefore.find((section) => section.id === id)
  check(`${id} 仍在设置页（builtin=true）`, view !== undefined && view.builtin === true, JSON.stringify(view?.builtin))
}
check(
  '分区投影的字段名一份不多（inSettings 不进 IPC）',
  sectionsBefore.every((section) => Object.keys(section).sort().join(',') === VIEW_KEYS),
  JSON.stringify(Object.keys(sectionsBefore[0] ?? {}).sort().join(',')),
)

console.log('\n── 远程控制：插件代管，但要进设置页 ──')
const beforeMount = kernel.ui.listPlugins()
await kernel.plugin(remotePlugin, {})
const afterMount = kernel.ui.listPlugins()
const remote = kernel.settings.sections().find((section) => section.id === 'remote')
check('远程控制分区已注册', remote !== undefined, JSON.stringify(kernel.settings.sections().map((s) => s.id)))
check('远程控制分区 builtin=true（桌面端设置页因此列得到它）', remote?.builtin === true, String(remote?.builtin))
check('远程控制分区还是那张通用表单（fields 有控件）', (remote?.fields ?? []).length > 0, String(remote?.fields?.length))
check(
  '远程控制不在插件中心的清单里（它由 boot/headless 直接挂载，没有插件卡）',
  afterMount.every((item) => item.file !== 'remote'),
  JSON.stringify(afterMount.map((item) => item.file)),
)
check(
  '挂上远程控制插件不改变插件中心清单',
  JSON.stringify(beforeMount) === JSON.stringify(afterMount),
  `${beforeMount.length} → ${afterMount.length}`,
)

console.log('\n── 终端界面：TUI 自己的显示偏好 ──')
const tuiSectionView = kernel.settings.sections().find((section) => section.id === 'tui')
check('终端界面分区已注册', tuiSectionView !== undefined, JSON.stringify(kernel.settings.sections().map((s) => s.id)))
check('终端界面分区是声明式（非 custom，两端同一张表渲染）', tuiSectionView?.custom === false, String(tuiSectionView?.custom))
check(
  '思考块默认展开开关在字段表里',
  tuiSectionView?.fields.some((field) => field.key === 'reasoningDefaultOpen') === true,
  JSON.stringify(tuiSectionView?.fields.map((field) => field.key)),
)
const tuiSaved = await kernel.settings.save('tui', 'reasoningDefaultOpen', true)
check('写入思考块默认展开成功', tuiSaved.ok === true, JSON.stringify(tuiSaved))
check('成功回执走 notice（不进 error 字段）', tuiSaved.ok === true && tuiSaved.notice !== undefined, JSON.stringify(tuiSaved))
check('值落到了 prefs.ui（ui 层深合并不动其它键）', kernel.settings.prefs().ui.reasoningDefaultOpen === true, String(kernel.settings.prefs().ui.reasoningDefaultOpen))

console.log('\n── 浏览器自动化：字段收成分组（0.6.62 的子页导航数据面） ──')
const { browserPlugin } = await import('../lib/plugins/browser.js')
await kernel.plugin(browserPlugin, {})
const browserSectionView = kernel.settings.sections().find((section) => section.id === 'browser')
const browserGroups = browserSectionView?.groups ?? []
check(
  '浏览器分区声明了四组',
  JSON.stringify(browserGroups.map((group) => group.id)) === JSON.stringify(['startup', 'safety', 'runtime', 'status']),
  JSON.stringify(browserGroups),
)
check(
  '每个带组字段的 group 都指向声明过的组',
  (browserSectionView?.fields ?? []).every((field) => field.group === undefined || browserGroups.some((group) => group.id === field.group)),
  JSON.stringify((browserSectionView?.fields ?? []).map((field) => field.group)),
)
check(
  '分区里没有无组字段（15 个全收进了组）',
  (browserSectionView?.fields ?? []).some((field) => field.group === undefined) === false,
  JSON.stringify((browserSectionView?.fields ?? []).filter((field) => field.group === undefined).map((field) => field.label)),
)

console.log('\n── 终端界面：状态栏段开关（prefs.ui.statusBar） ──')
const statusBarFields = (tuiSectionView?.fields ?? []).filter((field) => String(field.key).startsWith('statusBar.'))
check('状态栏组声明在 tui 分区上', (tuiSectionView?.groups ?? []).some((group) => group.id === 'status-bar'), JSON.stringify(tuiSectionView?.groups))
check('状态栏组有 10 个开关', statusBarFields.length === 10, JSON.stringify(statusBarFields.map((field) => field.key)))
const barSaved = await kernel.settings.save('tui', 'statusBar.model', false)
check('状态栏开关保存成功且静默（无 notice）', barSaved.ok === true && barSaved.notice === undefined, JSON.stringify(barSaved))
check('prefs.ui.statusBar 深合并不动其它段', kernel.settings.prefs().ui.statusBar.model === false && kernel.settings.prefs().ui.reasoningDefaultOpen === true, JSON.stringify(kernel.settings.prefs().ui.statusBar))

console.log('\n── 插件贡献的分区：不传第二参照旧不进设置页 ──')
const offPlain = kernel.settings.registerSection({
  id: 'probe-plain',
  title: '普通插件分区',
  order: 999,
  fields: () => [],
  values: () => ({}),
})
const offInSettings = kernel.settings.registerSection(
  { id: 'probe-in-settings', title: '声明进设置页的插件分区', order: 998, fields: () => [], values: () => ({}) },
  { inSettings: true },
)
const withProbes = kernel.settings.sections()
const plain = withProbes.find((section) => section.id === 'probe-plain')
const declared = withProbes.find((section) => section.id === 'probe-in-settings')
check('不传第二参的插件分区 builtin=false（不挤进设置页）', plain?.builtin === false, String(plain?.builtin))
check('传了 { inSettings: true } 的插件分区 builtin=true', declared?.builtin === true, String(declared?.builtin))
check(
  '注册插件分区不改变插件中心清单',
  JSON.stringify(kernel.ui.listPlugins()) === JSON.stringify(pluginsBefore),
  `${pluginsBefore.length} → ${kernel.ui.listPlugins().length}`,
)
check(
  '新注册的分区投影同样只有那八个字段',
  withProbes.every((section) => Object.keys(section).sort().join(',') === VIEW_KEYS),
  JSON.stringify(Object.keys(declared ?? {}).sort().join(',')),
)
check(
  '插件中心清单里没有 inSettings 字段泄漏',
  !JSON.stringify(kernel.ui.listPlugins()).includes('inSettings'),
)

console.log('\n── 退订与只读闸门 ──')
offInSettings()
check(
  '退订后分区消失',
  !kernel.settings.sections().some((section) => section.id === 'probe-in-settings'),
)
const saveDenied = await kernel.settings.save('probe-in-settings', 'x', 'y')
check('退订后的分区写不进去', saveDenied.ok === false, JSON.stringify(saveDenied))
offPlain()
check('远程控制分区仍在（退订互不影响）', kernel.settings.sections().some((section) => section.id === 'remote'))

console.log('')
if (failures === 0) {
  console.log('设置分区投影自检：全部通过')
  rmSync(shotHome, { recursive: true, force: true })
} else {
  console.log(`设置分区投影自检：${failures} 条失败（临时 HOME 留在 ${shotHome} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
