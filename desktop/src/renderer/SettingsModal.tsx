/**
 * 设置面板：遮罩 + 居中大面板 + 左侧分区导航 + 右侧内容（对照 dsh 桌面端设置）。
 * 关闭方式：右上角关闭按钮、点遮罩、Esc。
 *
 * 内容有两张表：
 * - 通用表单：把宿主声明的 `SettingsField`（text/number/select/switch/info/button）
 *   画成控件——内置「通用」「关于」走这里；插件贡献的分区不进设置，它们的
 *   配置就地画在插件中心的详情页里（复用的就是下面这个 GenericFields）；
 * - 特殊分区：`custom: true` 的「模型」「模式」「技能」由本文件、PresetsPanel 与
 *   SkillsView 自己画，数据走 getModelConfig / listPresets / listSkills。
 *
 * @module desktop/renderer/SettingsModal
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  EFFORT_WIRE_HINT,
  MODALITIES,
  MODALITY_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  THINKING_PARAMS,
  THINKING_PARAM_LABELS,
} from '@dsc/runtime/core/model-caps.js'
// error → 文案走全仓库唯一那份（core/err-text；别名沿用本文件既有的 text(...) 调用点）
import { errText as text } from '@dsc/runtime/core/err-text.js'
import type {
  Modality,
  ModelConfigView,
  PairShareData,
  ProviderDraft,
  ProviderModelView,
  ProviderView,
  SettingsField,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  ThinkingLevel,
  ThinkingParam,
  ThemeMode,
  UiFontSize,
  UiDensity,
  UiPrefsView,
} from '@dsc/runtime/contract.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { ArchivedView } from './ArchivedView.js'
import { PairModal, type PairRegenerateResult } from './PairModal.js'
import {
  BUTTON_SCALE_MAX,
  BUTTON_SCALE_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  applyButtonScale,
  applyFontScale,
  normalizeButtonScale,
  normalizeFontScale,
} from './appearance.js'
import { confirmAction } from './components/confirm.js'
import { Select } from './components/Select.js'
import { toastErr, toastOk } from './components/toast.js'
import { SkillsView } from './SkillsView.js'
import { PresetsPanel } from './PresetsPanel.js'
import { UsagePanel } from './UsagePanel.js'
import {
  IconArchive,
  IconBolt,
  IconChart,
  IconClose,
  IconEdit,
  IconGear,
  IconInfo,
  IconKey,
  IconLayers,
  IconPhone,
  IconPlus,
  IconSpark,
  IconSwap,
  IconTrash,
} from './icons.js'

/** 分区图标：认得的用形状，其余退回齿轮。 */
function sectionIcon(id: string): JSX.Element {
  const size = 15
  if (id === 'models') return <IconSpark size={size} />
  if (id === 'presets') return <IconLayers size={size} />
  if (id === 'skills') return <IconBolt size={size} />
  if (id === 'archive') return <IconArchive size={size} />
  if (id === 'usage') return <IconChart size={size} />
  if (id === 'remote') return <IconPhone size={size} />
  if (id === 'about') return <IconInfo size={size} />
  return <IconGear size={size} />
}

export function SettingsModal(props: {
  open: boolean
  proxy: RuntimeProxy
  /** 打开时定位的分区 id，空串 = 第一个分区。 */
  initial: string
  /** 外观与过程折叠的真值，由 App 从宿主的 ui 偏好里带来。 */
  uiPrefs: UiPrefsView
  onUiPrefs(patch: Partial<UiPrefsView>): void
  onClose(): void
  /**
   * 自检截图钩子：进面板自动点一次的按钮动作（`?pair=1` → `regenerate-code`，
   * 好把「手机连接」弹窗拉起来）。正常运行不传。
   */
  autoAction?: string
}): JSX.Element | null {
  const [sections, setSections] = useState<SettingsSectionView[]>([])
  const [active, setActive] = useState('')
  const [loadError, setLoadError] = useState('')
  const closing = useRef(props.onClose)
  closing.current = props.onClose

  // 每次打开重取分区清单。插件贡献的分区不进设置：它们的配置就地画在
  // 插件中心的详情页里（对照 dsh——插件配置页在插件中心编辑，设置不重复收录）。
  useEffect(() => {
    if (!props.open) return
    void props.proxy
      .getSettingsSections()
      .then((all) => {
        const list = all.filter((section) => section.builtin)
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
      <div className="settings" role="dialog" aria-modal="true" aria-label="Muse Code 设置">
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
            </button>
          ))}
          {sections.length === 0 && (
            <div className="settings-nav-empty">{loadError === '' ? '正在读取分区…' : loadError}</div>
          )}
          <div className="settings-nav-foot">Muse Code 设置 · 改动即时写入 ~/.dsc</div>
        </nav>

        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{section?.title ?? '设置'}</h2>
              {section?.subtitle !== undefined && <p>{section.subtitle}</p>}
            </div>
            <button className="icon-btn" data-tip="关闭设置，快捷键 Esc" onClick={props.onClose}>
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-body">
            {section === undefined ? (
              <div className="settings-empty">{loadError === '' ? '正在加载…' : `分区加载失败：${loadError}`}</div>
            ) : section.custom && section.id === 'models' ? (
              <ModelsPanel proxy={props.proxy} />
            ) : section.custom && section.id === 'presets' ? (
              <PresetsPanel proxy={props.proxy} />
            ) : section.custom && section.id === 'skills' ? (
              <SkillsView proxy={props.proxy} embedded />
            ) : section.custom && section.id === 'archive' ? (
              <ArchivedView proxy={props.proxy} />
            ) : section.custom && section.id === 'usage' ? (
              <UsagePanel proxy={props.proxy} />
            ) : (
              <GenericFields
                section={section}
                proxy={props.proxy}
                autoAction={props.autoAction}
                extra={
                  section.id === 'general' ? (
                    <AppearanceRows uiPrefs={props.uiPrefs} onUiPrefs={props.onUiPrefs} />
                  ) : undefined
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 把声明的控件画出来，改动即时写回宿主；成功回执与失败原因都走全局 Toast。
 * 设置面板和插件中心的详情页共用：`extra` 是追加在字段表末尾的额外内容
 * （设置「通用」分区的外观与过程折叠这几项走这里，详情页不传）。
 */
export function GenericFields(props: {
  section: SettingsSectionView
  proxy: RuntimeProxy
  extra?: ReactNode
  /**
   * 按钮跑成功之后叫一声。有的分区（安全钩子那种）的控件清单会随内容变：
   * 加了一条规则，下拉里就多一项。光回读值不够，得让外层把整份分区重取一次。
   */
  onAction?: () => void
  /**
   * 进面板就自动点一次的按钮动作（自检截图钩子用，`?pair=1` 走它把「手机连接」弹窗拉起来）。
   * 正常运行时不传，界面上没有任何自动点击。
   */
  autoAction?: string
}): JSX.Element {
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  /**
   * 挂着的「手机连接」弹窗：宿主动作带回配对数据时打开，关掉置空。
   * 连触发它的动作名一起记下来——弹窗里的「重新生成」要再调一次同一个动作。
   */
  const [pair, setPair] = useState<{ action: string; data: PairShareData } | null>(null)

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
          toastErr(`保存失败：${result.error}`)
          return
        }
        if (result.notice !== undefined) toastOk(result.notice)
        // 值可能被宿主改写（例如非法值被夹取），回读一次
        void props.proxy.getSectionValues(props.section.id).then(setValues).catch(() => {})
      })
      .catch((error: unknown) => toastErr(`保存失败：${text(error)}`))
  }

  const act = (action: string): void => {
    void props.proxy
      .runSettingAction(props.section.id, action)
      .then((result) => {
        const share = pairShare(result)
        // 配对码是「要一直看得见」的东西：回执带结构化数据就开弹窗，不再走一闪就没的 Toast
        if (share !== null) setPair({ action, data: share })
        // 链接载荷（检查更新发现新版）：提示照走 Toast，再把发布页交给系统浏览器
        else if (result.ok && result.data?.kind === 'url') {
          apply({ ...result, data: undefined })
          void dsc
            .openExternal(result.data.url)
            .catch((error: unknown) => toastErr(`打开发布页失败：${text(error)}`))
        } else apply(result)
        // 按钮也可能改值（批准状态、启停），跟保存一样回读一次
        void props.proxy.getSectionValues(props.section.id).then(setValues).catch(() => {})
        // 按钮可能改动了控件清单本身（加了一条规则、删了一条脚本），让外层重取整份分区
        if (result.ok) props.onAction?.()
      })
      .catch((error: unknown) => toastErr(`操作失败：${text(error)}`))
  }

  // 自检钩子（`?pair=1`）：进面板后自动点一次指定动作，把「手机连接」弹窗拉起来给截图用。
  // 只跑一次（autoAction 变了才重跑），正常运行时不传这个 prop，界面上没有自动点击。
  const autoFired = useRef('')
  useEffect(() => {
    const action = props.autoAction
    if (action === undefined || action === '' || autoFired.current === action) return
    autoFired.current = action
    const timer = window.setTimeout(() => act(action), 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoAction])


  /**
   * 弹窗里再点一次「重新生成」：调同一个宿主动作，把新码交给弹窗原地换上去。
   *
   * 失败有两种：宿主明确说不（还没开放、上一张码没用掉），或者宿主这一版根本不返回
   * 结构化数据（老回执只有一句 notice）。后者退回老行为——把那句话用 Toast 报出来，
   * 弹窗留在原地不关，用户还能再试。
   */
  const regeneratePair = async (action: string): Promise<PairRegenerateResult> => {
    try {
      const result = await props.proxy.runSettingAction(props.section.id, action)
      if (!result.ok) return { ok: false, error: result.error }
      const share = pairShare(result)
      if (share === null) {
        toastOk(result.notice ?? '已重新生成配对码')
        return { ok: false, error: '这一版宿主没有返回配对码内容，请升级后再试' }
      }
      void props.proxy.getSectionValues(props.section.id).then(setValues).catch(() => {})
      props.onAction?.()
      return { ok: true, data: share }
    } catch (error: unknown) {
      return { ok: false, error: `操作失败：${text(error)}` }
    }
  }

  const render = (field: SettingsField, index: number): JSX.Element => {
    if (field.type === 'info') {
      return (
        <div className="setting-row info" key={`${field.label ?? 'info'}-${String(index)}`}>
          {/* 标题与说明一起待在左栏（dsh 的版式），值靠右对齐 */}
          <div className="setting-text">
            {field.label !== undefined && <div className="setting-label">{field.label}</div>}
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
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
        </div>
      )
    }
    if (field.type === 'button') {
      return (
        <div className="setting-row action" key={`${field.action}-${String(index)}`}>
          {/* 动作行左边只有说明（按钮自己带名字），照 dsh：说明在左、按钮在右 */}
          <div className="setting-text">
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
          <button
            className={field.style === 'ghost' ? 'btn-ghost' : 'btn-primary'}
            onClick={() => act(field.action)}
          >
            {field.label}
          </button>
        </div>
      )
    }
    if (field.type === 'select') {
      const current = String(values[field.key] ?? '')
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-text">
            <div className="setting-label">{field.label}</div>
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-control">
            <Select
              className="setting-select"
              value={current}
              options={
                field.options.some((option) => option.value === current) || current === ''
                  ? field.options
                  // 宿主返回了选项外的值也要看得见，不能悄悄显示成第一项
                  : [...field.options, { value: current, label: `${current} · 未识别` }]
              }
              onPick={(next) => commit(field.key, next)}
              ariaLabel={field.label}
            />
          </div>
        </div>
      )
    }
    if (field.type === 'switch') {
      const on = values[field.key] === true
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-text">
            <div className="setting-label">{field.label}</div>
            {field.help !== undefined && <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-control">
            <button
              className={`switch${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              onClick={() => commit(field.key, !on)}
            />
          </div>
        </div>
      )
    }
    // text / number：失焦或回车提交，避免边打字边写盘
    const stored = values[field.key]
    const text = draft[field.key] ?? (stored === undefined ? '' : String(stored))
    return (
      <div className="setting-row" key={field.key}>
        <div className="setting-text">
          <div className="setting-label">{field.label}</div>
          {field.help !== undefined && <div className="setting-help">{field.help}</div>}
        </div>
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
        </div>
      </div>
    )
  }

  return (
    <div className="settings-fields">
      {props.section.fields.length === 0 && (
        <div className="settings-empty">该分区没有可配置项。</div>
      )}
      {props.section.fields.map(render)}
      {props.extra}
      {/* 弹窗自己走 portal 挂到 body 上（设置面板有 overflow 与 backdrop-filter），
          所以它长在 JSX 的哪一层都不影响画面。 */}
      {pair !== null && (
        <PairModal
          data={pair.data}
          onRegenerate={() => regeneratePair(pair.action)}
          onClose={() => setPair(null)}
        />
      )}
    </div>
  )
}

/**
 * 外观四项 + 过程折叠程度（第五项，同属「显示成什么样」，所以跟外观同处一组）。
 *
 * 宿主分区是宿主侧声明的控件，而这几项只有渲染层消费，所以画在这里、
 * 直接写回宿主的 ui 偏好：App 收到新值立刻重画，不用重启也不用等回推。
 */
function AppearanceRows(props: {
  uiPrefs: UiPrefsView
  onUiPrefs(patch: Partial<UiPrefsView>): void
}): JSX.Element {
  return (
    <div className="settings-appearance">
      <div className="settings-group-title">外观</div>
      {/* dsh 的版式：标题与说明在左栏（.setting-text），控件单独靠右（.setting-control），
          行间由 .setting-row 的发丝线分隔。 */}
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">主题</div>
          <div className="setting-help">「跟随系统」随系统深浅自动切换。</div>
        </div>
        <div className="setting-control">
          <Dropdown
            value={props.uiPrefs.themeMode}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ]}
            onPick={(value) => props.onUiPrefs({ themeMode: value })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">字号</div>
          <div className="setting-help">按百分比缩放全局字号，代码块与终端一起变。</div>
        </div>
        <div className="setting-control">
          <FontScaleRow
            value={normalizeFontScale(props.uiPrefs.fontSize)}
            onPick={(scale) => props.onUiPrefs({ fontSize: scale })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">按钮大小</div>
          <div className="setting-help">调整界面按钮与图标的大小。</div>
        </div>
        <div className="setting-control">
          <ButtonScaleRow
            value={normalizeButtonScale(props.uiPrefs.buttonScale)}
            onPick={(scale) => props.onUiPrefs({ buttonScale: scale })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">密度</div>
          <div className="setting-help">调整行高与间距，一屏可见的会话数随之变化。</div>
        </div>
        <div className="setting-control">
          <Dropdown
            value={props.uiPrefs.density}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'standard', label: '标准' },
              { value: 'roomy', label: '宽松' },
            ]}
            onPick={(value) => props.onUiPrefs({ density: value })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">过程折叠程度</div>
          <div className="setting-help">
            一轮结束后把思考与工具条目收成一行「用时 X」。紧凑档连摘要也不留；
            详细档只收历史轮，正在跑的一轮摊开；完全展开档逐条摊开。
          </div>
        </div>
        <div className="setting-control">
          <Dropdown
            value={props.uiPrefs.processFold}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'standard', label: '标准' },
              { value: 'detailed', label: '详细' },
              // 档位名与 dsh 的中文文案一致（ui-chat 的 settings.transcript.verbose = 完全展开）
              { value: 'verbose', label: '完全展开' },
            ]}
            onPick={(value) => props.onUiPrefs({ processFold: value })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">定稿的思考行</div>
          <div className="setting-help">
            写完的思考默认折成一行还是摊开正文；正在跑的与手动点开的不受影响。
          </div>
        </div>
        <div className="setting-control">
          <Dropdown
            value={props.uiPrefs.reasoningDefaultOpen ? 'open' : 'closed'}
            options={[
              { value: 'closed', label: '默认收起' },
              { value: 'open', label: '默认展开' },
            ]}
            onPick={(value) => props.onUiPrefs({ reasoningDefaultOpen: value === 'open' })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">工具卡</div>
          <div className="setting-help">
            每张工具卡默认只显示「工具名 + 状态」一行，还是连参数与结果一起摊开。
          </div>
        </div>
        <div className="setting-control">
          <Dropdown
            value={props.uiPrefs.toolDefaultOpen ? 'open' : 'closed'}
            options={[
              { value: 'closed', label: '默认收起' },
              { value: 'open', label: '默认展开' },
            ]}
            onPick={(value) => props.onUiPrefs({ toolDefaultOpen: value === 'open' })}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * 字号滑杆：85%–135%，右边实时显示当前百分比。
 *
 * 拖动过程中只改本地草稿 + `<html>` 上的 `--dsc-font-scale`（整页字号即时跟手），
 * 松手、松开按键或失焦才写宿主：一次拖动会发出几十次 change，
 * 每次落盘会连弹几十个「已保存外观设置」。
 * 拖到一半关掉设置面板时，把还停在预览态的字号撤回上一次落盘的值。
 */
function FontScaleRow(props: { value: number; onPick(value: number): void }): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  // 上一次落盘的倍率：判断要不要写宿主、退出时撤回到哪个值，都看它
  const committed = useRef(props.value)

  // 宿主那边的值变了（读档归一的迁移结果、写回去被夹取）就跟着回位
  useEffect(() => {
    committed.current = props.value
    setDraft(props.value)
  }, [props.value])
  useEffect(() => () => applyFontScale(committed.current), [])

  const commit = (): void => {
    if (draft === committed.current) return
    committed.current = draft
    props.onPick(draft)
  }

  return (
    <div className="font-scale">
      <input
        className="font-scale-range"
        type="range"
        min={FONT_SCALE_MIN}
        max={FONT_SCALE_MAX}
        step={0.01}
        value={draft}
        aria-label="全局字号"
        aria-valuetext={`${Math.round(draft * 100)}%`}
        onChange={(event) => {
          const next = Number(event.target.value)
          setDraft(next)
          applyFontScale(next)
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="font-scale-value">{Math.round(draft * 100)}%</span>
    </div>
  )
}

/**
 * 按钮大小滑杆：90%–150%，右边实时显示当前百分比。
 *
 * 与字号滑杆同一套交互：拖动过程中只改本地草稿 + `<html>` 上的
 * `--dsc-btn-scale`（按钮与图标即时跟手），松手、松开按键或失焦才写宿主。
 * 拖到一半关掉设置面板时，把还停在预览态的倍率撤回上一次落盘的值。
 */
function ButtonScaleRow(props: { value: number; onPick(value: number): void }): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  // 上一次落盘的倍率：判断要不要写宿主、退出时撤回到哪个值，都看它
  const committed = useRef(props.value)

  // 宿主那边的值变了（读档归一、写回去被夹取）就跟着回位
  useEffect(() => {
    committed.current = props.value
    setDraft(props.value)
  }, [props.value])
  useEffect(() => () => applyButtonScale(committed.current), [])

  const commit = (): void => {
    if (draft === committed.current) return
    committed.current = draft
    props.onPick(draft)
  }

  return (
    <div className="font-scale btn-scale">
      <input
        className="font-scale-range btn-scale-range"
        type="range"
        min={BUTTON_SCALE_MIN}
        max={BUTTON_SCALE_MAX}
        step={0.01}
        value={draft}
        aria-label="按钮大小"
        aria-valuetext={`${Math.round(draft * 100)}%`}
        onChange={(event) => {
          const next = Number(event.target.value)
          setDraft(next)
          applyButtonScale(next)
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="font-scale-value btn-scale-value">{Math.round(draft * 100)}%</span>
    </div>
  )
}

/** 下拉选择：外观区的选项一律用它与宿主 select 字段同款（收成一项，不再平铺）。 */
function Dropdown<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onPick(value: T): void
}): JSX.Element {
  return (
    <Select
      className="setting-select"
      value={props.value}
      options={props.options}
      onPick={props.onPick}
    />
  )
}

/** 结果 → Toast 回执：失败说清原因，成功有回执就报一句。 */
function apply(result: SettingsMutation): void {
  if (!result.ok) {
    toastErr(`操作失败：${result.error}`)
    return
  }
  if (result.notice !== undefined) toastOk(result.notice)
}

/**
 * 宿主回执里的配对数据，认不出来就返回 null。
 *
 * 三条不认的路都要走到 null（调用方据此走老路：一句 Toast）：
 *   - 老宿主（契约里还没有 `data` 的那一版）回执里根本没有这个字段；
 *   - 以后 `kind` 多了别的种类，今天这个弹窗只画得了配对码；
 *   - 字段缺失或空值（理论上新宿主不会发半截数据，但渲染层不该因为一个字段就白屏）。
 *
 * @param result 宿主动作的原始回执
 * @returns 可以直接交给 PairModal 的数据；认不出时 null
 */
function pairShare(result: SettingsMutation): PairShareData | null {
  if (!result.ok) return null
  const data = result.data
  if (data === undefined || data.kind !== 'pair-code') return null
  if (data.code === '' || data.url === '' || Number.isFinite(data.expiresAt) === false) return null
  return data
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
          toastErr(`操作失败：${result.error}`)
          return
        }
        toastOk(result.notice ?? okText ?? '已保存')
        reload()
      })
      .catch((error: unknown) => toastErr(`操作失败：${text(error)}`))
  }

  const defaultProvider = config.providers.find((entry) => entry.name === config.defaultProvider)

  /** 表单保存回执：失败留在表单里让用户改，成功就收起并重取（文件可能已被外部改过）。 */
  const finishDraft = (result: SettingsMutation): void => {
    if (!result.ok) {
      toastErr(`保存失败：${result.error}`)
      return
    }
    toastOk(result.notice ?? '端点已保存')
    setDraft(null)
    reload()
  }

  return (
    <div className="settings-fields models">
      <div className="setting-row">
        <div className="setting-label">默认模型</div>
        <div className="setting-control">
          <div className="model-default">
            <Select
              className="setting-select"
              value={config.defaultProvider}
              options={
                config.providers.length === 0
                  ? [{ value: '', label: '暂无端点' }]
                  : config.providers.map((entry) => ({ value: entry.name, label: entry.displayName || entry.name }))
              }
              onPick={(next) => {
                const provider = config.providers.find((entry) => entry.name === next)
                const first = provider?.models[0]?.id ?? ''
                if (first !== '') write(props.proxy.setDefaultModel(next, first))
              }}
              ariaLabel="默认端点"
            />
            <Select
              className="setting-select"
              value={config.defaultModel}
              disabled={defaultProvider === undefined || defaultProvider.models.length === 0}
              options={(defaultProvider?.models ?? []).map((model) => ({
                value: model.id,
                label: model.name || model.id,
              }))}
              onPick={(next) => write(props.proxy.setDefaultModel(config.defaultProvider, next))}
              ariaLabel="默认模型"
            />
          </div>
          <div className="setting-help">当前会话的下一次请求就用新值。</div>
        </div>
      </div>

      <div className="models-head">
        <span>端点</span>
        <span className="count">{config.providers.length}</span>
        <button
          className="btn-primary models-add"
          onClick={() => {
            setDraft({ oldName: null, name: '', displayName: '', baseUrl: '', models: [blankModel()] })
            setTimeout(() => document.querySelector('.provider-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0)
          }}
        >
          <IconPlus size={14} /> 添加端点
        </button>
      </div>

      {config.providers.length === 0 && (
        <div className="settings-empty">
          还没有端点。也可以直接编辑 <span className="mono">{config.configFile}</span>，修改后点击右上角刷新。
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
              <div className="provider-sub mono" title={provider.baseUrl}>
                {provider.baseUrl}
              </div>
            </div>
            <div className="provider-actions">
              <button
                className={`text-btn${provider.keyConfigured ? ' ok' : ' warn'}`}
                data-tip={
                  provider.keyConfigured
                    ? `${provider.keyRef} 已就绪，来自环境变量或凭据库`
                    : `${provider.keyRef} 尚未配置，该端点暂不可用`
                }
                onClick={() => {
                  setKeyFor(provider)
                  setKeyValue('')
                }}
              >
                <IconKey size={13} /> {provider.keyConfigured ? '密钥已配置' : '填写密钥'}
              </button>
              <button
                className="text-btn"
                data-tip="编辑这个端点"
                onClick={(event) => {
                  setDraft({
                    oldName: provider.name,
                    name: provider.name,
                    displayName: provider.displayName,
                    baseUrl: provider.baseUrl,
                    models: provider.models,
                  })
                  // 编辑框就长在这张卡里，滚动一下让它露出来（卡片在长列表下方时尤其需要）
                  const card = event.currentTarget.closest('.provider-card')
                  setTimeout(() => card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0)
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
                      `将从 ${config.configFile} 删除该端点，使用它的会话在下次请求时才会发现不可用；` +
                      `其 API key 仍保留在凭据库中，重新添加同名端点后可继续使用。${isDefault ? '该端点是当前默认端点，删除后默认端点将自动改为第一个可用端点。' : ''}`,
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

          {/* 编辑框就长在点「编辑」的那张卡里，不再永远掉到列表最底下 */}
          {draft !== null && draft.oldName === provider.name && (
            <ProviderForm
              key={`edit-${provider.name}`}
              draft={draft}
              proxy={props.proxy}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onDone={finishDraft}
            />
          )}

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
                  data-tip={`${model.id} · ${modelCapsSummary(model)}${isDefault ? ' · 当前默认模型' : ' · 点一下设为默认模型'}`}
                  onClick={() => write(props.proxy.setDefaultModel(provider.name, model.id))}
                >
                  {model.name || model.id}
                  {model.contextWindow > 0 && <span className="ctx">{Math.round(model.contextWindow / 1000)}k</span>}
                  {/* 只标不寻常的能力：能收图、能收视频、没有思考档位 */}
                  {model.modalities.includes('image') && <span className="cap-badge">图</span>}
                  {model.modalities.includes('video') && <span className="cap-badge">视频</span>}
                  {model.thinkingLevels.length === 0 && <span className="cap-badge dim">无思考</span>}
                </button>
              )
            })}
            {provider.models.length === 0 && <span className="provider-nomodel">该端点还没有模型，点击「编辑」添加</span>}
          </div>
        </div>
      ))}

      {/* 只有「添加端点」才在列表末尾长一张新表单；编辑走卡片内的就地表单 */}
      {draft !== null && draft.oldName === null && (
        <ProviderForm
          key="new"
          draft={draft}
          proxy={props.proxy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onDone={finishDraft}
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

/** 一行空模型（点「加模型」时用）。 */
function blankModel(): ProviderModelView {
  return { id: '', name: '', contextWindow: 0, maxTokens: 0, ...defaultCaps() }
}

/** 能力缺省值：数组每次新建，免得几行模型共用同一个数组互相改到。 */
function defaultCaps(): Pick<ProviderModelView, 'thinkingLevels' | 'thinkingParam' | 'effortMap' | 'modalities'> {
  return { thinkingLevels: [...THINKING_LEVELS], thinkingParam: 'thinking', effortMap: {}, modalities: ['text'] }
}

/** 一个模型的能力说明（端点卡片上模型 chip 的悬浮提示）。 */
function modelCapsSummary(model: ProviderModelView): string {
  const parts = [model.contextWindow > 0 ? `${Math.round(model.contextWindow / 1000)}k 上下文` : '上下文窗口没填']
  parts.push(
    model.thinkingLevels.length === 0
      ? '没有思考档位'
      : `思考档位 ${model.thinkingLevels.map((level) => THINKING_LEVEL_LABELS[level]).join('/')}（发法：${THINKING_PARAM_LABELS[model.thinkingParam].label}）`,
  )
  parts.push(`输入 ${model.modalities.map((modality) => MODALITY_LABELS[modality]).join('/')}`)
  return parts.join(' · ')
}

/** 「128000」「128k」「0.5m」都认；解析不了返回 NaN。 */
function parseTokenCount(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text.trim().toLowerCase().replace(/[,\s]/g, ''))
  if (match === null) return Number.NaN
  const value = Number.parseFloat(match[1] ?? '')
  if (match[2] === 'k') return Math.round(value * 1000)
  if (match[2] === 'm') return Math.round(value * 1_000_000)
  return Math.round(value)
}

/** 端点编辑表单：长在对应端点的卡片里；只有新增端点时才落在列表末尾。 */
function ProviderForm(props: {
  draft: ProviderDraft
  proxy: RuntimeProxy
  onChange(draft: ProviderDraft): void
  onCancel(): void
  onDone(result: SettingsMutation): void
}): JSX.Element {
  /** 批量文本模式：一行一个快改 id / 显示名 / 上下文，档位与输入类型按原行保留。 */
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState(formatModels(props.draft.models))
  const isNew = props.draft.oldName === null

  /** 进出批量文本各同步一次，两种录入方式不会各说各话。 */
  const switchBulk = (): void => {
    if (bulk) props.onChange({ ...props.draft, models: mergeCaps(props.draft.models, parseModels(bulkText)) })
    else setBulkText(formatModels(props.draft.models))
    setBulk(!bulk)
  }

  /** 改其中一行模型（其余行原样留着）。 */
  const patchModel = (index: number, patch: Partial<ProviderModelView>): void => {
    props.onChange({
      ...props.draft,
      models: props.draft.models.map((model, at) => (at === index ? { ...model, ...patch } : model)),
    })
  }

  const removeModel = (index: number): void => {
    props.onChange({ ...props.draft, models: props.draft.models.filter((_, at) => at !== index) })
  }

  /** 勾/去勾一档思考（结果始终按固定顺序排，免得勾选顺序随点击跑乱）。 */
  const toggleLevel = (index: number, level: ThinkingLevel): void => {
    const model = props.draft.models[index]
    if (model === undefined) return
    const wanted = new Set(model.thinkingLevels)
    if (wanted.has(level)) wanted.delete(level)
    else wanted.add(level)
    patchModel(index, { thinkingLevels: THINKING_LEVELS.filter((entry) => wanted.has(entry)) })
  }

  /** 勾/去勾一种输入类型；文本永远留着（协议里没有文本就发不出消息）。 */
  const toggleModality = (index: number, modality: Modality): void => {
    const model = props.draft.models[index]
    if (model === undefined || modality === 'text') return
    const wanted = new Set(model.modalities)
    if (wanted.has(modality)) wanted.delete(modality)
    else wanted.add(modality)
    patchModel(index, { modalities: MODALITIES.filter((entry) => wanted.has(entry)) })
  }

  const save = (): void => {
    const models = bulk ? mergeCaps(props.draft.models, parseModels(bulkText)) : props.draft.models
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
          <span>名字：小写字母、数字、- 或 _，作为 config.yaml 的键</span>
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
        <div className="field wide">
          <div className="model-rows-head">
            <span>模型与能力（不写的字段按默认：thinking 开关 + 四档 + 只吃文本）</span>
            <div className="model-rows-tools">
              <button className="text-btn" data-tip="用一行一个的文本快改 id / 显示名 / 上下文窗口" onClick={switchBulk}>
                <IconSwap size={13} /> {bulk ? '回到表格' : '批量文本'}
              </button>
              <button
                className="text-btn"
                data-tip="再加一个模型"
                onClick={() => props.onChange({ ...props.draft, models: [...props.draft.models, blankModel()] })}
              >
                <IconPlus size={13} /> 加模型
              </button>
            </div>
          </div>
          {bulk ? (
            <textarea
              className="setting-input mono tall"
              rows={Math.max(3, props.draft.models.length + 1)}
              value={bulkText}
              placeholder={'deepseek-chat, DeepSeek Chat, 64000, 8192\ndeepseek-reasoner, DeepSeek R1, 64000'}
              onChange={(event) => setBulkText(event.target.value)}
            />
          ) : (
            <>
              {props.draft.models.map((model, index) => (
                <ModelRow
                  key={index}
                  model={model}
                  onPatch={(patch) => patchModel(index, patch)}
                  onToggleLevel={(level) => toggleLevel(index, level)}
                  onToggleModality={(modality) => toggleModality(index, modality)}
                  onRemove={props.draft.models.length > 1 ? () => removeModel(index) : undefined}
                />
              ))}
              {props.draft.models.length === 0 && (
                <div className="model-rows-empty">这个端点还没有模型，点「加模型」填第一个（模型 id 就是请求里发的名字）。</div>
              )}
            </>
          )}
        </div>
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

/** 批量文本：一行一个 `id, 显示名, 上下文窗口, 最大输出`；空列从尾部省掉。 */
function formatModels(models: ProviderModelView[]): string {
  return models
    .filter((model) => model.id !== '')
    .map((model) => {
      const columns = [
        model.id,
        model.name === '' || model.name === model.id ? '' : model.name,
        model.contextWindow > 0 ? String(model.contextWindow) : '',
        model.maxTokens > 0 ? String(model.maxTokens) : '',
      ]
      while (columns.length > 1 && (columns.at(-1) ?? '') === '') columns.pop()
      return columns.join(', ')
    })
    .join('\n')
}

/** 解析批量文本；能力字段先按默认填，再由 {@link mergeCaps} 按 id 从原行接回来。 */
function parseModels(text: string): ProviderModelView[] {
  const models: ProviderModelView[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(/[,，\t]+/).map((part) => part.trim())
    const id = parts[0] ?? ''
    if (id === '') continue
    const name = parts[1] !== undefined && parts[1] !== '' ? parts[1] : id
    const contextWindow = parseTokenCount(parts[2] ?? '')
    const maxTokens = parseTokenCount(parts[3] ?? '')
    models.push({
      id,
      name,
      contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
      ...defaultCaps(),
    })
  }
  return models
}

/** 批量文本改完，把原行的思考档位 / 档位字段 / 输入类型接回来（一行一个的文本表达不了这些）。 */
function mergeCaps(base: ProviderModelView[], parsed: ProviderModelView[]): ProviderModelView[] {
  return parsed.map((model) => {
    const old = base.find((entry) => entry.id === model.id)
    if (old === undefined) return model
    return {
      ...model,
      thinkingLevels: old.thinkingLevels,
      thinkingParam: old.thinkingParam,
      effortMap: old.effortMap,
      modalities: old.modalities,
    }
  })
}

/**
 * 表单里的一个模型一行：上面一行是 id / 显示名 / 两个 token 数，
 * 下面一行是能力（思考档位、档位走哪个字段、输入类型）。
 */
function ModelRow(props: {
  model: ProviderModelView
  onPatch(patch: Partial<ProviderModelView>): void
  onToggleLevel(level: ThinkingLevel): void
  onToggleModality(modality: Modality): void
  onRemove?(): void
}): JSX.Element {
  const model = props.model
  // token 数这两个框让用户手打（128k 也认），所以本地存一份原文，失焦再归一化
  const [ctxText, setCtxText] = useState(model.contextWindow > 0 ? String(model.contextWindow) : '')
  const [outText, setOutText] = useState(model.maxTokens > 0 ? String(model.maxTokens) : '')

  /** 归一化一个 token 数输入；解析不出来就退回模型上已经有的值。 */
  const commit = (
    text: string,
    field: 'contextWindow' | 'maxTokens',
    fallback: number,
    sync: (text: string) => void,
  ): void => {
    const parsed = parseTokenCount(text)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      sync(fallback > 0 ? String(fallback) : '')
      return
    }
    props.onPatch({ [field]: parsed } as Partial<ProviderModelView>)
    sync(String(parsed))
  }

  /** 改某一档的线上值；清空 = 用内置值（读取时按缺省表补）。 */
  const patchWire = (level: ThinkingLevel, text: string): void => {
    const map = { ...model.effortMap }
    const value = text.trim()
    if (value === '') delete map[level]
    else map[level] = value
    props.onPatch({ effortMap: map })
  }

  return (
    <div className="model-row">
      <div className="model-row-main">
        <label className="model-row-field">
          <span>模型 id</span>
          <input
            className="setting-input mono"
            placeholder="请求里发的名字"
            value={model.id}
            onChange={(event) => props.onPatch({ id: event.target.value })}
          />
        </label>
        <label className="model-row-field">
          <span>显示名</span>
          <input
            className="setting-input"
            placeholder="留空 = 用 id"
            value={model.name === model.id ? '' : model.name}
            onChange={(event) => props.onPatch({ name: event.target.value })}
          />
        </label>
        <label className="model-row-field">
          <span>上下文</span>
          <input
            className="setting-input mono"
            inputMode="numeric"
            placeholder="128000"
            value={ctxText}
            onChange={(event) => setCtxText(event.target.value)}
            onBlur={(event) => commit(event.target.value, 'contextWindow', model.contextWindow, setCtxText)}
          />
        </label>
        <label className="model-row-field">
          <span>最大输出</span>
          <input
            className="setting-input mono"
            inputMode="numeric"
            placeholder="8192"
            value={outText}
            onChange={(event) => setOutText(event.target.value)}
            onBlur={(event) => commit(event.target.value, 'maxTokens', model.maxTokens, setOutText)}
          />
        </label>
        {props.onRemove !== undefined && (
          <button className="text-btn danger" data-tip="删掉这个模型" onClick={props.onRemove}>
            <IconTrash size={13} />
          </button>
        )}
      </div>
      <div className="model-row-caps">
        <span className="cap-label" data-tip="这个模型支持哪几档思考：思考面板只列勾上的这些">
          思考档位
        </span>
        <span className="cap-group">
          {THINKING_LEVELS.map((level) => (
            <button
              key={level}
              className={`cap-chip${model.thinkingLevels.includes(level) ? ' on' : ''}`}
              data-tip={`思考档位「${THINKING_LEVEL_LABELS[level]}」${model.thinkingLevels.includes(level) ? '，点一下取消' : '，点一下勾上'}`}
              onClick={() => props.onToggleLevel(level)}
            >
              {THINKING_LEVEL_LABELS[level]}
            </button>
          ))}
        </span>
        <Select
          className="setting-select cap-param"
          value={model.thinkingParam}
          options={THINKING_PARAMS.map((param) => ({ value: param, label: THINKING_PARAM_LABELS[param].label }))}
          onPick={(next) => props.onPatch({ thinkingParam: next })}
          ariaLabel="思考参数"
        />
        {model.thinkingParam === 'reasoning-effort' && (
          <span className="cap-wire">
            <span className="cap-label">线上值</span>
            {THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level)).map((level) => (
              <label className="cap-wire-field" key={level}>
                <span>{THINKING_LEVEL_LABELS[level]}</span>
                <input
                  className="setting-input mono cap-wire-input"
                  placeholder={EFFORT_WIRE_HINT[level]}
                  value={model.effortMap[level] ?? ''}
                  data-tip={`发给端点的 ${THINKING_LEVEL_LABELS[level]} 档写这个值；留空 = ${EFFORT_WIRE_HINT[level]}。要这一档不发字段，去 config.yaml 写成 null`}
                  onChange={(event) => patchWire(level, event.target.value)}
                />
              </label>
            ))}
          </span>
        )}
        <span className="cap-label" data-tip="这个模型能收什么输入：没勾照片，对话里就发不出图">
          输入
        </span>
        <span className="cap-group">
          {MODALITIES.map((modality) => (
            <button
              key={modality}
              className={`cap-chip${model.modalities.includes(modality) ? ' on' : ''}`}
              disabled={modality === 'text'}
              data-tip={
                modality === 'text'
                  ? '文本永远要勾（协议里没有文本就发不出消息）'
                  : `${MODALITY_LABELS[modality]}输入${model.modalities.includes(modality) ? '，点一下取消' : '，点一下勾上'}`
              }
              onClick={() => props.onToggleModality(modality)}
            >
              {MODALITY_LABELS[modality]}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}
