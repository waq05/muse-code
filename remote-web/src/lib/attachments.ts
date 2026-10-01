/**
 * 附件：图片压缩的尺寸判定、消息文本的附件行拼装、体积预算。
 *
 * 分工：本文件只管「纯逻辑 + 浏览器适配」——排版与上传编排在 Composer / client 里。
 * 之所以把尺寸计算与图片编解码拆开（尺寸是纯函数、编解码走可注入的 `CompressEnvironment`），
 * 是因为 canvas 在自检环境里不存在，而「长边缩到 1568、单张超 4MB 就拒」这条判定必须能验。
 *
 * 契约（批 B 的界面要求）：
 *   - 图片：canvas 压缩，长边 > 1568px 等比缩到 1568，导出 image/jpeg 质量 0.85；
 *     透明 PNG 保留 PNG；单张压缩后 > 4MB 拒绝并提示；压缩结果以 data URL 进 images[]。
 *   - 非图片文件：走 POST /api/upload，成功把 path 拼进消息文本（正文后空一行，一行一个 [附件]）。
 *   - 附件总量 > 8MB 拒绝。
 */

/** 长边上限（1568 是 Anthropic 视觉接口的建议上限，超过会被服务端自己缩）。 */
export const MAX_IMAGE_EDGE = 1568
/** JPEG 导出质量。 */
export const JPEG_QUALITY = 0.85
/** 单张图片压缩后的上限。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** 一次消息里附件总量（图片按压缩后、文件按原始大小）的上限。 */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

export interface Sized {
  width: number
  height: number
}

/** 是不是图片（按 MIME 判，不看扩展名）。 */
export function isImageFile(file: { type: string }): boolean {
  return file.type.startsWith('image/')
}

/** 透明 PNG 保留 PNG，其余一律走 JPEG（HEIC/WebP 在 canvas 上导出 JPEG 更稳）。 */
export function keepsAlpha(type: string): boolean {
  return type === 'image/png'
}

/**
 * 等比缩放到长边不超过 maxEdge；只缩不放（比 maxEdge 小的原样返回）。
 * 结果取整且至少 1px——0 会让 canvas 直接抛错。
 */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_IMAGE_EDGE): Sized {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/**
 * data URL 里正文的字节数（base64 按 3/4 估，去掉补位的 `=`）。
 * 为什么不直接 `atob` 数长度：一张 4MB 的图 atob 一次就是几 MB 的字符串，纯属白费。
 * 小误差（±2 字节）对「超没超 4MB」这种判定没有影响。
 */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const header = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!/;base64/i.test(header)) return payload.length
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/** 人话体积：812 B / 12 KB / 3.4 MB。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 附件的文本行：一行一个，宿主收到的是纯文本，所以格式写死在这里。 */
export function attachmentLines(paths: readonly string[]): string[] {
  return paths.filter((path) => path.trim() !== '').map((path) => `[附件] ${path}`)
}

/**
 * 正文 + 附件行：正文后空一行，多文件多个 `[附件] <path>` 行。
 * 没有正文时只发附件行（用户只丢了个文件也要能发出去）。
 */
export function composeOutgoing(text: string, paths: readonly string[]): string {
  const body = text.trim()
  const footer = attachmentLines(paths).join('\n')
  if (footer === '') return body
  return body === '' ? footer : `${body}\n\n${footer}`
}

// ── 图片压缩 ───────────────────────────────────────────────────────────────

/** 画布的最小面（只用到这些方法，方便自检塞一个假的进来）。 */
export interface CanvasLike {
  width: number
  height: number
  toDataURL(type?: string, quality?: number): string
}

export interface LoadedImage extends Sized {
  /** 原图对象（真环境里是 HTMLImageElement，自检里随便什么）。 */
  source: unknown
}

/** 压缩过程的三个外部动作：解码、建画布、画上去。 */
export interface CompressEnvironment {
  loadImage(file: Blob): Promise<LoadedImage>
  createCanvas(width: number, height: number): CanvasLike
  drawImage(canvas: CanvasLike, image: LoadedImage): void
}

/** 真实浏览器里的一套实现。 */
export function browserCompressEnvironment(): CompressEnvironment {
  return {
    loadImage: (file) =>
      new Promise<LoadedImage>((resolve, reject) => {
        const url = URL.createObjectURL(file)
        const image = new Image()
        image.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: image.naturalWidth, height: image.naturalHeight, source: image })
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('这张图在浏览器里解不开（换个格式试试）'))
        }
        // 用 <img> 而不是 createImageBitmap：iOS Safari 上 <img> 会照 EXIF 把方向摆正，
        // canvas.drawImage 用的是摆正后的尺寸，省掉一处「照片躺着」的坑。
        image.src = url
      }),
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas
    },
    drawImage: (canvas, image) => {
      const context = (canvas as HTMLCanvasElement).getContext('2d')
      if (context === null) throw new Error('浏览器没给出 canvas 2d 上下文，压不了图')
      context.drawImage(image.source as CanvasImageSource, 0, 0, canvas.width, canvas.height)
    },
  }
}

export interface CompressResult {
  dataUrl: string
  /** 压缩后的字节数（估的，见 estimateDataUrlBytes）。 */
  bytes: number
  width: number
  height: number
}

/**
 * 压缩一张图：长边缩到 1568、JPEG 0.85（PNG 原样保 PNG）；压缩后仍超 4MB 就抛错。
 * 抛出的错误文案直接给用户看（Composer 会挂到那个附件的 chip 上）。
 */
export async function compressImage(
  file: Blob,
  type: string,
  env: CompressEnvironment = browserCompressEnvironment(),
): Promise<CompressResult> {
  const image = await env.loadImage(file)
  const target = fitWithin(image.width, image.height)
  const canvas = env.createCanvas(target.width, target.height)
  env.drawImage(canvas, image)
  const dataUrl = keepsAlpha(type)
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  const bytes = estimateDataUrlBytes(dataUrl)
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`压缩后还有 ${formatBytes(bytes)}，超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}`)
  }
  return { dataUrl, bytes, width: target.width, height: target.height }
}

/** 附件总量（图片用压缩后的字节，文件用原始大小）。 */
export function totalBytes(sizes: readonly number[]): number {
  let sum = 0
  for (const size of sizes) {
    if (Number.isFinite(size) && size > 0) sum += size
  }
  return sum
}
