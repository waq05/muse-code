/**
 * electron-builder afterPack：把 staging 的 dsc-core/node_modules 补进产物。
 * electron-builder 的 extraResources 会硬编码忽略 node_modules 目录（即使
 * filter 显式包含），因此运行期依赖在打包完成后由本钩子复制。
 *
 * @module desktop/scripts/after-pack
 */
const { cpSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

module.exports = async function afterPack(context) {
  const desktopRoot = resolve(__dirname, '..')
  const source = join(desktopRoot, 'runtime-staging', 'dsc-core', 'node_modules')
  const target = join(context.appOutDir, 'resources', 'dsc-core', 'node_modules')
  if (!existsSync(source)) {
    throw new Error(`afterPack: 缺少 ${source}（先运行 node scripts/prepare-runtime.mjs）`)
  }
  cpSync(source, target, { recursive: true })
  console.log(`afterPack: dsc-core/node_modules -> ${target}`)
}
