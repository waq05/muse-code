/**
 * 设置面板：遮罩 + 居中大面板 + 左侧分区导航 + 右侧内容（对照 dsh 桌面端设置）。
 * 关闭方式：右上角关闭按钮、点遮罩、Esc。
 *
 * 内容有两张表：
 * - 通用表单：把宿主声明的 `SettingsField`（text/number/select/switch/info/button）
 *   画成控件——内置「通用」「关于」和外部插件贡献的分区都走这里，插件不给组件；
 * - 特殊分区：`custom: true` 的「模型」「技能」由本文件与 SkillsView 自己画，
 *   数据走 getModelConfig / listSkills。
 *
 * @module desktop/renderer/SettingsModal
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  ModelConfigView,
  ProviderDraft,
  ProviderModelView,
  ProviderView,
  SettingsField,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  UiPrefsView,
  ThemeMode,
  UiFontSize,
  UiDensity,
} from '@dsc/runtime/contract.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { ArchivedView } from './ArchivedView.js'
import { confirmAction } from './components/confirm.js'
import { toastErr, toastOk } from './components/toast.js'
import { SkillsView } from './SkillsView.js'
import {
  IconArchive,
  IconBolt,
  IconClose,
  IconEdit,
  IconGear,
  IconInfo,
  IconKey,
  IconPlus,
  IconSpark,
  IconTrash,
} from './icons.js'

/** 分区图标：认得的用形状，插件贡献的分区退回齿轮。 */
function sectionIcon(id: string): JSX.Element {
  const size = 15
  if (id === 'models') return <IconSpark size={size} />
  if (id === 'skills') return <IconBolt size={size} />
  if (id === 'archive') return <IconArchive size={size} />
  if (id === 'about') return <IconInfo size={size} />
  return <IconGear size={size} />
}

export function SettingsModal(props: {
  open: boolean
  proxy: RuntimeProxy
  /** 打开时定位的分区 id，空串 = 第一个分区。 */
  initial: string
  /** 外观三项的真值，由 App 从宿主的 ui 偏好里带来。 */
  uiPrefs: UiPrefsView
  onUiPrefs(patch: Partial<UiPrefsView>): void
  onClose(): void
}): JSX.Element | null {
  const [sections, setSections] = useState<SettingsSectionView[]>([])
  const [active, setActive] = useState('')
  const [loadError, setLoadError] = useState('')
  const closing = useRef(props.onClose)
  closing.current = props.onClose

  // 每次打开重取分区清单：期间可能挂上/卸下了贡献分区的插件
  useEffect(() => {
    if (!props.open) return
    void props.proxy
      .getSettingsSections()
      .then((list) => {
        setSections(list)
        setActive((current) =>
          list.some((section) => section.id === current)
            ? current
            : list.some((section) => section.id === props.initial)
              ? props.initial
              : (list[0]?.id ?? ''),
        )
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [props.open, props.proxy, props.initial])

  // Esc 关闭
  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closing.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open])

  if (!props.open) return null

  const section = sections.find((item) => item.id === active)

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label="dsc 设置">
        <nav className="settings-nav">
          <div className="settings-nav-head">设置</div>
          {sections.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${item.id === active ? ' on' : ''}`}
              data-tip={item.subtitle ?? item.title}
              onClick={() => setActive(item.id)}
            >
              {sectionIcon(item.id)}
              <span className="label">{item.title}</span>
              {!item.builtin && <span className="from-plugin">插件</span>}
            </button>
          ))}
          {sections.length === 0 && (
            <div className="settings-nav-empty">{loadError === '' ? '正在读取分区…' : loadError}</div>
          )}
          <div className="settings-nav-foot">dsc 设置 · 改动即时写入 ~/.dsc</div>
        </nav>

        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{section?.title ?? '设置'}</h2>
              {section?.subtitle !== undefined && <p>{section.subtitle}</p>}
            </div>
            <button className="icon-btn" data-tip="关闭设置（Esc）" onClick={props.onClose}>
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-body">
            {section === undefined ? (
              <div className="settings-empty">{loadError === '' ? '正在加载…' : `分区加载失败：${loadError}`}</div>
            ) : section.custom && section.id === 'models' ? (
              <ModelsPanel proxy={props.proxy} />
            ) : section.custom && section.id === 'skills' ? (
              <SkillsView proxy={props.proxy} embedded />
            ) : section.custom && section.id === 'archive' ? (
              <ArchivedView proxy={props.proxy} />
            ) : (
              <GenericFields section={section} proxy={props.proxy} uiPrefs={props.uiPrefs} onUiPrefs={props.onUiPrefs} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 把声明的控件画出来，改动即时写回宿主；成功回执与失败原因都走全局 Toast。 */
function GenericFields(props: {
  section: SettingsSectionView
  proxy: RuntimeProxy
  uiPrefs: UiPrefsView
  onUiPrefs(patch: Partial<UiPrefsView>): void
}): JSX.Element {
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    setDraft({})
    void props.proxy
      .getSectionValues(props.section.id)
      .then(setValues)
      .catch((error: unknown) => toastErr(`读取设置失败：${text(error)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.section.id])

  const commit = (key: string, value: SettingsValue): void => {
    void props.proxy
      .setSettingValue(props.section.id, key, value)
      .then((result) => {
        if (!result.ok) {
          toastErr(`没改成：${result.error}`)
          return
        }
        if (result.notice !== undefined) toastOk(result.notice)
        // 值可能被宿主改写（例如非法值被夹取），回读一次
        void props.proxy.getSectionValues(props.section.id).then(setValues).catch(() => {})
      })
      .catch((error: unknown) => toastErr(`没改成：${text(error)}`))
  }

  const act = (action: string): void => {
    void props.proxy
      .runSettingAction(props.section.id, action)
      .then((result) => apply(result))
      .catch((error: unknown) => toastErr(`操作失败：${text(error)}`))
  }

  const render = (field: SettingsField, index: number): JSX.Element => {
    if (field.type === 'info') {
      return (
        <div className="setting-row info" key={`${field.label ?? 'info'}-${String(index)}`}>
          {field.label !== undefined && <div className="setting-label">{field.label}</div>}
          <div className="setting-info">
            <span className={field.mono === true ? 'mono' : ''}>{field.text}</span>
            {field.copyable === true && (
              <span className="setting-info-actions">
                <button
                  className="text-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(field.text).then(
                      () => toastOk('已复制'),
                      () => toastErr('复制失败，请手动选中'),
                    )
                  }}
                >
                  复制
                </button>
                <button
                  className="text-btn"
                  data-tip="在文件管理器里打开"
                  onClick={() => {
                    void dsc.openPath(field.text).then((problem) => {
                      if (problem !== '') toastErr(`打开失败：${problem}`)
                    })
                  }}
                >
                  打开
                </button>
              </span>
            )}
          </div>
          {field.help !== undefined && <div className="setting-help">{field.help}</div>}
        </div>
      )
    }
    if (field.type === 'button') {
      return (
        <div className="setting-row action" key={`${field.action}-${String(index)}`}>
          <button
            className={field.style === 'ghost' ? 'btn-ghost' : 'btn-primary'}
            onClick={() => act(field.action)}
          >
            {field.label}
          </button>
          {field.help !== undefined && <div className="setting-help">{field.help}</div>}
        </div>
      )
    }
    if (field.type === 'select') {
      const current = String(values[field.key] ?? '')
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-label">{field.label}</div>
          <div className="setting-control">
            <select
              className="setting-select"
              value={current}
              onChange={(event) => commit(field.key, event.target.value)}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {/* 宿主返回了选项外的值也要看得见，不能悄悄显示成第一项 */}
              {!field.options.some((option) => option.value === current) && current !== '' && (
                <option value={current}>{current}（未识别）</option>
              )}
            </select>
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
        </div>
      )
    }
    if (field.type === 'switch') {
      const on = values[field.key] === true
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-label">{field.label}</div>
          <div className="setting-control">
            <button
              className={`switch${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              onClick={() => commit(field.key, !on)}
            />
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
        </div>
      )
    }
    // text / number：失焦或回车提交，避免边打字边写盘
    const stored = values[field.key]
    const text = draft[field.key] ?? (stored === undefined ? '' : String(stored))
    return (
      <div className="setting-row" key={field.key}>
        <div className="setting-label">{field.label}</div>
        <div className="setting-control">
          <input
            className={`setting-input${field.type === 'text' && field.mono === true ? ' mono' : ''}`}
            type={field.type === 'number' ? 'number' : 'text'}
            value={text}
            placeholder={field.type === 'text' ? field.placeholder : undefined}
            min={field.type === 'number' ? field.min : undefined}
            max={field.type === 'number' ? field.max : undefined}
            step={field.type === 'number' ? field.step : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
            onBlur={() => {
              if (text === (stored === undefined ? '' : String(stored))) return
              commit(field.key, field.type === 'number' ? Number(text) : text)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          {field.help !== undefined && <div className="setting-help">{field.help}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="settings-fields">
      {props.section.fields.length === 0 && (
        <div className="settings-empty">这个分区没有可配置的项。</div>
      )}
      {props.section.fields.map(render)}
      {props.section.id === 'general' && (
        <AppearanceRows uiPrefs={props.uiPrefs} onUiPrefs={props.onUiPrefs} />
      )}
    </div>
  )
}

/**
 * 外观三项。
 *
 * 宿主分区是宿主侧声明的控件，而这三项只有渲染层消费，所以画在这里、
 * 直接写回宿主的 ui 偏好：App 收到新值立刻重画，不用重启也不用等回推。
 */
function AppearanceRows(props: {
  uiPrefs: UiPrefsView
  onUiPrefs(patch: Partial<UiPrefsView>): void
}): JSX.Element {
  return (
    <div className="settings-appearance">
      <div className="settings-group-title">外观</div>
      {/* 一行两列：标签在左，控件与说明包在 setting-control 里靠右。
          少了这层包装，说明会被网格排到左列标签下面。 */}
      <div className="setting-row">
        <div className="setting-label">主题</div>
        <div className="setting-control">
          <Segments
            value={props.uiPrefs.themeMode}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ]}
            onPick={(value) => props.onUiPrefs({ themeMode: value })}
          />
          <div className="setting-help">深浅两套配色都是完整的；选「跟随系统」会跟着 Windows 的浅色设置随时切换。</div>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-label">字号</div>
        <div className="setting-control">
          <Segments
            value={props.uiPrefs.fontSize}
            options={[
              { value: 'sm', label: '小' },
              { value: 'md', label: '标准' },
              { value: 'lg', label: '大' },
            ]}
            onPick={(value) => props.onUiPrefs({ fontSize: value })}
          />
          <div className="setting-help">标准档正文 13px，小档 92%、大档 112%，代码块跟着一起缩放。</div>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-label">密度</div>
        <div className="setting-control">
          <Segments
            value={props.uiPrefs.density}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'standard', label: '标准' },
              { value: 'roomy', label: '宽松' },
            ]}
            onPick={(value) => props.onUiPrefs({ density: value })}
          />
          <div className="setting-help">只改行高与纵向内距（紧凑 90%、宽松 115%），一屏能看到的会话数会跟着变。</div>
        </div>
      </div>
    </div>
  )
}

/** 一小排互斥选项。选中态用 aria-selected，样式在原语的 .dsc-segmented 里。 */
function Segments<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onPick(value: T): void
}): JSX.Element {
  return (
    <div className="dsc-segmented" role="group">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="dsc-segmented__btn"
          aria-selected={option.value === props.value}
          onClick={() => props.onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 结果 → Toast 回执：失败说清原因，成功有回执就报一句。 */
function apply(result: SettingsMutation): void {
  if (!result.ok) {
    toastErr(`没做成：${result.error}`)
    return
  }
  if (result.notice !== undefined) toastOk(result.notice)
}

/** 把抛出来的东西压成一句话。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 模型分区：端点增删改、API key 写入、默认模型。 */
function ModelsPanel(props: { proxy: RuntimeProxy }): JSX.Element {
  const [config, setConfig] = useState<ModelConfigView | null>(null)
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [keyFor, setKeyFor] = useState<ProviderView | null>(null)
  const [keyValue, setKeyValue] = useState('')

  /** 拉一次模型配置；失败说清原因，保留上一次读到的数据。 */
  const reload = (): void => {
    void props.proxy
      .getModelConfig()
      .then(setConfig)
      .catch((error: unknown) => toastErr(`读取模型配置失败：${text(error)}`))
  }
  useEffect(reload, [])

  if (config === null) return <div className="settings-empty">正在读取模型配置…</div>

  /** 写一次，回执走 Toast；成功后重取（配置文件可能已被外部改过）。 */
  const write = (task: Promise<SettingsMutation>, okText?: string): void => {
    task
      .then((result) => {
        if (!result.ok) {
          toastErr(`没做成：${result.error}`)
          return
        }
        toastOk(result.notice ?? okText ?? '已保存')
        reload()
      })
      .catch((error: unknown) => toastErr(`没做成：${text(error)}`))
  }

  const defaultProvider = config.providers.find((entry) => entry.name === config.defaultProvider)

  return (
    <div className="settings-fields models">
      <div className="setting-row">
        <div className="setting-label">默认模型</div>
        <div className="setting-control">
          <div className="model-default">
            <select
              className="setting-select"
              value={config.defaultProvider}
              onChange={(event) => {
                const provider = config.providers.find((entry) => entry.name === event.target.value)
                const first = provider?.models[0]?.id ?? ''
                if (first !== '') write(props.proxy.setDefaultModel(event.target.value, first))
              }}
            >
              {config.providers.length === 0 && <option value="">（还没有端点）</option>}
              {config.providers.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.displayName || entry.name}
                </option>
              ))}
            </select>
            <select
              className="setting-select"
              value={config.defaultModel}
              disabled={defaultProvider === undefined || defaultProvider.models.length === 0}
              onChange={(event) => write(props.proxy.setDefaultModel(config.defaultProvider, event.target.value))}
            >
              {(defaultProvider?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.id}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-help">
            写入 {config.configFile}；当前会话下一次请求就用新值。
          </div>
        </div>
      </div>

      <div className="models-head">
        <span>端点</span>
        <span className="count">{config.providers.length}</span>
        <button
          className="btn-primary models-add"
          onClick={() =>
            setDraft({ oldName: null, name: '', displayName: '', baseUrl: '', models: [{ id: '', name: '', contextWindow: 0, maxTokens: 0 }] })
          }
        >
          <IconPlus size={14} /> 添加端点
        </button>
      </div>

      {config.providers.length === 0 && (
        <div className="settings-empty">
          还没有端点。也可以直接编辑 <span className="mono">{config.configFile}</span>，改完点右上刷新。
        </div>
      )}

      {config.providers.map((provider) => (
        <div className="provider-card" key={provider.name}>
          <div className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {provider.displayName || provider.name}
                <span className="mono provider-id">{provider.name}</span>
                {config.defaultProvider === provider.name && <span className="tag">默认</span>}
              </div>
              <div className="provider-sub mono" data-tip={provider.baseUrl}>
                {provider.baseUrl}
              </div>
            </div>
            <div className="provider-actions">
              <button
                className={`text-btn${provider.keyConfigured ? ' ok' : ' warn'}`}
                data-tip={
                  provider.keyConfigured
                    ? `${provider.keyRef} 已就绪（环境变量或凭据库）`
                    : `${provider.keyRef} 还没有值，这个端点暂时用不了`
                }
                onClick={() => {
                  setKeyFor(provider)
                  setKeyValue('')
                }}
              >
                <IconKey size={13} /> {provider.keyConfigured ? 'key 已配置' : '填写 key'}
              </button>
              <button
                className="text-btn"
                data-tip="编辑这个端点"
                onClick={() => {
                  setDraft({
                    oldName: provider.name,
                    name: provider.name,
                    displayName: provider.displayName,
                    baseUrl: provider.baseUrl,
                    models: provider.models,
                  })
                }}
              >
                <IconEdit size={13} /> 编辑
              </button>
              {/* 删端点是破坏性操作：先弹确认框说清后果（含默认端点改指），确认后才写。 */}
              <button
                className="text-btn danger"
                data-tip="删除这个端点"
                onClick={() => {
                  const isDefault = config.defaultProvider === provider.name
                  void confirmAction({
                    title: `删除端点「${provider.displayName || provider.name}」？`,
                    detail:
                      `这会从 ${config.configFile} 删掉这个端点，用它的会话要到下次请求才发现用不了；` +
                      `它的 API key 仍留在凭据库里，重加同名端点还能用。${isDefault ? '它是当前默认端点，删掉后默认会自动改指第一个可用端点。' : ''}`,
                    confirmLabel: '删除端点',
                    danger: true,
                  }).then((yes) => {
                    if (!yes) return
                    write(props.proxy.removeProvider(provider.name), `已删除端点「${provider.displayName || provider.name}」`)
                    if (draft !== null && draft.oldName === provider.name) setDraft(null)
                  })
                }}
              >
                <IconTrash size={13} /> 删除
              </button>
            </div>
          </div>

          {keyFor !== null && keyFor.name === provider.name && (
            <div className="provider-key">
              <input
                className="setting-input mono"
                type="password"
                autoFocus
                placeholder={`粘贴 ${provider.keyRef} 的值`}
                value={keyValue}
                onChange={(event) => setKeyValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && keyValue.trim() !== '') {
                    write(props.proxy.setProviderKey(provider.name, keyValue.trim()), 'API key 已写进凭据库')
                    setKeyFor(null)
                  }
                }}
              />
              <button
                className="btn-primary"
                disabled={keyValue.trim() === ''}
                onClick={() => {
                  write(props.proxy.setProviderKey(provider.name, keyValue.trim()), 'API key 已写进凭据库')
                  setKeyFor(null)
                }}
              >
                保存
              </button>
              {provider.keyConfigured && (
                <button
                  className="btn-ghost"
                  data-tip="从凭据库里删掉这个 key"
                  onClick={() => {
                    write(props.proxy.setProviderKey(provider.name, null), 'API key 已从凭据库移除')
                    setKeyFor(null)
                  }}
                >
                  清除
                </button>
              )}
              <button className="text-btn" onClick={() => setKeyFor(null)}>
                取消
              </button>
            </div>
          )}

          <div className="provider-models">
            {provider.models.map((model) => {
              const isDefault = config.defaultProvider === provider.name && config.defaultModel === model.id
              return (
                <button
                  key={model.id}
                  className={`model-chip${isDefault ? ' on' : ''}`}
                  data-tip={isDefault ? '当前默认模型' : '设为默认模型'}
                  onClick={() => write(props.proxy.setDefaultModel(provider.name, model.id))}
                >
                  {model.name || model.id}
                  {model.contextWindow > 0 && <span className="ctx">{model.contextWindow / 1000}k</span>}
                </button>
              )
            })}
            {provider.models.length === 0 && <span className="provider-nomodel">这个端点还没有模型，点「编辑」加一个</span>}
          </div>
        </div>
      ))}

      {draft !== null && (
        <ProviderForm
          key={draft.oldName ?? 'new'}
          draft={draft}
          proxy={props.proxy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onDone={(result) => {
            if (!result.ok) {
              toastErr(`保存失败：${result.error}`)
              return
            }
            toastOk(result.notice ?? '端点已保存')
            setDraft(null)
            reload()
          }}
        />
      )}

      <div className="settings-paths">
        <span>配置文件 </span>
        <span className="mono">{config.configFile}</span>
        <span>凭据 </span>
        <span className="mono">{config.credentialsFile}</span>
      </div>
    </div>
  )
}

/** 端点编辑表单：新增与改名共用（models 一行一个，`id, 显示名, 上下文窗口`）。 */
function ProviderForm(props: {
  draft: ProviderDraft
  proxy: RuntimeProxy
  onChange(draft: ProviderDraft): void
  onCancel(): void
  onDone(result: SettingsMutation): void
}): JSX.Element {
  const [modelsText, setModelsText] = useState(formatModels(props.draft.models))
  const isNew = props.draft.oldName === null

  const save = (): void => {
    const models = parseModels(modelsText)
    props.proxy
      .saveProvider({ ...props.draft, models })
      .then(props.onDone)
      .catch((error: unknown) =>
        props.onDone({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
  }

  return (
    <div className="provider-form">
      <div className="provider-form-title">{isNew ? '添加端点' : `编辑端点 ${props.draft.oldName}`}</div>
      <div className="provider-form-grid">
        <label className="field">
          <span>名字（小写字母/数字/-/_，写入 config.yaml 的键）</span>
          <input
            className="setting-input mono"
            value={props.draft.name}
            placeholder="deepseek"
            onChange={(event) => props.onChange({ ...props.draft, name: event.target.value })}
          />
        </label>
        <label className="field">
          <span>显示名</span>
          <input
            className="setting-input"
            value={props.draft.displayName}
            placeholder="DeepSeek"
            onChange={(event) => props.onChange({ ...props.draft, displayName: event.target.value })}
          />
        </label>
        <label className="field wide">
          <span>Base URL</span>
          <input
            className="setting-input mono"
            value={props.draft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(event) => props.onChange({ ...props.draft, baseUrl: event.target.value })}
          />
        </label>
        <label className="field wide">
          <span>模型（一行一个：模型id, 显示名, 上下文窗口）</span>
          <textarea
            className="setting-input mono tall"
            rows={3}
            value={modelsText}
            placeholder={'deepseek-chat, DeepSeek Chat, 64000\ndeepseek-reasoner, DeepSeek R1, 64000'}
            onChange={(event) => setModelsText(event.target.value)}
          />
        </label>
      </div>
      <div className="provider-form-actions">
        <button className="btn-primary" onClick={save}>
          保存
        </button>
        <button className="btn-ghost" onClick={props.onCancel}>
          取消
        </button>
        <span className="provider-form-hint">API key 单独填，只写进凭据库，不进配置文件</span>
      </div>
    </div>
  )
}

/** 端点编辑表单里的模型清单：一行一个，`id, 显示名, 上下文窗口`。 */
function formatModels(models: ProviderModelView[]): string {
  return models
    .filter((model) => model.id !== '')
    .map((model) =>
      [model.id, model.name === '' || model.name === model.id ? model.id : model.name, model.contextWindow > 0 ? String(model.contextWindow) : '']
        .join(', ')
        .replace(/, $/, ''),
    )
    .join('\n')
}

function parseModels(text: string): ProviderModelView[] {
  const models: ProviderModelView[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(/[,，\t]+/).map((part) => part.trim())
    const id = parts[0] ?? ''
    if (id === '') continue
    const name = parts[1] !== undefined && parts[1] !== '' ? parts[1] : id
    const contextWindow = Number.parseInt(parts[2] ?? '', 10)
    models.push({ id, name, contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0, maxTokens: 0 })
  }
  return models
}
