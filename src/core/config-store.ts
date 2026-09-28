/**
 * 模型配置的读写层：`~/.dsc/config.yaml`（providers + default + temperature）
 * 与 `~/.dsc/credentials.yaml`（API key）。设置界面「模型」分区是唯一写者，
 * headless 启动时读的那份对象由 settings 插件同步更新，所以改完不用重启宿主。
 *
 * 三条硬规矩：
 *   - API key 的值只写 credentials.yaml 的 refs，config.yaml 只留 apiKeyEnv 名字；
 *   - 写 config.yaml 前先落一份 `.bak`（YAML 重新序列化会丢手写注释）；
 *   - 读清单时以文件为准，缺 key 的端点也要列出来（运行期配置会把它过滤掉）。
 *
 * @module dsc/core/config-store
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import YAML from 'yaml'
import type { ModelConfigView, ProviderDraft, ProviderModelView, ProviderView } from '../contract.js'
import {
  DSC_CONFIG_YAML,
  DSC_CREDENTIALS,
  DSH_CREDENTIALS,
  parseTolerantYaml,
  type FileConfig,
  type FileProvider,
} from './migrate.js'

/** config.yaml 的绝对路径（关于分区与提示文案共用）。 */
export const CONFIG_FILE = DSC_CONFIG_YAML
/** dsc 凭据库路径。 */
export const CREDENTIALS_FILE = DSC_CREDENTIALS

/** 读 config.yaml 的原始文档（保留未知字段，缺 key 的端点也留着）。 */
export function readConfigDoc(): FileConfig {
  if (!existsSync(DSC_CONFIG_YAML)) return { providers: {} }
  const doc = parseTolerantYaml(readFileSync(DSC_CONFIG_YAML, 'utf8')) as unknown as FileConfig
  if (doc.providers === null || typeof doc.providers !== 'object') doc.providers = {}
  return doc
}

/** 写 config.yaml（覆盖前备份 .bak）。 */
export function writeConfigDoc(doc: FileConfig): void {
  mkdirSync(dirname(DSC_CONFIG_YAML), { recursive: true })
  if (existsSync(DSC_CONFIG_YAML)) {
    try {
      copyFileSync(DSC_CONFIG_YAML, `${DSC_CONFIG_YAML}.bak`)
    } catch {
      // 备份失败不阻塞写入：内容仍由调用方校验过
    }
  }
  const header =
    '# dsc 模型配置（设置界面「模型」分区可直接编辑，也可手改本文件）\n' +
    '# key 来源顺序：apiKeyEnv 环境变量 → ~/.dsc/credentials.yaml → ~/.dsh/.credentials.yaml\n'
  writeFileSync(DSC_CONFIG_YAML, `${header}${YAML.stringify(doc)}`, 'utf8')
}

/** 凭据库的 refs 段（key 名 → 值）。 */
function readCredentialRefs(): Record<string, string> {
  if (!existsSync(DSC_CREDENTIALS)) return {}
  const doc = parseTolerantYaml(readFileSync(DSC_CREDENTIALS, 'utf8')) as { refs?: Record<string, unknown> }
  const refs: Record<string, string> = {}
  for (const [name, value] of Object.entries(doc.refs ?? {})) {
    if (typeof value === 'string') refs[name] = value
  }
  return refs
}

/** 写凭据库 refs（保留其他条目；mode 600，值不外泄）。 */
function writeCredentialRef(ref: string, value: string | null): void {
  const refs = readCredentialRefs()
  if (value === null) delete refs[ref]
  else refs[ref] = value
  mkdirSync(dirname(DSC_CREDENTIALS), { recursive: true })
  writeFileSync(DSC_CREDENTIALS, YAML.stringify({ refs }), { encoding: 'utf8', mode: 0o600 })
}

/** dsh 的凭据库里有没有这个 key（只读，dsc 永不修改 dsh 的文件）。 */
function dshCredentialsHas(ref: string): boolean {
  if (!existsSync(DSH_CREDENTIALS)) return false
  const doc = parseTolerantYaml(readFileSync(DSH_CREDENTIALS, 'utf8')) as { refs?: Record<string, unknown> }
  const value = doc.refs?.[ref]
  return typeof value === 'string' && value !== ''
}

/** 这个 key 名当前能不能取到值（运行期同一套优先级）。 */
export function keyAvailable(ref: string): boolean {
  if (ref === '') return false
  if ((process.env[ref] ?? '') !== '') return true
  if ((readCredentialRefs()[ref] ?? '') !== '') return true
  return dshCredentialsHas(ref)
}

function toModelViews(models: FileProvider['models'] | undefined): ProviderModelView[] {
  return (models ?? []).map((model) => ({
    id: String(model.id ?? ''),
    name: String(model.name ?? model.id ?? ''),
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
    maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : 8_192,
  }))
}

/** 设置界面「模型」分区的数据源（读文件，因此缺 key 的端点也在列表里）。 */
export function readModelConfig(): ModelConfigView {
  const doc = readConfigDoc()
  const providers: ProviderView[] = Object.entries(doc.providers).map(([name, raw]) => {
    const keyRef = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv !== '' ? raw.apiKeyEnv : `${name.toUpperCase()}_API_KEY`
    return {
      name,
      displayName: typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : name,
      baseUrl: typeof raw.baseURL === 'string' ? raw.baseURL : '',
      keyRef,
      keyConfigured: keyAvailable(keyRef),
      models: toModelViews(raw.models),
    }
  })
  return {
    providers,
    defaultProvider: doc.default?.provider ?? '',
    defaultModel: doc.default?.model ?? '',
    temperature: typeof doc.temperature === 'number' ? doc.temperature : null,
    configFile: CONFIG_FILE,
    credentialsFile: CREDENTIALS_FILE,
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** 校验并归一化端点草稿（抛错的消息可直接展示给用户）。 */
export function validateDraft(draft: ProviderDraft): void {
  if (!NAME_PATTERN.test(draft.name)) {
    throw new Error(`端点名「${draft.name}」非法：用小写字母、数字、下划线或短横线，以字母或数字开头`)
  }
  if (!/^https?:\/\/\S+$/.test(draft.baseUrl.trim())) {
    throw new Error(`baseUrl「${draft.baseUrl}」非法：需要完整的 http(s) 地址，中间不能有空格`)
  }
  if (draft.models.length === 0) throw new Error('至少填一个模型（模型 id 是请求里发的名字）')
  for (const model of draft.models) {
    if (model.id.trim() === '') throw new Error('有模型的 id 是空的')
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error(`模型 ${model.id} 的上下文窗口要是正整数（不知道就填 128000）`)
    }
  }
}

/**
 * 写入端点新增/编辑/改名（同一 name 覆盖）。
 * @returns 改名后的新名字。
 */
export function upsertProvider(oldName: string | null, draft: ProviderDraft): string {
  validateDraft(draft)
  const doc = readConfigDoc()
  const name = draft.name.trim()
  if (oldName !== null && oldName !== name && doc.providers[name] !== undefined) {
    throw new Error(`端点 ${name} 已存在，先改个名字或删除旧的`)
  }
  const existing = oldName === null ? undefined : doc.providers[oldName]
  const keyRef = existing?.apiKeyEnv ?? `${name.toUpperCase()}_API_KEY`
  const provider: FileProvider = {
    displayName: draft.displayName.trim() === '' ? name : draft.displayName.trim(),
    baseURL: draft.baseUrl.trim().replace(/\/+$/, ''),
    apiKeyEnv: keyRef,
    models: draft.models.map((model) => ({
      id: model.id.trim(),
      name: model.name.trim() === '' ? model.id.trim() : model.name.trim(),
      contextWindow: Math.round(model.contextWindow),
      maxTokens: model.maxTokens > 0 ? Math.round(model.maxTokens) : 8_192,
    })),
  }
  if (oldName !== null && oldName !== name) delete doc.providers[oldName]
  doc.providers[name] = provider
  // 默认端点跟着改名走，否则启动时会退回第一个可用端点
  if (oldName !== null && doc.default?.provider === oldName) {
    doc.default = { provider: name, model: doc.default.model }
  }
  writeConfigDoc(doc)
  return name
}

/** 删除端点；默认端点被删时把 default 改指第一个可用端点。 */
export function deleteProvider(name: string): void {
  const doc = readConfigDoc()
  if (doc.providers[name] === undefined) throw new Error(`没有名为 ${name} 的端点`)
  delete doc.providers[name]
  const first = Object.keys(doc.providers)[0]
  if (doc.default?.provider === name) {
    doc.default =
      first === undefined
        ? undefined
        : { provider: first, model: doc.providers[first]?.models[0]?.id ?? '' }
  }
  writeConfigDoc(doc)
}

/** 写默认端点/模型。 */
export function writeDefaultModel(provider: string, model: string): void {
  const doc = readConfigDoc()
  if (doc.providers[provider] === undefined) throw new Error(`没有名为 ${provider} 的端点`)
  if (!toModelViews(doc.providers[provider].models).some((entry) => entry.id === model)) {
    throw new Error(`端点 ${provider} 没有模型 ${model}`)
  }
  doc.default = { provider, model }
  writeConfigDoc(doc)
}

/** 写采样温度（null = 删除该字段，跟随端点默认）。 */
export function writeTemperature(temperature: number | null): void {
  const doc = readConfigDoc()
  if (temperature === null) delete doc.temperature
  else doc.temperature = temperature
  writeConfigDoc(doc)
}

/**
 * 写入或清除端点的 API key（写 dsc 凭据库，并同步 process.env 让当前进程立即能用）。
 * @returns 给用户看的一句结果说明。
 */
export function writeProviderKey(ref: string, apiKey: string | null): string {
  if (ref === '') throw new Error('该端点没有声明 apiKeyEnv，无法定位 key 名')
  if (apiKey === null) {
    writeCredentialRef(ref, null)
    return keyAvailable(ref)
      ? `已从 ${CREDENTIALS_FILE} 清除 ${ref}，但本机环境变量仍提供它，运行期不受影响`
      : `已清除 ${ref}`
  }
  const value = apiKey.trim()
  if (value === '') throw new Error('API key 是空的')
  writeCredentialRef(ref, value)
  process.env[ref] = value
  return `已写入 ${ref}（${CREDENTIALS_FILE}）`
}
