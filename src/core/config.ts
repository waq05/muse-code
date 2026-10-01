/**
 * 核心配置：读 dsc 自己的 `~/.dsc/config.yaml`（providers + default），
 * 首次运行自动从 dsh 的 settings.yaml 迁移（见 migrate.ts）。
 *
 * key 来源顺序：`apiKeyEnv` 环境变量 → `~/.dsc/credentials.yaml`
 * → `~/.dsh/.credentials.yaml`（兼容回退）。任何情况下不打印 key。
 *
 * 兼容层：`~/.dsc/config.json` 仍可覆盖 default provider/model/temperature。
 *
 * @module dsc/core/config
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DSC_CONFIG_YAML,
  DSC_CREDENTIALS,
  DSH_CREDENTIALS,
  migrateFromDsh,
  parseTolerantYaml,
  type FileConfig,
  type FileProvider,
} from './migrate.js'
import { readModelCaps, type ModelCaps } from './model-caps.js'

/** 一个可对话的模型（能力声明见 core/model-caps.ts）。 */
export interface ModelInfo extends ModelCaps {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** 一个模型端点（线上协议由 `api` 选择，缺省 OpenAI 兼容；协议适配器见 llm 插件）。 */
export interface ProviderConfig {
  name: string
  displayName: string
  baseUrl: string
  apiKey: string
  /** 协议适配器 id；缺省 openai-completions。 */
  api?: string
  models: ModelInfo[]
}

/** 解析后的核心配置。 */
export interface DscCoreConfig {
  providers: Record<string, ProviderConfig>
  defaultProvider: string
  defaultModel: string
  /** 采样参数覆盖（缺省用端点默认）。 */
  temperature?: number
}

const DSC_CONFIG_JSON = join(homedir(), '.dsc', 'config.json')

/**
 * 把凭据库的 refs 段（env 名 → key 值）注入 process.env：dsc 自己的
 * 凭据文件优先，dsh 的作兼容回退。只注入缺失项。
 */
function loadCredentials(): void {
  for (const file of [DSC_CREDENTIALS, DSH_CREDENTIALS]) {
    if (!existsSync(file)) continue
    try {
      const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as { refs?: Record<string, unknown> }
      for (const [name, value] of Object.entries(doc.refs ?? {})) {
        if (typeof value === 'string' && value !== '' && process.env[name] === undefined) {
          process.env[name] = value
        }
      }
    } catch {
      // 单个凭据文件坏了不影响另一个
    }
  }
}

/** 把文件里的 provider 形状转成运行时形状（key 缺失的端点不注册）。 */
function toProvider(name: string, raw: FileProvider): ProviderConfig | null {
  const apiKey = raw.apiKeyEnv !== undefined ? (process.env[raw.apiKeyEnv] ?? '') : ''
  if (apiKey === '') return null
  // api 字段自给自足（不依赖别的能力声明），写错了当场说，不留到发请求才炸
  if (raw.api !== undefined && (typeof raw.api !== 'string' || raw.api.trim() === '')) {
    throw new Error(`config.yaml 端点 ${name} 的 api 字段写法不对：要填协议适配器 id（如 openai-completions）`)
  }
  return {
    name,
    displayName: raw.displayName ?? name,
    baseUrl: raw.baseURL.replace(/\/+$/, ''),
    apiKey,
    ...(raw.api !== undefined ? { api: raw.api.trim() } : {}),
    models: raw.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
      maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : 8_192,
      // 能力字段缺省时等价于旧行为：thinking 开关 + 四档 + 只吃文本
      ...readModelCaps(model),
    })),
  }
}

/**
 * 读配置。缺配置时先尝试从 dsh 迁移；provider 全空时返回空表
 * （boot 会把"没有可用端点"报给 UI，而不是崩溃）。
 */
export function readConfig(): DscCoreConfig {
  if (!existsSync(DSC_CONFIG_YAML)) migrateFromDsh()
  loadCredentials()

  const providers: Record<string, ProviderConfig> = {}
  let defaultProvider = ''
  let defaultModel = ''
  let temperature: number | undefined

  if (existsSync(DSC_CONFIG_YAML)) {
    const doc = parseTolerantYaml(readFileSync(DSC_CONFIG_YAML, 'utf8')) as unknown as FileConfig
    if (typeof doc.default?.provider === 'string') defaultProvider = doc.default.provider
    if (typeof doc.default?.model === 'string') defaultModel = doc.default.model
    if (typeof doc.temperature === 'number') temperature = doc.temperature
    for (const [name, raw] of Object.entries(doc.providers ?? {})) {
      const provider = toProvider(name, raw)
      if (provider !== null) providers[name] = provider
    }
  }

  if (existsSync(DSC_CONFIG_JSON)) {
    try {
      const overrides = JSON.parse(readFileSync(DSC_CONFIG_JSON, 'utf8')) as {
        provider?: string
        model?: string
        temperature?: number
      }
      if (typeof overrides.provider === 'string') defaultProvider = overrides.provider
      if (typeof overrides.model === 'string') defaultModel = overrides.model
      if (typeof overrides.temperature === 'number') temperature = overrides.temperature
    } catch {
      // 覆盖文件坏了就当没有
    }
  }

  // 默认路由指向不存在的 provider/model 时退回第一个可用组合
  if (providers[defaultProvider] === undefined) {
    const first = Object.keys(providers)[0]
    if (first !== undefined) {
      defaultProvider = first
      defaultModel = providers[first].models[0]?.id ?? ''
    } else {
      defaultProvider = ''
      defaultModel = ''
    }
  } else if (!providers[defaultProvider].models.some((model) => model.id === defaultModel)) {
    defaultModel = providers[defaultProvider].models[0]?.id ?? ''
  }

  return { providers, defaultProvider, defaultModel, temperature }
}
