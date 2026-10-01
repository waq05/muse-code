/**
 * 远程上传：手机把照片、日志、短音频丢进 `~/.dsc/remote/uploads/`，宿主再把磁盘路径
 * 交给会话（模型用 read 之类的工具自己去看）。
 *
 * 三条安全规矩：
 *
 *   1. **文件名从不可信输入里造**。路径分隔符（`/` 与 `\`）、控制字符、Windows 非法字符
 *      与设备名（CON/NUL/COM1…）全部剥掉，只留最后一段做「安全化文件名」，扩展名保留。
 *      落盘名再前置 8 位随机十六进制——同名文件不会互相覆盖，也看不出是谁传的。
 *   2. **单文件 20MB**，目录总量 **100MB**，超了按最旧删除（手机随手传的大文件不至于把
 *      用户的家目录撑爆）。上限判定在写入前后各做一次：前面那次是为了别先写爆再删。
 *   3. **按天分目录**（`uploads/yyyymmdd/`）。人工去翻的时候一眼能看出是哪天传的，
 *      配额淘汰也是先淘汰最早那几天的。
 *
 * @module dsc/core/remote/uploads
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { REMOTE_DIR } from './store.js'

/** 单文件上限 20MB（这条路由不受 64KB 请求体上限约束，见 plugins/remote.ts）。 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** 上传目录总配额 100MB。 */
export const UPLOAD_QUOTA_BYTES = 100 * 1024 * 1024

/** 上传根目录的缺省值：`~/.dsc/remote/uploads`。 */
export const UPLOAD_DIR = join(REMOTE_DIR, 'uploads')

/** 安全化文件名的长度上限（留出随机前缀与扩展名的位置）。 */
const STEM_LIMIT = 80

/** Windows 上不能直接当文件名用的设备名。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

export interface UploadSaved {
  ok: true
  /** 落盘绝对路径。 */
  path: string
  size: number
  /** 安全化之后的原始文件名（不含随机前缀，给界面显示用）。 */
  name: string
}

export interface UploadFailed {
  ok: false
  error: string
}

export type UploadOutcome = UploadSaved | UploadFailed

/**
 * 把用户给的文件名洗成能安全落盘的一段。
 *
 * 只取最后一段（`../../evil.txt` → `evil.txt`），去掉控制字符与 `< > : " | ? *`，
 * 去掉开头与结尾的点（`..`、`...`、`x.` 这些在 Windows 上会被截断或指到别处），
 * 保留扩展名（只留字母数字，最多 12 位）。洗完是空的就退回 `upload`。
 */
export function safeUploadName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
  if (cleaned === '') return 'upload'
  const dot = cleaned.lastIndexOf('.')
  const rawStem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const stem = (rawStem === '' ? 'upload' : rawStem).slice(0, STEM_LIMIT)
  const ext = (dot > 0 ? cleaned.slice(dot + 1) : '').replace(/[^0-9A-Za-z]/g, '').slice(0, 12)
  const name = ext === '' ? stem : `${stem}.${ext}`
  // 设备名看的是主名：Windows 上 `com1.txt` 照样指到串口，扩展名救不了它
  return RESERVED_NAMES.test(stem) ? `_${name}` : name
}

/** 落盘目录名：本地时间的 yyyymmdd。 */
function dayDir(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${day}`
}

export interface UploadStoreOptions {
  /** 上传根目录（默认 `~/.dsc/remote/uploads`；自检脚本换成临时目录）。 */
  dir?: string
  /** 取时刻（自检注入假钟，测按天分目录）。 */
  now?: () => number
  /** 目录总配额；自检脚本调小它才能几百字节就把淘汰那条路走通。 */
  quotaBytes?: number
}

export class RemoteUploads {
  private readonly dir: string
  private readonly now: () => number
  private readonly quotaBytes: number

  constructor(options: UploadStoreOptions = {}) {
    this.dir = options.dir ?? UPLOAD_DIR
    this.now = options.now ?? (() => Date.now())
    this.quotaBytes = options.quotaBytes ?? UPLOAD_QUOTA_BYTES
  }

  /** 上传根目录。 */
  get root(): string {
    return this.dir
  }

  /**
   * 落盘一个文件。
   *
   * @param filename - 客户端给的原始文件名（可能带路径、控制字符，全是不可信输入）
   * @param data - 原始字节
   */
  save(filename: string, data: Buffer): UploadOutcome {
    if (data.length > UPLOAD_MAX_BYTES) {
      return { ok: false, error: `文件超过 ${String(Math.round(UPLOAD_MAX_BYTES / 1024 / 1024))}MB 上限` }
    }
    const safe = safeUploadName(filename)
    const diskName = `${randomBytes(4).toString('hex')}-${safe}`
    const dayDirectory = join(this.dir, dayDir(this.now()))
    mkdirSync(dayDirectory, { recursive: true })
    // 先腾地方：这一次写下去也不能顶破配额
    this.enforceQuota(this.quotaBytes - data.length)
    const path = join(dayDirectory, diskName)
    writeFileSync(path, data)
    this.enforceQuota(this.quotaBytes, path)
    return { ok: true, path, size: data.length, name: safe }
  }

  /** 目录里现在一共多少字节。 */
  totalBytes(): number {
    let total = 0
    for (const file of this.files()) total += file.size
    return total
  }

  /** 目录里现有的文件（自检用；按路径排序）。 */
  files(): Array<{ path: string; size: number; mtimeMs: number }> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = []
    const walk = (directory: string): void => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        try {
          const info = statSync(full)
          if (info.isFile()) out.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
        } catch {
          // 正好被删了 / 读不动：跳过
        }
      }
    }
    walk(this.dir)
    out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return out
  }

  /**
   * 把总量压到 limit 以内：按修改时间从旧到新删，`protect` 指的是刚写完、不许被这次淘汰
   * 带走的那个文件。
   */
  private enforceQuota(limit: number, protect?: string): void {
    const files = this.files()
    let total = 0
    for (const file of files) total += file.size
    if (total <= limit) return
    const byAge = [...files].sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const file of byAge) {
      if (total <= limit) break
      if (protect !== undefined && file.path === protect) continue
      try {
        unlinkSync(file.path)
        total -= file.size
      } catch {
        // 删不掉（被占用之类）：留着，继续试下一个
      }
    }
  }
}
