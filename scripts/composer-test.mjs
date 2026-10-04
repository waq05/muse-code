/**
 * Composer 候补面板的确定性测试：用自定义 stdin/stdout 驱动 ink 渲染，
 * 逐键断言输出帧内容（不依赖真实终端的键盘管道）。
 *
 * 覆盖：命令候选 / 模型候选（/model 参数阶段）/ ↑↓ 选择 / Tab 补全 /
 * Esc 抑制 / 唯一前缀展开 / 输入框无占位文案。
 *
 * 运行：node scripts/composer-test.mjs
 *
 * @module dsc/scripts/composer-test
 */
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import { Composer } from '../lib/app/Composer.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MODELS = [
  { value: 'ark/deepseek-v4-pro', provider: 'ark', model: 'deepseek-v4-pro', description: '火山方舟 Agent Plan · 256k 上下文' },
  { value: 'ark/glm-5.3-flash', provider: 'ark', model: 'glm-5.3-flash', description: '火山方舟 Agent Plan · 1000k 上下文' },
  { value: 'hy3-a/hy3-a', provider: 'hy3-a', model: 'hy3-a', description: 'hy3-a · 256k 上下文' },
]

const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const stdout = new PassThrough()
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false

let output = ''
stdout.on('data', (chunk) => {
  output += String(chunk)
})

const KEY = { down: '\u001b[B', up: '\u001b[A', tab: '\t', esc: '\u001b', enter: '\r' }

const submitted = []
const instance = render(
  React.createElement(Composer, {
    disabled: false,
    models: MODELS,
    onSubmit: (text) => submitted.push(text),
  }),
  { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 清空累积输出并输入一串按键，返回最后一次渲染的整帧文本。 */
const press = async (keys) => {
  output = ''
  stdin.write(keys)
  await sleep(150)
  return output
}

console.log('Composer 候补面板测试')

// 0. 空输入：无占位文案，只有提示符和光标（检查初始渲染帧）
await sleep(150)
check('空输入无占位文案', !output.includes('说点什么') && output.includes('❯'))

// 1. 输入 / 弹出全部命令
let frame = await press('/')
check('输入 / 后面板出现', frame.includes('/new') && frame.includes('/resume'))
check('面板含参数提示', frame.includes('/model <[端点/]模型名>'))
check('面板含操作提示', frame.includes('Tab 补全'))

// 2. ↑↓ 选择移动（/agents 插入后 /compact 顺延一位）
frame = await press(KEY.down + KEY.down + KEY.down)
const selected = frame.split('\n').find((line) => line.includes('❯') && line.includes('/'))
check('↓↓↓ 后选中项变为 /compact', selected !== undefined && selected.includes('/compact'), `实际：${selected}`)

// 3. Tab 补全无参命令（填满输入框）
frame = await press(KEY.tab)
// 0.6.57 起假光标 ▏ 换成 ink useCursor 的物理光标（帧尾 G 序列 + ?25h）
check('Tab 补全为 /compact', frame.includes('❯ /compact'))

// 4. Esc 关闭面板，且输入变化前不再出现
frame = await press(KEY.esc)
check('Esc 后面板消失', !frame.includes('恢复历史会话'))
frame = await press('q')
check('输入变化前面板保持关闭', !frame.includes('新建会话'))

// 5. 清掉多余按键（逐键退格），输入 /mo 触发命令前缀过滤
for (let i = 0; i < 12; i += 1) await press('\u007f')
frame = await press('/mo')
check('/mo 命令过滤只剩 /model', frame.includes('/model') && !frame.includes('/new'), JSON.stringify(frame.slice(-300)))

// 6. Tab 补全 /model（填入带尾空格的 /model ）→ 面板切换为模型候选列表
frame = await press(KEY.tab)
check('空格后展示模型候选', frame.includes('ark/deepseek-v4-pro') && frame.includes('hy3-a/hy3-a'), JSON.stringify(frame.slice(-400)))
check('模型候选带说明', frame.includes('256k 上下文'))

// 7. ↓ 选中第二个模型 + Tab 补全（精确匹配后面板关闭）
frame = await press(KEY.down)
const modelSelected = frame.split('\n').find((line) => line.includes('❯') && line.includes('ark/'))
check('↓ 后选中 ark/glm-5.3-flash', modelSelected !== undefined && modelSelected.includes('ark/glm-5.3-flash'), `实际：${modelSelected}`)
frame = await press(KEY.tab)
check('Tab 补全为 /model ark/glm-5.3-flash', frame.includes('❯ /model ark/glm-5.3-flash'), JSON.stringify(frame.slice(-300)))
check('物理光标停靠序列存在（IME 预览落输入框）', /\[\d+G/.test(frame) && frame.includes('[?25h'), JSON.stringify(frame.slice(-80)))
check('补全后面板关闭', !frame.includes('hy3-a/hy3-a'))

// 8. 模型名前缀过滤（/model deep → 只留 deepseek）
for (let i = 0; i < 40; i += 1) await press('\u007f')
frame = await press('/model deep')
check('/model deep 过滤只剩 deepseek-v4-pro', frame.includes('deepseek-v4-pro') && !frame.includes('glm-5.3-flash'), JSON.stringify(frame.slice(-300)))

// 9. Enter 提交模型选择
await press(KEY.enter)
check('Enter 提交 /model deepseek-v4-pro（唯一前缀展开）', submitted[submitted.length - 1] === '/model ark/deepseek-v4-pro', JSON.stringify(submitted))

// 10. 命令唯一前缀展开
for (let i = 0; i < 40; i += 1) await press('\u007f')
await press('/ne')
await press(KEY.enter)
check('/ne + Enter 自动展开为 /new', submitted[submitted.length - 1] === '/new', JSON.stringify(submitted))

instance.unmount()
stdin.end()

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
