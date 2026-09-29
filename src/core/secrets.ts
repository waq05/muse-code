/**
 * 凭据遮红与环境脱敏：不让密钥从这三条路漏出去——
 *   1. 子进程继承到 dsc 自己的 API key，被模型诱导的脚本读走；
 *   2. 工具输出里的密钥原样进会话日志和界面；
 *   3. 会话文件落盘后被人当普通文本翻出来。
 *
 * 做法照 Hermes 的 `agent/redact.py` 与 `tools/code_execution_env.py:52`：
 * 一把正则扫文本，一份名单剥环境变量，开关在进程启动时冻结（运行中不许改）。
 *
 * @module dsc/core/secrets
 */

/** 遮红总开关：import 时冻结，运行中改环境变量无效（防止被诱导的脚本自己关掉）。 */
const REDACT_ENABLED = !/^(0|false|off)$/i.test(process.env.DSC_REDACT ?? '')

/** 遮红后的占位（长度与原值无关，不泄露密钥长短）。 */
const MASK = '«redacted:secret»'

/** 密钥形态：一条命中即整段替换。顺序按「长结构优先」排，避免 PEM 被后面的规则切碎。 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'deepseek-openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'stripe-key', re: /\b[rp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { name: 'bearer', re: /\b(authorization|auth)\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { name: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/gi },
  { name: 'kv-secret', re: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token)\b\s*[:=]\s*["']?([^\s"'&,;]{8,})["']?/gi },
]

/** 遮红结果：替换后的文本与命中条数。 */
export interface RedactResult {
  text: string
  /** 命中并替换掉的段数（0 = 这段没有密钥形状）。 */
  replaced: number
  /** 命中的规则名（进审计日志，不进正文，免得反向泄露）。 */
  kinds: string[]
}

/**
 * 把文本里密钥形状的字符串换成占位。
 *
 * 作用点：工具结果进会话前、审批卡摘要、会话日志落盘前、界面显示。
 * 关闭开关只影响这一层（`DSC_REDACT=0`），不影响下面的环境脱敏。
 */
export function redactText(input: string): RedactResult {
  if (!REDACT_ENABLED || input === '' || input.length > 4_000_000) return { text: input, replaced: 0, kinds: [] }
  let text = input
  let replaced = 0
  const kinds: string[] = []
  for (const { name, re } of SECRET_PATTERNS) {
    // 每条规则单独建新正则实例，避免共享 lastIndex 造成的漏扫。
    const pattern = new RegExp(re.source, re.flags)
    text = text.replace(pattern, (matched) => {
      // kv-secret 规则把键名一起吞进来了，这里只遮等号右边的值，键名留着给人看上下文。
      const at = matched.search(/[:=]\s*["']?/)
      if (name === 'kv-secret' && at > 0) return `${matched.slice(0, at + 1)}${MASK}`
      replaced += 1
      if (!kinds.includes(name)) kinds.push(name)
      return MASK
    })
  }
  return { text, replaced, kinds }
}

/** 只要遮红后的文本（大多数调用方不关心命中数）。 */
export function redact(input: string): string {
  return redactText(input).text
}

/** 变量名的密钥形状：命中就从子进程环境里剥掉。 */
const SECRET_ENV_NAME = /(^|_)(API_?KEY|APIKEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE_?KEY|ACCESS_?KEY|AUTH)(_|$)/i

/** 明确要剥的名字（不以密钥结尾但同样是凭据）。 */
const SECRET_ENV_EXPLICIT = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])

/** 剥环境时要无条件保活的键（子进程没有它们连不上网、找不到路径）。 */
const ENV_KEEP_ALWAYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'USER', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'LANG', 'LC_ALL', 'TERM', 'TTY', 'SHELL', 'PWD', 'HOSTNAME', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
])

/** 用户显式放行的环境变量名（`DSC_ENV_PASS=a,b`），只在没命中密钥形状时才有效。 */
function passThroughAllowlist(): Set<string> {
  const raw = process.env.DSC_ENV_PASS ?? ''
  return new Set(
    raw
      .split(/[,;]/)
      .map((name) => name.trim().toUpperCase())
      .filter((name) => name !== ''),
  )
}

/** 剥完的结果，附带被剥掉的变量名（进审计，值绝不进）。 */
export interface ScrubResult {
  env: Record<string, string | undefined>
  stripped: string[]
}

/**
 * 剥掉要跑的子进程环境里的凭据。
 *
 * 默认关死：命中密钥形状的变量名一律剥；`DSC_ENV_PASS` 只能放行没命中密钥形状的普通变量，
 * 命中密钥形状的怎么都不给（Hermes 的 `env_passthrough` 白名单也是这个次序）。
 * dsc 自己的 provider key 从 `~/.dsc/credentials.yaml` 走请求头，不靠环境变量，所以剥掉不影响对话。
 */
export function scrubChildEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): ScrubResult {
  const allow = passThroughAllowlist()
  const env: Record<string, string | undefined> = {}
  const stripped: string[] = []
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase()
    const isSecret = SECRET_ENV_EXPLICIT.has(upper) || SECRET_ENV_NAME.test(upper)
    if (isSecret && !ENV_KEEP_ALWAYS.has(upper)) {
      stripped.push(name)
      continue
    }
    if (allow.has(upper) === false && ENV_KEEP_ALWAYS.has(upper) === false && /^(DSC_|DSH_|HERMES_|OPENAI_|ANTHROPIC_|DEEPSEEK_)/.test(upper)) {
      // dsc/别家 harness 的私有变量对子进程没用，还常常带着端点与模型信息，一并剥掉。
      stripped.push(name)
      continue
    }
    env[name] = value
  }
  return { env, stripped }
}

/** 遮红是否生效（自检脚本用）。 */
export function redactionActive(): boolean {
  return REDACT_ENABLED
}
