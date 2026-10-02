/**
 * 文件树与预览页签的彩色文件图标：VSCode 同款 vscode-icons 集。
 * 图标名解析走 vscode-icons-js（特殊文件名 / 扩展名规则与 VSCode 的插件一致，
 * 如 package.json → npm、pnpm-lock.yaml → pnpm、.ts → typescript）；
 * SVG body 来自 build-icon-map.mjs 生成的常用子集（~500KB，同步 import）——
 * 0.6.36 前是整包 ~4MB 动态 import 懒 chunk，但文件图标在文件树 / 预览页签 /
 * 改动卡上出现得很早，懒加载名存实亡；现在按常用扩展名固化，未知图标回落
 * default-file，全集 chunk 从产物里消失。
 *
 * 渲染不走 @iconify/react 的 <Icon>：它的占位机制按需异步换 svg，离线整包下
 * 时序不可控（会出现部分行停在占位 span）。这里数据同步在手，直接画 <svg>；
 * body 里的渐变/裁剪 id 按实例加后缀，避免同页多实例互相串引用。
 * 目录图标不在这里——目录用 icons.tsx 的 IconFolder(Open)。
 */
import { useId, type JSX } from 'react'
import { getIconForFile } from 'vscode-icons-js'
import { GENERATED_FILE_ICONS, type GeneratedIconBody } from './file-icon-map.generated.js'

/** iconify 数据集的缺省 viewBox 尺寸（vscode-icons 全集是 16×16）。 */
const ICON_SIZE = 16

/**
 * 文件名 → iconify 图标 id。vscode-icons-js 给的是 VSCode 插件原始名
 * （file_type_markdown.svg），iconify 数据集的 id 是下划线转连字符
 * （file-type-markdown）——转一手再查；生成映射里没有的名字回落 default-file。
 */
export function fileIconName(name: string): string {
  return (getIconForFile(name) ?? 'default_file.svg').replace(/\.svg$/, '').replaceAll('_', '-')
}

/** body 里的 id/引用加实例后缀：linearGradient / clipPath 这类 id 全页唯一才不串色。 */
function uniquifyBody(body: string, suffix: string): string {
  return body
    .replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${id}${suffix})`)
    .replace(/href="#([^"]+)"/g, (_match, id: string) => `href="#${id}${suffix}"`)
    .replace(/id="([^"]+)"/g, (_match, id: string) => `id="${id}${suffix}"`)
}

/**
 * 一个文件的彩色图标。生成映射里没有的图标（长尾扩展名）回落 default-file，
 * 不留占位空档——树行/页签永远有像，只是非常用类型不再各带专属图形。
 */
export function FileIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }): JSX.Element {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '')
  const body: GeneratedIconBody | undefined =
    GENERATED_FILE_ICONS[fileIconName(name)] ?? GENERATED_FILE_ICONS['default-file']
  if (body === undefined) {
    return <span className={className} style={{ width: size, height: size }} aria-hidden />
  }
  const width = body.width ?? ICON_SIZE
  const height = body.height ?? ICON_SIZE
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
