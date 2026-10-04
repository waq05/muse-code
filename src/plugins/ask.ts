/**
 * ask 插件：provide `ask` 服务——`ask_user` 工具与它的提问卡。
 *
 * 一次提问最多几个问题、每个问题最多几个选项是插件配置（`ask.maxQuestions` / `ask.maxOptions`），
 * 工具描述里写的数字与实际裁剪的数字来自同一份配置，不会出现「描述说 3 个、代码砍到 2 个」。
 *
 * 一批问题**一次挂出**：工具参数里几个问题，界面上就是一张卡里的几行
 * （视图带完整 `questions` 数组，见 contract.ts 的 AskUserView）；用户逐题作答、统一提交，
 * 界面每交一题就调一次 `answerQuestion`，服务按题序收下，收齐整批才让 ask_user 这个
 * 工具调用落地——所以模型侧看到的仍然是「一次调用拿回全部答案」。
 *
 * 0.6.49 常驻模型：卡跟自己的会话走——多卡并存（每个会话最多一张，互不顶掉），
 * surface 只出「当前查看会话」的卡；切会话不再作废挂起的提问（后台会话的卡继续等）。
 *
 * @module dsc/plugins/ask
 */
import { randomUUID } from 'node:crypto'
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { ToolEntry } from '../core/tools.js'
import type { AskQuestionItem, AskUserView, AskUserViewInput } from '../contract.js'
import type { AskService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'ask'

/** 一次提问的问题数与选项数上限。 */
interface AskLimits {
  maxQuestions: number
  maxOptions: number
}

const DEFAULTS: AskLimits = { maxQuestions: 3, maxOptions: 4 }

/** 中断这一轮时替没答的题写的实话（模型据此知道这句不是用户的话）。 */
const INTERRUPTED = '（用户没回答就中断了这一轮）'
/** 程序退出时替没答的题写的实话。 */
const EXITED = '（用户退出了程序，这个问题没回答）'
/** 上一批还没答完就被新的一批顶掉时，替没答的题写的实话。 */
const SUPERSEDED = '（又挂了一批新问题，这一题作废）'

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

/**
 * 把「已经收到的答案 + 剩下这几题」拼成一整份答案：答过的保留原话，
 * 没答的填同一句实话。收尾路径（中断、换会话、退出、被顶掉）共用它。
 * @param questions - 这一批的题目（决定答案条数与题序）。
 * @param answered - 已经收到的答案，按题序靠前。
 * @param rest - 没答的题要填的那句话。
 */
function withRest(
  questions: readonly AskQuestionItem[],
  answered: readonly string[],
  rest: string,
): string[] {
  return questions.map((_, index) => answered[index] ?? rest)
}

export const askPlugin: Plugin.Object = {
  name: 'ask',
  inject: ['session', 'tools', 'surfaces', 'waiting'],
  provide: 'ask',
  apply(ctx, passed) {
    let limits = readLimits(passed)
    /** 挂着等答的批次：卡 id → 卡。多卡并存（0.6.49），每个会话最多一张。 */
    const pendings = new Map<
      string,
      {
        view: AskUserView
        answers: string[]
        /** 提问会话（后台提问也归属它）：surface 认领与应答只认当前查看会话的那张。 */
        sessionPath: string
        /** 收尾：清掉挂起状态、广播快照失效、让 ask 的 Promise 落地。只有它是出口。
         *  wake = 答完之后回合还要继续（状态点翻回 working）；中断/退出路径传 false。 */
        settle(final: string[], wake?: boolean): void
      }
    >()

    const touch = (): void => ctx.emit('dsc/changed')

    /** 当前查看会话的那张卡（没有就 undefined）——surface 与应答都只认它。 */
    const cardOfCurrent = () => {
      const path = ctx.session.current().filePath
      for (const card of pendings.values()) {
        if (card.sessionPath === path) return card
      }
      return undefined
    }

    /**
     * 一次挂出一批问题，挂起直到整批答完（跳过也算答完）、中断或退出。
     *
     * 收答案只走 `answerQuestion` 这一条路，而且按题序：第 1 次调用收下第 1 题的答案，
     * 第 2 次收第 2 题……没到齐之前视图**一动不动**——界面已经点了统一提交、本地草稿也清了，
     * 这里要是中途 `touch()`，快照会推着一张半空的卡回去重画一次。
     * @param input - 这一批题目（至少一题，调用方保证）。
     * @param signal - 这一轮工具调用的中断信号。
     * @param sessionPath - 提问会话的 jsonl 路径（0.6.49）：后台回合提问时归属它，缺省按当前会话。
     */
    const askMany = (input: readonly AskQuestionItem[], signal: AbortSignal, sessionPath?: string): Promise<string[]> => {
      // 空批不该挂出一张没有题的卡：宁可当场报错，也不给界面一张空卡。
      if (input.length === 0) return Promise.reject(new Error('一批问题至少要有一个'))
      return new Promise<string[]>((resolveDone) => {
        // 提问会话按工具运行身份显式解析（后台回合提问时 current() 是别家会话）。
        const session =
          (sessionPath !== undefined ? ctx.get('agent')?.sessionFor(sessionPath) : undefined) ?? ctx.session.current()
        const path = session.filePath
        // 同会话重复挂卡（防御，正常一轮只挂一张）：给旧卡一个交代，不能让它的 Promise 永远悬着。
        for (const card of [...pendings.values()]) {
          if (card.sessionPath === path) card.settle(withRest(card.view.questions ?? [], card.answers, SUPERSEDED), false)
        }
        const questions: AskQuestionItem[] = input.map((item) => ({
          ...item,
          options: item.options.map((option) => ({ ...option })),
        }))
        // 单题字段就是第 1 题的投影，和 questions[0] 同源，不会出现两处不一致。
        const view: AskUserView = { id: randomUUID(), ...questions[0], questions }
        const answers: string[] = []
        const settle = (final: string[], wake = true): void => {
          if (!pendings.has(view.id)) return
          pendings.delete(view.id)
          signal.removeEventListener('abort', onAbort)
          // 答完之后回合还要继续：状态点从「等审批」翻回 working；中断/退出交给 turn-end 收口。
          if (wake) {
            ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path, state: 'working' })
          }
          touch()
          resolveDone(final)
        }
        const onAbort = (): void => settle(withRest(questions, answers, INTERRUPTED), false)
        pendings.set(view.id, { view, answers, sessionPath: path, settle })
        signal.addEventListener('abort', onAbort, { once: true })
        ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path, state: 'awaiting-approval' })
        // 信号进来就已经中断了（abort 事件不会再补发一次）：立刻按「没回答」收尾，别挂死。
        if (signal.aborted) onAbort()
        else touch()
      })
    }

    const service: AskService = {
      pendingQuestion() {
        return cardOfCurrent()?.view ?? null
      },
      ask(question: AskUserViewInput, signal: AbortSignal, sessionPath?: string) {
        return askMany(
          [
            {
              question: question.question,
              ...(question.header === undefined ? {} : { header: question.header }),
              options: question.options,
              multiSelect: question.multiSelect,
              allowFreeText: question.allowFreeText,
            },
          ],
          signal,
          sessionPath,
        ).then((answers) => answers[0] ?? '')
      },
      askMany,
      answerQuestion(answer) {
        const current = cardOfCurrent()
        if (current === undefined) return
        current.answers.push(answer)
        // 整批还没收齐：视图保持不变，等最后一题。收齐了才收尾并 resolve。
        if (current.answers.length < (current.view.questions?.length ?? 1)) return
        current.settle(current.answers.slice())
      },
    }
    ctx.provide('ask', service)
    ctx.surfaces.register('pendingQuestion', () => service.pendingQuestion())
    ctx.waiting.register('ask', () => pendings.size > 0)

    const askUserTool: ToolEntry = {
      name: 'ask_user',
      // 描述里的两个数字跟着配置走：每次组装请求时现读，配置改了不用重启也不用重新注册。
      get description() {
        return (
          `当面问用户一个问题并等回答，最多 ${limits.maxQuestions} 个问题、` +
          `每个最多 ${limits.maxOptions} 个互斥选项。` +
          '一次可以问多个问题：它们会挂在同一张卡上让用户逐题作答、统一提交，' +
          '你在同一个工具结果里拿到全部答案（按你给的题序）。' +
          '什么时候用：需求真的有多种合理解释、或者下一步不可逆（要删数据、要改别人的配置）而用户没指定。' +
          '什么时候不用：能自己查代码查出来的别问；纯确认式的「我可以继续吗」别问——计划该不该做由评审卡决定。'
        )
      },
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: `要问的问题（最多 ${limits.maxQuestions} 个，一次全挂在同一张卡上）`,
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
        // 参数先整批收干净再挂卡：正文空的问题直接丢掉，别让一张空卡片闪一下又消失。
        const questions: AskQuestionItem[] = []
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
          questions.push({
            question: text,
            ...(typeof doc.header === 'string' ? { header: doc.header } : {}),
            options,
            multiSelect: doc.multiSelect === true,
            allowFreeText: true,
          })
        }
        if (questions.length === 0) throw new Error('问题正文都是空的')
        const answers = await askMany(questions, runCtx.signal, runCtx.sessionPath)
        // 答案按题序回给模型；跳过的题界面已经替它写了「（用户跳过了这一题）」，原样带过去。
        return questions
          .map((item, index) => `${item.question}\n用户回答：${answers[index] ?? '（用户跳过了这一题）'}`)
          .join('\n\n')
      },
    }
    ctx.tools.register(askUserTool)

    ctx.on('dsc/exit', () => {
      for (const card of [...pendings.values()]) {
        card.settle(withRest(card.view.questions ?? [], card.answers, EXITED), false)
      }
      pendings.clear()
    })
  },
}
