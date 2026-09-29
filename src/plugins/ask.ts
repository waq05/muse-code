/**
 * ask 插件：provide `ask` 服务——`ask_user` 工具与它的提问卡。
 *
 * 一次提问最多几个问题、每个问题最多几个选项是插件配置（`ask.maxQuestions` / `ask.maxOptions`），
 * 工具描述里写的数字与实际裁剪的数字来自同一份配置，不会出现「描述说 3 个、代码砍到 2 个」。
 *
 * @module dsc/plugins/ask
 */
import { randomUUID } from 'node:crypto'
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { ToolEntry } from '../core/tools.js'
import type { AskUserView } from '../contract.js'
import type { AskService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'ask'

/** 一次提问的问题数与选项数上限。 */
interface AskLimits {
  maxQuestions: number
  maxOptions: number
}

const DEFAULTS: AskLimits = { maxQuestions: 3, maxOptions: 4 }

/**
 * 从插件配置里取上限并夹到合理区间。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readLimits(passed: unknown): AskLimits {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
  }
  return {
    // 上限 8：再多界面就排不下，模型也记不住这么多岔路。
    maxQuestions: clamp(raw.maxQuestions, 1, 8, DEFAULTS.maxQuestions),
    maxOptions: clamp(raw.maxOptions, 1, 8, DEFAULTS.maxOptions),
  }
}

export const askPlugin: Plugin.Object = {
  name: 'ask',
  inject: ['tools', 'surfaces', 'waiting'],
  provide: 'ask',
  apply(ctx, passed) {
    let limits = readLimits(passed)
    let question: AskUserView | null = null
    let questionDone: ((answer: string) => void) | null = null

    const touch = (): void => ctx.emit('dsc/changed')

    const ask = (input: Omit<AskUserView, 'id'>, signal: AbortSignal): Promise<string> =>
      new Promise<string>((resolveDone) => {
        question = { id: randomUUID(), ...input }
        const finish = (answer: string): void => {
          if (questionDone === null) return
          questionDone = null
          question = null
          touch()
          resolveDone(answer)
        }
        questionDone = finish
        // 用户被打断时按「没回答」处理，回一句实话给模型，别让它编一个答案。
        signal.addEventListener('abort', () => finish('（用户没回答就中断了这一轮）'), { once: true })
        touch()
      })

    const service: AskService = {
      pendingQuestion() {
        return question
      },
      ask,
      answerQuestion(answer) {
        questionDone?.(answer)
      },
    }
    ctx.provide('ask', service)
    ctx.surfaces.register('pendingQuestion', () => service.pendingQuestion())
    ctx.waiting.register('ask', () => question !== null)

    const askUserTool: ToolEntry = {
      name: 'ask_user',
      // 描述里的两个数字跟着配置走：每次组装请求时现读，配置改了不用重启也不用重新注册。
      get description() {
        return (
          `当面问用户一个问题并等回答，最多 ${limits.maxQuestions} 个问题、` +
          `每个最多 ${limits.maxOptions} 个互斥选项。` +
          '什么时候用：需求真的有多种合理解释、或者下一步不可逆（要删数据、要改别人的配置）而用户没指定。' +
          '什么时候不用：能自己查代码查出来的别问；纯确认式的「我可以继续吗」别问——计划该不该做由评审卡决定。'
        )
      },
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: `要问的问题（最多 ${limits.maxQuestions} 个）`,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问题本体，一句话' },
                header: { type: 'string', description: '两三个字的短标签，界面显示在按钮上方' },
                options: {
                  type: 'array',
                  description: `选项（最多 ${limits.maxOptions} 个，推荐的放第一个并在 label 结尾写「（推荐）」）`,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: '选项文字' },
                      description: { type: 'string', description: '一句话说明这个选项的取舍' },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: { type: 'boolean', description: '允许多选（默认 false）' },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
      risk: 'read',
      async run(args, runCtx) {
        limits = readLimits(passed)
        const list = Array.isArray(args.questions) ? args.questions.slice(0, limits.maxQuestions) : []
        if (list.length === 0) throw new Error('questions 至少要有一个问题')
        const answers: string[] = []
        for (const raw of list) {
          const doc = (raw ?? {}) as Record<string, unknown>
          const text = typeof doc.question === 'string' ? doc.question.trim() : ''
          if (text === '') continue
          const options = (Array.isArray(doc.options) ? doc.options : [])
            .slice(0, limits.maxOptions)
            .map((option) => {
              const item = (option ?? {}) as Record<string, unknown>
              return {
                label: typeof item.label === 'string' ? item.label : String(item.label ?? ''),
                ...(typeof item.description === 'string' ? { description: item.description } : {}),
              }
            })
            .filter((option) => option.label !== '')
          const answer = await ask(
            {
              question: text,
              ...(typeof doc.header === 'string' ? { header: doc.header } : {}),
              options,
              multiSelect: doc.multiSelect === true,
              allowFreeText: true,
            },
            runCtx.signal,
          )
          answers.push(`${text}\n用户回答：${answer}`)
        }
        if (answers.length === 0) throw new Error('问题正文都是空的')
        return answers.join('\n\n')
      },
    }
    ctx.tools.register(askUserTool)

    ctx.on('dsc/session-open', () => {
      // 提问不跨会话留存：换会话时这张卡连同等待一起清掉。
      questionDone?.('（切换了会话，这个问题作废）')
      question = null
      questionDone = null
      touch()
    })

    ctx.on('dsc/exit', () => {
      questionDone?.('（用户退出了程序，这个问题没回答）')
    })
  },
}
