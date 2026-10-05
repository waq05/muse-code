/**
 * tui 插件：进程内 UI 插件——把 runtime 服务挂到 ink 终端界面。
 * 迁自 v2 boot.ts 的挂载逻辑；App 组件与 contract.ts 契约零改动。
 *
 * 0.6.66 起整帧跑在备用屏（DEC 1049，dsh-tui/codex 同款）：帧是「终端行数−1」
 * 的整屏视口，内联渲染一旦被滚动（历史输出、终端重排）挪了锚点，ink 卸载的
 * 擦除就擦错行——退出后残帧和 shell 提示交错。备用屏里随便折腾，1049l 一写
 * 主屏原样还原；`process.on('exit')` 兜底让崩溃路径也能退出备用屏（只还原、
 * 不告别——崩溃时「会话已保存」不一定是真话）。
 *
 * @module dsc/plugins/tui
 */
import React from 'react'
import { render, type Instance } from 'ink'
import type { Plugin } from '@deepseek-ai/cordis'
import { App } from '../app/App.js'

const ENTER_ALT = '\x1b[?1049h\x1b[2J\x1b[H'
const LEAVE_ALT = '\x1b[?1049l'
const GOODBYE = 'Muse Code 已退出，会话已保存（/resume 可继续）。'

export const tuiPlugin: Plugin.Object = {
  name: 'tui',
  inject: ['ui'],
  apply(ctx) {
    const runtime = ctx.ui
    const stdout = process.stdout
    const altScreen = stdout.isTTY === true
    if (altScreen) stdout.write(ENTER_ALT)
    // 有人在看：审批插件据此弹人工审批卡；没有这个登记时它按「无人应答」立刻拒掉，不白等超时。
    const offInteractive = ctx.provide('interactive', { kind: 'tui' as const, reachable: () => true })
    // exitOnCtrlC=false：Ctrl+C 交给 App（一次打断 / 双击退出）。
    const instance: Instance = render(React.createElement(App, { runtime }), { exitOnCtrlC: false })

    const leaveAlt = (): void => {
      if (altScreen) stdout.write(LEAVE_ALT)
    }
    // 正常退出路径专用的告别（崩溃兜底走 process 'exit'，那里只还原屏幕）
    const leaveAltWithGoodbye = (): void => {
      if (!altScreen) return
      leaveAlt()
      stdout.write(`${GOODBYE}\n`)
    }
    if (altScreen) process.on('exit', leaveAlt)

    // dsc/exit 与 disposer 可能都跑（exit 先 emit、dispose 再收尾）：卸载只做一次
    let tornDown = false
    const teardown = (goodbye: boolean): void => {
      if (tornDown) return
      tornDown = true
      instance.unmount()
      if (goodbye) leaveAltWithGoodbye()
      else leaveAlt()
      if (altScreen) process.removeListener('exit', leaveAlt)
    }
    ctx.on('dsc/exit', () => teardown(true))
    return () => {
      offInteractive()
      teardown(false)
    }
  },
}
