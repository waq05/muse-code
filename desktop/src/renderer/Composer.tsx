/**
 * 输入区：大圆角容器 + 无边框 textarea + 底部操作行（+ 按钮 / 模型选择器 / 发送圆钮）
 * + / 命令与 /model 补全面板 + 模型/思考强度弹出面板 + 图片附件（粘贴 / 拖入）。
 *
 * 思考档位只列当前模型声明过的那些；图片要模型勾了「照片」才收（否则发出去也是白搭）。
 *
 * @module desktop/renderer/Composer
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type {
  ApprovalPolicy,
  EffortLevel,
  ModelChoiceView,
  PolicySurface,
  PresetSurface,
  ThinkingLevel,
} from '@dsc/runtime/contract.js'
// 补全函数从纯模块拿：plugins/commands.js 的依赖链里有 git 收集（node:child_process），
// vite 对 node 内置模块 externalize 即炸（0.6.26 白屏教训），渲染层只走 core 这份。
import { completionsFor, expandCommand } from '@dsc/runtime/core/commands-completion.js'
import type { CompletionItem } from '@dsc/runtime/services/types.js'
import { insertMention, mentionQueryAt, rankMentionCandidates } from '@dsc/runtime/core/mention.js'
import { toastErr } from './components/toast.js'
import { IconArrowUp, IconCheck, IconChevronDown, IconClose, IconLayers, IconPlus, IconShield, IconStop } from './icons.js'

const EFFORTS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'default', label: '默认', hint: '不声明思考模式，跟随端点默认' },
  { value: 'off', label: '关', hint: '禁用思考' },
  { value: 'low', label: '低', hint: '' },
  { value: 'high', label: '高', hint: '' },
  { value: 'max', label: '最大', hint: '' },
]

/** 一张贴图最多 6MB（base64 后约 8MB）：再大的图应当先缩放，而不是塞进上下文。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/** 读一张图的两种结局：拿到 data URL，或者一句能直接显示的原因。 */
type ImageRead = { ok: true; url: string } | { ok: false; error: string }

async function readImage(file: File): Promise<ImageRead> {
  if (!file.type.startsWith('image/')) return { ok: false, error: `${file.name || '剪贴板里的内容'}不是图片` }
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: `${file.name || '图片'}超过 6MB，先缩小一点再贴` }
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
      reader.readAsDataURL(file)
    })
    return url.startsWith('data:') ? { ok: true, url } : { ok: false, error: '没读到图片内容' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 输入框下面有两根旋钮：
 *   - 权限模式（问出来之后怎么裁）；
 *   - 模式（模型是谁、手上有什么、被叮嘱了什么）。
 * 档位清单都不在这里写死，由快照里对应功能点贡献的那一片（`surfaces.policy` /
 * `surfaces.preset`）给。
 *
 * 协作模式（`surfaces.mode`）在这两根右边原来还有一颗，后来收掉了：它和权限
 * 模式的语义重叠，用户看着是两颗问同一件事的旋钮。模式本身没动，宿主的
 * `setMode` 与 `/mode` 类指令照旧可用，只是界面上不再有那颗入口。
 */
export function Composer(props: {
  disabled: boolean
  models: readonly ModelChoiceView[]
  model: string
  effort: EffortLevel
  /** 权限模式那根旋钮（当前档 + 可切清单，approval 插件贡献）。 */
  policy: PolicySurface
  /** 模式那根旋钮（当前档 + 可切清单，presets 插件贡献）。 */
  preset: PresetSurface
  working: boolean
  /** 当前工作目录（T14：切会话/换目录时 @ 文件清单缓存跟着失效）。 */
  cwd: string
  /** 草稿存取键（= 会话 id，0.6.50）：正文、贴图与输入历史每会话各一份，切会话各回各的。 */
  draftKey: string
  /** @ 提及候选的数据源（App 注入：dock fs-list 的工作区遍历，带缓存）。 */
  listFiles(): Promise<string[]>
  onSubmit(text: string, images?: string[], options?: { steer?: boolean }): void
  onInterrupt(): void
  onModelChange(value: string): void
  onEffortChange(value: EffortLevel): void
  onPolicyChange(value: ApprovalPolicy): void
  onPresetChange(value: string): void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [modelOpen, setModelOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  /** 待发送的图片（data URL 清单）。 */
  const [attachments, setAttachments] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  // ---- T14 @ 文件提及 ----
  /** 光标位置（onChange/onSelect 时更新），@ 查询据此定位。 */
  const [caret, setCaret] = useState(0)
  /** 工作区文件清单；null = 还没拉过。 */
  const [mentionFiles, setMentionFiles] = useState<string[] | null>(null)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionActive, setMentionActive] = useState(0)
  /** Escape 关掉面板后记住的 token：同一个 token 不再弹，换一个字重新弹。 */
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)

  // ---- 贴图双击预览（0.6.50）：dataURL 没有路径，复用不了文件预览页签，自立一个最轻的浮层 ----
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (preview === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  // ---- 每会话独立草稿（0.6.50）----
  /** 草稿的三样东西：正文、贴图、输入历史。会话切换时整份换入换出。 */
  const draftsRef = useRef(new Map<string, { value: string; attachments: string[]; history: string[] }>())
  const draftKeyRef = useRef(props.draftKey)
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return
    draftsRef.current.set(draftKeyRef.current, { value, attachments, history })
    draftKeyRef.current = props.draftKey
    const next = draftsRef.current.get(props.draftKey) ?? { value: '', attachments: [], history: [] }
    setValue(next.value)
    setAttachments(next.attachments)
    setHistory(next.history)
    // 历史游标跟着历史走：换了一份历史，上下键从头开始
    setHistoryIndex(null)
  }, [props.draftKey, value, attachments, history])

  const completions = completionsFor(value, props.models)
  const mentionQuery = mentionQueryAt(value, caret)
  // 命令输入（/ 开头）时命令面板优先，@ 面板让位
  const mentionOpen =
    mentionQuery !== null && mentionQuery.token !== mentionDismissed && !value.startsWith('/')
  const mentionCandidates = useMemo(
    () => (mentionQuery === null || mentionFiles === null ? [] : rankMentionCandidates(mentionFiles, mentionQuery.token)),
    [mentionQuery, mentionFiles],
  )
  const showPanel = completions.length > 0 && !mentionOpen

  useEffect(() => {
    setActive(0)
  }, [value])

  // 首次触发 @ 时拉一次工作区文件清单（失败给空清单：面板显示「没有匹配的文件」）
  useEffect(() => {
    if (!mentionOpen || mentionFiles !== null || mentionLoading) return
    setMentionLoading(true)
    void props
      .listFiles()
      .then((files) => setMentionFiles(files))
      .catch(() => setMentionFiles([]))
      .finally(() => setMentionLoading(false))
  }, [mentionOpen, mentionFiles, mentionLoading, props.listFiles])

  // 换工作目录（切会话）后清单作废重拉
  useEffect(() => {
    setMentionFiles(null)
  }, [props.cwd])

  /** 把候选路径插回正文并落好光标。 */
  const pickMention = (path: string): void => {
    const query = mentionQueryAt(value, caret)
    if (query === null) return
    const next = insertMention(value, query, path)
    setValue(next.text)
    // caret state 不同步的话，mentionQueryAt 还拿旧光标往前扫到 @，把整条已选路径
    // 当成新 token，面板在点选后继续开着（候选退化成刚选的那条）。
    setCaret(next.caret)
    setMentionActive(0)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  useEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [value])

  const currentChoice = props.models.find((model) => model.model === props.model)
  /** 权限模式当前档的文案（档位清单由 approval 插件贡献，这里只负责画）。 */
  const policyCurrent = props.policy.options.find((item) => item.id === props.policy.current)
  /** 模式当前档（清单由 presets 插件贡献；文件被删时这里查不到，就用名字顶上）。 */
  const presetCurrent = props.preset.options.find((item) => item.name === props.preset.current)
  /** 当前模型能不能收图；模型列表里查不到它时先放行，别把输入框锁死。 */
  const canPasteImage = currentChoice === undefined || currentChoice.modalities.includes('image')

  /** 这个模型支持的思考档位；查不到模型时全给（避免列表没同步就把面板掏空）。 */
  const effortOptions = useMemo(
    () =>
      EFFORTS.filter(
        (item) =>
          item.value === 'default' ||
          currentChoice === undefined ||
          currentChoice.thinkingLevels.includes(item.value as ThinkingLevel),
      ),
    [currentChoice],
  )

  /** 把剪贴板 / 拖进来的文件收成贴图；模型没声明照片输入就一句话顶回去。 */
  const attachFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    if (!canPasteImage) {
      toastErr(`${props.model} 没声明照片输入：在设置 → 模型里给它勾上「照片」，或者换一个勾了的模型`)
      return
    }
    for (const file of files) {
      const result = await readImage(file)
      if (!result.ok) toastErr(`这张图没贴上：${result.error}`)
      else setAttachments((current) => [...current, result.url])
    }
  }

  const submit = (steer = false): void => {
    const text = expandCommand(value).trim()
    if (text === '' && attachments.length === 0) return
    props.onSubmit(text, attachments.length > 0 ? attachments : undefined, steer ? { steer: true } : undefined)
    if (text !== '' && !text.startsWith('/')) {
      setHistory((current) => [...current.slice(-49), text])
    }
    setHistoryIndex(null)
    setValue('')
    setAttachments([])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // @ 提及面板优先于命令面板：Esc 关掉（同 token 不再弹），键选回车即插入
    if (mentionOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(mentionQuery?.token ?? null)
        return
      }
      if (mentionCandidates.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setMentionActive((current) => (current + 1) % mentionCandidates.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setMentionActive((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length)
          return
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          event.preventDefault()
          pickMention(mentionCandidates[mentionActive] ?? mentionCandidates[0]!)
          return
        }
        return
      }
      // 候选还在加载：不劫持任何键，落回默认行为
    }
    if (showPanel) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => (current + 1) % completions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => (current - 1 + completions.length) % completions.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        setValue(completions[active]?.insert ?? value)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const item = completions[active]
        // 精确匹配（补全插入值 == 当前输入展开）时提交，否则先补全
        const expanded = expandCommand(value)
        if (item !== undefined && item.insert !== expanded) {
          setValue(item.insert)
          return
        }
        submit(event.ctrlKey || event.metaKey)
        return
      }
      return
    }
    // Ctrl/Cmd+回车 = 提交并插话（对照 dsh 的 busy-Enter 约定：回车排队、加速键插话）。
    // 回合没在跑时它跟普通回车一样，只是发出去——插话那一步由宿主判断要不要动手。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(event.ctrlKey || event.metaKey)
      return
    }
    if (event.key === 'ArrowUp' && value === '' && history.length > 0) {
      event.preventDefault()
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(index)
      setValue(history[index] ?? '')
      return
    }
    if (event.key === 'ArrowDown' && historyIndex !== null) {
      event.preventDefault()
      const index = historyIndex + 1
      if (index >= history.length) {
        setHistoryIndex(null)
        setValue('')
      } else {
        setHistoryIndex(index)
        setValue(history[index] ?? '')
      }
    }
  }

  // 按厂商（provider）分组，组内保持配置顺序
  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelChoiceView[]>()
    for (const choice of props.models) {
      const list = map.get(choice.provider) ?? []
      list.push(choice)
      map.set(choice.provider, list)
    }
    return [...map.entries()]
  }, [props.models])

  const currentLabel = currentChoice?.model ?? props.model
  /** 输入框里有东西可发（正文或贴图）。 */
  const sendable = value.trim() !== '' || attachments.length > 0
  /**
   * 回合跑着、手上又有内容：这一下不是「发出去」而是「排队」（内核出账时机见
   * core/loop.ts 的 drainInbox）。这时右下角并排两颗——停止留着，一键能停。
   */
  const queueing = props.working && sendable

  return (
    <div
      className="composer"
      style={{ marginTop: 10 }}
      onDragOver={(event) => {
        if (canPasteImage && event.dataTransfer?.types.includes('Files') === true) event.preventDefault()
      }}
      onDrop={(event) => {
        const files = event.dataTransfer?.files
        if (files === undefined || files.length === 0) return
        event.preventDefault()
        void attachFiles(Array.from(files))
      }}
    >
      {mentionOpen && (
        <div className="completions">
          {mentionFiles === null ? (
            <div className="item" style={{ cursor: 'default' }}>
              <span className="label">正在读取工作区文件…</span>
            </div>
          ) : mentionCandidates.length === 0 ? (
            <div className="item" style={{ cursor: 'default' }}>
              <span className="label">没有匹配的文件</span>
            </div>
          ) : (
            mentionCandidates.map((path: string, index: number) => (
              <div
                key={path}
                className={`item${index === mentionActive ? ' active' : ''}`}
                onMouseEnter={() => setMentionActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pickMention(path)
                }}
              >
                <span className="label">{`@${path}`}</span>
              </div>
            ))
          )}
        </div>
      )}
      {showPanel && (
        <div className="completions">
          {completions.map((item: CompletionItem, index: number) => (
            <div
              key={item.insert}
              className={`item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                setValue(item.insert)
                textarea.current?.focus()
              }}
            >
              <span className="label">{item.label}</span>
              <span className="desc">{item.description}</span>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attach-strip">
          {attachments.map((url, index) => (
            <span className="attach-item" key={`${url.slice(0, 48)}-${String(index)}`}>
              <img
                src={url}
                alt={`第 ${String(index + 1)} 张贴图`}
                data-tip="双击看大图"
                onDoubleClick={() => setPreview(url)}
              />
              <button
                className="attach-remove"
                data-tip="不要这张图"
                onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}
              >
                <IconClose size={11} />
              </button>
            </span>
          ))}
          <span className="attach-hint">{attachments.length} 张贴图，发送时一起发出去</span>
        </div>
      )}
      {preview !== null &&
        createPortal(
          <div className="img-lightbox" onClick={() => setPreview(null)} role="presentation">
            <img src={preview} alt="贴图预览" />
          </div>,
          document.body,
        )}
      <textarea
        ref={textarea}
        rows={1}
        autoFocus
        value={value}
        placeholder={
          props.disabled
            ? '等待审批…'
            : props.working
              ? '回合进行中：回车把消息排进队里，Ctrl+Enter 插话（打断当前输出）'
              : canPasteImage
                ? '发消息，/ 调用指令，@ 引用文件，可贴图或拖图片进来'
                : '发消息，/ 调用指令，@ 引用文件（当前模型没开照片输入，贴图会被拒绝）'
        }
        disabled={props.disabled}
        onChange={(event) => {
          setValue(event.target.value)
          setCaret(event.target.selectionStart ?? 0)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const items = event.clipboardData?.items
          if (items === undefined) return
          const files = Array.from(items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
          if (files.length === 0) return
          event.preventDefault()
          void attachFiles(files)
        }}
      />
      <div className="composer-bar">
        <button
          className="icon-btn"
          data-tip="插入 / 调用指令"
          onClick={() => {
            setValue((current) => (current === '' ? '/' : current))
            textarea.current?.focus()
          }}
        >
          <IconPlus size={15} />
        </button>
        <div className="bar-left">
          <div className="model-anchor">
            <button
              className={`model-btn${policyOpen ? ' open' : ''}`}
              onClick={() => {
                setPolicyOpen((current) => !current)
                setModelOpen(false)
                setPresetOpen(false)
              }}
              data-tip={policyCurrent?.hint ?? '权限模式'}
            >
              <IconShield size={13} />
              {policyCurrent?.label ?? props.policy.current}
              <IconChevronDown size={12} />
            </button>
            {policyOpen && (
              <>
                <div className="pop-mask" onClick={() => setPolicyOpen(false)} />
                <div className="model-pop policy-pop">
                  <div className="pop-label">权限模式</div>
                  {props.policy.options.map((item) => (
                    <button
                      key={item.id}
                      className={`pop-item${item.id === props.policy.current ? ' on' : ''}`}
                      data-tip={item.hint}
                      onClick={() => {
                        props.onPolicyChange(item.id)
                        setPolicyOpen(false)
                      }}
                    >
                      <span className="name">{item.label}</span>
                      {item.id === props.policy.current && <IconCheck size={14} className="check" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="model-anchor">
            <button
              className={`model-btn${presetOpen ? ' open' : ''}`}
              onClick={() => {
                setPresetOpen((current) => !current)
                setModelOpen(false)
                setPolicyOpen(false)
              }}
              data-tip={presetCurrent?.description || '模式：模型是谁、手上有什么、被叮嘱了什么'}
            >
              <IconLayers size={13} />
              {presetCurrent?.label ?? props.preset.current}
              <IconChevronDown size={12} />
            </button>
            {presetOpen && (
              <>
                <div className="pop-mask" onClick={() => setPresetOpen(false)} />
                <div className="model-pop preset-pop">
                  <div className="pop-label">
                    模式
                    <span className="pop-note">新建/编辑：设置 → 模式</span>
                  </div>
                  {props.preset.options.map((item) => (
                    <button
                      key={item.name}
                      className={`pop-item${item.name === props.preset.current ? ' on' : ''}`}
                      data-tip={item.problem ?? item.description}
                      onClick={() => {
                        props.onPresetChange(item.name)
                        setPresetOpen(false)
                      }}
                    >
                      <span className="name">
                        {item.label}
                        {item.name === props.preset.defaultName && <span className="pop-badge">默认</span>}
                        {item.problem !== undefined && <span className="pop-badge warn">有问题</span>}
                      </span>
                      {item.name === props.preset.current && <IconCheck size={14} className="check" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="bar-right">
          <div className="model-anchor">
            <button
              className={`model-btn${modelOpen ? ' open' : ''}`}
              onClick={() => {
                setModelOpen((current) => !current)
                setPolicyOpen(false)
              }}
              data-tip="模型与思考强度"
            >
              <span className="model-name">{currentLabel}</span>
              <IconChevronDown size={13} />
            </button>
            {modelOpen && (
              <>
                <div className="pop-mask" onClick={() => setModelOpen(false)} />
                <div className="model-pop">
                  <div className="pop-label">
                    思考强度
                    {effortOptions.length < EFFORTS.length && (
                      <span className="pop-note">这个模型只声明了这些档位</span>
                    )}
                  </div>
                  <div className="effort-row">
                    {effortOptions.map((item) => (
                      <button
                        key={item.value}
                        className={`effort-btn${props.effort === item.value ? ' on' : ''}`}
                        data-tip={item.hint || item.label}
                        onClick={() => {
                          props.onEffortChange(item.value)
                          setModelOpen(false)
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="pop-label">模型</div>
                  <div className="model-list">
                    {modelGroups.map(([provider, list]) => (
                      <div key={provider}>
                        <div className="pop-group">{provider}</div>
                        {list.map((choice) => (
                          <button
                            key={choice.value}
                            className={`pop-item${choice.value === currentChoice?.value ? ' on' : ''}`}
                            data-tip={choice.description}
                            onClick={() => {
                              props.onModelChange(choice.value)
                              setModelOpen(false)
                            }}
                          >
                            <span className="name">{choice.model}</span>
                            {choice.modalities.includes('image') && <span className="pop-badge">图</span>}
                            {choice.modalities.includes('video') && <span className="pop-badge">视频</span>}
                            <span className="ctx">{`${Math.round(choice.contextWindow / 1000)}k`}</span>
                            {choice.value === currentChoice?.value && (
                              <IconCheck size={14} className="check" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                    {props.models.length === 0 && (
                      <div className="pop-item" style={{ cursor: 'default' }}>
                        <span className="name">{props.model}</span>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {/* 回合跑着：停止钮一直在（哪怕手上正打着字，一键能停）；
              有内容可发时它旁边再多一颗发送钮——那一下是排队，不是立刻发。 */}
          {props.working && (
            <button
              className={`send-btn stop${queueing ? ' dim' : ''}`}
              aria-label="打断当前回合"
              data-tip="打断当前回合"
              onClick={props.onInterrupt}
            >
              <IconStop size={16} />
            </button>
          )}
          {!props.working || queueing ? (
            <button
              className="send-btn"
              aria-label={props.working ? '排队发送' : '发送'}
              data-tip={
                props.working
                  ? '排队发送：这一轮跑完立刻发出（Ctrl+Enter 插话：打断当前输出先发这条）'
                  : '发送，快捷键 Enter'
              }
              disabled={!sendable || props.disabled}
              onClick={() => submit()}
            >
              <IconArrowUp size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
