/**
 * markdown 子集解析 + 渲染的确定性测试：解析器逐块断言；渲染走真 ink（PassThrough
 * 管道渲染一个只含一条 text 条目的最小 App 视图——直接渲染 MarkdownView 组件），
 * 剥 ANSI 后断言帧文本（粗体/标题的星号井号必须消失、表格出框线、链接带补注）。
 *
 * 运行：pnpm build && node scripts/markdown-render-test.mjs
 *
 * @module dsc/scripts/markdown-render-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-md-test-'))
const { parseInline, parseMarkdown, displayWidth } = await import('../lib/app/markdown.js')
const { MarkdownView } = await import('../lib/app/MarkdownView.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ---- 行内解析 ----
const bold = parseInline('**晴到多云**，全天无雨')
check('粗体解析', bold.some((s) => s.bold && s.text === '晴到多云') && bold.some((s) => s.text === '，全天无雨'), JSON.stringify(bold))

const code = parseInline('西北风 `3-4 级` 转微风')
check('行内代码解析', code.some((s) => s.code && s.text === '3-4 级'), JSON.stringify(code))

const link = parseInline('[数据来源](https://weather.example.com) 已核对')
check('链接解析', link.some((s) => s.link === 'https://weather.example.com' && s.text === '数据来源'), JSON.stringify(link))

const snake = parseInline('变量 foo_bar_baz 与 my_var 不受斜体影响')
check('snake_case 不当斜体', !snake.some((s) => s.italic === true), JSON.stringify(snake))

const nested = parseInline('**粗体里 `code` 套**')
check('嵌套解析（粗体套代码）', nested.some((s) => s.bold && s.code && s.text === 'code'), JSON.stringify(nested))

// ---- 块解析 ----
const doc = [
  '## 结论',
  '**晴到多云**，全天无雨。',
  '',
  '- **工作目录**：`D:\\dsc`，先确认位置',
  '- 第二条',
  '',
  '1. 第一点',
  '2. 第二点',
  '',
  '| 项目 | 国内源 | 国际源 |',
  '| --- | --- | --- |',
  '| 气温 | 14 ℃ ~ 25 ℃ | 11 ℃ ~ 24 ℃ |',
  '| 降水 | 未提供 | 0% |',
  '',
  '> 引用一句',
  '',
  '```ts',
  'const x = 1',
  '```',
].join('\n')
const blocks = parseMarkdown(doc)
check('块数（标题/段/无序/有序/表/引/码）', blocks.length === 7, JSON.stringify(blocks.map((b) => b.kind)))
check('H2 标题', blocks[0].kind === 'heading' && blocks[0].level === 2)
check('段落含粗体 span', blocks[1].kind === 'paragraph' && blocks[1].rows[0].some((s) => s.bold))
check('无序列表两项', blocks[2].kind === 'list' && !blocks[2].ordered && blocks[2].items.length === 2)
check('有序列表两项', blocks[3].kind === 'list' && blocks[3].ordered && blocks[3].items.length === 2)
const table = blocks[4]
check('表格 3 列 2 行', table.kind === 'table' && table.header.length === 3 && table.rows.length === 2, JSON.stringify(table))
check('表格表头首格', table.kind === 'table' && table.header[0][0].text === '项目')
check('引用块', blocks[5].kind === 'quote')
check('代码块带语言', blocks[6].kind === 'code' && blocks[6].lang === 'ts' && blocks[6].lines[0] === 'const x = 1')

check('显示宽度 CJK=2', displayWidth('气温') === 4 && displayWidth('ab') === 2)

// 未闭合围栏不崩
const unclosed = parseMarkdown('```ts\nconst x = 1')
check('未闭合围栏照收', unclosed.length === 1 && unclosed[0].kind === 'code')

// ---- 渲染（真 ink 管道）----
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}
const stdout = new PassThrough()
stdout.columns = 100
stdout.rows = 40
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk) => {
  output += String(chunk)
})

const stripAnsi = (text) =>
  text.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
/** 本次渲染新产出的可见帧（基线之后的输出，剥 ANSI）。 */
const frameSince = (baseline) => stripAnsi(output.slice(baseline)).replace(/\n$/, '')

let baseline = output.length
render(React.createElement(MarkdownView, { source: doc }), {
  stdin,
  stdout,
  exitOnCtrlC: false,
  patchConsole: false,
})
await new Promise((resolve) => setTimeout(resolve, 300))
let frame = frameSince(baseline)
let lines = frame.split('\n')

check('标题不带井号', lines.some((l) => l.trim() === '结论') && !frame.includes('## '), JSON.stringify(lines.slice(0, 3)))
check('粗体不带星号', !frame.includes('**') && frame.includes('晴到多云，全天无雨。'))
check('行内代码不带反引号（围栏行的反引号合法）', frame.includes('D:\\dsc') && !lines.some((l) => l.includes('D:\\dsc') && l.includes('`')))
check('列表符号渲染', frame.includes('- 工作目录') && frame.includes('1. 第一点'))
check('表格框线', frame.includes('┌') && frame.includes('┼') && frame.includes('└'))
// 竖线对齐：每行表格标记的显示列位置必须一致（CJK 宽度算错的经典翻车点）
const { displayWidth: cellWidth } = await import('../lib/app/markdown.js')
const markCols = lines
  .filter((l) => /[│┌┬┐├┼┤└┴┘]/.test(l))
  .map((l) => {
    const cols = []
    let w = 0
    for (const ch of l) {
      if ('│┌┬┐├┼┤└┴┘'.includes(ch)) cols.push(w)
      w += cellWidth(ch)
    }
    return cols.join(',')
  })
check('表格竖线全对齐', new Set(markCols).size === 1, JSON.stringify(markCols))
check('表格表头居中行', lines.some((l) => l.includes('│') && l.includes('项目')), JSON.stringify(lines.filter((l) => l.includes('│'))))
check('引用符号渲染', frame.includes('▎') && frame.includes('引用一句') && !frame.includes('> 引用'))
check('围栏行保留语言、正文缩进', frame.includes('```ts') && lines.some((l) => l === '  const x = 1'), JSON.stringify(lines.filter((l) => l.includes('const x'))))

// 链接补注 url
baseline = output.length
render(React.createElement(MarkdownView, { source: '看[数据来源](https://a.b/c)即知' }), {
  stdin,
  stdout,
  exitOnCtrlC: false,
  patchConsole: false,
})
await new Promise((resolve) => setTimeout(resolve, 250))
frame = frameSince(baseline)
check('链接文本+url 补注', frame.includes('数据来源') && frame.includes('(https://a.b/c)'), JSON.stringify(frame.slice(-200)))

process.exit(failures === 0 ? 0 : 1)
