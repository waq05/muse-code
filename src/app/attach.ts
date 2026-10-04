/**
 * 提交前的图片附件提取：消息里出现「存在的本地图片文件路径」（空格分词、可带引号）
 * 就读成 data URL 附加。路径原样留在正文里，模型文本与图都看得见。
 *
 * 当前模型没勾「照片」时不需要这里拦——宿主的 drop-images 投影（order 900）会把图
 * 换成一句说明发出去。
 *
 * @module dsc/app/attach
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 单图上限：再大的多半选错了文件，报「读取失败」让用户自己看。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface AttachResult {
  /** 原文（路径不替换，模型看得见来源）。 */
  text: string
  /** 成功读出的 data URL 清单（submit(text, images) 的第二参）。 */
  images: string[]
  /** 成功附加的路径。 */
  attached: string[]
  /** 看起来是图片路径但没读成的（太大/IO 错误），界面提示用。 */
  failed: string[]
}

export function extractImages(text: string): AttachResult {
  const images: string[] = []
  const attached: string[] = []
  const failed: string[] = []
  const next = text.replace(/\S+/g, (token) => {
    const clean = token.replace(/^["'`（「]+|["'`,，。」』）]+$/g, '')
    const mime = IMAGE_MIME[extname(clean).toLowerCase()]
    if (mime === undefined) return token
    try {
      if (!existsSync(clean) || !statSync(clean).isFile()) return token
      if (statSync(clean).size > MAX_IMAGE_BYTES) {
        failed.push(clean)
        return token
      }
      images.push(`data:${mime};base64,${readFileSync(clean).toString('base64')}`)
      attached.push(clean)
    } catch {
      failed.push(clean)
    }
    return token
  })
  return { text: next, images, attached, failed }
}
