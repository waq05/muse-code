/**
 * 模式（预设）：一个模式就是 `~/.dsc/presets/<名字>.md` 一个文件。
 * frontmatter 说清这个模式的工牌（工具白名单、要去掉的骨架段），正文就是这个模式
 * 追加给模型的提示词——形状和 `~/.dsc/agents/<名字>.md` 一样，会写角色就会写模式。
 *
 * 与协作模式（`core/modes.ts`）的分工是两根独立旋钮（dsh 的 preset 与 plan-mode 也分开）：
 *   协作模式  管「这一轮允许模型把手伸多远」——工具闸门，判法是代码；
 *   模式      管「模型是谁、手上有什么、被叮嘱了什么」——提示词 + 工具目录 + 骨架取舍。
 *
 * 三条硬约束（改这个文件时别破）：
 *   1. **模式只做减法**。工具白名单只能是全量的子集，`drop` 只能在下面那张名单里去掉
 *      骨架段。任何模式都放宽不了安全：审批灾难地板与守卫链不看模式，看的是命令行与权限模式。
 *   2. **默认档必须等价于「没有模式这个概念」**。标准模式的工具投影是恒等映射、提示段是
 *      空串（空段会被 composePrompt 滤掉），所以系统提示词逐字节不变——服务端提示缓存
 *      只认前缀，默认档一变就等于全失效。
 *   3. **坏文件不许把启动拦下来**。解析不出来就带 problem 列出来，模型仍按标准档跑。
 *
 * frontmatter 认这些键（都可选，缺省值见括号）：
 *
 * ```markdown
 * ---
 * name: review                    # 模式标识，小写字母数字连字符（缺省取文件名）
 * label: 代码审查模式               # 界面上的显示名（缺省取 name）
 * description: 只读地找漏洞与测试缺口，指出文件与行号
 * tools: read, glob, grep, bash   # 工具白名单（不写 = 全量；写 none = 一个工具都不给）
 * drop: behavior, tool-rules      # 要去掉的骨架提示段（名单见 DROPPABLE_SECTIONS）
 * ---
 * 这一段是模式的提示词，追加进系统提示。
 * ```
 *
 * @module dsc/core/presets
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import YAML from 'yaml'
import { splitFrontmatter } from './skills.js'

/** 模式文件目录。 */
export const DSC_PRESETS_DIR = join(homedir(), '.dsc', 'presets')

/** 四个出厂模式的标识（标准档是永久的回落目标，任何读不出来的情况都回落到它）。 */
export const STANDARD_PRESET = 'standard'
export const MINIMAL_PRESET = 'minimal'
export const MAKER_PRESET = 'maker'
export const PTC_PRESET = 'ptc'

/** 允许被模式去掉的骨架提示段。
 *
 * 只放「做法层面的叮嘱」：去掉它们只影响模型的自觉程度，
 * 代码里的守卫（审批硬地板、命令策略、路径策略）一条都不会因此松开。
 * `identity`（中文与称呼约定）与 `environment`（环境事实）不在名单里：前者是产品约定，
 * 后者是事实——两者都不该被一个模式抹掉。 */
export const DROPPABLE_SECTIONS: readonly string[] = ['behavior', 'tool-rules', 'instructions', 'skills']

/** 骨架段的中文名（设置面板上让人勾的名单）。 */
export const DROPPABLE_LABELS: Readonly<Record<string, string>> = {
  behavior: '做事方式（先看代码再动手、破坏性操作先警告…）',
  'tool-rules': '工具使用规范（哪个工具干什么、别拿 shell 当万能）',
  instructions: '项目说明书（AGENTS.md / CLAUDE.md）',
  skills: '技能目录（<available_skills>）',
}

/** 模式名形状：小写字母数字加连字符，最长 32，够界面一排显示。 */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 一个模式。 */
export interface Preset {
  /** 模式标识（文件名去掉 .md，或 frontmatter 里的 name）。 */
  name: string
  /** 界面上的显示名。 */
  label: string
  description: string
  /** 工具白名单；null = 全量，空数组 = 一个工具都不给。 */
  tools: string[] | null
  /** 要去掉的骨架提示段 id（只认 {@link DROPPABLE_SECTIONS} 里的）。 */
  drop: string[]
  /** 正文 = 这个模式追加给模型的提示词。 */
  prompt: string
  /** 是不是 dsc 出厂自带的那四个。 */
  builtin: boolean
  /** 文件路径（诊断与「查看配置」用）。 */
  file: string
  /** 文件里有问题时的说明（其余字段退回默认值）。 */
  problem?: string
}

/** 出厂模式：名字 → 文件内容。第一次用到时写出去，之后用户随便改（不覆盖）。 */
const BUILTIN_FILES: Readonly<Record<string, string>> = {
  [STANDARD_PRESET]: `---
name: ${STANDARD_PRESET}
label: 标准模式
description: 处理代码、文件和资料，适合大多数任务；工具按需使用，提示词与出厂完全一致
---

`,
  [MINIMAL_PRESET]: `---
name: ${MINIMAL_PRESET}
label: 极简模式
description: 只给一条 shell（PowerShell）与固定提示词，用来对照模型的基础表现
tools: bash
drop: behavior, tool-rules, instructions, skills
---

你手上只有一条 shell 工具（bash），在这台机器上它跑的是 PowerShell，工作目录就是当前项目。
别的工具一个都没有：读文件、找文件、改文件、跑测试，全部用 shell 命令完成。

怎么干：
- 看文件用 Get-Content（要行号自己数）；找内容用 Select-String；找文件用 Get-ChildItem -Recurse。
- 改文件没有定点替换工具：先整篇读出来，再整篇写回去（Set-Content），改一处也一样。
- 跑测试、构建、git 都用 shell。
- 一条命令只做一件事；输出会被原样收进上下文，所以用 Select-Object -First 之类的办法先收窄，
  别把几万行拉进来。
- 每条命令都要过审批。危险动作（递归删除、强推、重置）先停下来说清，不要硬试。
- 最后用一小段话交回：做了什么、结果是什么、哪里还没查清。
`,
  [MAKER_PRESET]: `---
name: ${MAKER_PRESET}
label: 创造模式
description: 在标准能力之上加运行时只读查询：给自己加模式、给 dsc 写插件
---

你可以给自己加模式，也可以写插件。两件事都有现成的落点：

加一个模式：在 ~/.dsc/presets/ 下新建 <名字>.md（小写字母数字连字符）。frontmatter 认
name / label / description / tools / drop 五个键，正文就是追加进系统提示的那段话；
tools 是工具白名单（不写 = 全量），drop 只能去掉行为规范那几段（完整名单见 docs/presets.md）。
写完让用户切过去试：/preset <名字>，或者在设置 → 模式里点一下。

写一个插件：先读 docs/dsh-plugin-porting.md 与 examples/plugins/ 里的例子，再用
plugin_manager 装进 ~/.dsc/plugins/。插件能拿到哪些服务、扩展点长什么样，用 runtime_api
工具查——它读的是运行期的真状态，不是文档里的旧说法。

做事方式：
- 动别人的文件之前先说清要改什么、为什么；改完立刻验证（切过去问一轮，或跑相关自检脚本）。
- 别猜 API：查不到就说查不到，不要凭印象编一个方法名或字段名出来。
`,
  [PTC_PRESET]: `---
name: ${PTC_PRESET}
label: PTC 模式
description: 模型用代码组织工具调用：一次写一段脚本批量调工具，在代码里筛选汇总再把结论交回来
tools: run_code
---

这一轮你用代码组织工具调用：手上只有 run_code 一个工具，别的工具都在它的 SDK 里。

怎么写：run_code 的 code 参数是一段 JavaScript（顶层可以直接 await），
里面用 sdk 调工具——每个工具是一个函数，参数就是它原来的参数，返回它原来的输出文本：

    const found = await sdk.grep({ pattern: 'TODO', path: 'src' })
    const hits = found.split('\\n').filter((line) => line.includes('core'))
    return hits.slice(0, 20).join('\\n')

为什么这么做：工具的原始输出先进你的程序，你在程序里筛选、去重、统计、汇总，
只把结论交回上下文；批量任务因此不会被几十条工具输出撑爆。

每次 sdk.xxx 调用都照旧过审批与安全钩子，也照旧记进会话记录里。
直接 return 的就是要交回的内容——太长会被截断，自己先压到一两百行以内。
`,
}

/** 出厂模式名（界面标「内置」，删的时候给提示但不阻止不了——见 removePreset）。 */
export function builtinPresetNames(): string[] {
  return Object.keys(BUILTIN_FILES).sort()
}

/**
 * 把还不存在的出厂模式写进模式目录。
 * @returns 实际新写出的模式名（已存在的一律不覆盖，用户改过的永远留着）。
 */
export function ensureBuiltinPresets(): string[] {
  const created: string[] = []
  for (const [name, text] of Object.entries(BUILTIN_FILES)) {
    const file = join(DSC_PRESETS_DIR, `${name}.md`)
    if (existsSync(file)) continue
    try {
      mkdirSync(DSC_PRESETS_DIR, { recursive: true })
      writeFileSync(file, text, 'utf8')
      created.push(name)
    } catch {
      // 目录建不出来（只读盘、权限）：不报错，让用户自己建文件。
    }
  }
  return created
}

/** 把 frontmatter 里的列表字段读成字符串数组：逗号或空隔分隔，也认 YAML 数组。 */
function readList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw.map((item) => String(item)) : String(raw).split(/[,，\s]+/)
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

/** 读一个模式文件；返回 null = 文件名不合法或读不起来。 */
export function readPreset(file: string): Preset | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const base = basename(file, '.md')
  return parsePreset(text, base, file, base in BUILTIN_FILES)
}

/**
 * 标准档规格：文件在就用文件，文件被删了/写坏了就用出厂那份（内存里现解析）。
 * 这个函数**绝不返回 null**——它是整套模式系统的回落点，任何读不出来的情况
 * （文件没了、frontmatter 坏了、偏好里写了不存在的名字）最后都落到它身上。
 */
export function standardPreset(): Preset {
  const fromDisk = findPreset(STANDARD_PRESET)
  if (fromDisk !== null) return fromDisk
  const parsed = parsePreset(
    BUILTIN_FILES[STANDARD_PRESET] ?? '',
    STANDARD_PRESET,
    join(DSC_PRESETS_DIR, `${STANDARD_PRESET}.md`),
    true,
  )
  return parsed ?? FALLBACK_PRESET
}

/** 连出厂文本都解析不出来时的兜底对象（理论上到不了这里，留一个绝不为 null 的底）。 */
const FALLBACK_PRESET: Preset = {
  name: STANDARD_PRESET,
  label: '标准模式',
  description: '',
  tools: null,
  drop: [],
  prompt: '',
  builtin: true,
  file: join(DSC_PRESETS_DIR, `${STANDARD_PRESET}.md`),
}

/** 解析一份模式文件正文（磁盘上的文件与出厂文本走同一条路，判法只有一处）。 */
function parsePreset(text: string, base: string, file: string, builtin: boolean): Preset | null {
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
  if (!PRESET_NAME.test(name)) {
    return {
      name: base,
      label: base,
      description: '',
      tools: null,
      drop: [],
      prompt: '',
      builtin,
      file,
      problem: `模式名「${name}」不合法：只能用小写字母、数字、连字符，且不能以连字符开头`,
    }
  }

  const rawTools = doc.tools
  let tools: string[] | null = null
  if (rawTools !== undefined) {
    const list = readList(rawTools)
    tools = list.length === 0 || list.every((item) => item === 'none') ? [] : list
  }

  // drop 只认名单里的段：写错的当场说清，别让用户对着「提示词没变」猜半天
  const rawDrop = readList(doc.drop)
  const unknownDrop = rawDrop.filter((id) => !DROPPABLE_SECTIONS.includes(id))
  if (unknownDrop.length > 0) {
    problem =
      problem ?? `drop 里的 ${unknownDrop.join('、')} 不是可去掉的段（可选：${DROPPABLE_SECTIONS.join('、')}）`
  }
  const drop = rawDrop.filter((id) => DROPPABLE_SECTIONS.includes(id))

  const label = typeof doc.label === 'string' && doc.label.trim() !== '' ? doc.label.trim() : name
  return {
    name,
    label,
    description: typeof doc.description === 'string' ? doc.description.trim() : '',
    tools,
    drop,
    prompt: body.trim(),
    builtin,
    file,
    ...(problem !== undefined ? { problem } : {}),
  }
}

/** 列出全部模式，按名字排序；坏文件也列出来（带 problem），免得用户以为文件没生效。 */
export function listPresets(): Preset[] {
  if (!existsSync(DSC_PRESETS_DIR)) return []
  const out: Preset[] = []
  const seen = new Set<string>()
  // 文件名先排序：两个文件声明了同一个 name 时，谁生效是确定的（字典序在前的那个）
  for (const entry of readdirSync(DSC_PRESETS_DIR).sort()) {
    if (!entry.endsWith('.md')) continue
    const preset = readPreset(join(DSC_PRESETS_DIR, entry))
    if (preset === null) continue
    if (seen.has(preset.name)) {
      // 不静默丢弃：这一份按文件名挂在清单里，带一句话说明它为什么没生效
      out.push({
        ...preset,
        name: basename(entry, '.md'),
        label: `${preset.label}（未生效）`,
        tools: [],
        drop: [],
        prompt: '',
        problem: `这个文件声明的 name 是「${preset.name}」，已经有一个同名模式生效了，所以这一份不生效`,
      })
      continue
    }
    seen.add(preset.name)
    out.push(preset)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名字取模式；不存在返回 null（调用方决定是报错还是回落到标准档）。 */
export function findPreset(name: string): Preset | null {
  if (!PRESET_NAME.test(name)) return null
  const preset = readPreset(join(DSC_PRESETS_DIR, `${name}.md`))
  return preset !== null && preset.name === name ? preset : null
}

/** 写一个模式文件的正文（新建与编辑共用）。 */
function presetFileText(draft: {
  name: string
  label: string
  description: string
  tools: string[] | null
  drop: string[]
  prompt: string
}): string {
  const front: Record<string, unknown> = { name: draft.name, label: draft.label, description: draft.description }
  if (draft.tools !== null) front.tools = draft.tools.length === 0 ? 'none' : draft.tools.join(', ')
  if (draft.drop.length > 0) front.drop = draft.drop.join(', ')
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n\n${draft.prompt.trim()}\n`
}

/**
 * 写一个模式文件（设置面板「保存」用）。
 *
 * 覆盖写：手写在 frontmatter 里的额外键不会保留（写的永远是上面那五个键），
 * 想留着自己的键就直接编辑文件。名字非法或改名为已存在的模式时抛错。
 */
export function writePreset(draft: {
  oldName: string | null
  name: string
  label: string
  description: string
  tools: string[] | null
  drop: string[]
  prompt: string
}): Preset {
  const name = draft.name.trim()
  if (!PRESET_NAME.test(name)) {
    throw new Error(`模式名「${name}」不合法：只能用小写字母、数字、连字符，且不能以连字符开头`)
  }
  const drop = draft.drop.filter((id) => DROPPABLE_SECTIONS.includes(id))
  const label = draft.label.trim() === '' ? name : draft.label.trim()
  mkdirSync(DSC_PRESETS_DIR, { recursive: true })
  const file = join(DSC_PRESETS_DIR, `${name}.md`)
  if (draft.oldName !== null && draft.oldName !== name) {
    const oldFile = join(DSC_PRESETS_DIR, `${draft.oldName}.md`)
    if (existsSync(oldFile) && !existsSync(file)) rmSync(oldFile, { force: true })
  }
  writeFileSync(file, presetFileText({ ...draft, name, label, drop }), 'utf8')
  const written = readPreset(file)
  if (written === null) throw new Error(`模式 ${name} 写下去了却读不回来，检查一下 ${file}`)
  return written
}

/**
 * 删掉一个自定义模式。
 *
 * 内置四个不给删：删了下次启动 ensureBuiltinPresets 又会长回来，只会让人以为没删掉；
 * 想改内置的就直接编辑它。
 */
export function removePreset(name: string): void {
  if (name in BUILTIN_FILES) {
    throw new Error(`「${name}」是出厂内置模式，删不掉（删了下次启动又会长回来）；想改就直接编辑它`)
  }
  if (!PRESET_NAME.test(name)) throw new Error(`模式名「${name}」不合法`)
  const file = join(DSC_PRESETS_DIR, `${name}.md`)
  if (!existsSync(file)) throw new Error(`没有名为「${name}」的模式`)
  rmSync(file, { force: true })
}

/** 用户输入里的模式别名（`/preset 极简` 这类也能翻）。 */
const PRESET_ALIASES: Readonly<Record<string, string>> = {
  standard: STANDARD_PRESET,
  标准: STANDARD_PRESET,
  默认: STANDARD_PRESET,
  minimal: MINIMAL_PRESET,
  极简: MINIMAL_PRESET,
  精简: MINIMAL_PRESET,
  maker: MAKER_PRESET,
  创造: MAKER_PRESET,
  cordis: MAKER_PRESET,
  ptc: PTC_PRESET,
  代码: PTC_PRESET,
  批量: PTC_PRESET,
}

/**
 * 把用户写的模式词翻成模式名：先按别名表，再按显示名（label）精确匹配。
 * 认不出来返回 null（让调用方报可用清单）。
 */
export function parsePresetToken(token: string, presets: readonly Preset[] = listPresets()): string | null {
  const raw = token.trim()
  if (raw === '') return null
  const alias = PRESET_ALIASES[raw.toLowerCase()]
  if (alias !== undefined) return alias
  const byLabel = presets.find((preset) => preset.label === raw)
  if (byLabel !== undefined) return byLabel.name
  const lower = raw.toLowerCase()
  return presets.some((preset) => preset.name === lower) ? lower : null
}
