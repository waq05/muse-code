/**
 * 生成 desktop/src/renderer/file-icon-map.generated.ts：
 * 从 @iconify-json/vscode-icons 的全集（~4MB）里抽出「常用扩展名/文件名」对应的
 * icon body，产出一个几百 KB 的同步映射表。file-icons.tsx 从此不再动态 import
 * 图标集——未知扩展名回落 default-file 图标（VSCode 同款），长尾类型不再各带一个
 * 几 KB 的 SVG path。
 *
 * 为什么按「扩展名清单」而不是「图标名清单」生成：扩展名是稳定常识，不用对着
 * iconify 的命名猜；解析仍走 vscode-icons-js（特殊文件名规则与 VSCode 一致），
 * 生成器只负责把解析结果对应的 body 固化下来。
 *
 * 用法：node desktop/scripts/build-icon-map.mjs
 * 产物已入库；改了清单或升级 @iconify-json/vscode-icons 后重跑一次。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const require = createRequire(join(desktopRoot, 'package.json'))

const { getIconForFile } = require('vscode-icons-js')
const set = require('@iconify-json/vscode-icons/icons.json')

/** 扩展名（不带点）。覆盖语言 / 配置 / 文档 / 资源 / 归档，按真实仓库里的高频文件选的。 */
const EXTENSIONS = `js mjs cjs jsx ts mts cts tsx d.ts json jsonc json5 md mdx txt pdf py pyw pyi rb rs go
java kt kts cs fs fsx fsx? php swift c h cpp hpp cc cxx hxx m mm scala sc scss? sh bash zsh fish ps1 psm1 psd1
bat cmd lua pl pm r rmd jl d ex exs erl hrl hs ml mli fs? clj cljs cljc edn groovy gradle vue svelte astro dart
nim zig sql gql graphql prisma proto thrift tf tfvars hcl vim elm coffee pug hbs ejs njk twig liquid
yaml yml toml ini cfg conf properties env xml html htm xhtml css scss sass less styl pcss postcss
csv tsv parquet lock log gitignore gitattributes editorconfig npmrc yarnrc
png jpg jpeg gif svg webp ico avif bmp tif tiff icns woff woff2 ttf otf eot
mp3 wav flac ogg m4a mp4 webm mov avi mkv wmv zip gz tgz tar bz2 xz 7z rar jar war class
wasm wat bin exe dll so dylib obj o a lib pdb ipdb deb rpm apk ipa
doc docx xls xlsx ppt pptx odt ods odp rtf numbertmpl
astro svelte vueStyle ignore sum mod sum?` .split(/\s+/).filter((x) => /^[a-z0-9.?]+$/.test(x))

/** 常见完整文件名（vscode-icons-js 的特殊文件名规则比扩展名准，这里点名常用的）。 */
const FILENAMES = `package.json package-lock.json pnpm-lock.yaml yarn.lock bun.lockb deno.json deno.lock
tsconfig.json tsconfig.build.json jsconfig.json vite.config.ts vite.config.js vitest.config.ts
webpack.config.js rollup.config.js babel.config.js .babelrc .eslintrc .eslintrc.json eslint.config.js
.prettierrc .prettierrc.json prettier.config.js .editorconfig .gitignore .gitattributes .npmrc .nvmrc
Dockerfile .dockerignore docker-compose.yml Makefile CMakeLists.txt gradlew pom.xml build.gradle
Gemfile Rakefile Procfile Vagrantfile LICENSE LICENSE.md README.md CHANGELOG.md CONTRIBUTING.md
Cargo.toml Cargo.lock go.mod go.sum requirements.txt pyproject.toml setup.py poetry.lock Pipfile
composer.json phpunit.xml .env .env.example next.config.js nuxt.config.ts tailwind.config.js
tailwind.config.ts postcss.config.js svelte.config.js astro.config.mjs biome.json turbo.json
pnpm-workspace.yaml lerna.json .prettierignore .eslintignore codeOfWorkspace.code-workspace`.split(/\s+/)

/** 解析文件名 → iconify 图标 id（同 file-icons.tsx 的转换规则）。 */
function iconNameFor(filename) {
  return (getIconForFile(filename) ?? 'default_file.svg').replace(/\.svg$/, '').replaceAll('_', '-')
}

/** 沿 aliases 解引用到实体 icon（同 file-icons.tsx 的 iconBody，取名字与尺寸）。 */
function resolveIcon(id) {
  const direct = set.icons[id]
  if (direct !== undefined) return { ...direct }
  let parent = set.aliases?.[id]?.parent
  for (let depth = 0; depth < 3 && parent !== undefined; depth += 1) {
    const hit = set.icons[parent]
    if (hit !== undefined) return { ...hit }
    parent = set.aliases?.[parent]?.parent
  }
  return undefined
}

const bodies = new Map()
const misses = []
const add = (filename) => {
  const id = iconNameFor(filename)
  if (bodies.has(id)) return
  const icon = resolveIcon(id)
  if (icon === undefined || icon.body === undefined) {
    misses.push(`${filename} → ${id}`)
    return
  }
  bodies.set(id, { body: icon.body, width: icon.width, height: icon.height })
}

for (const ext of EXTENSIONS) add(`x.${ext.replace(/\?$/, '')}`)
for (const name of FILENAMES) add(name)
add('x.unknown') // default_file 兜底图标必须在内

if (bodies.get('default-file') === undefined) {
  throw new Error('default-file 图标没解析出来，回落链断了，先检查 icons.json 结构')
}

const entries = [...bodies.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
const totalBytes = entries.reduce((sum, [, v]) => sum + v.body.length, 0)
const out = `/**
 * 本文件由 desktop/scripts/build-icon-map.mjs 生成——不要手改，改清单后重跑生成器。
 *
 * 常用扩展名/文件名 → vscode-icons 图标 body 的固化映射（全集 ~4MB 里抽出来的常用子集，
 * 未知图标回落 default-file）。key 是 fileIconName() 的产物（iconify 图标 id，下划线转连字符）。
 * 生成时间：${new Date().toISOString()}；图标 ${entries.length} 个，body 合计 ≈ ${Math.round(totalBytes / 1024)} KB。
 */
/** 图标 body（path/gradient 等 svg 内联内容）与原始 viewBox 尺寸。 */
export interface GeneratedIconBody {
  body: string
  width?: number
  height?: number
}

export const GENERATED_FILE_ICONS: Record<string, GeneratedIconBody> = {
${entries.map(([id, v]) => `  '${id}': { body: ${JSON.stringify(v.body)}${v.width === undefined ? '' : `, width: ${v.width}`}${v.height === undefined ? '' : `, height: ${v.height}`} },`).join('\n')}
}
`

writeFileSync(join(desktopRoot, 'src', 'renderer', 'file-icon-map.generated.ts'), out)
console.log(`生成 ${entries.length} 个图标，body 合计 ≈ ${Math.round(totalBytes / 1024)} KB → src/renderer/file-icon-map.generated.ts`)
if (misses.length > 0) console.log(`未解析（跳过，运行时回落 default-file）：\n  ${misses.join('\n  ')}`)
