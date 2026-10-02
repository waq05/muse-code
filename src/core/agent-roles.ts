/**
 * 角色名册：一个角色就是 `~/.dsc/agents/<名字>.md` 一个文件。
 * frontmatter 说清「这个队友被授权干什么」，正文就是这个队友的系统提示词——
 * 形状和技能中心的 SKILL.md 一样，所以会写技能就会写角色。
 *
 * frontmatter 认这些键（都可选，缺省取下面的默认值）：
 *
 * ```markdown
 * ---
 * name: explorer
 * description: 只读探索：读代码、找定义、把事实汇总回来
 * tools: read, glob, grep        # 工具白名单；写 none 表示一个工具都不给
 * model:                         # 例 deepseek/deepseek-chat；留空 = 跟随当前模型
 * effort: default                # default|off|low|high|max
 * max-turns: 12                  # 内部请求轮次上限，到点自动收手
 * approval: forbid               # forbid|ask|foreground：这个角色想不想弹审批卡
 * enabled: true
 * ---
 * 这里是这个队友的系统提示词。
 * ```
 *
 * 「工牌」= 从这里读出来的那份约束（工具白名单 + 审批意愿 + 轮次预算 + 模型）。
 * 队友开工那一刻把工牌复制进运行时并冻结，之后改文件只影响下一个新队友。
 *
 * @module dsc/core/agent-roles
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import YAML from 'yaml'
import type { EffortLevel } from '../contract.js'
import { splitFrontmatter } from './skills.js'

/** 角色文件目录。 */
export const DSC_AGENTS_DIR = join(homedir(), '.dsc', 'agents')

/** 队友想不想向用户要工具授权（最终还要受全局设置这个上限压着）。 */
export type TeammateApproval = 'forbid' | 'ask' | 'foreground'

const APPROVAL_MODES: readonly TeammateApproval[] = ['forbid', 'ask', 'foreground']
const EFFORTS: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']

/** 角色名形状：小写字母数字加连字符，最长 32，够 UI 一排显示。 */
const ROLE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 一个角色（含它被授权的范围，即「工牌」）。 */
export interface AgentRole {
  /** 角色文件名（`<名字>.md`）。 */
  file: string
  name: string
  description: string
  /** 工具白名单；null = 不限工具（仍受权限模式与审批上限约束）。 */
  tools: string[] | null
  /** 模型覆盖，形状 `端点名/模型名`；null = 跟随当前模型。 */
  model: string | null
  /** 思考强度覆盖；null = 跟随当前档位。 */
  effort: EffortLevel | null
  /** 内部请求轮次上限（到点自动收手，防止子智能体无限自转）。 */
  maxTurns: number
  /** 这个角色想不想弹审批卡。 */
  approval: TeammateApproval
  enabled: boolean
  /** 正文 = 这个角色的系统提示词。 */
  prompt: string
  /** 是不是 dsc 出厂自带的那几个角色。 */
  builtin: boolean
  /** 文件里有问题时的说明（其余字段退回默认值）。 */
  problem?: string
}

/** 出厂角色：名字 → 文件内容。第一次用到时才写出去，之后用户随便改。 */
const BUILTIN_FILES: Readonly<Record<string, string>> = {
  explorer: `---
name: explorer
description: 只读探索：读代码、找定义、把事实汇总回来
tools: read, glob, grep
max-turns: 12
approval: forbid
---

你是团队里的探索手。你只有读类工具，不能改文件也不能执行命令。

工作方式：
1. 先把任务拆成两三个具体要查的问题，别一上来就通读整个仓库。
2. 用 glob/grep 定位，再用 read 精读关键片段；引结论时给出「文件名:行号」。
3. 结论用一小段话交回来：查了什么、看到什么、结论是什么、哪里还没查清。
4. 你没权限做的事不要反复尝试，直接写在回复里，让 Lead 或用户去决定。
`,
  writer: `---
name: writer
description: 落地实现：按明确范围改代码、补测试
tools: read, write, edit, glob, grep, bash
max-turns: 20
approval: ask
---

你是团队里的实现手，负责把明确的需求落成代码。

工作方式：
1. 动手前先用一两句话说清你要改哪几个文件、为什么。
2. 一次只推进一件事，改完立刻自检（类型检查或跑相关测试），失败就修。
3. 严格按分配给你的写作用域改，超出范围的文件不要碰，写在回复里让 Lead 协调。
4. 最后交一份改动清单：改了哪些文件、为什么这么改、还剩什么没做。
`,
  critic: `---
name: critic
description: 反驳式审查：只读材料，专门找漏洞和反例
tools: read, glob, grep
max-turns: 4
approval: forbid
---

你是团队里的审查手，任务是推翻眼前这个方案，而不是夸它。

工作方式：
1. 先列出这个方案成立的隐含假设，逐条问「如果不成立会怎样」。
2. 找反例：现有代码里有没有与之冲突的地方、边界条件、失败路径、并发与时序问题。
3. 每条问题给出证据（文件名:行号）与严重程度；没有发现问题就明说你查过哪里。
4. 不要提出完整替代方案，指出方向即可，方案由 Lead 定。
`,
  reviewer: `---
name: reviewer
description: 代码审查（/review 用）：只读过 diff 与相关代码，按固定格式交 findings
tools: read, glob, grep
max-turns: 16
approval: forbid
---

你是团队里的代码审查员。你会收到一份工作区未提交改动的 diff 和可选的关注点，用 read/glob/grep 打开相关文件核对上下文，然后交审查结论。

分级口径：P1 = 正确性或安全问题，必须修；P2 = 边界、健壮性、性能问题，应该修；P3 = 可读性、风格、更好的写法，可以更好。

每条 finding 严格按这个格式交（渲染层按它解析成卡片，一个字段都不能少）：

### [P1] 一句话标题
位置：相对路径:行号
说明：问题是什么、证据是什么（引用改动里的代码或 read 到的上下文）。
建议：怎么改。

规则：
1. 位置用仓库相对路径与真实行号；整篇新增的文件写到关键行的行号。
2. 先说结论——每个问题都要落到改动本身，不评审 diff 之外的历史遗留。
3. 没有问题就只写一段话：明说没有发现问题，交代你查过的文件与维度。
4. 你只有读类工具；跑不了构建和测试，判断依据是代码与 diff 本身，不确定的点在说明里如实标注。
`,
}

/** 出厂角色名（UI 上标「内置」，删除时给提示但不阻止）。 */
export function builtinRoleNames(): string[] {
  return Object.keys(BUILTIN_FILES).sort()
}

/**
 * 把还不存在的出厂角色写进角色目录。
 * @returns 实际新写出的角色名（已存在的一律不覆盖）。
 */
export function ensureBuiltinRoles(): string[] {
  const created: string[] = []
  for (const [name, text] of Object.entries(BUILTIN_FILES)) {
    const file = join(DSC_AGENTS_DIR, `${name}.md`)
    if (existsSync(file)) continue
    try {
      mkdirSync(DSC_AGENTS_DIR, { recursive: true })
      writeFileSync(file, text, 'utf8')
      created.push(name)
    } catch {
      // 目录建不出来（只读盘、权限）：不报错，让用户自己建文件。
    }
  }
  return created
}

/** 读一个角色文件；返回 null = 文件名不合法或读不起来。 */
export function readRole(file: string): AgentRole | null {
  const base = basename(file, '.md')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseRoleText(file, text)
}

/**
 * 取一个出厂角色的定义，**不落盘**（文件被用户删掉时 /review 仍要能派出审查员）。
 * 只认 {@link BUILTIN_FILES} 里登记过的名字；其余返回 null。
 */
export function builtinRole(name: string): AgentRole | null {
  const text = BUILTIN_FILES[name]
  if (text === undefined) return null
  return parseRoleText(join(DSC_AGENTS_DIR, `${name}.md`), text)
}

/** 角色文本 → {@link AgentRole}（frontmatter 解析与缺省回退都在这；文件与内存构造共用）。 */
function parseRoleText(file: string, text: string): AgentRole | null {
  const base = basename(file, '.md')
  const { front, body } = splitFrontmatter(text)
  let doc: Record<string, unknown> = {}
  let problem: string | undefined
  if (front.trim() !== '') {
    try {
      doc = (YAML.parse(front) as Record<string, unknown>) ?? {}
    } catch (error) {
      problem = `frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const declared = typeof doc.name === 'string' ? doc.name.trim() : ''
  const name = declared !== '' ? declared : base
  if (!ROLE_NAME.test(name)) {
    return {
      file,
      name: base,
      description: '',
      tools: null,
      model: null,
      effort: null,
      maxTurns: 0,
      approval: 'forbid',
      enabled: false,
      prompt: '',
      builtin: base in BUILTIN_FILES,
      problem: `角色名「${name}」不合法：只能用小写字母、数字、连字符，且不能以连字符开头`,
    }
  }

  // tools: 逗号分隔字符串或 YAML 数组；none/空数组 = 一个工具都不给（null = 不限）
  let tools: string[] | null = null
  const rawTools = doc.tools
  if (rawTools !== undefined) {
    const items = Array.isArray(rawTools)
      ? rawTools.map((item) => String(item))
      : String(rawTools).split(/[,，\s]+/)
    const list = items.map((item) => item.trim()).filter((item) => item !== '')
    tools = list.length === 0 || list.every((item) => item === 'none') ? [] : list
  }

  const rawModel = typeof doc.model === 'string' ? doc.model.trim() : ''
  const rawEffort = typeof doc.effort === 'string' ? doc.effort.trim() : ''
  let effort: EffortLevel | null = null
  if (rawEffort !== '' && rawEffort !== 'default') {
    if (EFFORTS.includes(rawEffort as EffortLevel)) effort = rawEffort as EffortLevel
    else problem = problem ?? `effort 只能是 ${EFFORTS.join(' / ')}，收到 ${rawEffort}，本项退回跟随当前`
  }

  const rawTurns = Number.parseInt(String(doc['max-turns'] ?? doc.maxTurns ?? ''), 10)
  const maxTurns = Number.isFinite(rawTurns) ? Math.min(Math.max(rawTurns, 1), 200) : 12

  const rawApproval = typeof doc.approval === 'string' ? doc.approval.trim() : ''
  let approval: TeammateApproval = 'forbid'
  if (rawApproval !== '') {
    if (APPROVAL_MODES.includes(rawApproval as TeammateApproval)) approval = rawApproval as TeammateApproval
    else problem = problem ?? `approval 只能是 ${APPROVAL_MODES.join(' / ')}，收到 ${rawApproval}，本项退回 forbid`
  }

  return {
    file,
    name,
    description: typeof doc.description === 'string' ? doc.description.trim() : '',
    tools,
    model: rawModel !== '' ? rawModel : null,
    effort,
    maxTurns,
    approval,
    enabled: doc.enabled !== false && doc.enabled !== 'false',
    prompt: body.trim(),
    builtin: base in BUILTIN_FILES,
    ...(problem !== undefined ? { problem } : {}),
  }
}

/** 列出全部角色，按名字排序；坏文件也列出来（带 problem），免得用户以为文件没生效。 */
export function listRoles(): AgentRole[] {
  if (!existsSync(DSC_AGENTS_DIR)) return []
  const out: AgentRole[] = []
  for (const entry of readdirSync(DSC_AGENTS_DIR)) {
    if (!entry.endsWith('.md')) continue
    const role = readRole(join(DSC_AGENTS_DIR, entry))
    if (role !== null) out.push(role)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名字取启用中的角色；不存在或未启用时返回 null。 */
export function findRole(name: string): AgentRole | null {
  if (!ROLE_NAME.test(name)) return null
  const role = readRole(join(DSC_AGENTS_DIR, `${name}.md`))
  return role !== null && role.name === name && role.enabled ? role : null
}

/** 写一个角色文件（设置界面「新建角色」用）。名字非法时抛错。 */
export function writeRole(name: string, patch: { description: string; prompt: string }): string {
  if (!ROLE_NAME.test(name)) {
    throw new Error(`角色名「${name}」不合法：只能用小写字母、数字、连字符，且不能以连字符开头`)
  }
  mkdirSync(DSC_AGENTS_DIR, { recursive: true })
  const file = join(DSC_AGENTS_DIR, `${name}.md`)
  const text = `---
name: ${name}
description: ${patch.description}
---

${patch.prompt.trim() === '' ? `你是团队里的「${name}」。把这一段改成这个角色的具体职责和做事步骤。` : patch.prompt.trim()}
`
  writeFileSync(file, text, 'utf8')
  return file
}
