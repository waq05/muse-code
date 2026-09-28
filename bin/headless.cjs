/**
 * dsc headless 宿主的 CJS 兼容入口。
 *
 * Electron 的 utilityProcess.fork 只加载 CJS 主模块，而 dsc 的编译产物是
 * ESM（package type: module）——本 shim 以动态 import 加载真正的 ESM 入口
 * lib/headless.js。同时它必须在同步阶段注册一条 parentPort 空监听：
 * utilityProcess 环境下保活进程（协议监听与装配在 ESM 侧完成）。
 *
 * 用法（桌面端）：
 *   utilityProcess.fork(<dsc>/bin/headless.cjs, [], { cwd })
 * 用法（终端手测，stdin/stdout JSONL）：
 *   node <dsc>/bin/headless.cjs
 */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

const entry = pathToFileURL(join(__dirname, '..', 'lib', 'headless.js')).href

if (process.parentPort !== undefined) {
  // utilityProcess：同步注册监听保活（真正的协议处理在 ESM 侧的 host-stdio 插件）
  process.parentPort.on('message', () => {})
}

import(entry).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  if (process.parentPort !== undefined) {
    process.parentPort.postMessage({
      type: 'result',
      id: 0,
      ok: false,
      error: `宿主加载失败：${message}`,
    })
  } else {
    console.error('[dsc] headless 加载失败：', message)
  }
  process.exit(1)
})
