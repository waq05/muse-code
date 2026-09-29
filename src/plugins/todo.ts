/**
 * todo 插件：provide `todo` 服务——模型自己维护、界面实时显示的那张任务清单。
 *
 * 这个功能点由四块组成，全在自己文件里：
 *   1. 工具 `todo_write`（整表替换或按 id 合并）；
 *   2. 命令 `/todo [clear]`；
 *   3. 界面快照里的 `todos` 那片投影（注册进 surfaces 注册表）；
 *   4. 会话状态条目 `todos`（恢复历史会话时清单跟着回来）与压缩后要原样带过去的清单文本。
 *
 * 形状抄三家：整表替换与四态来自 Codex 的 `update_plan`（`protocol/src/plan_tool.rs:9-28`）
 * 与 DSH 的 `todo_write`；id / 子任务 / 单调 revision 来自 Hermes（`tools/todo_tool.py:9-32`）。
 *
 * @module dsc/plugins/todo
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { TodoStore } from '../core/todo.js'
import type { ToolEntry } from '../core/tools.js'
import type { TodoService } from '../services/types.js'

/** 任务清单工具：写入即回显整表，模型看到的和用户看到的是同一份。 */
function todoTool(store: TodoStore, onWrite: () => void): ToolEntry {
  return {
    name: 'todo_write',
    description:
      '维护本次任务的用户可见清单：传 todos 数组整表替换，或 merge:true 只改给出的那几条（必须带 id）。' +
      '状态只有 pending / in_progress / completed / cancelled 四种，同一时刻最多一条 in_progress。' +
      '什么时候用：3 步以上的活开工前先立清单，做完一步立刻改状态。' +
      '什么时候不用：一两步就完的事别立清单，纯问答也别立；不要用它在计划模式里代替计划文件。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '条目 id（不给自动生成；merge 模式必须给）' },
              content: { type: 'string', description: '一句话动作描述（≤300 字）' },
              status: { type: 'string', description: 'pending | in_progress | completed | cancelled' },
              parent: { type: 'string', description: '父任务 id（表示这是它的子任务）' },
            },
            required: ['content'],
          },
        },
        merge: { type: 'boolean', description: 'true = 按 id 合并更新；默认 false = 整表替换' },
      },
      required: ['todos'],
    },
    risk: 'read',
    async run(args) {
      const list = Array.isArray(args.todos) ? args.todos : null
      if (list === null) throw new Error('todos 必须是数组')
      const result = store.write(list, args.merge === true)
      onWrite()
      const progress = store.progress()
      const notes = result.notes.length > 0 ? `\n注意：${result.notes.join('；')}` : ''
      if (store.read().length === 0) return '清单已清空。'
      return `清单已更新（${progress.done}/${progress.total} 完成）\n${store.formatForPrompt()}${notes}`
    },
  }
}

export const todoPlugin: Plugin.Object = {
  name: 'todo',
  inject: ['session', 'tools', 'commands', 'surfaces', 'compact'],
  provide: 'todo',
  apply(ctx) {
    const todos = new TodoStore()
    const restored = ctx.session.current().state('todos')
    if (restored !== undefined) todos.restore(restored)

    const touch = (): void => ctx.emit('dsc/changed')
    const writeTodos = (list: readonly unknown[], merge: boolean) => {
      const result = todos.write(list, merge)
      ctx.session.current().appendState('todos', result.items)
      touch()
      return result
    }

    const service: TodoService = {
      todoView() {
        const progress = todos.progress()
        return {
          items: todos.read(),
          revision: todos.rev,
          done: progress.done,
          total: progress.total,
          active: progress.active,
        }
      },
      writeTodos,
      clearTodos() {
        todos.clear()
        ctx.session.current().appendState('todos', [])
        ctx.emit('dsc/notice', '任务清单已清空')
        touch()
      },
      todoPrompt() {
        return todos.empty ? '' : `本次任务清单（当前进度，照它继续，别重建）：\n${todos.formatForPrompt()}`
      },
    }
    ctx.provide('todo', service)

    ctx.tools.register(todoTool(todos, () => ctx.emit('dsc/changed')))

    ctx.surfaces.register('todos', () => service.todoView())
    // 压缩摘要会把清单改写走样，所以整表要原样带过去（压缩插件只问注册表要文本）。
    ctx.compact.registerCarry(() => service.todoPrompt())

    ctx.commands.register(
      { name: 'todo', args: '[clear]', description: '查看或清空本次任务清单' },
      ({ args, ui }) => {
        if (args[0] === 'clear') {
          service.clearTodos()
          return
        }
        const text = todos.formatForPrompt()
        ui.notice(text === '' ? '当前没有任务清单。' : text)
      },
    )

    ctx.on('dsc/session-open', ({ session }) => {
      const items = session.state('todos')
      todos.clear()
      if (items !== undefined) todos.restore(items)
      touch()
    })
  },
}
