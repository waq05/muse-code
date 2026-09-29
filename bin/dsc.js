#!/usr/bin/env node
/**
 * Muse Code（msc）— 独立 TUI harness 的瘦启动器（零依赖）。
 *
 * v2 起 msc 不再经过 dsh：本文件只做参数翻译，然后 spawn
 * `node <本包>/lib/boot.js`（编译产物）。保持零 lib 依赖，全局
 * `npm i -g file:D:\dsc` 得到的 msc 命令开箱即跑。
 * （文件名沿用 dsc.js：bin 命令名由 package.json 的 bin 键决定，与文件名无关。）
 *
 * `--resume [path]` / `-c` / `--continue`：无 path 时恢复上次会话
 * （~/.dsc/.last-session 指针），有 path 时恢复指定会话 jsonl；
 * 通过环境变量 DSC_RESUME_SESSION 交给 boot（'1' = 自动 / 路径 = 指定）。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOOT = join(PKG_ROOT, 'lib', 'boot.js')

function fail(message) {
  console.error(`[msc] ${message}`)
  process.exit(1)
}

// ── 子命令：version / help ───────────────────────────────────────────────────
const first = process.argv[2]
if (first === '--version' || first === '-v') {
  let version = 'unknown'
  try {
    version = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? version
  } catch {}
  console.log(`Muse Code msc ${version}`)
  process.exit(0)
}
if (first === '--help' || first === '-h') {
  console.log(
    '用法：msc [选项] | msc config <子命令>\n' +
      '\n' +
      '选项：\n' +
      '  --resume [path]   恢复上次会话，或恢复指定 jsonl 的会话\n' +
      '  -c, --continue    同 --resume\n' +
      '\n' +
      '配置：\n' +
      '  msc config migrate [--force]   从 dsh 迁移模型配置到 ~/.dsc/config.yaml\n' +
      '  msc config show                显示当前生效的端点/模型/key 来源\n',
  )
  process.exit(0)
}

// ── 子命令：config（交给 lib/tools/config-cli.js） ───────────────────────────
if (first === 'config') {
  const child = spawn(process.execPath, [join(PKG_ROOT, 'lib', 'tools', 'config-cli.js'), ...process.argv.slice(3)], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('error', (error) => fail(`启动失败：${error.message}`))
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  // ── 参数拦截：--resume 走环境变量，其余透传给 boot ─────────────────────────
  const passthrough = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--resume' || arg === '-c' || arg === '--continue' || arg.startsWith('--resume=')) {
      let target = arg.startsWith('--resume=') ? arg.slice('--resume='.length).trim() : ''
      if (!target && arg === '--resume' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        target = argv[++i].trim()
      }
      process.env.DSC_RESUME_SESSION = target === '' ? '1' : target
    } else {
      passthrough.push(arg)
    }
  }

  // ── 启动：node lib/boot.js ────────────────────────────────────────────────
  const child = spawn(process.execPath, [BOOT, ...passthrough], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('error', (error) => fail(`启动失败：${error.message}`))
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}
