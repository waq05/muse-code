/**
 * dsc 版本号：从包根 package.json 读一次（设置「关于」分区展示）。
 * 宿主可能跑在 `lib/` 或打包后的任意深度，因此逐级上溯找本包的清单
 * （包名 `muse-code`，兼容旧名 `dsc-tui`；两个都不认就会一直上溯到盘根）。
 *
 * @module dsc/core/version
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包的包名：改名时要同步这里，否则「关于」分区会退回 `0.0.0`。 */
const PACKAGE_NAMES: readonly string[] = ['muse-code', 'dsc-tui']

export const DSC_VERSION: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (typeof doc.name === 'string' && PACKAGE_NAMES.includes(doc.name) && typeof doc.version === 'string') {
        return doc.version
      }
    } catch {
      // 这一层没有 package.json，继续往上
    }
    const parent = dirname(dir)
    if (parent === dir) return '0.0.0'
    dir = parent
  }
})()
