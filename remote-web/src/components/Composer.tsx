import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 底部固定发送框。
 *
 * 手机上的三个要点：
 *   - 位置固定（flex 列的最后一行 + 视口用 dvh），软键盘弹起时视口收缩，输入框跟着上移，
 *     不会盖住正文也不会跑出屏幕；
 *   - textarea 自动增高，1 行起、6 行封顶（超过就在框内滚），免得上屏一半高度都是输入框；
 *   - 轮次运行中在输入框上方挂一行「排队中（当前轮结束后发送）」——core 是排队语义，
 *     不是把消息注入正在跑的轮次里，这句提示就是让用户别误会消息被吞了。
 */
const LINE_HEIGHT = 22
const MAX_ROWS = 6
const MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS

export interface ComposerProps {
  busy: boolean
  stopping: boolean
  connected: boolean
  error: string | null
  onSend: (text: string) => void
  onInterrupt: () => void
}

export function Composer({ busy, stopping, connected, error, onSend, onInterrupt }: ComposerProps): ReactNode {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const node = area.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const canSend = connected && !stopping && text.trim() !== ''

  function send(): void {
    const value = text.trim()
    if (value === '' || !connected || stopping) return
    onSend(value)
    setText('')
  }

  return (
    <div className="composer">
      {error !== null && error !== '' ? <div className="composer-error">{error}</div> : null}
      {busy ? <div className="composer-queue">排队中（当前轮结束后发送）</div> : null}
      <div className="composer-row">
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
            发送
          </button>
        )}
      </div>
      <div className="composer-hint">Enter 发送，Shift+Enter 换行</div>
    </div>
  )
}
