/**
 * 0.6.26 宿主直测：审批卡「将做的改动」推演 + /review 的改动收集与消息组装 +
 * 渲染层 unified diff 解析器（type stripping 直接跑 TS 源，import type 剥掉后零依赖）。
 *
 * 不走真模型（限流期）：approvalDiffOf / collectWorkingTree / reviewMessage /
 * parseUnifiedDiff 都是纯函数或 fs+git 级函数，临时目录 + 临时 git 仓库直接断言。
 *
 * 运行：pnpm build && node scripts/review-approval-test.mjs
 *
 * @module dsc/scripts/review-approval-test
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalDiffOf } from '../lib/plugins/approval.js'
import { collectWorkingTree } from '../lib/core/git-info.js'
import { reviewMessage } from '../lib/core/git-info.js'
import { parseUnifiedDiff, splitUnifiedDiffByFile } from '../desktop/src/renderer/unified-diff.ts'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsc-626-test-'))

console.log('审批卡「将做的改动」推演（approvalDiffOf）')

// ── 1. write 新建：盘上不存在 → 从空串起算，整篇新增，fellBack ──
{
  const file = join(root, 'new-file.txt')
  const view = await approvalDiffOf({
    toolName: 'write',
    argsSummary: 'write new-file.txt',
    args: { path: file, content: 'line1\nline2\n' },
    cwd: root,
  })
  check('write 新建算出 diff', view !== null && view.hunks.length === 1, JSON.stringify(view))
  check('write 新建 status=added 且计数 +2 -0', view !== null && view.status === 'added' && view.added === 2 && view.removed === 0)
  check('write 新建标 fellBack（文件当时不存在）', view?.fellBack === true)
  check('write 新建不带 baseline 内存字段', view !== null && !Object.hasOwn(view, 'baseline'))
}

// ── 2. write 覆盖已有文件：盘上现值在手 → modified，无 fellBack ──
{
  const file = join(root, 'exists.txt')
  writeFileSync(file, 'old line\n', 'utf8')
  const view = await approvalDiffOf({
    toolName: 'write',
    argsSummary: 'write exists.txt',
    args: { path: file, content: 'new one\nnew two\n' },
    cwd: root,
  })
  check('write 覆盖 status=modified、fellBack 缺省', view !== null && view.status === 'modified' && view.fellBack === undefined)
  check('write 覆盖的 diff 反映盘上旧值', view?.hunks[0]?.lines.some((line) => line.kind === 'remove' && line.text === 'old line') === true)
}

// ── 3. edit 正常替换：old 唯一命中盘上现值 ──
{
  const file = join(root, 'code.ts')
  writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
  const view = await approvalDiffOf({
    toolName: 'edit',
    argsSummary: 'edit code.ts',
    args: { path: file, old: 'const b = 2', new: 'const b = 42' },
    cwd: root,
  })
  check('edit 替换算出 diff 且无 mismatch', view !== null && view.mismatch === undefined && view.hunks.length === 1)
  check('edit 替换的行内容正确', view?.hunks[0]?.lines.some((line) => line.kind === 'add' && line.text === 'const b = 42') === true)
}

// ── 4. edit old 匹配不到 / 匹配多处：mismatch + old→new 参数差异 ──
{
  const file = join(root, 'code.ts')
  const missing = await approvalDiffOf({
    toolName: 'edit',
    argsSummary: 'edit code.ts',
    args: { path: file, old: 'not in file', new: 'x' },
    cwd: root,
  })
  check('edit old 不存在标 mismatch=missing', missing?.mismatch === 'missing' && missing.fellBack === undefined)
  const file2 = join(root, 'dup.ts')
  writeFileSync(file2, 'same\nsame\n', 'utf8')
  const ambiguous = await approvalDiffOf({
    toolName: 'edit',
    argsSummary: 'edit dup.ts',
    args: { path: file2, old: 'same', new: 'x' },
    cwd: root,
  })
  check('edit old 多处标 mismatch=ambiguous', ambiguous?.mismatch === 'ambiguous')
}

// ── 5. 工作区外（读不到盘）的 edit：fellBack + old→new 参数差异 ──
{
  const view = await approvalDiffOf({
    toolName: 'edit',
    argsSummary: 'edit outside.txt',
    args: { path: 'D:\\definitely-not-here\\outside.txt', old: 'old text', new: 'new text' },
    cwd: root,
  })
  check('读不到盘的 edit 标 fellBack', view?.fellBack === true)
  check('读不到盘的 edit diff 是 old→new', view?.hunks[0]?.lines.some((line) => line.kind === 'remove' && line.text === 'old text') === true)
}

// ── 6. 非 write/edit / 参数不齐 → null；hunks 文本过 redact ──
{
  check('bash 不推演', (await approvalDiffOf({ toolName: 'bash', argsSummary: 'ls', args: { command: 'ls' }, cwd: root })) === null)
  check('write 缺 content 为 null', (await approvalDiffOf({ toolName: 'write', argsSummary: 'w', args: { path: join(root, 'x') }, cwd: root })) === null)
  const file = join(root, 'secret.txt')
  writeFileSync(file, 'hello\n', 'utf8')
  const view = await approvalDiffOf({
    toolName: 'write',
    argsSummary: 'write secret.txt',
    args: { path: file, content: 'token = "sk-abcdefghijklmnop123456"\n' },
    cwd: root,
  })
  const joined = JSON.stringify(view?.hunks ?? [])
  check('hunks 里的密钥形状被遮红', !joined.includes('sk-abcdefghijklmnop123456'), joined)
}

console.log('/review 的改动收集与消息组装')

// ── 7. 非 git 目录 → null ──
check('非 git 目录返回 null', (await collectWorkingTree(root)) === null)

// ── 8. 临时 git 仓库：已跟踪改动进 diff，新文件列 untracked ──
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git('init', '-b', 'main')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8')
git('add', '.')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add tracked')
writeFileSync(join(repo, 'tracked.txt'), 'one\nTWO!\n', 'utf8')
writeFileSync(join(repo, 'fresh.txt'), 'brand new\n', 'utf8')
const collected = await collectWorkingTree(repo)
check('git 仓库收集到 diff', collected !== null && collected.diff.includes('-two') && collected.diff.includes('+TWO!'), JSON.stringify(collected?.diff.slice(0, 120)))
check('untracked 只列名单不进 diff', collected?.untracked.length === 1 && collected.untracked[0] === 'fresh.txt' && !collected.diff.includes('brand new'))

// ── 9. 消息组装：关注点 / diff / untracked 名单 ──
{
  const message = reviewMessage({ diff: 'diff --git a/x b/x', untracked: ['fresh.txt'] }, '只看安全')
  check('消息带关注点', message.includes('关注点：只看安全'))
  check('消息带 diff 与未跟踪名单', message.includes('diff --git a/x b/x') && message.includes('- fresh.txt'))
  const noDiff = reviewMessage({ diff: '', untracked: ['a.txt'] }, '')
  check('只有未跟踪文件时说明空白', noDiff.includes('只有未跟踪的新文件') && !noDiff.includes('关注点'))
}

console.log('渲染层 unified diff 解析器')

// ── 10. parseUnifiedDiff：@@ 头、上下文/增删、\ No newline 容错、计数以实际行为准 ──
{
  const sample = [
    'diff --git a/x.ts b/x.ts',
    'index 111..222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-gone',
    '+here',
    '+again',
    ' tail',
    '\\ No newline at end of file',
  ].join('\n')
  const hunks = parseUnifiedDiff(sample)
  check('解析出 1 个 hunk', hunks.length === 1, JSON.stringify(hunks))
  const lines = hunks[0]?.lines ?? []
  check('行类型与文本正确', lines.length === 5 && lines[0]?.kind === 'context' && lines[1]?.kind === 'remove' && lines[2]?.text === 'here')
  check('hunk 头行号正确', hunks[0]?.oldStart === 1 && hunks[0]?.newStart === 1)
  check('计数按实际行算（new=4、old=3）', hunks[0]?.newCount === 4 && hunks[0]?.oldCount === 3)
}

// ── 11. splitUnifiedDiffByFile：全量 diff 切段、取 b/ 侧路径、counts ──
{
  const sample = [
    'diff --git a/src/one.ts b/src/one.ts',
    'index 111..222 100644',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/two.ts b/src/two.ts',
    'index 333..444 100644',
    '--- a/src/two.ts',
    '+++ b/src/two.ts',
    '@@ -5,2 +5,1 @@',
    ' c',
    '-d',
  ].join('\n')
  const files = splitUnifiedDiffByFile(sample)
  check('切成两段且路径取 b/ 侧', files.length === 2 && files[0]?.path === 'src/one.ts' && files[1]?.path === 'src/two.ts')
  check('每段计数正确', files[0]?.added === 1 && files[0]?.removed === 1 && files[1]?.removed === 1 && files[1]?.added === 0)
  check('无 diff 体给空数组', splitUnifiedDiffByFile('everything clean').length === 0)
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
