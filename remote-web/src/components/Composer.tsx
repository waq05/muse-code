import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import {
  MAX_TOTAL_BYTES,
  composeOutgoing,
  compressImage,
  formatBytes,
  isImageFile,
  totalBytes,
} from '../lib/attachments.js'

/**
 * 底部固定发送框。
 *
 * 手机上的三个要点：
 *   - 位置固定（flex 列的最后一行 + 视口用 dvh），软键盘弹起时视口收缩，输入框跟着上移，
 *     不会盖住正文也不会跑出屏幕；
 *   - textarea 自动增高，1 行起、6 行封顶（超过就在框内滚），免得上屏一半高度都是输入框；
 *   - 轮次运行中在输入框上方挂一行「排队中（当前轮结束后发送）」——core 是排队语义，
 *     不是把消息注入正在跑的轮次里，这句提示就是让用户别误会消息被吞了。
 *
 * 附件（📎）分两条路：
 *   - 图片在本地压缩（长边 1568 / JPEG 0.85），结果当 data URL 随 submit 一起发；
 *   - 其它文件走 HTTP 上传（POST /api/upload），拿到路径后拼进消息文本（`[附件] <path>`）。
 * 两种都先落成一个 chip：文件名的 + 大小 + 状态（压缩/上传中带转圈），单个可移除。
 */
const LINE_HEIGHT = 22
const MAX_ROWS = 6
const MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS

/** 一个待发附件在界面上的样子。 */
interface Chip {
  id: string
  name: string
  /** 原始字节（图片 chip 上显示的还是原始大小，压缩后的大小写在 title 里）。 */
  size: number
  kind: 'image' | 'file'
  status: 'working' | 'ready' | 'error'
  /** 图片压缩后的 data URL。 */
  dataUrl?: string
  /** 图片压缩后的字节数（算总量用）。 */
  bytes?: number
  /** 非图片文件上传成功后宿主给的路径。 */
  path?: string
  /** 出错时的原因（压缩失败 / 上传失败）。 */
  error?: string
}

export interface ComposerProps {
  busy: boolean
  stopping: boolean
  connected: boolean
  error: string | null
  /** 发送：非图片附件的路径已在 text 里，图片以 data URL 数组单发一个参数。 */
  onSend: (text: string, images: string[]) => void
  /** 上传一个非图片文件，返回宿主给的路径；失败要把人话文案放进 Error。 */
  onUploadFile: (file: File) => Promise<string>
  onInterrupt: () => void
}

export function Composer({
  busy,
  stopping,
  connected,
  error,
  onSend,
  onUploadFile,
  onInterrupt,
}: ComposerProps): ReactNode {
  const [text, setText] = useState('')
  const [chips, setChips] = useState<Chip[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  /**
   * chips 的镜像：选文件是一段异步循环（压缩 + 上传），拿 state 算总量会读到旧值，
   * 所以循环里以这个 ref 为准，每一步都同步回 state 让界面即时显示进度。
   */
  const chipsRef = useRef<Chip[]>([])
  const seqRef = useRef(0)

  useEffect(() => {
    const node = area.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const working = picking || chips.some((chip) => chip.status === 'working')
  const ready = chips.filter((chip) => chip.status === 'ready')
  const images = ready
    .filter((chip) => chip.kind === 'image' && chip.dataUrl !== undefined)
    .map((chip) => chip.dataUrl as string)
  const paths = ready
    .filter((chip) => chip.kind === 'file' && chip.path !== undefined)
    .map((chip) => chip.path as string)
  const hasContent = text.trim() !== '' || ready.length > 0
  const canSend = connected && !stopping && !working && hasContent

  function commit(next: Chip[]): void {
    chipsRef.current = next
    setChips(next)
  }

  /** 附件占用：图片按压缩后的字节算，文件按原始大小算。 */
  function usedBytes(list: readonly Chip[]): number {
    return totalBytes(list.map((chip) => (chip.kind === 'image' ? (chip.bytes ?? chip.size) : chip.size)))
  }

  async function addFiles(files: File[]): Promise<void> {
    setAttachError(null)
    setPicking(true)
    const skipped: string[] = []
    try {
      for (const file of files) {
        const existing = chipsRef.current
        if (usedBytes(existing) + file.size > MAX_TOTAL_BYTES && !isImageFile(file)) {
          // 非图片没法压，体积就是原始大小，这里能直接判掉。
          skipped.push(file.name)
          continue
        }
        seqRef.current += 1
        const chip: Chip = {
          id: `att-${seqRef.current}`,
          name: file.name === '' ? '未命名文件' : file.name,
          size: file.size,
          kind: isImageFile(file) ? 'image' : 'file',
          status: 'working',
        }
        commit([...existing, chip])

        if (chip.kind === 'image') {
          try {
            const result = await compressImage(file, file.type)
            // 压缩后才知道真实体积，8MB 总量在这一步判（图片按压缩后算，不该被原图大小误伤）。
            if (usedBytes(chipsRef.current.filter((item) => item.id !== chip.id)) + result.bytes > MAX_TOTAL_BYTES) {
              commit(chipsRef.current.filter((item) => item.id !== chip.id))
              skipped.push(`${file.name}（压缩后 ${formatBytes(result.bytes)}，会超总量）`)
              continue
            }
            commit(
              chipsRef.current.map((item) =>
                item.id === chip.id
                  ? { ...item, status: 'ready', dataUrl: result.dataUrl, bytes: result.bytes }
                  : item,
              ),
            )
          } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            commit(
              chipsRef.current.map((item) =>
                item.id === chip.id ? { ...item, status: 'error', error: reason } : item,
              ),
            )
          }
          continue
        }

        try {
          const path = await onUploadFile(file)
          commit(
            chipsRef.current.map((item) =>
              item.id === chip.id ? { ...item, status: 'ready', path, bytes: item.size } : item,
            ),
          )
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause)
          commit(
            chipsRef.current.map((item) =>
              item.id === chip.id ? { ...item, status: 'error', error: reason } : item,
            ),
          )
        }
      }
      if (skipped.length > 0) {
        setAttachError(`超过附件总量 ${formatBytes(MAX_TOTAL_BYTES)}，这些没加：${skipped.join('、')}`)
      }
    } finally {
      setPicking(false)
    }
  }

  function removeChip(id: string): void {
    // 已经传上去的文件不会因此从宿主删掉（协议里没有删除这条路），这里只是不再引用它。
    commit(chipsRef.current.filter((chip) => chip.id !== id))
  }

  function send(): void {
    if (!canSend) return
    const outgoing = composeOutgoing(text, paths)
    onSend(outgoing, images)
    setText('')
    setAttachError(null)
    commit([])
  }

  return (
    <div className="composer">
      {error !== null && error !== '' ? <div className="composer-error">{error}</div> : null}
      {busy ? <div className="composer-queue">排队中（当前轮结束后发送）</div> : null}
      {chips.length > 0 ? (
        <div className="chips">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className={`chip${chip.status === 'error' ? ' chip-error' : ''}`}
              title={chip.error ?? chip.name}
            >
              <span className="chip-kind" aria-hidden="true">
                {chip.kind === 'image' ? '🖼' : '📄'}
              </span>
              <span className="chip-name">{chip.name}</span>
              <span className="chip-size mono">
                {chip.kind === 'image' && chip.bytes !== undefined && chip.bytes !== chip.size
                  ? `${formatBytes(chip.size)} → ${formatBytes(chip.bytes)}`
                  : formatBytes(chip.size)}
              </span>
              {chip.status === 'working' ? <span className="chip-spin" aria-hidden="true" /> : null}
              {chip.status === 'error' ? <span className="chip-flag">失败</span> : null}
              <button
                type="button"
                className="chip-x"
                onClick={() => removeChip(chip.id)}
                aria-label={`移除附件 ${chip.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachError !== null ? <div className="composer-error">{attachError}</div> : null}
      {chips.some((chip) => chip.status === 'error') ? (
        <div className="composer-error">
          {chips
            .filter((chip) => chip.status === 'error')
            .map((chip) => `${chip.name}：${chip.error ?? '处理失败'}`)
            .join('；')}
        </div>
      ) : null}
      <div className="composer-row">
        <input
          ref={picker}
          className="composer-file"
          type="file"
          multiple
          accept="*/*"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const list = event.target.files
            const files = list === null ? [] : Array.from(list)
            // 清空 value：不然同一个文件选第二次不会触发 change。
            event.target.value = ''
            if (files.length > 0) void addFiles(files)
          }}
        />
        <button
          type="button"
          className="composer-attach"
          disabled={!connected || working}
          aria-label="添加附件"
          title="添加附件"
          onClick={() => picker.current?.click()}
        >
          {working ? <span className="chip-spin" aria-hidden="true" /> : '📎'}
        </button>
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={connected ? '发消息…' : '连接断开中，恢复后可发送'}
          enterKeyHint="send"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            send()
          }}
        />
        {busy ? (
          <button type="button" className="composer-stop" disabled={stopping} onClick={onInterrupt}>
            {stopping ? '正在停止…' : '打断'}
          </button>
        ) : (
          <button type="button" className="composer-send" disabled={!canSend} onClick={send}>
            {working ? '上传中…' : '发送'}
          </button>
        )}
      </div>
      <div className="composer-hint">Enter 发送，Shift+Enter 换行 · 图片压缩后随消息发送</div>
    </div>
  )
}
