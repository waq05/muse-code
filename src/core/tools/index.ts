/**
 * 工具注册表：MiniAgent 可用的全部工具（对应 dsh 的工具行栈的个人版）。
 * 新工具在此追加即可被 loop 发现。
 *
 * @module dsc/core/tools/index
 */
import type { ToolEntry } from '../tools.js'
import { createBashTool } from './bash.js'
import { createReadTool, editTool, writeTool } from './fs-tools.js'
import { globTool, grepTool } from './search-tools.js'

export const defaultTools: ToolEntry[] = [createBashTool(), createReadTool(), writeTool, editTool, globTool, grepTool]
