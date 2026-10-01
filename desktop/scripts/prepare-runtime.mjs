/**
 * 组装打包用 dsc-core 运行时：把 dsc 仓库的 bin/lib/package.json 与 headless
 * 的运行期依赖（从 pnpm symlink 布局解析真实目录后复制）收拢到
 * desktop/runtime-staging/dsc-core，供 electron-builder 的 extraResources 携带。
 *
 * 运行期依赖清单 = 两处取并集再递归展开成闭包：
 *   ① dsc 自己 package.json 的 `dependencies` 去掉只有 TUI 用的几档
 *      （ink / react 只被 tui 入口加载，headless 不 import）；
 *   ② `lib` 里**真正 import** 的裸包（编译产物是唯一真相）。
 * 每个包再按自己的 dependencies / optionalDependencies 往下走，直到收全。
 *
 * 为什么不再维护一份手工清单：remote 插件 import `ws` 与 `web-push`，手工清单漏了
 * 这两个包，开发机上靠 Node 从 `desktop/node_modules` 爬回仓库侥幸能跑，换一台机器
 * 的打包件直接崩。闭包是自动的，任何包再引用什么都不会漏（连带补上了
 * `@deepseek-ai/schemastery` 这类原先清单里也没写的传递依赖）。
 *
 * @module desktop/scripts/prepare-runtime
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const dscRoot = resolve(desktopRoot, '..')
const staging = resolve(desktopRoot, 'runtime-staging', 'dsc-core')

// Windows 上上一轮被中断的 node 进程可能还攥着句柄，重试几次再放弃
rmSync(resolve(desktopRoot, 'runtime-staging'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
mkdirSync(join(staging, 'node_modules'), { recursive: true })

cpSync(join(dscRoot, 'bin'), join(staging, 'bin'), { recursive: true })
cpSync(join(dscRoot, 'lib'), join(staging, 'lib'), { recursive: true })
cpSync(join(dscRoot, 'package.json'), join(staging, 'package.json'))

const dscPackage = JSON.parse(readFileSync(join(dscRoot, 'package.json'), 'utf8'))

/** 只有 TUI 用的那几档不进嵌入运行时（headless 入口不加载，带上只是把包撑大）。 */
const TUI_ONLY = new Set(['ink', 'react'])

/**
 * 解析依赖的真实目录（pnpm 的 node_modules 里是符号链接，必须落到实体目录才能复制）。
 * 先试 dsc 顶层 node_modules；再照 Node 的解析顺序，从引用方的**真实目录**逐级往上试
 * 每一级的 node_modules：pnpm 的虚拟目录在 `.pnpm/<包>@<版本>/node_modules`，隐藏的
 * 提升目录在 `.pnpm/node_modules`。
 * @param viaDir - 引用方的真实目录（顶层依赖传 dscRoot）。
 */
function resolveDepDir(dependency, viaDir) {
  const parts = dependency.split('/')
  const top = join(dscRoot, 'node_modules', ...parts)
  if (existsSync(top)) return realpathSync(top)
  let cursor = viaDir
  for (;;) {
    const candidate = join(cursor, 'node_modules', ...parts)
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = resolve(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`在 ${viaDir} 的解析路径上找不到 ${dependency}`)
}

/** 读一个包真实目录的 package.json；读不出来（不是包目录）返回 null。 */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// ── 依赖闭包 ──────────────────────────────────────────────────────────────────
// 种子两处取：
//   ① dsc package.json 的 dependencies（去掉只有 TUI 用的那几档）；
//   ② lib 里**真正 import** 的裸包——编译产物是唯一真相。声明了不 import 是常态，
//      import 了没声明才是地雷：ws / web-push 当年正是这样漏掉的（代码在插件里，
//      手工清单却没人更新）。
// optionalDependencies 也算一条边：koffi 的原生二进制拆在平台子包
// （win32 是 @koromix/koffi-win32-x64），主包 require 时运行时加载，必须带上；
// 别的平台的子包 pnpm 压根没装，解析不到就跳过。
const closure = new Map()
const queue = []
for (const name of Object.keys(dscPackage.dependencies ?? {})) {
  if (!TUI_ONLY.has(name)) queue.push({ name, via: 'dsc 的 dependencies', viaDir: dscRoot, optional: false })
}

/** 收 lib 目录下所有 .js 里的裸模块名（跳过 node 内置；TUI 专用由调用方筛掉）。 */
function scanLibImports(libDir) {
  const found = new Set()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(path, 'utf8')
        for (const match of text.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) found.add(match[1])
        for (const match of text.matchAll(/import\(\s*['"]([^'".][^'"]*)['"]/g)) found.add(match[1])
      }
    }
  }
  walk(libDir)
  const names = new Set()
  for (const spec of found) {
    if (spec.startsWith('node:') || builtinModules.includes(spec)) continue
    const parts = spec.split('/')
    names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
  return names
}

/** lib 里 import 了、但 dev 树上也解析不到的包（照实报，不当场拦下打包）。 */
const unresolved = []

/** 跑一轮闭包扩张：队列里每条边各自解析，并把自己的依赖排进队列。 */
function expand() {
  while (queue.length > 0) {
    const edge = queue.shift()
    if (closure.has(edge.name)) continue
    let dir
    try {
      dir = resolveDepDir(edge.name, edge.viaDir)
    } catch (error) {
      if (edge.optional) continue
      throw new Error(`运行期依赖 ${edge.name}（由 ${edge.via} 引用）解析不到：${error.message}`)
    }
    enqueueDependencies(edge.name, dir)
  }
}

/** 记下一个包，并把它的 dependencies / optionalDependencies 排进队列。 */
function enqueueDependencies(name, dir) {
  closure.set(name, dir)
  const manifest = readManifest(dir)
  if (manifest === null) return
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    queue.push({ name: dep, via: name, viaDir: dir, optional: false })
  }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    queue.push({ name: dep, via: name, viaDir: dir, optional: true })
  }
}

expand()

// 第二遍：拿 lib 里真实出现的裸包对账。声明了不 import 是常态，import 了没声明才是地雷
// ——ws / web-push 当年正是这样漏掉的（代码在插件里，手工清单没人更新）。
// 这一步只补不删：闭包里已经有了的（例如 cordis 的传递依赖 schemastery）直接跳过。
for (const name of scanLibImports(join(staging, 'lib'))) {
  if (TUI_ONLY.has(name) || closure.has(name)) continue
  let dir = null
  // 从 dsc 根和闭包里每个已解析目录各试一次：pnpm 把传递依赖放在虚拟 node_modules 里，
  // 只从根找是找不到的
  for (const viaDir of [dscRoot, ...closure.values()]) {
    try {
      dir = resolveDepDir(name, viaDir)
      break
    } catch {
      // 换下一个引用方继续试
    }
  }
  if (dir === null) {
    unresolved.push(name)
    continue
  }
  enqueueDependencies(name, dir)
  expand()
}

// 嵌入运行时必须带上的包：缺了它，宿主在换一台机器之后 import 就会失败。
// 少一个当场停在这里，而不是等打包件在用户机器上崩。
const REQUIRED = ['ws', 'web-push']
const missing = REQUIRED.filter((name) => !closure.has(name))
if (missing.length > 0) {
  throw new Error(
    `嵌入运行时缺少 ${missing.join('、')}：检查 dsc 的 package.json dependencies 是否还声明着它们`,
  )
}

if (unresolved.length > 0) {
  // 不当场拦下：dev 树上就没有这个包，多半是别处正在写的代码引用了还没装的依赖。
  // 但也别装作没看见——嵌入运行时里一样不会有它，那个插件真跑起来就会 import 失败。
  console.warn(`! 这些包 lib 里有 import，但 dev 树上也解析不到，嵌入运行时同样带不了：${unresolved.sort().join('、')}`)
}

for (const [name, source] of closure) {
  cpSync(source, join(staging, 'node_modules', ...name.split('/')), { recursive: true })
  console.log(`+ ${name} (${source})`)
}

// 真加载一次：解析对了不代表传递依赖齐全（漏一个传递依赖，require 时才炸）。
// 这里从产物目录里 require，缺谁当场报出来。
const stagedRequire = createRequire(join(staging, 'package.json'))
for (const name of REQUIRED) {
  stagedRequire(name)
  console.log(`✓ ${name} 能在产物目录里加载`)
}

console.log(`dsc-core 已组装：${staging}（${closure.size} 个依赖包）`)
