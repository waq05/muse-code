/**
 * `msc config` 子命令实现（由 bin/dsc.js spawn 本文件）：
 *   msc config migrate [--force]   从 dsh 迁移模型配置到 ~/.dsc/config.yaml
 *   msc config show                显示当前生效的端点/模型/key 来源（不打印 key）
 *
 * @module dsc/tools/config-cli
 */
import { existsSync } from 'node:fs'
import { readConfig } from '../core/config.js'
import {
  DSC_CONFIG_YAML,
  DSC_CREDENTIALS,
  DSH_CREDENTIALS,
  DSH_SETTINGS,
  migrateFromDsh,
  parseTolerantYaml,
} from '../core/migrate.js'
import { readFileSync } from 'node:fs'

const [, , command, ...rest] = process.argv

function runMigrate(): number {
  const force = rest.includes('--force')
  if (!existsSync(DSH_SETTINGS)) {
    console.log(`未找到 dsh 配置（${DSH_SETTINGS}），无内容可迁移。`)
    console.log(`可直接编辑 ${DSC_CONFIG_YAML} 手动配置端点。`)
    return 1
  }
  const report = migrateFromDsh({ force })
  if (report === null) {
    console.log(`目标配置已存在：${DSC_CONFIG_YAML}`)
    console.log('（迁移幂等，不覆盖；要重新迁移请加 --force）')
    return 0
  }
  console.log('迁移完成：')
  console.log(`  端点配置  ${report.configPath}`)
  console.log(`  端点      ${report.providers.join('、')}`)
  console.log(`  默认      ${report.defaultProvider}/${report.defaultModel}`)
  if (report.credentialsPath !== null) {
    console.log(`  凭据副本  ${report.credentialsPath}（key 名：${report.keysCopied.join('、')}，值未打印）`)
  } else {
    console.log(`  凭据      未复制（沿用 apiKeyEnv 环境变量或 ${DSH_CREDENTIALS} 回退）`)
  }
  return 0
}

function runShow(): number {
  const config = readConfig()
  console.log(`配置文件  ${DSC_CONFIG_YAML}${existsSync(DSC_CONFIG_YAML) ? '' : '（不存在）'}`)
  const providerNames = Object.keys(config.providers)
  if (providerNames.length === 0) {
    console.log('可用端点  （无——检查配置与 key 来源）')
    return 1
  }
  // key 来源标注（只用文件里出现过的名字判断，不读值）
  const dscCreds = existsSync(DSC_CREDENTIALS)
    ? (parseTolerantYaml(readFileSync(DSC_CREDENTIALS, 'utf8')) as { refs?: Record<string, unknown> })
    : {}
  const dshCreds = existsSync(DSH_CREDENTIALS)
    ? (parseTolerantYaml(readFileSync(DSH_CREDENTIALS, 'utf8')) as { refs?: Record<string, unknown> })
    : {}
  const fileProviders = existsSync(DSC_CONFIG_YAML)
    ? (parseTolerantYaml(readFileSync(DSC_CONFIG_YAML, 'utf8')) as {
        providers?: Record<string, { apiKeyEnv?: string }>
      }).providers
    : undefined
  for (const name of providerNames) {
    const provider = config.providers[name]
    const envName = fileProviders?.[name]?.apiKeyEnv
    const origin =
      envName === undefined
        ? '未标注 key 来源'
        : process.env[envName] === undefined
          ? `缺少环境变量 ${envName}`
          : dscCreds.refs?.[envName] !== undefined
            ? `${envName}（dsc 凭据文件）`
            : dshCreds.refs?.[envName] !== undefined && process.env[envName] === dshCreds.refs[envName]
              ? `${envName}（dsh 凭据回退）`
              : `${envName}（环境变量）`
    console.log(`\n端点 ${name}（${provider.displayName}）`)
    console.log(`  baseURL   ${provider.baseUrl}`)
    console.log(`  key       ${origin}`)
    for (const model of provider.models) {
      const mark = name === config.defaultProvider && model.id === config.defaultModel ? ' ←默认' : ''
      console.log(`  - ${model.id}  ${Math.round(model.contextWindow / 1000)}k 上下文${mark}`)
    }
  }
  console.log(`\n默认路由  ${config.defaultProvider}/${config.defaultModel}`)
  return 0
}

switch (command) {
  case 'migrate':
    process.exit(runMigrate())
    break
  case 'show':
    process.exit(runShow())
    break
  default:
    console.log('用法：msc config migrate [--force] | msc config show')
    process.exit(command === undefined ? 0 : 1)
}
