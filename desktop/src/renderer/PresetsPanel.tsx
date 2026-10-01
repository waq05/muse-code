/**
 * 模式（设置 → 模式）：卡片列表 + 就地表单。
 *
 * 一个模式 = `~/.dsc/presets/<名字>.md` 一个文件，页面上做的每一次改动都写回文件，
 * 所以「手写文件」和「在这里点」是同一个东西的两条路：改完刷新页面，两边看到的一样。
 *
 * 版式照「模型」分区：内置与自定义分两组，每张卡片给出工牌摘要（工具白名单、去掉的提示段），
 * 操作按钮在卡片右侧；「查看配置」读文件原文（含 frontmatter，只读），编辑用就地表单
 * （不弹窗，和端点编辑一个做法）。
 *
 * @module desktop/renderer/PresetsPanel
 */
import { useEffect, useState, type JSX } from 'react'
import type { PresetDraft, PresetSurface, PresetView, SettingsMutation, ToolEntryView } from '@dsc/runtime/contract.js'
import { confirmAction } from './components/confirm.js'
import { toastErr, toastOk } from './components/toast.js'
import type { RuntimeProxy } from './bridge.js'
import { IconPlus, IconRefresh } from './icons.js'

/** 模式标识的形状，与 core/presets.ts 的 PRESET_NAME 同一张表（表单里先拦一道）。 */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

const RISK_LABELS: Record<ToolEntryView['risk'], string> = {
  read: '只读',
  write: '写入',
  exec: '执行',
}

export function PresetsPanel(props: { proxy: RuntimeProxy }): JSX.Element {
  const [surface, setSurface] = useState<PresetSurface | null>(null)
  const [tools, setTools] = useState<ToolEntryView[]>([])
  const [draft, setDraft] = useState<PresetDraft | null>(null)
  const [peek, setPeek] = useState<{ name: string; text: string } | null>(null)

  /** 拉一次清单与工具目录；失败说清原因，保留上一次读到的数据。 */
  const reload = (): void => {
    void props.proxy
      .listPresets()
      .then(setSurface)
      .catch((error: unknown) => toastErr(`读取模式清单失败：${text(error)}`))
    void props.proxy
      .listTools()
      .then(setTools)
      // 读不到工具目录时说清（空着会让人以为「一个工具都没有」，那不是同一件事）
      .catch((error: unknown) => {
        setTools([])
        toastErr(`读取工具目录失败，工具多选这一块是空的：${text(error)}`)
      })
  }
  useEffect(reload, [])

  /** 写一次，回执走 Toast；成功后重取（文件可能已被外部改过）。 */
  const write = (task: Promise<SettingsMutation>, okText?: string): void => {
    void task
      .then((result) => {
        if (!result.ok) {
          toastErr(`操作失败：${result.error}`)
          return
        }
        toastOk(result.notice ?? okText ?? '已保存')
        reload()
      })
      .catch((error: unknown) => toastErr(`操作失败：${text(error)}`))
  }

  /** 表单保存：失败留在表单里让用户改，成功就收起并重取。 */
  const finishDraft = (result: SettingsMutation): void => {
    if (!result.ok) {
      toastErr(`保存失败：${result.error}`)
      return
    }
    toastOk(result.notice ?? '模式已保存')
    setDraft(null)
    reload()
  }

  if (surface === null) return <div className="settings-empty">正在读取模式…</div>

  const builtin = surface.options.filter((item) => item.builtin)
  const custom = surface.options.filter((item) => !item.builtin)

  return (
    <div className="settings-fields presets">
      <div className="preset-intro">
        模式决定<strong>模型是谁、手上有什么、被叮嘱了什么</strong>（提示词 + 工具目录）。
        它与权限模式（问出来之后怎么裁）、协作模式（这一轮能把手伸多远）是三根独立旋钮：
        模式只做减法，工具白名单只能是全量的子集，所以任何模式都放宽不了安全。
        切档也可以直接敲 <span className="mono">/preset {'<'}名字{'>'}</span>。
      </div>

      <div className="models-head">
        <span>内置</span>
        <span className="count">{builtin.length}</span>
        <button className="btn-ghost presets-refresh" data-tip="重新读取模式文件" onClick={reload}>
          <IconRefresh size={14} /> 刷新
        </button>
      </div>
      {builtin.map((item) => (
        <PresetCard
          key={item.name}
          preset={item}
          surface={surface}
          onUse={() => write(props.proxy.usePreset(item.name))}
          onDefault={() => write(props.proxy.setDefaultPreset(item.name))}
          onEdit={() => setDraft({ ...toDraft(item), oldName: item.name })}
          onPeek={() => void peekPreset(props.proxy, item.name, setPeek)}
        />
      ))}

      <div className="models-head">
        <span>自定义</span>
        <span className="count">{custom.length}</span>
        <button
          className="btn-primary models-add"
          onClick={() => setDraft(blankDraft())}
          data-tip="新建一个模式文件（内容与手写 ~/.dsc/presets/*.md 完全等价）"
        >
          <IconPlus size={14} /> 新建模式
        </button>
      </div>
      {custom.length === 0 && (
        <div className="settings-empty">
          还没有自定义模式。点「新建模式」在这里建一个，或者直接在 <span className="mono">~/.dsc/presets/</span>{' '}
          里手写一个 <span className="mono">{'<名字>'}.md</span>（frontmatter + 正文，形状跟队友角色一样）。
        </div>
      )}
      {custom.map((item) => (
        <PresetCard
          key={item.name}
          preset={item}
          surface={surface}
          onUse={() => write(props.proxy.usePreset(item.name))}
          onDefault={() => write(props.proxy.setDefaultPreset(item.name))}
          onEdit={() => setDraft({ ...toDraft(item), oldName: item.name })}
          onPeek={() => void peekPreset(props.proxy, item.name, setPeek)}
          onRemove={() => {
            void confirmAction({
              title: `删除模式「${item.label}」？`,
              detail: `会删掉文件 ~/.dsc/presets/${item.name}.md，删掉之后找不回来（想留着就先把内容复制出来）。`,
              confirmLabel: '删除',
              danger: true,
            }).then((yes) => {
              if (yes) write(props.proxy.removePreset(item.name))
            })
          }}
        />
      ))}

      {peek !== null && (
        <div className="preset-raw">
          <div className="preset-raw-head">
            <span className="mono">{peek.name}.md</span>
            <span className="preset-raw-hint">文件原文（只读）：frontmatter 里的键就是这张卡片的全部设置</span>
            <button className="text-btn" onClick={() => setPeek(null)}>
              关闭
            </button>
          </div>
          <pre>{peek.text}</pre>
        </div>
      )}

      {draft !== null && (
        <PresetForm
          key={draft.oldName ?? 'new'}
          draft={draft}
          tools={tools}
          droppable={surface.droppable}
          known={surface.options.map((item) => item.name)}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          proxy={props.proxy}
          onDone={finishDraft}
        />
      )}

      <div className="settings-paths">
        <span>模式文件 </span>
        <span className="mono">~/.dsc/presets/</span>
        <span>共 {surface.options.length} 个</span>
      </div>
    </div>
  )
}

/** 一张模式卡片：显示名 + 标识 + 工牌摘要 + 操作按钮。 */
function PresetCard(props: {
  preset: PresetView
  surface: PresetSurface
  onUse(): void
  onDefault(): void
  onEdit(): void
  onPeek(): void
  onRemove?(): void
}): JSX.Element {
  const item = props.preset
  const isCurrent = props.surface.current === item.name
  const isDefault = props.surface.defaultName === item.name
  return (
    <div className={`preset-card${isCurrent ? ' on' : ''}`}>
      <div className="preset-row">
        <div className="preset-main">
          <div className="preset-name">
            {item.label}
            <span className="mono preset-id">{item.name}</span>
            {isCurrent && <span className="tag">当前</span>}
            {isDefault && <span className="tag dim">新会话默认</span>}
          </div>
          <div className="preset-sub">{item.description === '' ? '没有写说明' : item.description}</div>
          <div className="preset-badge-line">
            <span className="preset-badge">
              工具：{item.tools === null ? '全量（跟随当前挂载的插件）' : item.tools.length === 0 ? '一个都不给' : item.tools.join('、')}
            </span>
            {item.drop.length > 0 && <span className="preset-badge warn">去掉提示段：{item.drop.join('、')}</span>}
            {item.prompt.trim() !== '' && <span className="preset-badge">带 {item.prompt.trim().length} 字提示词</span>}
          </div>
          {item.problem !== undefined && <div className="preset-problem">{item.problem}</div>}
        </div>
        <div className="preset-actions">
          <button
            className={isCurrent ? 'text-btn preset-use' : 'btn-ghost preset-use'}
            disabled={isCurrent}
            data-tip={isCurrent ? '当前会话已经在用这个模式' : '把当前会话切到这个模式（写进会话记录）'}
            onClick={props.onUse}
          >
            {isCurrent ? '使用中' : '用这个'}
          </button>
          <button
            className="text-btn"
            disabled={isDefault}
            data-tip={isDefault ? '新会话已经默认用这个模式' : '新开的会话默认用这个模式（当前会话不变）'}
            onClick={props.onDefault}
          >
            {isDefault ? '已是默认' : '设为默认'}
          </button>
          <button className="text-btn" data-tip="改名字、说明、工具白名单与提示词" onClick={props.onEdit}>
            编辑
          </button>
          <button className="text-btn" data-tip="只读查看模式文件原文" onClick={props.onPeek}>
            查看配置
          </button>
          {props.onRemove !== undefined && (
            <button className="text-btn danger" data-tip="删掉这个模式文件" onClick={props.onRemove}>
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 模式编辑表单：新建与编辑共用，保存时整份写回文件。 */
function PresetForm(props: {
  draft: PresetDraft
  tools: ToolEntryView[]
  droppable: Array<{ id: string; label: string }>
  known: string[]
  proxy: RuntimeProxy
  onChange(draft: PresetDraft): void
  onCancel(): void
  onDone(result: SettingsMutation): void
}): JSX.Element {
  const draft = props.draft
  const isNew = draft.oldName === null
  const patch = (next: Partial<PresetDraft>): void => props.onChange({ ...draft, ...next })
  const nameOk = PRESET_NAME.test(draft.name)
  const renameClash = !isNew && draft.name !== draft.oldName && props.known.includes(draft.name)

  /** 勾 / 取消一个工具：勾第一个时从「全量」切到「白名单」，取消到空也是空（一个工具都不给）。 */
  const toggleTool = (name: string, checked: boolean): void => {
    const list = draft.tools ?? []
    patch({ tools: checked ? [...list, name] : list.filter((item) => item !== name) })
  }

  const save = (): void => {
    void props.proxy.savePreset(draft).then(props.onDone)
  }

  return (
    <div className="provider-form preset-form">
      <div className="provider-form-title">{isNew ? '新建模式' : `编辑模式「${draft.oldName}」`}</div>
      <div className="provider-form-grid">
        <label className="preset-field">
          <span>标识</span>
          <input
            className="setting-input mono"
            value={draft.name}
            placeholder="review（小写字母、数字、连字符）"
            onChange={(event) => patch({ name: event.target.value.trim() })}
          />
        </label>
        <label className="preset-field">
          <span>显示名</span>
          <input
            className="setting-input"
            value={draft.label}
            placeholder="代码审查模式"
            onChange={(event) => patch({ label: event.target.value })}
          />
        </label>
        <label className="preset-field preset-field-wide">
          <span>说明</span>
          <input
            className="setting-input"
            value={draft.description}
            placeholder="一句话说清这个模式是干什么的（切档时会给用户看）"
            onChange={(event) => patch({ description: event.target.value })}
          />
        </label>
      </div>
      {!nameOk && (
        <div className="preset-problem">标识只能用小写字母、数字、连字符，且不能以连字符开头（当前：{draft.name || '空'}）</div>
      )}
      {renameClash && <div className="preset-problem">已经有一个叫「{draft.name}」的模式了，换个名字</div>}

      <div className="preset-field-block">
        <div className="preset-field-head">
          <span>工具白名单</span>
          <label className="preset-switch">
            <input
              type="checkbox"
              checked={draft.tools === null}
              onChange={(event) => patch({ tools: event.target.checked ? null : [] })}
            />
            全量（跟随当前挂载的插件，将来装的新工具也自动有）
          </label>
        </div>
        {draft.tools !== null && (
          <>
            <div className="preset-tool-grid">
              {props.tools.map((tool) => (
                <label className="preset-tool" key={tool.name} data-tip={tool.description}>
                  <input
                    type="checkbox"
                    checked={draft.tools?.includes(tool.name) === true}
                    onChange={(event) => toggleTool(tool.name, event.target.checked)}
                  />
                  <span className="mono">{tool.name}</span>
                  <span className={`preset-risk ${tool.risk}`}>{RISK_LABELS[tool.risk]}</span>
                  {tool.presets !== undefined && <span className="preset-risk mode">仅 {tool.presets.join('/')}</span>}
                </label>
              ))}
            </div>
            <div className="setting-help">
              一个都不勾 = 这个模式不给模型任何工具（连读文件都不行）。工具名写错的不会报错：
              生效的是「白名单 ∩ 当前注册表」。
            </div>
          </>
        )}
      </div>

      <div className="preset-field-block">
        <div className="preset-field-head">
          <span>去掉的提示段</span>
          <span className="setting-help">去掉的只是叮嘱，代码里的守卫不受影响</span>
        </div>
        <div className="preset-drop-list">
          {props.droppable.map((section) => (
            <label className="preset-tool" key={section.id}>
              <input
                type="checkbox"
                checked={draft.drop.includes(section.id)}
                onChange={(event) =>
                  patch({
                    drop: event.target.checked
                      ? [...draft.drop, section.id]
                      : draft.drop.filter((id) => id !== section.id),
                  })
                }
              />
              <span className="mono">{section.id}</span>
              <span className="preset-drop-label">{section.label}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="preset-field preset-field-block">
        <span>提示词（追加进系统提示，排在「做事方式」之后）</span>
        <textarea
          className="preset-prompt"
          value={draft.prompt}
          placeholder={'你专门找问题，不夸方案。每条结论给「文件名:行号」。'}
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </label>

      <div className="provider-form-actions">
        <button className="btn-primary" disabled={!nameOk || renameClash} onClick={save}>
          {isNew ? '创建' : '保存'}
        </button>
        <button className="btn-ghost" onClick={props.onCancel}>
          取消
        </button>
        <span className="provider-form-hint">保存即写文件，当前会话下一次请求生效</span>
      </div>
    </div>
  )
}

/** 读模式原文；失败走 Toast（不把只读面板留在半路上）。 */
async function peekPreset(
  proxy: RuntimeProxy,
  name: string,
  set: (value: { name: string; text: string } | null) => void,
): Promise<void> {
  const result = await proxy.readPreset(name)
  if (!result.ok) {
    toastErr(`读取失败：${result.error}`)
    return
  }
  set({ name, text: result.text })
}

function blankDraft(): PresetDraft {
  return { oldName: null, name: '', label: '', description: '', tools: null, drop: [], prompt: '' }
}

function toDraft(preset: PresetView): PresetDraft {
  return {
    oldName: preset.name,
    name: preset.name,
    label: preset.label,
    description: preset.description,
    tools: preset.tools === null ? null : [...preset.tools],
    drop: [...preset.drop],
    prompt: preset.prompt,
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
