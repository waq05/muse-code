/**
 * dsh 兼容层的模块解析钩子（主线程，同步注册）。
 *
 * dsh 外部插件以裸说明符 import dsh 生态的库（`@deepseek-ai/dsh-tools` 的
 * defineTool、`@deepseek-ai/schemastery` 的 z……）。这些文件装在 `~/.dsc/plugins/`
 * 下，Node 的解析走不到 dsc 自带的 node_modules。本钩子只做一件事：
 * 当**导入方在插件目录里**且说明符以 `@deepseek-ai/` 开头时，改用 dsc 运行时的
 * node_modules（以及 dsh-tools 自身的真实目录，pnpm 的传递依赖在那里）按 ESM
 * 条件重新解析。双构建包（schemastery 这类）因此会命中与 dsh-tools 内部 import
 * 完全相同的文件，不会出现 CJS/ESM 双实例的 instanceof 分裂。
 *
 * 用 `registerHooks`（同步、本线程）而不是 `register`（异步、hooks 线程）：
 * 注册完成即可生效，挂载路径不必等钩子线程就绪，也没有跨线程状态要传。
 *
 * @module dsc/core/dsh-compat/resolve-hook
 */
import { registerHooks, createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let registered = false

/**
 * 注册解析钩子（幂等）。
 * @param pluginsRoots - 允许重定向的插件目录（`~/.dsc/plugins/`）。
 */
export function ensureResolveHook(pluginsRoots: string[]): void {
  if (registered) return
  registered = true

  // 解析基点：dsc 根目录（直接依赖：cordis、dsh-tools）；dsh-tools 的真实目录
  // （它的传递依赖 schemastery、dsh-brand、dsh-util-values 住在 pnpm 布局的兄弟位）。
  const runtimeRoot = fileURLToPath(new URL('../..', import.meta.url))
  const bases = [runtimeRoot]
  try {
    bases.push(join(createRequire(join(runtimeRoot, 'package.json')).resolve('@deepseek-ai/dsh-tools'), '..'))
  } catch {
    // 没装 dsh-tools 就只剩 dsc 根目录一个基点：插件 import 时会响亮失败
  }
  const roots = pluginsRoots.map((root) => `${pathToFileURL(root).href}/`)

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? ''
      if (
        specifier.startsWith('@deepseek-ai/') &&
        parent.startsWith('file:') &&
        roots.some((root) => parent.startsWith(root))
      ) {
        for (const base of bases) {
          try {
            // 借基点目录当 parent：裸说明符解析只用目录做向上查走，假文件名不要求存在
            return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(base, 'package.json')).href })
          } catch {
            // 换下一个基点；全失败就走默认解析（ERR_MODULE_NOT_FOUND，响亮）
          }
        }
      }
      return nextResolve(specifier, context)
    },
  })
}
