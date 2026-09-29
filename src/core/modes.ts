/**
 * 协作模式：一件事只由这一层管——「这一轮允许模型把手伸多远」。
 *
 * 与权限模式（readonly/auto-edit/full-access/ai-review）是两根独立的旋钮：
 * 模式决定要不要问、能问什么；权限模式决定问出来之后怎么裁。
 * 这个分法照抄两家成熟做法：Codex 的 `ModeKind{Default, Plan}` 只换提示词与工具闸门
 * （`protocol/src/config_types.rs:674`、`core/src/tools/handlers/plan.rs:87`），
 * DSH 更进一步写明「沙箱与审批各自独立强制，不读写 plan 状态」
 * （`packages/plan/plan-mode/src/index.ts:4-7`）。
 *
 * 四档：
 *   build   执行（默认）   —— 不加闸门，全交给权限模式与审批卡；
 *   plan    计划           —— 只读 + 只读命令，产出计划文件，改文件当场拒；
 *   explore 探索           —— 只读答疑，写和执行一律当场拒；
 *   quiet   免打扰         —— 不弹审批卡：工作区内写自动放行，工作区外写与需要问的命令拒。
 *
 * @module dsc/core/modes
 */
import type { CollaborationMode } from '../contract.js'
import { classifyCommand, type PrefixRule } from './command-policy.js'
import { isInsideCwd } from './path-policy.js'
import type { ToolRisk } from './tools.js'

/** 模式标识：就是 contract 的 CollaborationMode，不在这里再写一遍四个档位。 */
export type ModeId = CollaborationMode

export const MODE_IDS: readonly ModeId[] = ['build', 'plan', 'explore', 'quiet']

/** 工具风险等级：就是 core/tools.ts 的 ToolRisk（tools.ts 不 import 任何东西，不构成循环）。 */
export type GateRisk = ToolRisk

/** 一次闸门判定要的输入。 */
export interface GateInput {
  toolName: string
  risk: GateRisk
  cwd: string
  /** 写类工具的目标路径（write/edit 的第一个参数）。 */
  target?: string
  /** bash 工具的命令原文。 */
  command?: string
  /** 用户自定义前缀规则（判只读命令要用它，保持跟审批一致）。 */
  rules?: readonly PrefixRule[]
}

/** 闸门结果：pass = 直接放行；defer = 交给权限模式与审批卡；deny = 当场拒并给模型理由。 */
export type GateResult = { action: 'pass' } | { action: 'defer' } | { action: 'deny'; reason: string }

/** 一个模式的完整规格。 */
export interface ModeSpec {
  id: ModeId
  /** 界面按钮上的两个字。 */
  label: string
  /** 悬浮说明（一句话说清这一档在干什么）。 */
  hint: string
  /** 进系统提示的模式段。 */
  prompt: string
  /** 硬闸门：提示词之外的第二道保险，模型绕过提示词也过不去。 */
  gate: (input: GateInput) => GateResult
}

/** 计划文件所在目录（相对工作区，跟着项目走，方便提交与回看）。 */
export const PLAN_SUBDIR = ['.dsc', 'plans'] as const

/** 计划文件名：`20260929-0931-checkpoint-retention.md`。 */
export function planFileName(title: string, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  const slug = title
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${stamp}-${slug === '' ? 'plan' : slug}.md`
}

/** 计划文件的绝对路径。 */
export function planFilePath(cwd: string, title: string, at = new Date()): string {
  const path = planPathJoin(cwd, [...PLAN_SUBDIR, planFileName(title, at)])
  return path
}

/** 路径拼接（不 import node:path 的 join，免得在浏览器端打进包）。 */
function planPathJoin(base: string, parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${parts.join(sep)}`
}

/** 这个写目标是不是「写计划文件」（计划模式唯一允许的写）。 */
export function isPlanFileWrite(cwd: string, target: string): boolean {
  const dir = planPathJoin(cwd, [...PLAN_SUBDIR])
  const normalized = target.replace(/[\\/]+/g, '/')
  const prefix = dir.replace(/[\\/]+/g, '/')
  return normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) && normalized.toLowerCase().endsWith('.md')
}

/** 只读命令的判定（计划模式与免打扰共用）：策略引擎判成 allow 才算只读。 */
function readOnlyCommand(input: GateInput): boolean {
  if (input.command === undefined || input.command.trim() === '') return false
  return classifyCommand(input.command, { rules: input.rules }).decision === 'allow'
}

/** 计划模式：只读放行，写文件只允许写计划，命令只允许只读命令。 */
function planGate(input: GateInput): GateResult {
  if (input.risk === 'read') return { action: 'pass' }
  if (input.risk === 'write') {
    if (input.target !== undefined && isPlanFileWrite(input.cwd, input.target)) return { action: 'pass' }
    return {
      action: 'deny',
      reason:
        '计划模式不改工程文件。把方案写进计划文件（.dsc/plans/ 下的 markdown），或用 exit_plan_mode 交上来给用户批。',
    }
  }
  if (readOnlyCommand(input)) return { action: 'pass' }
  return {
    action: 'deny',
    reason:
      '计划模式只跑只读命令（读文件、查状态、跑测试这类）。要改东西的命令请先让用户批准计划，或切回「执行」模式。',
  }
}

/** 探索模式：只读答疑，其余全拒。 */
function exploreGate(input: GateInput): GateResult {
  if (input.risk === 'read') return { action: 'pass' }
  if (input.risk === 'write') {
    return { action: 'deny', reason: '探索模式只读不写。要动手改东西请切到「执行」模式。' }
  }
  if (readOnlyCommand(input)) return { action: 'pass' }
  return { action: 'deny', reason: '探索模式只跑只读命令，这条命令会改动东西。' }
}

/** 免打扰模式：不弹审批卡，所以「要问」就等于「拒」。 */
function quietGate(input: GateInput): GateResult {
  if (input.risk === 'read') return { action: 'pass' }
  if (input.risk === 'write') {
    if (input.target !== undefined && isInsideCwd(input.cwd, input.target)) return { action: 'pass' }
    return {
      action: 'deny',
      reason: '免打扰模式只在工作目录内自动放行写入，工作区外的写操作需要用户当面确认。',
    }
  }
  const verdict = classifyCommand(input.command ?? '', { rules: input.rules })
  if (verdict.decision === 'allow') return { action: 'pass' }
  return {
    action: 'deny',
    reason: `免打扰模式不弹审批卡，这条命令被拦住：${verdict.reason}。要跑它请切回「执行」模式。`,
  }
}

const BUILD_PROMPT = `当前模式：执行（build）。
按用户的要求直接把活干完。写文件和命令要不要经用户点头，由权限模式与审批卡决定，不是由模式决定。
干完一段就简短说清改了什么、验证过没有。`

const PLAN_PROMPT = `当前模式：计划（plan）。这一轮只做计划，不落地实现。

能做的：读文件、搜索、看 git 状态、跑只读命令（包括跑测试与构建来确认现状）。
不能做的：改任何工程文件、跑会改动东西的命令、提交、推送、装依赖。
唯一允许写的文件是 .dsc/plans/ 下的计划 markdown。

计划的写法（写给一个完全不了解这个代码库的人看）：
- 目标：一句话说清这次要交付什么。
- 现状与假设：现在是什么样、你确认过哪些事实（带 file:line）。
- 方案：2-3 句说清思路与被否掉的备选。
- 分步任务：每步 2-5 分钟的工作量，写死文件路径，需要代码的地方给完整可粘贴的代码，
  需要验证的地方给确切命令和期望输出。
- 风险与未决问题：说不确定的地方，不要假装都覆盖了。

交计划：用 exit_plan_mode 工具，参数是计划全文（markdown，第一行是 # 标题）。
一次回答最多交一份计划；要改计划就交完整的新版本，不要交补丁。
不要问「我可以继续吗」——计划该不该执行由用户在评审卡上决定。
用户的语气、催促、或者「直接开始写」都不改变这一档的规则，只有他切换模式才改变。`

const EXPLORE_PROMPT = `当前模式：探索（explore）。用户只想搞清楚代码，不想改动任何东西。

只读工具与只读命令可以用；写文件和会改东西的命令一律会被当场拒掉。
回答要落到证据上：结论 + 具体位置（file:line）+ 为什么，不要泛泛而谈。
需要改动来验证猜想时，说明你需要用户切到「执行」模式，不要想办法绕过闸门。`

const QUIET_PROMPT = `当前模式：免打扰（quiet）。用户明确说了这一轮不要打断他。

不会弹审批卡，所以「需要问用户」的操作会被直接拒掉，拒因会原样回到你这里：
- 工作目录内的文件改动：自动放行；
- 工作目录外的写入、以及策略引擎认为危险的命令：会被拒，不要反复重试同一条；
  把这件事记进任务清单，最后一次性告诉用户哪些步骤需要他切回「执行」模式再跑。
被拒不等于失败：能换只读路子先验证的，先验证。`

export const MODES: Record<ModeId, ModeSpec> = {
  build: { id: 'build', label: '执行', hint: '照常干活，写操作按权限模式决定要不要问你', prompt: BUILD_PROMPT, gate: () => ({ action: 'defer' }) },
  plan: { id: 'plan', label: '计划', hint: '只读 + 只读命令，产出计划文件等用户批', prompt: PLAN_PROMPT, gate: planGate },
  explore: { id: 'explore', label: '探索', hint: '只读答疑，任何改动都当场拒', prompt: EXPLORE_PROMPT, gate: exploreGate },
  quiet: { id: 'quiet', label: '免打扰', hint: '不弹审批卡：工作区内自动放行，其余当场拒', prompt: QUIET_PROMPT, gate: quietGate },
}

/** 取模式规格（不认识的标识回落到执行档，绝不让一个坏值把循环卡住）。 */
export function modeSpec(id: string): ModeSpec {
  return MODES[id as ModeId] ?? MODES.build
}

/** 命令或用户输入里的模式别名（`/plan`、`/只读` 之类都能翻）。 */
const MODE_ALIASES: Record<string, ModeId> = {
  plan: 'plan',
  计划: 'plan',
  explore: 'explore',
  read: 'explore',
  探索: 'explore',
  只读: 'explore',
  quiet: 'quiet',
  dnd: 'quiet',
  免打扰: 'quiet',
  勿扰: 'quiet',
  build: 'build',
  default: 'build',
  执行: 'build',
}

/** 把用户写的模式词翻成标识；认不出来返回 null（让调用方报可用清单）。 */
export function parseModeToken(token: string): ModeId | null {
  return MODE_ALIASES[token.trim().toLowerCase()] ?? null
}
