/**
 * 输入区：大圆角容器 + 无边框 textarea + 底部操作行（+ 按钮 / 模型选择器 / 发送圆钮）
 * + / 命令与 /model 补全面板 + 模型/思考强度弹出面板。
 *
 * @module desktop/renderer/Composer
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ApprovalPolicy, EffortLevel, ModelChoiceView } from '@dsc/runtime/contract.js'
import { completionsFor, expandCommand } from '@dsc/runtime/plugins/commands.js'
import type { CompletionItem } from '@dsc/runtime/services/types.js'
import { IconArrowUp, IconCheck, IconChevronDown, IconPlus, IconShield, IconStop } from './icons.js'

const EFFORTS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'default', label: '默认', hint: '不声明思考模式（跟随端点默认）' },
  { value: 'off', label: '关', hint: '禁用思考' },
  { value: 'low', label: '低', hint: '' },
  { value: 'high', label: '高', hint: '' },
  { value: 'max', label: '最大', hint: '' },
]

const POLICIES: { value: ApprovalPolicy; label: string; title: string }[] = [
  { value: 'readonly', label: '仅查看', title: '只读模式：写/执行类工具一律拒绝' },
  { value: 'auto-edit', label: '自动编辑', title: '工作区内写操作自动放行，其余需审批' },
  { value: 'full-access', label: '完全访问', title: '全部工具自动放行（谨慎）' },
  { value: 'ai-review', label: 'AI 审查', title: '由模型逐次判断是否放行，失败回退人工审批' },
]

export function Composer(props: {
  disabled: boolean
  models: readonly ModelChoiceView[]
  model: string
  effort: EffortLevel
  policy: ApprovalPolicy
  working: boolean
  onSubmit(text: string): void
  onInterrupt(): void
  onModelChange(value: string): void
  onEffortChange(value: EffortLevel): void
  onPolicyChange(value: ApprovalPolicy): void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [modelOpen, setModelOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
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

  const submit = (): void => {
    const text = expandCommand(value).trim()
    if (text === '') return
    props.onSubmit(text)
    if (!text.startsWith('/')) {
      setHistory((current) => [...current.slice(-49), text])
    }
    setHistoryIndex(null)
    setValue('')
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

  const currentChoice = props.models.find((model) => model.model === props.model)
  const currentLabel = currentChoice?.model ?? props.model

  return (
    <div className="composer" style={{ marginTop: 10 }}>
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
      <textarea
        ref={textarea}
        rows={1}
        autoFocus
        value={value}
        placeholder={props.disabled ? '等待审批…' : '发消息，/ 调用指令'}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
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
              }}
              data-tip={POLICIES.find((item) => item.value === props.policy)?.title ?? '权限模式'}
            >
              <IconShield size={13} />
              {POLICIES.find((item) => item.value === props.policy)?.label ?? props.policy}
              <IconChevronDown size={12} />
            </button>
            {policyOpen && (
              <>
                <div className="pop-mask" onClick={() => setPolicyOpen(false)} />
                <div className="model-pop policy-pop">
                  <div className="pop-label">权限模式</div>
                  {POLICIES.map((item) => (
                    <button
                      key={item.value}
                      className={`pop-item${item.value === props.policy ? ' on' : ''}`}
                      data-tip={item.title}
                      onClick={() => {
                        props.onPolicyChange(item.value)
                        setPolicyOpen(false)
                      }}
                    >
                      <span className="name">{item.label}</span>
                      {item.value === props.policy && <IconCheck size={14} className="check" />}
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
                  <div className="pop-label">思考强度</div>
                  <div className="effort-row">
                    {EFFORTS.map((item) => (
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
                            <span className="ctx">
                              {choice.description.split('·').pop()?.trim() ?? ''}
                            </span>
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
              data-tip="发送（Enter）"
              disabled={value.trim() === '' || props.disabled}
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
