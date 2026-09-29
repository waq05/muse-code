/**
 * 技能写入：SKILL.md 的硬校验、写入后安全扫描（不过就还原）、归档、使用台账与老化分级。
 *
 * 为什么硬校验要卡在写盘之前、扫描要卡在写盘之后：
 *   - 校验（frontmatter / description ≤60 字符 / 正文非空 / 体积上限）是「这份技能还能不能
 *     被模型正确路由」的问题，写之前就能判，所以一个字节都不落盘；
 *   - 安全扫描是「这份技能会不会变成注入载荷」的问题，它看的是整份目录，只能在写完之后跑；
 *     不过就把原内容盖回去（新建的则删掉），并把原因回给模型——技能正文会被下一次的我
 *     当成操作手册照做，这里放过去等于给自己留一条后门。
 *
 * 三条硬规矩（对齐 hermes 的 `skill_manager_tool`）：read-before-write（本会话没读过就拒）、
 * 改前留副本（`SKILL.md.bak.<秒级时间戳>`）、归档只搬不删（`.archive/<名字>-<戳>/`）。
 *
 * 使用台账与老化分级也在这里：`~/.dsc/skills/.usage.json` 记命中计数与活跃时间，
 * `active → stale（14 天未命中）→ archived（30 天）`。**只有 `createdBy: 'agent'` 的技能
 * 会被自动归档**——用户手写的技能被自动搬走，是这份功能最不该做的事。
 *
 * 与 ledger.ts 之间有一处双向 import（这里要记台账、台账要读技能目录布局）。两边都只在
 * 函数里互相调用，模块顶层不做任何跨文件取值，所以 ESM 的循环求值是安全的。
 *
 * @module dsc/core/learnings/skill-write
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { contentText, type ChatMessage } from '../llm.js'
import { DSC_SKILLS_DIR, parseSkillMarkdown, scanSkillRoot, splitFrontmatter, writeSkillEnabled } from '../skills.js'
import { appendLedger, copyToBackup, EMPTY_HASH, hashText, type LedgerEntry } from './ledger.js'

/** 技能主文件名。 */
export const SKILL_FILE = 'SKILL.md'

/** 技能根目录（用户级技能目录，与 core/skills.js 的 DSC_SKILLS_DIR 是同一个）。 */
export function skillsRoot(): string {
  return DSC_SKILLS_DIR
}

/** 归档区（只进不出地堆在这里，永不删）。 */
export function archiveRoot(): string {
  return join(skillsRoot(), '.archive')
}

/** 使用台账文件。 */
export function usageFile(): string {
  return join(skillsRoot(), '.usage.json')
}

/** 技能的硬约束（设置里只暴露体积与描述长度，名字长度按 hermes 固定 64）。 */
export interface SkillLimits {
  /** description 的字符上限（hermes 的 SKILL_PROMPT_DESC_LIMIT）。 */
  descriptionMax: number
  /** SKILL.md 整份的字符上限。 */
  bodyMax: number
  /** 名字长度上限。 */
  nameMax: number
  /** 单个附属文件（references/scripts 这类）的字节上限。 */
  fileMax: number
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  descriptionMax: 60,
  bodyMax: 20 * 1024,
  nameMax: 64,
  fileMax: 256 * 1024,
}

/** 可以放附属文件的子目录（与 hermes 的 ALLOWED_SUBDIRS 一致，去掉 assets 换成 dsc 习惯的 assets 保留）。 */
export const ALLOWED_SUBDIRS: readonly string[] = ['references', 'templates', 'scripts', 'assets']

/** 技能名规则：kebab-case（与 core/skills.js 一致）。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 字符数（按码点算，表情符号不会被算成两个字符）。 */
function charCount(text: string): number {
  return [...text].length
}

// ── 校验 ───────────────────────────────────────────────────────────────────────

/** 校验结果：失败带中文原因，成功带解析出来的字段。 */
export interface ValidateResult {
  ok: boolean
  error: string
  fields: SkillDraft | null
}

/** 一份技能草稿的四个字段（L2 复盘让模型只回这四个）。 */
export interface SkillDraft {
  name: string
  description: string
  whenToUse: string
  content: string
}

/** 名字合法吗；不合法给一句中文原因。 */
export function validateSkillName(name: string, limits: SkillLimits = DEFAULT_SKILL_LIMITS): string {
  const trimmed = name.trim()
  if (trimmed === '') return '技能名不能空着'
  if (charCount(trimmed) > limits.nameMax) return `技能名超过 ${String(limits.nameMax)} 个字符`
  if (!NAME_PATTERN.test(trimmed)) {
    return `技能名「${trimmed}」不是 kebab-case（小写字母数字用短横线相连，例如 git-workflow）`
  }
  return ''
}

/**
 * 校验一份 SKILL.md 全文。
 *
 * 为什么 description 超限是**拒**而不是截断：技能目录里那份 description 是模型决定「要不要
 * 加载这个技能」的唯一依据，截到 57 字符加省略号会把触发词本身砍掉（用户写「当用户说……
 * 的时候」就没了后半句），于是这个技能永远不会被选中——静默失效比报错难查得多。
 */
export function validateSkillMarkdown(text: string, limits: SkillLimits = DEFAULT_SKILL_LIMITS): ValidateResult {
  if (text.trim() === '') return { ok: false, error: '技能正文是空的', fields: null }
  if (charCount(text) > limits.bodyMax) {
    return {
      ok: false,
      error: `技能正文 ${String(charCount(text))} 字符，超过 ${String(limits.bodyMax)} 的上限：把细节挪到 references/ 下的附属文件，SKILL.md 只留每次都要用的步骤`,
      fields: null,
    }
  }
  const { front, body } = splitFrontmatter(text)
  if (front.trim() === '') {
    return { ok: false, error: 'SKILL.md 必须以 YAML frontmatter（第一行 ---）开头，里面写 name、description、whenToUse', fields: null }
  }
  const parsed = parseSkillMarkdown(text)
  if (parsed.name === undefined) {
    return { ok: false, error: 'frontmatter 里缺 name，或者 name 不是字符串（kebab-case，例如 git-workflow）', fields: null }
  }
  const nameProblem = validateSkillName(parsed.name, limits)
  if (nameProblem !== '') return { ok: false, error: nameProblem, fields: null }
  if (parsed.description === '') return { ok: false, error: 'frontmatter 里缺 description（一句话写清做什么，它进模型可见目录）', fields: null }
  if (charCount(parsed.description) > limits.descriptionMax) {
    return {
      ok: false,
      error: `description 有 ${String(charCount(parsed.description))} 个字符，超过 ${String(limits.descriptionMax)} 的上限：技能目录会把超出的部分砍掉、触发词就没了，请缩短后重写`,
      fields: null,
    }
  }
  if (parsed.whenToUse === undefined) {
    return { ok: false, error: 'frontmatter 里缺 whenToUse（什么情况下该用这个技能），例如 whenToUse: 用户说「部署」的时候', fields: null }
  }
  if (body.trim() === '') {
    return { ok: false, error: 'frontmatter 之后必须有正文（步骤、命令、注意事项），不能是空技能', fields: null }
  }
  return {
    ok: true,
    error: '',
    fields: { name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse, content: body.trim() },
  }
}

/** 校验一份结构化草稿（L2 复盘与 `/learn` 走这条，插件自己拼 frontmatter）。 */
export function validateSkillDraft(draft: SkillDraft, limits: SkillLimits = DEFAULT_SKILL_LIMITS): ValidateResult {
  const nameProblem = validateSkillName(draft.name, limits)
  if (nameProblem !== '') return { ok: false, error: nameProblem, fields: null }
  const markdown = renderSkillMarkdown(draft)
  const result = validateSkillMarkdown(markdown, limits)
  if (!result.ok) return result
  return { ok: true, error: '', fields: draft }
}

/**
 * 把草稿拼成 SKILL.md 全文。
 *
 * frontmatter 的取值一律双引号包起来（JSON 字符串是合法 YAML 标量）：description 里出现
 * 冒号、引号、`#` 都不会把 YAML 解析带偏。`created_by: agent` 由这里盖章，
 * 不接受调用方传值——它是「这份技能归自动化维护」的标记，老化归档只认它。
 */
export function renderSkillMarkdown(draft: SkillDraft): string {
  const quote = (value: string): string => JSON.stringify(value.trim())
  const body = draft.content.replace(/\r\n/g, '\n').trim()
  return [
    '---',
    `name: ${quote(draft.name)}`,
    `description: ${quote(draft.description)}`,
    `whenToUse: ${quote(draft.whenToUse)}`,
    'created_by: agent',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

// ── 写后安全扫描 ───────────────────────────────────────────────────────────────

/** 不可见字符（零宽空格、方向控制符、标签字符、BOM）。全用转义写：源码里不该出现看不见的内容。 */
const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u2064\\uFEFF\\u{E0000}-\\u{E007F}]', 'gu')

interface ThreatRule {
  label: string
  pattern: RegExp
}

/**
 * 技能正文的安检表（自己实现一份，不 import 内核记忆那套私有规则）。
 *
 * 拦的不是脏话，而是「一段能让下一次的我把技能当指令去执行」的载体：叫模型忽略既有规则、
 * 别告诉用户、冒充系统消息、藏不可见字符，以及一大段编码载荷。危险命令（rm -rf 之类）
 * 不在这里拦——正经的运维技能正文里会写它，交给命令策略与审批那一层管。
 */
const THREAT_RULES: readonly ThreatRule[] = [
  { label: '藏着不可见字符（零宽空格、方向控制符这类，肉眼看不见但模型看得见）', pattern: INVISIBLE },
  {
    label: '叫模型忽略它自己收到的指令',
    pattern:
      /(忽略|无视|忘掉)[^。\n]{0,10}(指令|规则|约束|限制|系统提示)|ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|system)\s+(?:instruction|rule|prompt)/iu,
  },
  {
    label: '叫模型别把看到的东西告诉用户',
    pattern: /(不要|别)(告诉|提醒|通知|提及)[^。\n]{0,8}(用户|使用者)|do\s+not\s+(?:tell|inform|mention)[\s,]+(?:the\s+)?user/iu,
  },
  { label: '冒充系统消息或新的系统提示', pattern: /new\s+system\s+prompt|\[SYSTEM\]|<\|?system\|?>|我是系统提示/iu },
  { label: '一大段 base64 形状的载荷（200 字符以上）', pattern: /[A-Za-z0-9+/]{200,}={0,2}/u },
  {
    label: '一段编码后的载荷配着执行',
    pattern: /(base64|atob|fromCharCode|Convert\.FromBase64)[^\n]{0,40}(?:eval|exec|spawn|powershell|bash|Invoke-Expression)/iu,
  },
  {
    label: '把凭据原文写进了技能（形如 sk-… / AKIA… / eyJ… 的长串）',
    pattern: /\b(?:sk|pk|ghp|gho|xoxb|AKIA)[-_][A-Za-z0-9]{12,}\b|\beyJ[A-Za-z0-9_-]{20,}/u,
  },
  {
    label: '想把这条安检或技能台账绕过去',
    pattern: /(\.ledger\.jsonl|skill-write|skill_write)[^。\n]{0,14}(关掉|放开|绕过|改成|删掉)|(绕过|跳过)[^。\n]{0,6}(安检|扫描)/iu,
  },
]

/**
 * 一段技能文本过不过安检。
 *
 * @returns 拦下的原因；空串表示放行。先做 NFKC 归一：全角与兼容字符先换成一副正经面孔再判，
 *          不然一个全角的「ｉｇｎｏｒｅ」就能绕过去。
 */
export function scanSkillThreat(text: string): string {
  const normalized = text.normalize('NFKC')
  for (const rule of THREAT_RULES) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(normalized)) return rule.label
  }
  return ''
}

/** 整份技能目录的安检：SKILL.md 加全部附属文件一起看。 */
export function scanSkillDir(dir: string): string {
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      // 副本与临时文件不参与扫描：它们是原文件的影子，扫出问题也不是新引入的
      if (entry.name.includes('.bak.') || entry.name.endsWith('.tmp')) continue
      try {
        if (statSync(full).size > DEFAULT_SKILL_LIMITS.fileMax) return `${relative(dir, full)} 超过单个文件 ${String(DEFAULT_SKILL_LIMITS.fileMax)} 字节的上限`
        const reason = scanSkillThreat(readFileSync(full, 'utf8'))
        if (reason !== '') return `${relative(dir, full)}：${reason}`
      } catch {
        continue
      }
    }
  }
  return ''
}

// ── 落盘 ───────────────────────────────────────────────────────────────────────

/** 原子写文本：tmp + rename（Windows 上 rename 会覆盖目标，所以不需要先删）。 */
export function atomicWriteText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件已经不在了：忽略
    }
    throw error
  }
}

/** 技能目录路径。 */
export function skillDirOf(name: string): string {
  return join(skillsRoot(), name)
}

/** 技能正文文件路径。 */
export function skillFileOf(name: string): string {
  return join(skillDirOf(name), SKILL_FILE)
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一次技能写入的结果。 */
export interface SkillOpResult {
  ok: boolean
  error: string
  /** 成功时给用户 / 模型看的一句话。 */
  notice: string
  /** 这次写入记下的台账（失败时是 null）。 */
  entry: LedgerEntry | null
  /** 改前留的副本文件名（没有副本就是空串）。 */
  backup: string
}

function fail(error: string): SkillOpResult {
  return { ok: false, error, notice: '', entry: null, backup: '' }
}

/** 落盘 + 写台账，任何一步失败都转成中文原因。 */
function finishWrite(draft: Omit<LedgerEntry, 'id' | 'ts'>, notice: string, backup: string): SkillOpResult {
  try {
    const entry = appendLedger(draft)
    return { ok: true, error: '', notice, entry, backup }
  } catch (error) {
    // 台账写不进去不影响技能已经写好的事实：如实说出来，但不把这次写入判失败
    return { ok: true, error: '', notice: `${notice}（台账没写成：${errText(error)}）`, entry: null, backup }
  }
}

/** 新建技能的入参。 */
export interface CreateSkillInput {
  name: string
  markdown: string
  actor: 'model' | 'user'
  limits?: SkillLimits
  now?: number
}

/**
 * 新建一个技能：校验 → 落盘 → 写后扫描（不过就删掉刚写的文件）→ 记台账 → **写进停用名单**。
 *
 * 为什么默认停用：一份刚由模型自己写出来的技能，还没经过用户看过一眼就进模型目录，
 * 等于让模型用它自己写的手册指挥自己。停用之后用户 `/skills` 里点一下才生效。
 */
export function createSkill(input: CreateSkillInput): SkillOpResult {
  const limits = input.limits ?? DEFAULT_SKILL_LIMITS
  const nameProblem = validateSkillName(input.name, limits)
  if (nameProblem !== '') return fail(nameProblem)
  const validated = validateSkillMarkdown(input.markdown, limits)
  if (!validated.ok || validated.fields === null) return fail(validated.error)
  if (validated.fields.name !== input.name) {
    return fail(`frontmatter 里的 name「${validated.fields.name}」与要创建的名字「${input.name}」对不上：两者必须一致，否则技能中心显示的名字与目录名是两回事`)
  }
  const dir = skillDirOf(input.name)
  if (existsSync(dir)) {
    return fail(`技能 ${input.name} 已经存在（${dir}）：要改它用 patch，别用 create（create 不会覆盖别人的技能）`)
  }
  const file = skillFileOf(input.name)
  try {
    mkdirSync(dir, { recursive: true })
    atomicWriteText(file, input.markdown)
  } catch (error) {
    return fail(`技能没能写进磁盘：${errText(error)}`)
  }
  const threat = scanSkillDir(dir)
  if (threat !== '') {
    // 新建的这份没过安检：连同目录一起收拾掉（目录是我们刚建的，里面只有这一个文件）
    try {
      unlinkSync(file)
      rmdirSync(dir)
    } catch {
      // 收拾不干净就留着，至少内容已经删掉了
    }
    return fail(`这份技能没过安全扫描，已经撤销：${threat}`)
  }
  let notice = ''
  try {
    writeSkillEnabled(input.name, false)
  } catch (error) {
    notice = `（停用名单没写成，技能可能直接进模型目录，请在 /skills 里确认：${errText(error)}）`
  }
  // 使用台账：`created_by: agent` 是允许自动化维护它的唯一凭据（老化归档只认这一个标记）
  recordSkillCreated(input.name, input.now ?? Date.now(), 'agent')
  return finishWrite(
    {
      actor: input.actor,
      action: 'create',
      skill: input.name,
      beforeHash: EMPTY_HASH,
      afterHash: hashText(input.markdown),
      note: `新建 ${input.name}（默认停用，等用户在 /skills 启用）`,
    },
    `已建技能 ${input.name}（默认停用，/skills 里启用后才进模型可见目录）${notice}`,
    '',
  )
}

/** patch 的入参。 */
export interface PatchSkillInput {
  name: string
  oldString: string
  newString: string
  actor: 'model' | 'user'
  limits?: SkillLimits
  /** replaceAll：默认 false，片段撞多处就拒（改错地方比不改更糟）。 */
  replaceAll?: boolean
  /** read-before-write 是否满足（插件按会话状态判定后传进来）。 */
  readConfirmed: boolean
  now?: number
}

/**
 * 改一处：先在内存里改，校验整份新内容，再留副本、落盘、扫描；不过就把原内容盖回去。
 *
 * 顺序不能反：先留副本再落盘（不然崩溃就两头空），先校验再落盘（不然写进去一份缺
 * frontmatter 的文件，技能中心当场读不出来）。
 */
export function patchSkill(input: PatchSkillInput): SkillOpResult {
  const limits = input.limits ?? DEFAULT_SKILL_LIMITS
  const file = skillFileOf(input.name)
  if (!existsSync(file)) return fail(`技能 ${input.name} 不存在（${file}）：先 create，或者确认名字拼对了`)
  if (!input.readConfirmed) {
    return fail(`改 ${input.name} 之前得先读它：本会话还没用 skill 工具读过这个技能，先读一遍再改（读到的内容才是你要改的那份）`)
  }
  if (input.oldString === '') return fail('old_string 不能是空的：要说清楚改哪一段')
  let original = ''
  try {
    original = readFileSync(file, 'utf8')
  } catch (error) {
    return fail(`技能读不出来：${errText(error)}`)
  }
  const hits = original.split(input.oldString).length - 1
  if (hits === 0) return fail(`在 ${input.name}/SKILL.md 里找不到要替换的那段文字（片段要对得上，包括缩进与换行）`)
  if (hits > 1 && input.replaceAll !== true) {
    return fail(`这段文字在 ${input.name}/SKILL.md 里出现了 ${String(hits)} 次：要么把片段写得更具体，要么显式传 replace_all`)
  }
  const next = input.replaceAll === true ? original.split(input.oldString).join(input.newString) : original.replace(input.oldString, input.newString)
  const validated = validateSkillMarkdown(next, limits)
  if (!validated.ok) return fail(`这样改会把 SKILL.md 改坏：${validated.error}`)
  const backup = copyToBackup(file, input.now)
  try {
    atomicWriteText(file, next)
  } catch (error) {
    return fail(`技能没能写进磁盘：${errText(error)}`)
  }
  const threat = scanSkillDir(skillDirOf(input.name))
  if (threat !== '') {
    try {
      atomicWriteText(file, original)
    } catch (error) {
      return fail(`写后扫描没过（${threat}），而且原内容也没盖回去：${errText(error)}。原内容在副本 ${backup === '' ? '（没留下）' : backup} 里`)
    }
    return fail(`写后扫描没过，已经把原内容盖回去了：${threat}`)
  }
  bumpSkillPatch(input.name, input.now ?? Date.now())
  return finishWrite(
    {
      actor: input.actor,
      action: 'patch',
      skill: input.name,
      beforeHash: hashText(original),
      afterHash: hashText(next),
      ...(backup === '' ? {} : { backup }),
      note: '改一处',
    },
    `已改 ${input.name}/SKILL.md${backup === '' ? '' : `（改前的内容在副本 ${backup} 里）`}`,
    backup,
  )
}

/** 写附属文件的入参。 */
export interface WriteSkillFileInput {
  name: string
  /** 相对技能目录的路径，必须在 references/templates/scripts/assets 之下。 */
  filePath: string
  content: string
  actor: 'model' | 'user'
  limits?: SkillLimits
  readConfirmed: boolean
  now?: number
}

/** 附属文件路径的合法性检查：不许跳出技能目录，必须落在允许的子目录里。 */
export function validateSkillFilePath(filePath: string): string {
  const raw = filePath.trim().replace(/\\/g, '/')
  if (raw === '') return 'file_path 不能空着'
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return 'file_path 只能是相对技能目录的路径'
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return "file_path 里不许出现 '..'"
  if (parts.length < 2) return `附属文件要放在子目录里：${ALLOWED_SUBDIRS.join(' / ')} 之下，例如 references/example.md`
  if (!ALLOWED_SUBDIRS.includes(parts[0] ?? '')) {
    return `附属文件只能放在 ${ALLOWED_SUBDIRS.join(' / ')} 之下，收到的是「${parts[0] ?? ''}」`
  }
  return ''
}

/** 写一个附属文件（references/scripts 这类）：路径受辖、体积受辖、写后照样过安检。 */
export function writeSkillFile(input: WriteSkillFileInput): SkillOpResult {
  const limits = input.limits ?? DEFAULT_SKILL_LIMITS
  const dir = skillDirOf(input.name)
  if (!existsSync(skillFileOf(input.name))) return fail(`技能 ${input.name} 不存在：先 create 再用 write_file 加附属文件`)
  const pathProblem = validateSkillFilePath(input.filePath)
  if (pathProblem !== '') return fail(pathProblem)
  const relativePath = input.filePath.trim().replace(/\\/g, '/')
  const target = resolve(dir, relativePath)
  const root = resolve(dir)
  if (target !== root && !target.startsWith(root + sep)) {
    return fail(`写入目标跑到技能目录外面去了，拒绝：${relativePath}`)
  }
  if (Buffer.byteLength(input.content, 'utf8') > limits.fileMax) {
    return fail(`单个附属文件不能超过 ${String(limits.fileMax)} 字节`)
  }
  const exists = existsSync(target)
  if (exists && !input.readConfirmed) {
    return fail(`覆盖 ${input.name}/${relativePath} 之前得先读它：本会话还没用 skill 工具读过这个技能`)
  }
  const original = exists ? readFileSync(target, 'utf8') : ''
  const backup = exists ? copyToBackup(target, input.now) : ''
  try {
    atomicWriteText(target, input.content)
  } catch (error) {
    return fail(`附属文件没能写进磁盘：${errText(error)}`)
  }
  const threat = scanSkillDir(dir)
  if (threat !== '') {
    try {
      if (exists) atomicWriteText(target, original)
      else unlinkSync(target)
    } catch (error) {
      return fail(`写后扫描没过（${threat}），而且回滚也没做成：${errText(error)}`)
    }
    return fail(`写后扫描没过，已经撤销这次写入：${threat}`)
  }
  bumpSkillPatch(input.name, input.now ?? Date.now())
  return finishWrite(
    {
      actor: input.actor,
      action: 'write_file',
      skill: input.name,
      beforeHash: exists ? hashText(original) : EMPTY_HASH,
      afterHash: hashText(input.content),
      ...(backup === '' ? {} : { backup }),
      note: relativePath,
    },
    `已写 ${input.name}/${relativePath}${backup === '' ? '' : `（原文件在副本 ${backup} 里）`}`,
    backup,
  )
}

/** 秒级时间戳折成 `YYYYMMDDHHMMSS`（归档目录命名用，人一眼能看出是哪天搬的）。 */
export function formatStamp(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 把一个技能目录搬进归档区。 */
export function moveToArchive(name: string, now = Date.now(), suffix = ''): { ok: boolean; error: string; path: string } {
  const dir = skillDirOf(name)
  if (!existsSync(dir)) return { ok: false, error: `技能 ${name} 不存在`, path: '' }
  const base = `${name}-${formatStamp(now)}${suffix}`
  let target = join(archiveRoot(), base)
  for (let index = 1; existsSync(target) && index < 50; index += 1) {
    target = join(archiveRoot(), `${base}-${String(index)}`)
  }
  try {
    mkdirSync(archiveRoot(), { recursive: true })
    renameSync(dir, target)
  } catch (error) {
    return { ok: false, error: `搬进归档区失败：${errText(error)}`, path: '' }
  }
  return { ok: true, error: '', path: target }
}

/** 归档一个技能：只搬不删，台账里记一条。 */
export function archiveSkill(name: string, actor: 'model' | 'user', note = '归档（只搬不删）', now = Date.now()): SkillOpResult {
  const file = skillFileOf(name)
  if (!existsSync(file)) return fail(`技能 ${name} 不存在：没有可归档的东西`)
  const beforeHash = hashText(readFileSync(file, 'utf8'))
  const moved = moveToArchive(name, now)
  if (!moved.ok) return fail(moved.error)
  return finishWrite(
    { actor, action: 'archive', skill: name, beforeHash, afterHash: EMPTY_HASH, note: `${note} → ${moved.path}` },
    `已把技能 ${name} 搬进归档区 ${moved.path}（只搬不删，要恢复就把它搬回 ${skillsRoot()}）`,
    '',
  )
}

// ── read-before-write：本会话读过哪些技能 ────────────────────────────────────────

/** 扫会话消息里 `skill` 工具的调用参数，得到本会话读过的技能名。 */
export function skillNamesReadInMessages(messages: readonly ChatMessage[]): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || message.tool_calls === undefined) continue
    for (const call of message.tool_calls) {
      if (call.function.name !== 'skill') continue
      try {
        const args = JSON.parse(call.function.arguments) as { name?: unknown }
        if (typeof args.name === 'string' && args.name.trim() !== '') names.add(args.name.trim())
      } catch {
        // 参数不是合法 JSON 的调用跳过：这条调用本身也没成功
      }
    }
  }
  return [...names]
}

/** read-before-write 的判定入参。 */
export interface ReadBeforeWriteInput {
  /** 会话状态里记的已读技能。 */
  readSkills: readonly string[]
  /** 会话状态里记的「本插件刚建的技能」（刚建的算已读）。 */
  createdSkills: readonly string[]
  messages: readonly ChatMessage[]
  name: string
}

/**
 * read-before-write：本会话必须读过这个技能才准改。
 *
 * 为什么要查会话消息而不是只信会话状态：状态是插件自己写的，模型看不到也改不了，
 * 但「读过」这个事实本来就在会话里（`skill` 工具的调用参数）。两边取并集，
 * 重启恢复的老会话也能认出「这个会话确实读过它」。
 */
export function readBeforeWriteCheck(input: ReadBeforeWriteInput): { ok: boolean; error: string } {
  if (input.createdSkills.includes(input.name)) return { ok: true, error: '' }
  if (input.readSkills.includes(input.name)) return { ok: true, error: '' }
  if (skillNamesReadInMessages(input.messages).includes(input.name)) return { ok: true, error: '' }
  return { ok: false, error: `改 ${input.name} 之前得先读它：本会话还没用 skill 工具读过这个技能，先读一遍再改` }
}

/** 从会话消息里取出最后一条用户消息的纯文本（L1 的纠正语气判定用）。 */
export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'user') return contentText(message.content).trim()
  }
  return ''
}

/** 最后一个用户消息之前那条用户消息（L1 记「上一轮用户说了什么」用）。 */
export function previousUserText(messages: readonly ChatMessage[]): string {
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    seen += 1
    if (seen === 2) return contentText(message.content).trim()
  }
  return ''
}

/** 本轮用了多少次工具迭代（从末尾往回数 tool 消息，遇到 user 消息停）。 */
export function toolIterationsOfTurn(messages: readonly ChatMessage[]): number {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user') break
    if (message.role === 'tool') count += 1
  }
  return count
}

/** 本轮用户消息是第几条（0 起算；没有用户消息返回 -1）。 */
export function userTurnIndex(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) if (message.role === 'user') count += 1
  return count - 1
}

/** 取最后一条 assistant 消息的正文（L2 复盘结果就是这一条）。 */
export function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') return contentText(message.content).trim()
  }
  return ''
}

// ── 使用台账与老化分级 ─────────────────────────────────────────────────────────

/** 技能的生命周期档位。 */
export type SkillLifecycle = 'active' | 'stale' | 'archived'

/** 一个技能的使用记录。 */
export interface SkillUsageRecord {
  /** `agent` = 这份技能归自动化维护（老化归档只动这一档）；其它值（user / installed）不自动动它。 */
  createdBy: string
  /** 被 `skill` 工具读出来的次数。 */
  useCount: number
  /** 被 patch / write_file 改过的次数。 */
  patchCount: number
  createdAt: number
  /** 最后一次被读出来的时间；从没读过就是 null。 */
  lastUsedAt: number | null
  lastPatchedAt: number | null
  state: SkillLifecycle
  /** 钉住：挡住一切自动改写与自动归档。 */
  pinned: boolean
  archivedAt: number | null
}

/** 使用台账整份文件。 */
export interface UsageDoc {
  version: number
  skills: Record<string, SkillUsageRecord>
}

/** 读使用台账；文件缺失或坏了都当空台账（它只是遥测，不该让技能功能瘫掉）。 */
export function readUsage(): UsageDoc {
  const file = usageFile()
  if (!existsSync(file)) return { version: 1, skills: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; skills?: unknown }
    const skills: Record<string, SkillUsageRecord> = {}
    if (raw.skills !== null && typeof raw.skills === 'object' && !Array.isArray(raw.skills)) {
      for (const [name, value] of Object.entries(raw.skills as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        const record = value as Record<string, unknown>
        const num = (field: unknown, fallback: number): number => {
          const parsed = Number(field)
          return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
        }
        const time = (field: unknown): number | null => {
          const parsed = Number(field)
          return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null
        }
        const state = record.state
        skills[name] = {
          createdBy: typeof record.createdBy === 'string' ? record.createdBy : 'user',
          useCount: num(record.useCount, 0),
          patchCount: num(record.patchCount, 0),
          createdAt: num(record.createdAt, 0),
          lastUsedAt: time(record.lastUsedAt),
          lastPatchedAt: time(record.lastPatchedAt),
          state: state === 'stale' || state === 'archived' ? state : 'active',
          pinned: record.pinned === true,
          archivedAt: time(record.archivedAt),
        }
      }
    }
    return { version: 1, skills }
  } catch {
    return { version: 1, skills: {} }
  }
}

/** 写使用台账（tmp + rename）。 */
export function writeUsage(doc: UsageDoc): void {
  const file = usageFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 忽略
    }
    throw error
  }
}

/** 拿一条记录（没有就现造一条，不落盘）。 */
function ensureRecord(doc: UsageDoc, name: string, now: number): SkillUsageRecord {
  const existing = doc.skills[name]
  if (existing !== undefined) return existing
  const fresh: SkillUsageRecord = {
    createdBy: 'user',
    useCount: 0,
    patchCount: 0,
    createdAt: now,
    lastUsedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
    archivedAt: null,
  }
  doc.skills[name] = fresh
  return fresh
}

/** 记一次命中（`skill` 工具把它读出来了）：stale 的重新变 active。 */
export function bumpSkillUse(name: string, now = Date.now()): void {
  try {
    const doc = readUsage()
    const record = ensureRecord(doc, name, now)
    record.useCount += 1
    record.lastUsedAt = now
    if (record.state === 'stale') record.state = 'active'
    writeUsage(doc)
  } catch {
    // 遥测写不进去不影响技能本身
  }
}

/** 记一次改动（patch / write_file）。 */
export function bumpSkillPatch(name: string, now = Date.now()): void {
  try {
    const doc = readUsage()
    const record = ensureRecord(doc, name, now)
    record.patchCount += 1
    record.lastPatchedAt = now
    if (record.state === 'stale') record.state = 'active'
    writeUsage(doc)
  } catch {
    // 同上
  }
}

/** 新建技能时起一条记录：`createdBy: agent` 是「允许自动化维护它」的唯一凭据。 */
export function recordSkillCreated(name: string, now = Date.now(), createdBy = 'agent'): void {
  try {
    const doc = readUsage()
    doc.skills[name] = {
      createdBy,
      useCount: 0,
      patchCount: 0,
      createdAt: now,
      lastUsedAt: null,
      lastPatchedAt: null,
      state: 'active',
      pinned: false,
      archivedAt: null,
    }
    writeUsage(doc)
  } catch {
    // 同上
  }
}

/** 钉住 / 取消钉住；返回钉住后的状态。 */
export function setSkillPinned(name: string, pinned: boolean, now = Date.now()): boolean {
  const doc = readUsage()
  ensureRecord(doc, name, now).pinned = pinned
  writeUsage(doc)
  return pinned
}

/** 这个技能被钉住了吗。 */
export function isSkillPinned(name: string): boolean {
  return readUsage().skills[name]?.pinned === true
}

/** 老化判定用的阈值。 */
export interface AgingOptions {
  /** 多少天没命中算 stale。 */
  staleAfterDays: number
  /** 多少天没命中就归档。 */
  archiveAfterDays: number
}

export const DEFAULT_AGING: AgingOptions = { staleAfterDays: 14, archiveAfterDays: 30 }

/**
 * 一条记录现在该是什么档：活跃时间取「最后一次被读 / 被改 / 创建」里最新的那个。
 *
 * 为什么把 patch 也算活跃：被改过说明它还在被维护，用「最近一次命中」单算会把
 * 一个正在被反复改的技能判成 stale。
 */
export function classifyAging(record: SkillUsageRecord, now: number, options: AgingOptions = DEFAULT_AGING): SkillLifecycle {
  const anchor = Math.max(record.lastUsedAt ?? 0, record.lastPatchedAt ?? 0, record.createdAt)
  const days = (now - anchor) / (24 * 60 * 60 * 1000)
  if (days >= options.archiveAfterDays) return 'archived'
  if (days >= options.staleAfterDays) return 'stale'
  return 'active'
}

/** 一次整理的账。 */
export interface CurateReport {
  /** 这一轮降级成 stale 的技能。 */
  stale: string[]
  /** 这一轮归档的技能。 */
  archived: string[]
  /** 看着没事的、以及不该自动动的（用户手写、钉住、已归档）。 */
  skipped: string[]
  /** 整理后剩下的技能数。 */
  total: number
}

/**
 * 整理一次：把久未命中的技能降级，把过期的搬进归档区。
 *
 * **只动 `createdBy: 'agent'` 的技能**（与 hermes 的 curator 同一条规矩）：用户手写的技能
 * 是用户的东西，自动化没有资格替他把目录搬走。钉住的技能一律跳过。
 */
export function curateSkills(now = Date.now(), options: AgingOptions = DEFAULT_AGING): CurateReport {
  const report: CurateReport = { stale: [], archived: [], skipped: [], total: 0 }
  const doc = readUsage()
  let local: string[] = []
  try {
    local = scanSkillRoot({ dir: skillsRoot(), source: 'user-dsc', rank: 400 }).map((item) => item.name)
  } catch {
    local = []
  }
  report.total = local.length
  for (const name of local) {
    const record = doc.skills[name]
    if (record === undefined) {
      // 第一次见到的技能：起一条记录把活跃时钟锚在现在，绝不在这一轮就判它过期
      ensureRecord(doc, name, now)
      report.skipped.push(name)
      continue
    }
    if (record.pinned) {
      report.skipped.push(name)
      continue
    }
    if (record.createdBy !== 'agent') {
      report.skipped.push(name)
      continue
    }
    if (record.state === 'archived') {
      report.skipped.push(name)
      continue
    }
    const next = classifyAging(record, now, options)
    if (next === 'active') {
      if (record.state === 'stale') record.state = 'active'
      report.skipped.push(name)
      continue
    }
    if (next === 'stale') {
      record.state = 'stale'
      report.stale.push(name)
      continue
    }
    const moved = moveToArchive(name, now)
    if (!moved.ok) {
      report.skipped.push(name)
      continue
    }
    record.state = 'archived'
    record.archivedAt = now
    report.archived.push(name)
    try {
      appendLedger({
        actor: 'user',
        action: 'archive',
        skill: name,
        beforeHash: EMPTY_HASH,
        afterHash: EMPTY_HASH,
        note: `老化归档：${String(options.archiveAfterDays)} 天没命中 → ${moved.path}`,
        ts: now,
      })
    } catch {
      // 台账写不进去不影响已经搬走的事实
    }
  }
  try {
    writeUsage(doc)
  } catch {
    // 台账写不进去就算了
  }
  return report
}

/** 技能目录里有哪些本地技能（整理与设置页显示用）。 */
export function localSkillNames(): string[] {
  try {
    return scanSkillRoot({ dir: skillsRoot(), source: 'user-dsc', rank: 400 })
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** 归档区里堆了多少个（设置页显示「只搬不删」的现状）。 */
export function archivedCount(): number {
  try {
    return existsSync(archiveRoot()) ? readdirSync(archiveRoot()).length : 0
  } catch {
    return 0
  }
}

/** 把路径压成技能根下的相对路径（显示用；不在根下就原样返回）。 */
export function relativeToSkills(target: string): string {
  const root = normalize(skillsRoot())
  const full = normalize(resolve(target))
  return full.startsWith(root) ? relative(root, full) || basename(full) : target
}
