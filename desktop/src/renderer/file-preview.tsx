/**
 * 文件预览页签的渲染器（对齐 dsh ui-sidebar-documentpreview 的分流思路，按
 * 「宿主 fs-read 回包 kind + 扩展名」选渲染器）：
 *   - markdown：ReactMarkdown（会话流同款）+ 相对路径图片走 fs-read 转 base64
 *     + 代码块走 shiki 高亮；
 *   - code/text/json/yaml…：shiki 语法高亮（JS regex 引擎免 WASM），语法按扩展名
 *     懒加载（SHIKI_LANG_BY_EXT 里没有的语言回落纯文本）；双主题出 CSS 变量，
 *     浅/深由 data-theme 切换（styles.css 的 .shiki 变量段）；
 *   - csv/tsv：papaparse 解析成表格；xlsx/xlsm：SheetJS 解析成表格（多 sheet 页签）；
 *   - pdf：pdfjs 逐页渲染成 canvas 截图（≤50 页）；
 *   - image：base64 <img>；binary / 超限 / 失败：占位说明。
 *
 * 所有重解析库（shiki 语法 / papaparse / xlsx / pdfjs）都走 dynamic import：
 * 点开对应类型的文件才加载对应 chunk，首屏与文件树不受影响。
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RuntimeProxy } from './bridge.js'
import { FileIcon } from './file-icons.js'
import { basenameOf, formatSize, joinPath, previewKindFor, SHIKI_LANG_BY_EXT, type ReadResult } from './file-util.js'

/** 预览代码块的截断线数（shiki 高亮大文本很贵，超限截断并提示）。 */
const CODE_MAX_LINES = 5000
/** 表格类预览的行 / 列截断。 */
const TABLE_MAX_ROWS = 500
const TABLE_MAX_COLS = 100
/** PDF 最多渲染的页数（pdfjs 逐页渲染，页数多时提示截断）。 */
const PDF_MAX_PAGES = 50

// ── shiki 单例（懒加载） ────────────────────────────────────────────────────────

type HighlighterCoreLike = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>
type LangModule = { default: unknown }

/**
 * 语法 id → 模块加载器。必须用字面量 import（@shikijs/langs 的 exports 是固定
 * 枚举、没有通配，模板串动态 import 运行时解析不了）；每条各自成懒 chunk，
 * 点开对应语言的文件才加载。表键与 SHIKI_LANG_BY_EXT 映射出的 id 一一对应。
 */
const LANG_IMPORTS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  json5: () => import('@shikijs/langs/json5'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  lua: () => import('@shikijs/langs/lua'),
  scala: () => import('@shikijs/langs/scala'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  bat: () => import('@shikijs/langs/bat'),
  powershell: () => import('@shikijs/langs/powershell'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  sass: () => import('@shikijs/langs/sass'),
  less: () => import('@shikijs/langs/less'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  astro: () => import('@shikijs/langs/astro'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  proto: () => import('@shikijs/langs/proto'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  'objective-cpp': () => import('@shikijs/langs/objective-cpp'),
  dart: () => import('@shikijs/langs/dart'),
  r: () => import('@shikijs/langs/r'),
  julia: () => import('@shikijs/langs/julia'),
  elixir: () => import('@shikijs/langs/elixir'),
  erlang: () => import('@shikijs/langs/erlang'),
  haskell: () => import('@shikijs/langs/haskell'),
  clojure: () => import('@shikijs/langs/clojure'),
  perl: () => import('@shikijs/langs/perl'),
  zig: () => import('@shikijs/langs/zig'),
  solidity: () => import('@shikijs/langs/solidity'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  diff: () => import('@shikijs/langs/diff'),
  log: () => import('@shikijs/langs/log'),
  rst: () => import('@shikijs/langs/rst'),
  latex: () => import('@shikijs/langs/latex'),
  makefile: () => import('@shikijs/langs/makefile'),
}

let highlighterPromise: Promise<HighlighterCoreLike> | null = null
const loadedLangs = new Set<string>()

/** 单例 highlighter：JS regex 引擎（免 oniguruma WASM），主题先空载、语言按需装。 */
export function getHighlighter(): Promise<HighlighterCoreLike> {
  highlighterPromise ??= import('shiki/core').then(async (core) =>
    core.createHighlighterCore({
      themes: [
        import('@shikijs/themes/github-light'),
        import('@shikijs/themes/one-dark-pro'),
      ],
      langs: [],
      engine: (await import('shiki/engine/javascript')).createJavaScriptRegexEngine(),
    }),
  )
  return highlighterPromise
}

/** 装一门语法（幂等；表里没有的 id 原样返回——调用方回落纯文本）。 */
export async function loadLang(id: string): Promise<void> {
  if (loadedLangs.has(id)) return
  const loader = LANG_IMPORTS[id]
  if (loader === undefined) return
  const grammar = await loader()
  const highlighter = await getHighlighter()
  await highlighter.loadLanguage((grammar as LangModule).default as never)
  loadedLangs.add(id)
}

/** 扩展名 → shiki 语法 id（没有映射的返回 undefined = 纯文本）。 */
export function langForPath(path: string): string | undefined {
  const name = basenameOf(path).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return SHIKI_LANG_BY_EXT[ext]
}

/** 把一段代码高亮成 shiki HTML（无语法 / 装不上 → 纯文本 lang，回落转义输出）。 */
async function highlightToHtml(code: string, lang: string | undefined): Promise<string> {
  const highlighter = await getHighlighter()
  const usable = lang !== undefined && (loadedLangs.has(lang) || LANG_IMPORTS[lang] !== undefined)
  const id = usable && lang !== undefined ? lang : 'text'
  if (usable && lang !== undefined && !loadedLangs.has(lang)) await loadLang(lang)
  return highlighter.codeToHtml(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'one-dark-pro' },
    defaultColor: false,
  })
}

/** 代码视图：装语法期间先画纯文本，就绪后原地换高亮 HTML。 */
function CodeView({ text, path, targetLine }: { text: string; path: string; targetLine?: number }): JSX.Element {
  const lang = useMemo(() => langForPath(path), [path])
  const lines = useMemo(() => text.split('\n'), [text])
  const truncated = lines.length > CODE_MAX_LINES
  const shown = useMemo(() => (truncated ? lines.slice(0, CODE_MAX_LINES).join('\n') : text), [lines, text, truncated])
  const [html, setHtml] = useState<string | null>(null)
  // 高亮分支是 div、纯文本回落是 pre——ref 用回调统一收 HTMLElement
  const bodyRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let on = true
    highlightToHtml(shown, lang)
      .then((value) => {
        if (on) setHtml(value)
      })
      .catch(() => {
        // 语法装不上就留在纯文本，不报错——预览不该比文件本身更脆
      })
    return () => {
      on = false
    }
  }, [shown, lang])
  // 行号跳转（/review findings）：渲染完把目标行滚到视口中间并挂高亮类；
  // 换目标先摘旧高亮。目标行超出截断范围就滚到截断条，不硬来。
  useEffect(() => {
    if (targetLine === undefined) return
    const body = bodyRef.current
    if (body === null) return
    body.querySelectorAll('.file-code-line-target').forEach((node) => node.classList.remove('file-code-line-target'))
    const rows = body.querySelectorAll('.line')
    const at = Math.min(Math.max(targetLine, 1), rows.length)
    const row = rows[at - 1]
    if (row !== undefined) {
      row.classList.add('file-code-line-target')
      row.scrollIntoView({ block: 'center' })
    }
  }, [html, targetLine, shown])
  const numbered = targetLine !== undefined
  return (
    <div className={numbered ? 'file-code file-code--numbered' : 'file-code'}>
      {truncated && <div className="tree-note" data-tree-note="truncated">文件较大，仅高亮前 {CODE_MAX_LINES} 行</div>}
      {html !== null ? (
        <div ref={(node) => { bodyRef.current = node }} className="file-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre ref={(node) => { bodyRef.current = node }} className="file-code-plain">
          {shown.split('\n').map((row, index) => (
            <span key={index} className="line">{`${row}\n`}</span>
          ))}
        </pre>
      )}
    </div>
  )
}

// ── markdown（相对路径图片走 fs-read） ─────────────────────────────────────────

/** 相对路径图片的 base64 缓存（进程内一份；key = 绝对路径）。 */
const mdImageCache = new Map<string, string>()

/** markdown 里的一张图：http(s)/data 直接给 src；相对路径经 fs-read 转 data URL。 */
function MdImage(props: { src: string; alt: string; base: string; proxy: RuntimeProxy }): JSX.Element {
  const { src, alt, base, proxy } = props
  const external = /^(https?:|data:|blob:)/i.test(src)
  const abs = external ? src : joinPath(base, decodeURIComponent(src))
  const cached = external ? undefined : mdImageCache.get(abs)
  const [resolved, setResolved] = useState<string | undefined>(external ? src : cached)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (external || resolved !== undefined) return
    let on = true
    void proxy
      .dock('fs-read', { file: abs })
      .then((data) => {
        const read = data as { kind?: string; mime?: string; base64?: string; tooLarge?: boolean }
        if (!on) return
        if (read.kind === 'image' && read.tooLarge !== true && read.base64 !== undefined) {
          const url = `data:${read.mime};base64,${read.base64}`
          mdImageCache.set(abs, url)
          setResolved(url)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (on) setFailed(true)
      })
    return () => {
      on = false
    }
  }, [external, abs, proxy, resolved])
  if (failed || (!external && resolved === undefined)) {
    return <span className="file-md-img-missing">[图片：{alt || src}]</span>
  }
  return <img src={resolved} alt={alt} loading="lazy" />
}

/** markdown 视图：会话流同款 ReactMarkdown，代码块交给 shiki。 */
function MarkdownView({ text, path, proxy }: { text: string; path: string; proxy: RuntimeProxy }): JSX.Element {
  const base = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  return (
    <div className="file-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const source = typeof src === 'string' ? src : ''
            return source === '' ? <span className="file-md-img-missing">[图片]</span> : <MdImage src={source} alt={alt ?? ''} base={base} proxy={proxy} />
          },
          code: ({ className, children }) => {
            const match = /language-([\w-]+)/.exec(className ?? '')
            const raw = String(children ?? '').replace(/\n$/, '')
            if (match === null) return <code className={className}>{children}</code>
            return <CodeBlock code={raw} lang={match[1]!} />
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** markdown 代码块的 shiki 高亮（语法 id 直接来自围栏标注）。 */
function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    highlightToHtml(code, lang)
      .then((value) => {
        if (on) setHtml(value)
      })
      .catch(() => {})
    return () => {
      on = false
    }
  }, [code, lang])
  if (html === null) return <pre className="file-code-plain">
    <code>{code}</code>
  </pre>
  return <div className="file-code-body" dangerouslySetInnerHTML={{ __html: html }} />
}

// ── csv / xlsx 表格 ────────────────────────────────────────────────────────────

/** csv/tsv 视图：papaparse 解析，首行当表头，行/列截断。 */
function CsvView({ text, path }: { text: string; path: string }): JSX.Element {
  const [rows, setRows] = useState<string[][] | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let on = true
    void import('papaparse').then((Papa) => {
      const result = Papa.parse(text.replace(/\r\n/g, '\n'), { delimiter: path.toLowerCase().endsWith('.tsv') ? '\t' : undefined })
      if (on) setRows(result.data as string[][])
    }).catch((error: unknown) => {
      if (on) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => {
      on = false
    }
  }, [text, path])
  if (failed !== '') return <NoticeLine message={`解析失败：${failed}`} />
  if (rows === null) return <NoticeLine message="解析中…" />
  const truncated = rows.length > TABLE_MAX_ROWS || rows.some((row) => row.length > TABLE_MAX_COLS)
  const shown = rows.slice(0, TABLE_MAX_ROWS).map((row) => row.slice(0, TABLE_MAX_COLS))
  const [head, ...body] = shown
  return (
    <div className="file-table-wrap">
      {truncated && <div className="tree-note" data-tree-note="truncated">表格较大，仅显示前 {TABLE_MAX_ROWS} 行 × {TABLE_MAX_COLS} 列</div>}
      <table className="file-table">
        {head !== undefined && (
          <thead>
            <tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** xlsx 视图：SheetJS 读工作簿（从 fs-read 的 base64），多 sheet 页签切换。
 *  工作簿缓存在 ref 里——切 sheet 只做 sheet_to_json，不重新解析整本文件。 */
function XlsxView({ base64 }: { base64: string }): JSX.Element {
  const [sheets, setSheets] = useState<string[] | null>(null)
  const [active, setActive] = useState(0)
  const [rows, setRows] = useState<string[][]>([])
  const [failed, setFailed] = useState('')
  const workbookRef = useRef<import('xlsx').WorkBook | null>(null)
  const showSheet = (index: number): void => {
    void import('xlsx').then((XLSX) => {
      const workbook = workbookRef.current
      const sheet = workbook?.Sheets[workbook.SheetNames[index]!]
      if (sheet === undefined) return
      setRows((XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][]).map((row) => row.map((cell) => String(cell ?? ''))))
    })
  }
  useEffect(() => {
    let on = true
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    void import('xlsx')
      .then((XLSX) => {
        const workbook = XLSX.read(bytes, { type: 'array' })
        if (!on) return
        workbookRef.current = workbook
        setSheets(workbook.SheetNames)
        showSheet(0)
      })
      .catch((error: unknown) => {
        if (on) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      on = false
    }
  }, [base64])
  const pick = (index: number): void => {
    setActive(index)
    setFailed('')
    showSheet(index)
  }
  if (failed !== '') return <NoticeLine message={`解析失败：${failed}`} />
  if (sheets === null) return <NoticeLine message="解析中…" />
  const truncated = rows.length > TABLE_MAX_ROWS || rows.some((row) => row.length > TABLE_MAX_COLS)
  const shown = rows.slice(0, TABLE_MAX_ROWS).map((row) => row.slice(0, TABLE_MAX_COLS))
  const [head, ...body] = shown
  return (
    <div className="file-table-wrap">
      {sheets.length > 1 && (
        <div className="file-sheets">
          {sheets.map((name, index) => (
            <button key={name} className={`file-sheet${index === active ? ' on' : ''}`} onClick={() => pick(index)}>
              {name}
            </button>
          ))}
        </div>
      )}
      {truncated && <div className="tree-note" data-tree-note="truncated">表格较大，仅显示前 {TABLE_MAX_ROWS} 行 × {TABLE_MAX_COLS} 列</div>}
      <table className="file-table">
        {head !== undefined && (
          <thead>
            <tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── pdf ───────────────────────────────────────────────────────────────────────

/** pdf 视图：pdfjs 逐页渲染成图片（worker 走 ?url 资产；≤50 页，超出提示）。 */
function PdfView({ base64 }: { base64: string }): JSX.Element {
  const [pages, setPages] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [failed, setFailed] = useState('')
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let on = true
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, workerUrlModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      GlobalWorkerOptions.workerSrc = workerUrlModule.default
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const doc = await getDocument({ data: bytes }).promise
      if (!on) return
      setTotal(doc.numPages)
      const count = Math.min(doc.numPages, PDF_MAX_PAGES)
      for (let index = 1; index <= count; index += 1) {
        const page = await doc.getPage(index)
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')!
        await page.render({ canvas, canvasContext: context, viewport }).promise
        if (!on) return
        const url = canvas.toDataURL('image/png')
        setPages((current) => [...current, url])
      }
    })().catch((error: unknown) => {
      if (on) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => {
      on = false
    }
  }, [base64])
  if (failed !== '') return <NoticeLine message={`PDF 解析失败：${failed}`} />
  return (
    <div className="file-pdf">
      {pages.length === 0 && <NoticeLine message="渲染中…" />}
      {pages.map((url, index) => (
        <img key={index} className="file-pdf-page" src={url} alt={`第 ${index + 1} 页`} />
      ))}
      {total > PDF_MAX_PAGES && <div className="tree-note" data-tree-note="truncated">共 {total} 页，仅渲染前 {PDF_MAX_PAGES} 页</div>}
    </div>
  )
}

// ── 占位行与页签体 ─────────────────────────────────────────────────────────────

/** 一条居中的说明行（加载中/失败/占位共用）。 */
function NoticeLine({ message }: { message: string }): JSX.Element {
  return <div className="file-preview-empty">{message}</div>
}

/**
 * 预览页签体：拉一次 fs-read，按类型分发到各渲染器。头部是相对路径 + 文件
 * 彩色图标（dsh 的 TextPreview 头部同位）。line = 打开时定位的 1-based 行号
 * （仅代码/文本视图支持：挂行号列并把目标行滚进视口高亮）。
 */
export function FilePreviewView({ path, cwd, proxy, line }: { path: string; cwd: string; proxy: RuntimeProxy; line?: number }): JSX.Element {
  const [read, setRead] = useState<ReadResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let on = true
    setRead(null)
    setError('')
    void proxy
      .dock('fs-read', { file: path })
      .then((data) => {
        if (on) setRead(data as ReadResult)
      })
      .catch((cause: unknown) => {
        if (on) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      on = false
    }
  }, [path, proxy])

  const relative = path.slice(cwd.length)
  const name = basenameOf(path)
  let body: JSX.Element
  if (error !== '') {
    body = <NoticeLine message={`读取失败：${error}`} />
  } else if (read === null) {
    body = <NoticeLine message="读取中…" />
  } else if (read.tooLarge) {
    body = <NoticeLine message="文件过大，仅支持预览 10MB 以内的文件" />
  } else {
    switch (previewKindFor(read)) {
      case 'markdown':
        body = <MarkdownView text={read.text ?? ''} path={path} proxy={proxy} />
        break
      case 'csv':
        body = <CsvView text={read.text ?? ''} path={path} />
        break
      case 'xlsx':
        body = <XlsxView base64={read.base64 ?? ''} />
        break
      case 'pdf':
        body = <PdfView base64={read.base64 ?? ''} />
        break
      case 'image':
        body = (
          <div className="file-preview-img">
            <img src={`data:${read.mime};base64,${read.base64}`} alt={path} />
          </div>
        )
        break
      case 'binary':
        body = <NoticeLine message={`二进制文件（${formatSize(read.size ?? 0)}），暂不支持预览`} />
        break
      default:
        body = <CodeView text={read.text ?? ''} path={path} targetLine={line} />
    }
  }
  return (
    <div className="file-preview-page">
      <div className="file-preview-head">
        <span className="file-preview-path">
          <FileIcon name={name} size={14} />
          {relative === '' ? name : relative}
        </span>
      </div>
      <div className="file-preview-body">{body}</div>
    </div>
  )
}
