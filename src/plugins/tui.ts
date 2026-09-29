/**
 * tui 插件：进程内 UI 插件——把 runtime 服务挂到 ink 终端界面。
 * 迁自 v2 boot.ts 的挂载逻辑；App 组件与 contract.ts 契约零改动。
 *
 * @module dsc/plugins/tui
 */
import React from 'react'
import { render, type Instance } from 'ink'
import type { Plugin } from '@deepseek-ai/cordis'
import { App } from '../app/App.js'

export const tuiPlugin: Plugin.Object = {
  name: 'tui',
  inject: ['ui'],
  apply(ctx) {
    const runtime = ctx.ui
    // 有人在看：审批插件据此弹人工审批卡；没有这个登记时它按「无人应答」立刻拒掉，不白等超时。
    const offInteractive = ctx.provide('interactive', { kind: 'tui' as const, reachable: () => true })
    // exitOnCtrlC=false：Ctrl+C 交给 App（一次打断 / 双击退出）。
    const instance: Instance = render(React.createElement(App, { runtime }), { exitOnCtrlC: false })
    ctx.on('dsc/exit', () => instance.unmount())
    return () => {
      offInteractive()
      instance.unmount()
    }
  },
}
