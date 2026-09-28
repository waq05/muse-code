/**
 * 组装打包用 dsc-core 运行时：把 dsc 仓库的 bin/lib/package.json 与 headless
 * 的运行期依赖（从 pnpm symlink 布局解析真实目录后复制）收拢到
 * desktop/runtime-staging/dsc-core，供 electron-builder 的 extraResources 携带。
 *
 * 运行期依赖清单 = lib 代码 import 的非 node 内置包：
 *   @deepseek-ai/cordis、@deepseek-ai/cordis-plugin-loader（连带 cosmokit、
 *   @standard-schema/spec）、yaml（config 解析）。ink/react 仅 TUI 使用，
 *   headless 不加载，不需要携带。
 *
 * @module desktop/scripts/prepare-runtime
 */
import { cpSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const dscRoot = resolve(desktopRoot, '..')
const staging = resolve(desktopRoot, 'runtime-staging', 'dsc-core')

rmSync(resolve(desktopRoot, 'runtime-staging'), { recursive: true, force: true })
mkdirSync(join(staging, 'node_modules'), { recursive: true })

cpSync(join(dscRoot, 'bin'), join(staging, 'bin'), { recursive: true })
cpSync(join(dscRoot, 'lib'), join(staging, 'lib'), { recursive: true })
cpSync(join(dscRoot, 'package.json'), join(staging, 'package.json'))

/**
 * 解析依赖的真实目录：先试顶层 symlink；传递依赖（不在顶层）从引用方的
 * pnpm 虚拟 node_modules（realpath 后上两级）解析。
 */
function resolveDepDir(dependency, via) {
  try {
    return realpathSync(join(dscRoot, 'node_modules', ...dependency.split('/')))
  } catch {
    const viaReal = realpathSync(join(dscRoot, 'node_modules', ...via.split('/')))
    const virtualNm = resolve(viaReal, '..', '..')
    return realpathSync(join(virtualNm, ...dependency.split('/')))
  }
}

// [依赖名, 引用方]：cosmokit 与 @standard-schema/spec 是 cordis 的传递依赖
const RUNTIME_DEPS = [
  ['@deepseek-ai/cordis', '@deepseek-ai/cordis'],
  ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-loader'],
  ['@deepseek-ai/cosmokit', '@deepseek-ai/cordis'],
  ['@standard-schema/spec', '@deepseek-ai/cordis'],
  ['yaml', 'yaml'],
]

for (const [dependency, via] of RUNTIME_DEPS) {
  const source = resolveDepDir(dependency, via)
  cpSync(source, join(staging, 'node_modules', ...dependency.split('/')), { recursive: true })
  console.log(`+ ${dependency} (${source})`)
}

console.log(`dsc-core 已组装：${staging}`)
