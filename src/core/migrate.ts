/**
 * 把 dsh 的模型配置迁移到 dsc 自己的配置文件：
 *   ~/.dsh/settings.yaml 的 llm-pi-ai.providers + agent-default-model
 *     → ~/.dsc/config.yaml（providers + default）
 *   ~/.dsh/.credentials.yaml 的 refs（仅被引用到的 key）
 *     → ~/.dsc/credentials.yaml
 *
 * 迁移后 dsc 不再读 dsh 的任何文件（dsh 凭据只作缺失时回退）。
 * 幂等：目标已存在时不做（除非 force）。只读 dsh 文件，绝不修改它们。
 *
 * @module dsc/core/migrate
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import YAML from 'yaml'
import type { RawModelCaps } from './model-caps.js'

export const DSH_SETTINGS = join(homedir(), '.dsh', 'settings.yaml')
export const DSH_CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
export const DSC_CONFIG_YAML = join(homedir(), '.dsc', 'config.yaml')
export const DSC_CREDENTIALS = join(homedir(), '.dsc', 'credentials.yaml')

/** config.yaml 里一个模型条目：除 id 外都可缺省，能力字段见 core/model-caps.ts。 */
export interface FileModel extends RawModelCaps {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** dsc config.yaml 里一个端点的形状。 */
export interface FileProvider {
  displayName: string
  baseURL: string
  apiKeyEnv?: string
  /** 线上协议适配器 id；缺省 openai-completions。装了提供别的协议的插件后在这里选。 */
  api?: string
  models: FileModel[]
}

/** dsc config.yaml 的文件形状。 */
export interface FileConfig {
  default?: { provider?: string; model?: string }
  temperature?: number
  providers: Record<string, FileProvider>
}

export interface MigrationReport {
  configPath: string
  credentialsPath: string | null
  providers: string[]
  defaultProvider: string
  defaultModel: string
  /** 复制到 dsc 凭据文件的 key 名（不含值）。 */
  keysCopied: string[]
}

interface RawProvider {
  displayName?: string
  apiKeyEnv?: string
  api?: string
  baseURL?: string
  models?: {
    id?: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    /** dsh 侧的输入模态声明（`[text, image]` 之类）。 */
    inputModalities?: unknown
    /** dsh 侧的档位映射：false = 不支持思考，对象 = 档位 → 端点上的线上值。 */
    reasoningEfforts?: unknown
  }[]
}

/** 解析含 dsh 特有 tag（`!!js`）的 YAML：失败则剥掉这些行重试。 */
export function parseTolerantYaml(text: string): Record<string, unknown> {
  try {
    return (YAML.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    const stripped = text
      .split(/\r?\n/)
      .filter((line) => !line.includes('!!'))
      .join('\n')
    try {
      return (YAML.parse(stripped) as Record<string, unknown>) ?? {}
    } catch {
      return {}
    }
  }
}

/** 从 dsh settings.yaml 抽出可迁移的 provider 集合（仅 openai-completions）。 */
export function extractDshProviders(doc: Record<string, unknown>): Record<string, FileProvider> {
  const section = doc['llm-pi-ai'] as { providers?: Record<string, RawProvider> } | undefined
  const providers: Record<string, FileProvider> = {}
  for (const [name, raw] of Object.entries(section?.providers ?? {})) {
    if (raw?.api !== 'openai-completions' || typeof raw.baseURL !== 'string') continue
    const models: FileProvider['models'] = []
    for (const model of raw.models ?? []) {
      if (typeof model?.id !== 'string') continue
      const entry: FileModel = {
        id: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
        maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : 8_192,
      }
      // dsh 侧已经写清楚的能力声明一起搬过来，省得用户在界面上重填一遍
      if (Array.isArray(model.inputModalities)) entry.modalities = model.inputModalities
      const efforts = model.reasoningEfforts
      if (efforts === false) entry.thinkingLevels = []
      else if (efforts !== null && typeof efforts === 'object') {
        entry.thinkingLevels = Object.keys(efforts as Record<string, unknown>)
        entry.effortMap = efforts
        entry.thinkingParam = 'reasoning-effort'
      }
      models.push(entry)
    }
    if (models.length === 0) continue
    providers[name] = {
      displayName: typeof raw.displayName === 'string' ? raw.displayName : name,
      baseURL: raw.baseURL.replace(/\/+$/, ''),
      ...(typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv !== '' ? { apiKeyEnv: raw.apiKeyEnv } : {}),
      models,
    }
  }
  return providers
}

/**
 * 执行迁移。
 * @param force - 目标已存在时是否覆盖重迁。
 * @returns 迁移报告；无 dsh 配置或（未 force 且）目标已存在时返回 null。
 */
export function migrateFromDsh(options: { force?: boolean } = {}): MigrationReport | null {
  if (!existsSync(DSH_SETTINGS)) return null
  if (existsSync(DSC_CONFIG_YAML) && options.force !== true) return null

  const doc = parseTolerantYaml(readFileSync(DSH_SETTINGS, 'utf8'))
  const providers = extractDshProviders(doc)
  if (Object.keys(providers).length === 0) return null

  const defaults = (doc['agent-default-model'] ?? {}) as { provider?: string; model?: string }
  const config: FileConfig = {
    ...(typeof defaults.provider === 'string' || typeof defaults.model === 'string'
      ? { default: { ...(defaults.provider !== undefined ? { provider: defaults.provider } : {}), ...(defaults.model !== undefined ? { model: defaults.model } : {}) } }
      : {}),
    providers,
  }
  mkdirSync(dirname(DSC_CONFIG_YAML), { recursive: true })
  writeFileSync(
    DSC_CONFIG_YAML,
    `# dsc 模型配置（由 dsh 迁移生成，可直接编辑）\n# key 来源顺序：apiKeyEnv 环境变量 → ~/.dsc/credentials.yaml → ~/.dsh/.credentials.yaml\n${YAML.stringify(config)}`,
    'utf8',
  )

  // 凭据：只复制被 provider 引用到的 key（不打印值）
  const keysCopied: string[] = []
  let credentialsPath: string | null = null
  const wanted = new Set(
    Object.values(providers)
      .map((provider) => provider.apiKeyEnv)
      .filter((name): name is string => name !== undefined),
  )
  if (wanted.size > 0 && existsSync(DSH_CREDENTIALS)) {
    const creds = parseTolerantYaml(readFileSync(DSH_CREDENTIALS, 'utf8')) as { refs?: Record<string, unknown> }
    const refs: Record<string, string> = {}
    for (const name of wanted) {
      const value = creds.refs?.[name]
      if (typeof value === 'string' && value !== '') {
        refs[name] = value
        keysCopied.push(name)
      }
    }
    if (keysCopied.length > 0) {
      mkdirSync(dirname(DSC_CREDENTIALS), { recursive: true })
      writeFileSync(DSC_CREDENTIALS, YAML.stringify({ refs }), { encoding: 'utf8', mode: 0o600 })
      credentialsPath = DSC_CREDENTIALS
    }
  }

  return {
    configPath: DSC_CONFIG_YAML,
    credentialsPath,
    providers: Object.keys(providers),
    defaultProvider: config.default?.provider ?? Object.keys(providers)[0] ?? '',
    defaultModel: config.default?.model ?? providers[Object.keys(providers)[0] ?? '']?.models[0]?.id ?? '',
    keysCopied,
  }
}
