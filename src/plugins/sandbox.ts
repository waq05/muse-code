/**
 * sandbox 插件：给动手类工具套一层沙箱。**默认开**。
 *
 * 形制照 codex 的 `sandbox_mode` + 执行策略面，而不是 dsh 的 fail-closed：
 *   - 三档：read-only / workspace-write（默认）/ danger-full-access；
 *   - 策略面：可写根白名单（工作区 + 沙箱私有临时目录 + 附加根）、
 *     可写根内的只读子路径、受保护元数据名（`.git`、`.ssh`、`.env*`、凭据文件、
 *     `~/.dsc` 自己的控制文件）、网络开关（默认关）；
 *   - 命令前缀策略（codex 的 execpolicy）：逐段判 allow / prompt / forbidden；
 *   - 一次性升权：模型带成对的 `sandbox_permissions` + `justification` 请求放宽，
 *     只对这一次生效，且照常弹审批卡（见 `src/core/tools/sandbox-args.ts`）；
 *   - **降级照 codex，不照 dsh**：强制后端不可用时不 fail-closed，改为
 *     「照常执行 + 审批卡兜底」，并把 `enforcement: partial` 如实报给模型与用户。
 *
 * 职责边界（写在这里免得后来人搞混）：**沙箱管「能不能」，审批管「要不要问」**。
 * 所以本插件只 deny 两件事：越界写、以及「网络被关时还要联网」。
 * read-only 档也**不**拒掉整个 exec（那是权限模式与审批卡的事），
 * 只在命令里出现写目标时拒——两处都拒等于同一件事报两次错，模型会拿着两条理由不知道该改哪条。
 *
 * 挂载点：
 *   - 守卫链 order 8（早于协作模式 10）：越界 deny，范围内 defer 让别人照常判；
 *   - 命令执行器缝（`src/core/tools/command-runner.ts`）：只有「容器后端」用它；
 *   - `ctx.provide('sandbox', …)` 对外给查询与路径判定；
 *   - `ctx.prompt.register` 把当前档位与强制执行等级写进系统提示（降级必须可见）；
 *   - 设置分区 id 'sandbox' 与 `/sandbox` 命令。
 *
 * 支撑模块（本插件独占，别的插件不碰）：`src/core/sandbox/{policy,execpolicy,backends}.ts`
 *
 * @module dsc/plugins/sandbox
 */
import { mkdirSync } from 'node:fs'
import type { Plugin } from '@deepseek-ai/cordis'
import type { SettingsField, SettingsValues } from '../contract.js'
import { DSC_HOME } from '../core/path-policy.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { registerCommandRunner } from '../core/tools/command-runner.js'
import { readSandboxRequest } from '../core/tools/sandbox-args.js'
import type { ToolGuard } from '../core/tool-guards.js'
import { createDockerRunner, probeDocker } from '../core/sandbox/backends.js'
import { createWindowsTokenRunner, probeWindowsToken, type WindowsTokenRunnerHandle } from '../core/sandbox/win/backend.js'
import { readSetupState } from '../core/sandbox/win/account.js'
import { runSetupElevated } from '../core/sandbox/win/setup.js'
import { doctorWindowsNetwork } from '../core/sandbox/win/doctor.js'
import { evaluateCommand } from '../core/sandbox/execpolicy.js'
import {
  checkWrite,
  createPolicy,
  describePolicy,
  formatPathList,
  legalWay,
  parseAllowlistText,
  parsePathListText,
  resolveSandboxConfig,
  sandboxTmpDir,
  SANDBOX_CONFIG_KEY,
  SANDBOX_MODES,
  DEFAULT_SANDBOX_IMAGE,
  type PathCheck,
  type SandboxConfig,
  type SandboxPolicy,
} from '../core/sandbox/policy.js'
import type {
  SandboxCheck,
  SandboxEnforcement,
  SandboxMode,
  SandboxService,
  SettingsSectionSpec,
} from '../services/types.js'

/** 守卫刻度：灾难地板 5 < 沙箱 8 < 协作模式 10 < 安全钩子 20 < 审批 30。 */
const GUARD_ORDER = 8
/** 系统提示段位置：模式条款（30）之后、插件默认（60）之前。 */
const PROMPT_ORDER = 40
/** 设置分区位置：审批地板 33 之前，跟权限/模式相关的放前面。 */
const SECTION_ORDER = 31
/** 内存里留最近几次拒绝给 `/sandbox` 看。 */
const DENY_BUFFER = 3

/** 一条拒绝记录（内存环形缓冲，不落盘：它是给人当场看的，不是审计——审计在 core/audit.ts）。 */
interface DenialRecord {
  at: number
  tool: string
  rule: string
  why: string
}

/** 守卫给出的裁决（本插件内部用，统一带「怎么合法地做」那句）。 */
interface FenceVerdict {
  allowed: boolean
  rule: string
  why: string
  how: string
}

const PASS: FenceVerdict = { allowed: true, rule: 'allowed', why: '', how: '' }

/** 时间戳 → `/sandbox` 里那行 `[12:03:44]`。 */
function clockOf(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const sandboxPlugin: Plugin.Object = {
  name: 'sandbox',
  inject: ['guards', 'transcript', 'settings', 'prompt', 'commands', 'session'],
  apply(ctx, passed: unknown) {
    const readConfig = () => resolveSandboxConfig(resolvePluginConfig(SANDBOX_CONFIG_KEY, passed))

    /** 最近几次拒绝（新的在后）。 */
    const denials: DenialRecord[] = []
    /** 强制执行等级与后端现状：探测/降级都会改它，系统提示与设置页都读它。 */
    let enforcement: SandboxEnforcement = 'partial'
    let backendDetail = '进程内策略围栏（默认后端，不依赖外部进程）'
    /** 容器执行器的退订函数（换后端/停插件时要收回）。 */
    let offRunner: (() => void) | null = null
    /** 受限令牌后端的收尾（回收私有临时目录的能力 ACE）。 */
    let offWinDispose: (() => void) | null = null
    /** 网络第二级体检结论（doctor）：布防完整 full / 任一项缺 partial。 */
    let networkTier: 'full' | 'partial' = 'partial'
    /** 体检的逐项明细（√/× 每项一句话）。 */
    let networkTierDetail = '尚未体检'
    /** 探测代次：异步探测回来时后端已经又换过一次，那就作废这次结果。 */
    let generation = 0
    let disposed = false

    const currentCwd = (): string => ctx.session.current().meta.cwd
    const currentSessionId = (): string => ctx.session.current().meta.id

    /**
     * 组一份当前策略快照：设置与会话状态都现读，所以设置页改完立刻生效，不用重启宿主。
     * 沙箱私有临时目录顺手建出来（建不出来也不抛：策略会把它当普通路径判）。
     *
     * @param cwdOverride - 显式指定工作目录（守卫拿到的是 `input.cwd`，服务是 `canWrite` 的
     *   第二参）。为什么不直接用会话 cwd：可写根随「这次调用」走，同进程里可能同时有
     *   多个工作目录在跑；调用方给哪个目录，就按哪个目录算根。
     */
    const snapshot = (cwdOverride?: string): { config: SandboxConfig; policy: SandboxPolicy; problems: string[] } => {
      const { config, problems } = readConfig()
      const cwd = cwdOverride ?? currentCwd()
      const tmpDir = sandboxTmpDir(DSC_HOME, cwd, currentSessionId())
      try {
        mkdirSync(tmpDir, { recursive: true })
      } catch {
        // 目录建不出来时写它就是失败的，不必在这里报错（工具自己会拿到真实错误）
      }
      const policy = createPolicy({
        mode: config.mode,
        cwd,
        tmpDir,
        extraWritableRoots: config.extraWritableRoots,
        readOnlySubpaths: config.readOnlySubpaths,
        dscHome: DSC_HOME,
        networkAccess: config.networkAccess,
      })
      return { config, policy, problems: [...problems, ...policy.problems] }
    }

    /** 规则名 → 「怎么合法地做」。 */
    const howTo = (rule: string): string => {
      if (rule.startsWith('write-target:')) return legalWay(rule.slice('write-target:'.length) as PathCheck['rule'])
      if (rule === 'network-off') return '在「设置 → 沙箱」打开网络开关，或换成不需要联网的做法'
      if (rule === 'malformed-request') return '两个升权参数要么都给（sandbox_permissions + justification），要么都不给'
      return '换一个不需要改机器配置的做法；确需执行这条命令请让用户手工跑'
    }

    /** 记一次拒绝 + 拼给模型看的那句话（带档位、可写根、命中规则、下一步怎么走）。 */
    const refuse = (
      config: SandboxConfig,
      policy: SandboxPolicy,
      tool: string,
      verdict: FenceVerdict,
    ): { action: 'deny'; reason: string } => {
      denials.push({ at: Date.now(), tool, rule: verdict.rule, why: verdict.why })
      if (denials.length > DENY_BUFFER) denials.shift()
      const roots = policy.roots.length === 0 ? '（无）' : policy.roots.join('、')
      const reason =
        `沙箱拒绝这次 ${tool}：${verdict.why}。` +
        `当前档位 ${config.mode}（可写根：${roots}；网络：${config.networkAccess ? '开' : '关'}），` +
        `命中规则「${verdict.rule}」。${verdict.how}`
      return { action: 'deny', reason }
    }

    /** 写类调用：没有可认的写目标就不判（那是审批卡的活，别在这里瞎猜）。 */
    const writeVerdict = (policy: SandboxPolicy, target: string | undefined): FenceVerdict => {
      if (target === undefined || target.trim() === '') return PASS
      const check = checkWrite(policy, target)
      if (check.allowed) return PASS
      return { allowed: false, rule: check.rule, why: check.reason, how: legalWay(check.rule) }
    }

    /** 命令类调用：只有 forbidden 才拒；prompt/allow 都 defer（要不要问由审批层定）。 */
    const execVerdict = (config: SandboxConfig, policy: SandboxPolicy, command: string | undefined): FenceVerdict => {
      if (command === undefined || command.trim() === '') return PASS
      const verdict = evaluateCommand(command, {
        networkAccess: config.networkAccess,
        checkWrite: (raw) => checkWrite(policy, raw),
      })
      if (verdict.decision !== 'forbidden') return PASS
      return { allowed: false, rule: verdict.rule, why: verdict.reason, how: howTo(verdict.rule) }
    }

    // ── 守卫（order 8）────────────────────────────────────────────────────────

    const guard: ToolGuard = {
      id: 'sandbox',
      order: GUARD_ORDER,
      decide(input) {
        // 按这次调用的工作目录算可写根：input.cwd 就是循环传进来的会话目录，
        // 显式优先于会话状态，同进程多工作目录时才不会拿错根。
        const { config, policy } = snapshot(input.cwd)
        // 不设围栏的档位：整档交出去（审批与权限模式照常管）
        if (config.mode === 'danger-full-access') return { action: 'defer' }
        // 读限制不在本插件职责内：内核 path-policy 已经管凭据读取，这里再拒一次只会给两条理由
        if (input.risk === 'read') return { action: 'defer' }

        const request = readSandboxRequest(input.args)
        // 半截的升权请求一律拒：单独一个 sandbox_permissions（想偷偷放宽）
        // 或单独一个 justification，都不该放过去。
        if (request.kind === 'malformed') {
          const verdict: FenceVerdict = {
            allowed: false,
            rule: 'malformed-request',
            why: `升权参数不完整：${request.reason}`,
            how: howTo('malformed-request'),
          }
          return refuse(config, policy, input.toolName, verdict)
        }

        const verdict =
          input.risk === 'write'
            ? writeVerdict(policy, input.target)
            : input.risk === 'exec'
              ? execVerdict(config, policy, input.command)
              : PASS
        if (verdict.allowed) return { action: 'defer' }
        // 请求完整（成对）→ 交给审批卡照常问人：这正是「一次性」语义。
        // 沙箱在这里不表态，等于把「越界」这件事摊在卡上让用户决定。
        if (request.kind === 'ok') return { action: 'defer' }
        return refuse(config, policy, input.toolName, verdict)
      },
    }
    const offGuard = ctx.guards.register(guard)

    // ── 系统提示段（降级必须可见）─────────────────────────────────────────────

    /** 强制等级 → 一句人话。 */
    const enforcementText = (): string => {
      switch (enforcement) {
        case 'full':
          return 'full：命令的执行体被换成了容器（网络与文件系统由容器隔离）'
        case 'partial':
          return 'partial：进程内策略围栏（拦得住 dsc 自己发起的工具调用，拦不住命令内部的任意写）'
        default:
          return 'none：当前档位不设围栏'
      }
    }

    const promptText = (): string => {
      const { config, policy, problems } = snapshot()
      if (config.mode === 'danger-full-access') {
        return '【沙箱】档位 danger-full-access：沙箱不设围栏，写盘与命令只受权限模式与审批卡约束。'
      }
      const lines: string[] = []
      lines.push(`【沙箱】档位 ${config.mode}｜强制执行 ${enforcement}（${enforcementText()}）`)
      lines.push(
        `可写根：${policy.roots.length === 0 ? '（无，只读档不许写盘）' : policy.roots.join('、')}；` +
          `只读子路径：${policy.readOnlySubpaths.length === 0 ? '（无）' : policy.readOnlySubpaths.join('、')}；` +
          `网络：${config.networkAccess ? '开' : '关（要联网的命令会被直接拒）'}`,
      )
      if (config.backend === 'windows-token') {
        lines.push(`当前后端是 Windows 受限令牌：命令内部的越界写（脚本里的 fs.writeFile 这类）会被系统层直接拒绝；读不受限；网络第二级体检 ${networkTier}（明细见 /sandbox）。`)
      } else {
        lines.push('策略围栏拦得住 dsc 自己发起的工具调用，拦不住命令内部的任意写（脚本里的 fs.writeFile 这类）；要真隔离，请在「设置 → 沙箱」把后端换成 Windows 受限令牌（本机即可，无需 docker）或容器。')
      }
      lines.push('要写到可写根之外（例如另一个盘的项目目录），只能在这一次调用里同时给 sandbox_permissions 与 justification，且照常会弹审批卡让用户点。')
      if (problems.length > 0) lines.push(`⚠ 沙箱配置有问题（已按默认值兜底）：${problems.join('；')}`)
      return lines.join('\n')
    }
    const offPrompt = ctx.prompt.register('sandbox', promptText, { order: PROMPT_ORDER })

    // ── 后端探测与降级 ────────────────────────────────────────────────────────

    /**
     * 按当前设置重新决定后端与强制执行等级。
     *
     * 三档结果：不设围栏（none）/ 策略围栏（partial）/ 容器（full）。
     * 容器探测失败**不拒执行**，只是把「真隔离」降级成「审批卡兜底」并如实上报——
     * 这是与 dsh 的 fail-closed 最大的分歧点，理由写在 backends.ts 文件头。
     */
    const refreshBackend = async (): Promise<string> => {
      generation += 1
      const mine = generation
      offRunner?.()
      offRunner = null
      offWinDispose?.()
      offWinDispose = null
      const { config } = readConfig()

      if (config.mode === 'danger-full-access') {
        enforcement = 'none'
        backendDetail = '档位 danger-full-access：不设围栏'
        ctx.emit('dsc/changed')
        return backendDetail
      }
      if (config.backend === 'policy') {
        enforcement = 'partial'
        backendDetail = '进程内策略围栏（默认后端，不需要外部进程）'
        ctx.emit('dsc/changed')
        return backendDetail
      }

      if (config.backend === 'windows-token') {
        const probe = probeWindowsToken()
        if (!probe.available) {
          enforcement = 'partial'
          backendDetail = `Windows 受限令牌后端不可用，已降级为策略围栏：${probe.detail}`
          ctx.transcript.system(`沙箱：${backendDetail}`)
          ctx.emit('dsc/changed')
          return backendDetail
        }
        // 账本在 = 提权 setup 成功过：走账号分支（runner 以专用账号跑命令，网络过白名单代理）
        const setupState = readSetupState(DSC_HOME)
        const account = setupState !== null && setupState.ok
          ? { name: setupState.state.account, sid: setupState.state.sid, dscHome: DSC_HOME, proxyPort: setupState.state.proxyPort }
          : undefined
        const handle: WindowsTokenRunnerHandle = createWindowsTokenRunner({
          mode: config.mode === 'read-only' ? 'read-only' : 'workspace-write',
          cwd: currentCwd(),
          tmpDir: sandboxTmpDir(DSC_HOME, currentCwd(), currentSessionId()),
          extraRoots: config.extraWritableRoots,
          networkAccess: () => readConfig().config.networkAccess,
          networkAllowlist: () => readConfig().config.networkAllowlist,
          ...(account === undefined ? {} : { account }),
          onDetail: (message) => {
            if (!disposed) ctx.transcript.system(`沙箱：${message}`)
          },
        })
        offRunner = registerCommandRunner(handle.runner)
        offWinDispose = handle.dispose
        // 如实上报：账号分支在位 = FS 与网络双层锁死（full）；只有受限令牌时
        // 硬链接别名/读不受限是结构性缺口，网络只有软墙（partial），缺口在 detail 说透
        enforcement = handle.networkEnforced ? 'full' : 'partial'
        backendDetail = account === undefined
          ? `Windows 受限令牌：命令内部越界写被系统层拦截（${handle.describe()}）`
          : `Windows 受限令牌 + 专用账号（${account.name}）：越界写与越界出网都被系统层拦截（${handle.describe()}）`
        ctx.emit('dsc/changed')
        return backendDetail
      }

      const probe = await probeDocker({})
      if (disposed || mine !== generation) return '后端被再次切换，这次探测结果作废'
      if (!probe.available) {
        enforcement = 'partial'
        backendDetail = `容器后端不可用，已降级为策略围栏：${probe.detail}`
        ctx.transcript.system(`沙箱：选的容器后端用不了，已降级为策略围栏（强制执行 partial，照常执行 + 审批卡兜底）——${probe.detail}`)
        ctx.emit('dsc/changed')
        return backendDetail
      }
      const runner = createDockerRunner({
        image: config.image,
        networkAccess: () => readConfig().config.networkAccess,
        readOnly: () => readConfig().config.mode === 'read-only',
      })
      offRunner = registerCommandRunner(runner)
      enforcement = 'full'
      backendDetail = `容器后端可用（${probe.detail}），命令在 ${config.image} 里跑`
      ctx.emit('dsc/changed')
      return backendDetail
    }

    /** 挂载时那条可见说明：只讲档位、强制等级与网络，明细（后端、可写根）在 /sandbox 与设置里。 */
    const mountLine = (): string => {
      const { config, problems } = snapshot()
      const head = `沙箱已就绪：档位 ${config.mode}｜强制执行 ${enforcement}｜网络 ${config.networkAccess ? '开' : '关'}`
      const tail = enforcement === 'partial'
        ? (config.backend === 'windows-token'
          ? '。越界写已被系统层拦截；明细见 /sandbox。'
          : '。策略围栏拦得住工具调用，拦不住命令内部的任意写，要真隔离请在「设置 → 沙箱」换后端。')
        : '。'
      const warn = problems.length === 0 ? '' : ` ⚠ 配置有问题（已按默认值兜底）：${problems.join('；')}`
      return `${head}${tail}${warn}`
    }

    /** 跑一次网络第二级体检（不抛：任何异常都变成明细里的一条）。 */
    const refreshNetworkTier = async (): Promise<void> => {
      if (process.platform !== 'win32') {
        networkTier = 'partial'
        networkTierDetail = '非 Windows 平台：网络第二级不适用'
        ctx.emit('dsc/changed')
        return
      }
      try {
        const result = await doctorWindowsNetwork(DSC_HOME)
        networkTier = result.tier
        networkTierDetail = result.details.join('；')
      } catch (error) {
        networkTierDetail = `体检失败：${error instanceof Error ? error.message : String(error)}`
      }
      ctx.emit('dsc/changed')
    }

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    /** `/sandbox` 与设置页共用的一份现状文本。 */
    const report = (): string => {
      const { config, policy, problems } = snapshot()
      const lines: string[] = []
      lines.push(`沙箱现状：档位 ${config.mode}｜强制执行 ${enforcement}`)
      lines.push(`后端：${config.backend} —— ${backendDetail}`)
      lines.push(`可写根（${String(policy.roots.length)}）：`)
      if (policy.roots.length === 0) lines.push('  （无：只读档不许写盘）')
      for (const root of policy.roots) lines.push(`  ${root}`)
      lines.push(`只读子路径（${String(policy.readOnlySubpaths.length)}）：${policy.readOnlySubpaths.length === 0 ? '无' : ''}`)
      for (const sub of policy.readOnlySubpaths) lines.push(`  ${sub}`)
      lines.push(`网络：${config.networkAccess ? '开' : '关'}｜出网白名单 ${String(config.networkAllowlist.length)} 项｜沙箱私有临时目录：${policy.tmpDir}`)
      if (process.platform === 'win32') lines.push(`网络第二级：${networkTier} —— ${networkTierDetail}`)
      lines.push('最近 3 次拒绝：')
      if (denials.length === 0) lines.push('  （还没有）')
      for (const one of denials) lines.push(`  [${clockOf(one.at)}] ${one.tool} · ${one.rule} —— ${one.why}`)
      if (problems.length > 0) lines.push(`⚠ 配置有问题（已按默认值兜底）：${problems.join('；')}`)
      return lines.join('\n')
    }

    const section: SettingsSectionSpec = {
      id: SANDBOX_CONFIG_KEY,
      title: '沙箱',
      subtitle: '档位、可写根、网络开关与强制后端：拦「能不能写」，不拦「要不要问」',
      order: SECTION_ORDER,
      fields(): SettingsField[] {
        const { config, policy, problems } = snapshot()
        const list: SettingsField[] = [
          {
            type: 'select',
            key: 'mode',
            label: '档位',
            options: [
              { value: 'read-only', label: '只读（任何写盘都拒）' },
              { value: 'workspace-write', label: '工作区可写（默认）' },
              { value: 'danger-full-access', label: '不设围栏（等同关掉沙箱）' },
            ],
            help: '默认档不挡正常的工作区读写与命令：只有越界写、受保护名与「网络关时的联网命令」会被拒。',
          },
          {
            type: 'switch',
            key: 'networkAccess',
            label: '网络访问',
            help: '关时命中网络命令一律拒（curl / wget / npm install / git pull 这类）。开关只拦「写在命令里的」网络动作，脚本内部的请求拦不住。',
          },
          {
            type: 'text',
            key: 'networkAllowlist',
            label: '出网白名单（分号分隔域名）',
            mono: true,
            placeholder: 'registry.npmjs.org; *.example.com',
            help: 'windows-token 后端第二级（提权 setup 后）的代理按这份清单放行；*.example.com 匹配子域，精确域不含子域。清单为空 = 开着网也没放任何域名。',
          },
          {
            type: 'text',
            key: 'extraWritableRoots',
            label: '附加可写根（分号分隔）',
            mono: true,
            placeholder: 'D:\\shared; /srv/cache',
            help: '在工作区与私有临时目录之外再放行几个目录。相对路径按会话工作目录展开。',
          },
          {
            type: 'text',
            key: 'readOnlySubpaths',
            label: '只读子路径（分号分隔）',
            mono: true,
            placeholder: 'D:\\proj\\generated',
            help: '可写根内部的例外：这些子树即使落在可写根里也不许写。',
          },
          {
            type: 'select',
            key: 'backend',
            label: '强制后端',
            options: [
              { value: 'policy', label: '进程内策略围栏（默认，强制执行 partial）' },
              { value: 'windows-token', label: 'Windows 受限令牌（仅 Windows，越界写系统层拦截）' },
              { value: 'docker', label: '容器（需要本机 docker，强制执行 full）' },
            ],
            help:
              '受限令牌后端把命令换进「受限令牌 + 工作区 ACL」的 runner 子进程里跑（无需 docker，命令内部的越界写会被系统直接拒绝；' +
              '已知缺口：硬链接别名、读不受限、网络真管控需一次性提权 setup）。' +
              '容器后端把命令换进 docker 里跑（只挂工作区，网络按上面的开关），适合跨平台构建命令。' +
              '认不出 shell 形态的命令不会被换执行体，那一句仍会在宿主上跑。',
          },
          {
            type: 'text',
            key: 'image',
            label: '容器镜像',
            mono: true,
            placeholder: DEFAULT_SANDBOX_IMAGE,
            help: `容器后端用的镜像，默认 ${DEFAULT_SANDBOX_IMAGE}。镜像里得有你那条命令要用的工具（例如 node:20-alpine）。`,
          },
          { type: 'info', label: '强制执行等级', text: `${enforcement} —— ${enforcementText()}` },
          { type: 'info', label: '后端现状', text: backendDetail },
          { type: 'info', label: '沙箱私有临时目录', mono: true, copyable: true, text: policy.tmpDir },
          { type: 'info', label: '当前生效', text: describePolicy(policy) },
          {
            type: 'info',
            label: '最近 3 次拒绝',
            text: denials.length === 0 ? '（还没有）' : denials.map((one) => `[${clockOf(one.at)}] ${one.tool} · ${one.rule} —— ${one.why}`).join('\n'),
          },
          {
            type: 'button',
            action: 'probe',
            label: '立即探测后端',
            style: 'ghost',
            help: '按上面的后端选项现探一次：容器可不可用、降级到哪一档，结果就在按钮下面那句提示里。',
          },
        ]
        if (process.platform === 'win32') {
          list.push(
            { type: 'info', label: '网络第二级（提权布防）', text: `${networkTier} —— ${networkTierDetail}` },
            {
              type: 'button',
              action: 'setup',
              label: '提权安装网络管控（UAC 一次）',
              style: 'ghost',
              help: '创建专用离线账号、按账号 SID 出网阻断（防火墙 5 规则 + WFP 12 条持久 filter）、密码 DPAPI 落盘；账号先禁用、布防全部成功才解禁。需要你在 UAC 弹窗点一次允许。',
            },
            {
              type: 'button',
              action: 'doctor',
              label: '体检网络第二级',
              style: 'ghost',
              help: '逐项核对：FFI、状态文件、账号、密码可解、防火墙规则、WFP 子层；全绿即 full。',
            },
          )
        }
        if (problems.length > 0) {
          list.push({
            type: 'info',
            label: '配置有问题（已按默认值兜底）',
            text: problems.join('；'),
            help: '沙箱的坏配置不会把工作区写全禁掉——它只是少了一层围栏，所以这里回落默认值并如实列出来。',
          })
        }
        return list
      },
      values(): SettingsValues {
        const { config } = readConfig()
        return {
          mode: config.mode,
          networkAccess: config.networkAccess,
          networkAllowlist: formatPathList(config.networkAllowlist),
          extraWritableRoots: formatPathList(config.extraWritableRoots),
          readOnlySubpaths: formatPathList(config.readOnlySubpaths),
          backend: config.backend,
          image: config.image,
        }
      },
      async save(key, value): Promise<string | void> {
        switch (key) {
          case 'mode': {
            const mode = String(value)
            if (!(SANDBOX_MODES as readonly string[]).includes(mode)) return `档位只能是 ${SANDBOX_MODES.join(' / ')}`
            writePluginConfig(SANDBOX_CONFIG_KEY, { mode })
            break
          }
          case 'networkAccess':
            writePluginConfig(SANDBOX_CONFIG_KEY, { networkAccess: value === true })
            break
          case 'networkAllowlist': {
            const { domains, bad } = parseAllowlistText(typeof value === 'string' ? value : String(value))
            if (bad.length > 0) return `白名单里有不像域名的项：${bad.join('；')}`
            writePluginConfig(SANDBOX_CONFIG_KEY, { networkAllowlist: domains })
            break
          }
          case 'extraWritableRoots':
            writePluginConfig(SANDBOX_CONFIG_KEY, { extraWritableRoots: parsePathListText(typeof value === 'string' ? value : String(value)) })
            break
          case 'readOnlySubpaths':
            writePluginConfig(SANDBOX_CONFIG_KEY, { readOnlySubpaths: parsePathListText(typeof value === 'string' ? value : String(value)) })
            break
          case 'backend': {
            const backend = String(value)
            if (backend !== 'policy' && backend !== 'docker' && backend !== 'windows-token') {
              return '后端只能是 policy（策略围栏）/ docker（容器）/ windows-token（Windows 受限令牌）'
            }
            writePluginConfig(SANDBOX_CONFIG_KEY, { backend })
            break
          }
          case 'image': {
            const image = String(value).trim()
            if (image === '') return '镜像名不能空着（要恢复默认就填 ' + DEFAULT_SANDBOX_IMAGE + '）'
            if (/\s/.test(image)) return '镜像名不能带空格'
            writePluginConfig(SANDBOX_CONFIG_KEY, { image })
            break
          }
          default:
            return `这个分区没有这项：${key}`
        }
        // 档位/后端/网络都可能改变强制等级，改完立刻重算一次
        await refreshBackend()
        ctx.emit('dsc/changed')
      },
      async action(name): Promise<string | void> {
        if (name === 'probe') return await refreshBackend()
        if (name === 'doctor') {
          await refreshNetworkTier()
          return `网络第二级：${networkTier} —— ${networkTierDetail}`
        }
        if (name === 'setup') {
          if (process.platform !== 'win32') return '网络第二级只适用于 Windows'
          const result = await runSetupElevated(DSC_HOME)
          await refreshNetworkTier()
          const verdict = result.ok ? '提权 setup 完成' : '提权 setup 未完成'
          return `${verdict}：${result.detail}｜体检：${networkTier} —— ${networkTierDetail}`
        }
        return `这个分区没有这个按钮：${name}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // ── /sandbox 命令 ─────────────────────────────────────────────────────────

    const offCommand = ctx.commands.register(
      { name: 'sandbox', args: '', description: '看沙箱档位、强制执行等级、可写根、网络开关与最近 3 次拒绝' },
      ({ ui }) => {
        ui.notice(report())
      },
    )

    // ── 对外服务 ─────────────────────────────────────────────────────────────

    const service: SandboxService = {
      get mode(): SandboxMode {
        return readConfig().config.mode
      },
      get enforcement(): SandboxEnforcement {
        return enforcement
      },
      get writableRoots(): readonly string[] {
        return snapshot().policy.roots
      },
      get networkAccess(): boolean {
        return readConfig().config.networkAccess
      },
      get tmpDir(): string {
        return snapshot().policy.tmpDir
      },
      canWrite(path: string, cwd?: string): SandboxCheck {
        // cwd 省略时退回会话工作目录（接口约定见 src/services/types.ts 的 SandboxService）。
        const { policy } = snapshot(cwd)
        const check = checkWrite(policy, path)
        const out: SandboxCheck = { allowed: check.allowed, reason: check.reason }
        if (check.root !== undefined) out.root = check.root
        return out
      },
      describe(): string {
        const { config, policy } = snapshot()
        return `沙箱 ${config.mode}（强制执行 ${enforcement}）：${describePolicy(policy)}`
      },
    }
    const offService = ctx.provide('sandbox', service)

    // 换会话 = 换工作目录：受限令牌后端的可写根必须跟着重建（授权按路径缓存，重复授权幂等）。
    const offSession = ctx.on('dsc/session-open', () => {
      void refreshBackend().catch(() => {
        // 重建失败维持现状：下一次 plan() 会在授权失败时自己降级并如实上报
      })
      ctx.emit('dsc/changed')
    })

    // 挂载后立刻探一次后端，并把现状写进会话流：降级（partial）必须看得见。
    void refreshBackend()
      .then(() => {
        if (!disposed) ctx.transcript.system(mountLine())
      })
      .catch((error: unknown) => {
        if (!disposed) ctx.transcript.system(`沙箱后端探测失败（照常执行 + 审批卡兜底）：${errText(error)}`)
      })
    // 网络第二级体检（异步，结论进设置页与 /sandbox；不写会话流，避免挂载信息过载）
    void refreshNetworkTier()

    return () => {
      disposed = true
      generation += 1
      offRunner?.()
      offRunner = null
      offWinDispose?.()
      offWinDispose = null
      offSession()
      offService()
      offCommand()
      offSection()
      offPrompt()
      offGuard()
    }
  },
}
