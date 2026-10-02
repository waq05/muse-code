/**
 * 输入区：大圆角容器 + 无边框 textarea + 底部操作行（+ 按钮 / 模型选择器 / 发送圆钮）
 * + / 命令与 /model 补全面板 + 模型/思考强度弹出面板 + 图片附件（粘贴 / 拖入）。
 *
 * 思考档位只列当前模型声明过的那些；图片要模型勾了「照片」才收（否则发出去也是白搭）。
 *
 * @module desktop/renderer/Composer
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
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
  onSubmit(text: string, images?: string[]): void
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

  const completions = completionsFor(value, props.models)
  const showPanel = completions.length > 0

  useEffect(() => {
    setActive(0)
  }, [value])

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

  const submit = (): void => {
    const text = expandCommand(value).trim()
    if (text === '' && attachments.length === 0) return
    props.onSubmit(text, attachments.length > 0 ? attachments : undefined)
    if (text !== '' && !text.startsWith('/')) {
      setHistory((current) => [...current.slice(-49), text])
    }
    setHistoryIndex(null)
    setValue('')
    setAttachments([])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
        submit()
        return
      }
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
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
              <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
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
      <textarea
        ref={textarea}
        rows={1}
        autoFocus
        value={value}
        placeholder={
          props.disabled
            ? '等待审批…'
            : canPasteImage
              ? '发消息，/ 调用指令，可以贴图或拖图片进来'
              : '发消息，/ 调用指令（当前模型没开照片输入，贴图会被拒绝）'
        }
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
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
          {props.working ? (
            <button className="send-btn stop" data-tip="打断当前回合" onClick={props.onInterrupt}>
              <IconStop size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              data-tip="发送，快捷键 Enter"
              disabled={(value.trim() === '' && attachments.length === 0) || props.disabled}
              onClick={submit}
            >
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
