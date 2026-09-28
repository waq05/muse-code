/**
 * tools-default 插件：向 tools 注册表注册 6 件套默认工具
 * （bash/read/write/edit/glob/grep）。剔除本插件即可得到纯对话 harness。
 *
 * @module dsc/plugins/tools-default
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { bashTool } from '../core/tools/bash.js'
import { editTool, readTool, writeTool } from '../core/tools/fs-tools.js'
import { globTool, grepTool } from '../core/tools/search-tools.js'

export const toolsDefaultPlugin: Plugin.Object = {
  name: 'tools-default',
  inject: ['tools'],
  apply(ctx) {
    for (const entry of [bashTool, readTool, writeTool, editTool, globTool, grepTool]) {
      ctx.tools.register(entry)
    }
  },
}
