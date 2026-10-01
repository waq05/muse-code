/**
 * 文件树与预览页签的彩色文件图标：VSCode 同款 vscode-icons 集。
 * 图标名解析走 vscode-icons-js（特殊文件名 / 扩展名规则与 VSCode 的插件一致，
 * 如 package.json → npm、pnpm-lock.yaml → pnpm、.ts → typescript）；
 * SVG 数据来自 @iconify-json/vscode-icons（整包注册一次，~4MB 走动态 import
 * 的懒 chunk——第一次画文件图标才加载，首屏不受影响）。
 *
 * 渲染不走 @iconify/react 的 <Icon>：它的占位机制按需异步换 svg，离线整包下
 * 时序不可控（会出现部分行停在占位 span）。这里数据到手后**同步**取 body 画
 * <svg>；body 里的渐变/裁剪 id 按实例加后缀，避免同页多实例互相串引用。
 * 目录图标不在这里——目录用 icons.tsx 的 IconFolder(Open)。
 */
import { useEffect, useId, useState, type JSX } from 'react'
import { getIconForFile } from 'vscode-icons-js'

/** icons.json 的最小形状（只需要 body 与尺寸，别引 @iconify/types 的完整类型）。 */
interface IconBody {
  body: string
  width?: number
  height?: number
}
interface IconSet {
  width?: number
  height?: number
  icons: Record<string, IconBody>
  aliases?: Record<string, { parent: string }>
}

/** 已装载的图标集（null = 还在懒加载）。 */
let collection: IconSet | null = null
let collectionPromise: Promise<void> | null = null

/** 装载图标集（幂等；动态 import 让 4MB 数据留在懒 chunk）。 */
function ensureFileIcons(): Promise<void> {
  collectionPromise ??= import('@iconify-json/vscode-icons').then((data) => {
    collection = data.icons as unknown as IconSet
  })
  return collectionPromise
}

/**
 * 文件名 → iconify 图标 id。vscode-icons-js 给的是 VSCode 插件原始名
 * （file_type_markdown.svg），iconify 数据集的 id 是下划线转连字符
 * （file-type-markdown）——转一手再查；查不到回落 default-file。
 */
export function fileIconName(name: string): string {
  return (getIconForFile(name) ?? 'default_file.svg').replace(/\.svg$/, '').replaceAll('_', '-')
}

/** 取一个图标的 body（沿 alias.parent 解引用，最多两层兜底）。 */
function iconBody(set: IconSet, id: string): IconBody | undefined {
  let alias = set.aliases?.[id]
  if (alias === undefined) return set.icons[id]
  let parent = alias.parent
  for (let depth = 0; depth < 2; depth += 1) {
    const direct = set.icons[parent]
    if (direct !== undefined) return direct
    const next = set.aliases?.[parent]
    if (next === undefined) return undefined
    parent = next.parent
  }
  return undefined
}

/** body 里的 id/引用加实例后缀：linearGradient / clipPath 这类 id 全页唯一才不串色。 */
function uniquifyBody(body: string, suffix: string): string {
  return body
    .replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${id}${suffix})`)
    .replace(/href="#([^"]+)"/g, (_match, id: string) => `href="#${id}${suffix}"`)
    .replace(/id="([^"]+)"/g, (_match, id: string) => `id="${id}${suffix}"`)
}

/**
 * 一个文件的彩色图标。数据未就绪时画等宽占位，就绪后同步换真图标；
 * 同名文件画不出图标（理论上不会）时也回落占位，不把树行带崩。
 */
export function FileIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }): JSX.Element {
  const [ready, setReady] = useState(collection !== null)
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '')
  useEffect(() => {
    if (collection !== null) return
    let on = true
    void ensureFileIcons().then(() => {
      if (on) setReady(true)
    }).catch(() => {})
    return () => {
      on = false
    }
  }, [])
  const placeholder = <span className={className} style={{ width: size, height: size }} aria-hidden />
  if (!ready || collection === null) return placeholder
  const set = collection
  const body = iconBody(set, fileIconName(name))
  if (body === undefined) return placeholder
  const width = body.width ?? set.width ?? 16
  const height = body.height ?? set.height ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: uniquifyBody(body.body, instance) }}
    />
  )
}
