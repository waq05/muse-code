/**
 * LSP 基础协议分帧：`Content-Length` 头 + `\r\n\r\n` + UTF-8 JSON 正文。
 *
 * 为什么单独一层：dsc 里另一处子进程协议（`src/core/mcp.ts`）走的是**换行分帧**
 * ——一行一个 JSON。LSP 不是这样：正文里可能有换行，只能用头部报的字节数切。
 * 所以这里必须自己写一套流式解析器，而且必须能处理两种真实情况：
 *   - **粘包**：一次 `data` 里来两条（甚至半条 + 一整条 + 半条）；
 *   - **半包**：一条消息拆成几次到，头都没收全。
 *
 * 三道上限存在的理由：语言服务器是外部程序，它（或它解析的用户代码）能让流变得没法收拾。
 * 头的上限挡住「永远不发分隔符」；单消息上限挡住「报一个 4GB 的 Content-Length」；
 * stderr 尾巴上限挡住「往 stderr 刷日志刷爆内存」——尾巴是给人看的原因，不是日志仓库。
 *
 * @module dsc/core/lsp/framing
 */

/** 头部（分隔符之前那段）字节上限。 */
export const MAX_HEADER_BYTES = 64 * 1024

/** 单条消息正文的字节上限（16MB：够任何正常 LSP 响应，又不至于让内存没边）。 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** 子进程 stderr 尾巴保留的字节上限（1MB）。 */
export const MAX_STDERR_TAIL_BYTES = 1024 * 1024

/** 头与正文之间的分隔符。 */
const HEADER_SEPARATOR = '\r\n\r\n'

/**
 * 把一条 JSON-RPC 消息编成可以直接写进子进程 stdin 的字节。
 *
 * @param message - 要发的 JSON-RPC 消息（对象）。
 * @returns 头部 + UTF-8 正文拼好的 Buffer。
 * @throws Error - 消息里有循环引用之类让 `JSON.stringify` 失败的东西时抛（调用方自己兜底）。
 */
export function encodeMessage(message: unknown): Buffer {
  const text = JSON.stringify(message)
  if (typeof text !== 'string') {
    // undefined / 函数 之类 stringify 出来不是字符串：发出去只会让服务器解析失败。
    throw new Error('LSP 消息没法序列化成 JSON')
  }
  const body = Buffer.from(text, 'utf8')
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new Error(`LSP 消息正文 ${body.length} 字节，超过 ${MAX_MESSAGE_BYTES} 字节的上限`)
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * 流式解析器：把 stdout 的字节块喂进来，吐出**此刻已经完整**的消息正文。
 *
 * 状态只有一份累积缓冲；`push` 返回的顺序就是到达顺序。粘包与半包都不需要调用方额外处理。
 * 额外容忍一件事：流开头多出来的空行（个别服务器会在每次响应前多打一个 `\r\n`）。
 * 但缺 `Content-Length` 头一律当协议错——那说明这个流已经不是 LSP 了，继续往下解析
 * 只会把后续字节错位地拼成假消息。
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * @param maxMessageBytes - 单条正文的上限；超了抛错（调用方据此判连接不可用）。
   */
  constructor(private readonly maxMessageBytes: number = MAX_MESSAGE_BYTES) {}

  /**
   * 追加一块字节，返回这次凑齐的全部消息。
   *
   * @param chunk - 从 stdout 读到的字节。
   * @returns 解析好的 JSON 值（按到达顺序，可能为空数组）。
   * @throws Error - 头畸形、头超限、正文超限或正文不是合法 JSON 时抛。
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const step = this.next()
      if (!step.ready) break
      messages.push(step.message)
    }
    return messages
  }

  /** 还在缓冲里没凑齐的字节数（诊断与自检用）。 */
  get pending(): number {
    return this.buffer.length
  }

  /** 试着切出下一条完整消息。 */
  private next(): { ready: false } | { ready: true; message: unknown } {
    // 半包：连分隔符都没见着，先等更多字节（但头不能无限长）。
    const separator = this.buffer.indexOf(HEADER_SEPARATOR)
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new Error(`LSP 头字节数超过 ${MAX_HEADER_BYTES} 字节仍没有出现 \\r\\n\\r\\n`)
      }
      return { ready: false }
    }
    if (separator > MAX_HEADER_BYTES) {
      throw new Error(`LSP 头字节数 ${separator} 超过 ${MAX_HEADER_BYTES} 字节的上限`)
    }
    const length = parseContentLength(this.buffer.toString('ascii', 0, separator))
    if (length > this.maxMessageBytes) {
      throw new Error(`LSP 消息声明 ${length} 字节，超过 ${this.maxMessageBytes} 字节的上限`)
    }
    const bodyStart = separator + HEADER_SEPARATOR.length
    const bodyEnd = bodyStart + length
    // 正文还没收全：整段留着等下一次 push。
    if (this.buffer.length < bodyEnd) return { ready: false }
    const body = this.buffer.toString('utf8', bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    try {
      return { ready: true, message: JSON.parse(body) as unknown }
    } catch (error) {
      throw new Error(`LSP 正文不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 从头里读 `Content-Length`（字段名不分大小写，其它头一律忽略）。
 *
 * @throws Error - 找不到这个头，或者值不是非负整数时抛。
 */
function parseContentLength(headerText: string): number {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const raw = line.slice(colon + 1).trim()
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`LSP 的 Content-Length 头不是非负整数：${JSON.stringify(line)}`)
    }
    return value
  }
  throw new Error(`LSP 头里没有 Content-Length：${JSON.stringify(headerText.slice(0, 200))}`)
}

/**
 * 子进程 stderr 的环形尾巴。
 *
 * 为什么要留：服务器起不来时，唯一能说明原因的就是它自己打的那几行（例如
 * `Cannot find module 'typescript'`、V8 的 heap 崩溃栈）。但 stderr 也可能被刷爆，
 * 所以只保留最近 {@link MAX_STDERR_TAIL_BYTES} 字节，读的时候再解码。
 */
export class StderrTail {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * @param maxBytes - 保留的字节上限。
   */
  constructor(private readonly maxBytes: number = MAX_STDERR_TAIL_BYTES) {}

  /** 追加一块 stderr 字节（超出上限就从最老的字节开始丢）。 */
  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (bytes.length >= this.maxBytes) {
      this.buffer = bytes.subarray(bytes.length - this.maxBytes)
      return
    }
    const merged = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    this.buffer = merged.length > this.maxBytes ? merged.subarray(merged.length - this.maxBytes) : merged
  }

  /** 尾巴全文（按 UTF-8 解码；被截断处的半个字符会被换成替换符，无害）。 */
  text(): string {
    return this.buffer.toString('utf8')
  }

  /**
   * 尾巴末尾的若干行（错误消息里给人看的那几行）。
   *
   * @param lines - 最多要几行。
   */
  tailLines(lines: number): string {
    const text = this.text()
    if (text.trim() === '') return ''
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines).join('\n')
  }

  /** 丢掉已攒的内容（实例重启时用）。 */
  clear(): void {
    this.buffer = Buffer.alloc(0)
  }
}
