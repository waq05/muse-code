/**
 * 组装打包用 dsc-core 运行时：把 dsc 仓库的 bin/lib/package.json 与 headless
 * 的运行期依赖（从 pnpm symlink 布局解析真实目录后复制）收拢到
 * desktop/runtime-staging/dsc-core，供 electron-builder 的 extraResources 携带。
 *
 * 运行期依赖清单 = lib 代码 import 的非 node 内置包：
 *   @deepseek-ai/cordis、@deepseek-ai/cordis-plugin-loader（连带 cosmokit、
 *   @standard-schema/spec）、yaml（config 解析）、koffi（沙箱 Win32 FFI）。
 *   ink/react 仅 TUI 使用，headless 不加载，不需要携带。
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
    // 从引用方真实目录往上走到它所在的虚拟 node_modules（对 scoped/unscoped 引用方都成立），
    // 再在里面找依赖的平级链接
    const viaReal = realpathSync(join(dscRoot, 'node_modules', ...via.split('/')))
    let cursor = viaReal
    while (cursor !== resolve(cursor, '..')) {
      if (cursor.endsWith('node_modules')) break
      cursor = resolve(cursor, '..')
    }
    return realpathSync(join(cursor, ...dependency.split('/')))
  }
}

// [依赖名, 引用方]：cosmokit 与 @standard-schema/spec 是 cordis 的传递依赖；
// koffi 是沙箱 windows-token 后端的运行期依赖（lib/core/sandbox/win/ffi.js require），
// 带原生二进制（win32-x64 预编译），同平台打包直接整目录复制即可
const RUNTIME_DEPS = [
  ['@deepseek-ai/cordis', '@deepseek-ai/cordis'],
  ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-loader'],
  ['@deepseek-ai/cosmokit', '@deepseek-ai/cordis'],
  ['@standard-schema/spec', '@deepseek-ai/cordis'],
  ['yaml', 'yaml'],
  ['koffi', 'koffi'],
  // koffi 3.x 的原生二进制拆在平台子包里（win32_x64/koffi.node），主包 require 运行时加载；
  // 它在 pnpm 里是 koffi 的平级依赖，不在 koffi 目录内部，必须单独携带
  ['@koromix/koffi-win32-x64', 'koffi'],
]

for (const [dependency, via] of RUNTIME_DEPS) {
  const source = resolveDepDir(dependency, via)
  cpSync(source, join(staging, 'node_modules', ...dependency.split('/')), { recursive: true })
  console.log(`+ ${dependency} (${source})`)
}

console.log(`dsc-core 已组装：${staging}`)
