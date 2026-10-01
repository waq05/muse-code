/**
 * 插件中心（对照 dsh「插件」页）：三档从上到下——
 * ① 自定义（用户放进 `~/.dsc/plugins/` 的 .js，永远排在最前）
 * ② 官方可开关（随包发布但有开关，例如智能体团队、电脑操作）
 * ③ 运行内核（内置不可停用；默认只露 3 行，其余折叠，且放在页面最底部）
 * 整卡可点：点开是这个插件自己的详情页，配置表单就地画在详情页里——
 * 对照 dsh「插件注册的配置页在插件中心里编辑，设置面板不收录插件配置」。
 *
 * @module desktop/renderer/PluginsView
 */
import { useEffect, useState, type JSX } from 'react'
import type { PluginInfoView, SettingsSectionView } from '@dsc/runtime/contract.js'
import { GenericFields } from './SettingsModal.js'
import type { RuntimeProxy } from './bridge.js'
import { IconChevronRight, IconPuzzle, IconRefresh, IconRestart } from './icons.js'

/** 图标底色（按名称散列，避免每行同色）。 */
const GRADIENTS = [
  'linear-gradient(135deg, #4d6bfe, #7a5cff)',
  'linear-gradient(135deg, #12a5a5, #4d6bfe)',
  'linear-gradient(135deg, #e06c75, #b04dfe)',
  'linear-gradient(135deg, #e5a04c, #e06c75)',
  'linear-gradient(135deg, #4cc38a, #12a5a5)',
]

function iconColor(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) | 0
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length] ?? GRADIENTS[0]!
}

function PluginRow({
  plugin,
  onToggle,
  onOpen,
}: {
  plugin: PluginInfoView
  onToggle(file: string, next: boolean): void
  onOpen(file: string): void
}): JSX.Element {
  return (
    <div
      className={`plugin-row${plugin.enabled ? '' : ' off'}`}
      onClick={() => onOpen(plugin.file)}
      data-tip="查看详情与配置"
    >
      <div className="plugin-icon" style={{ background: iconColor(plugin.name) }}>
        {plugin.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="plugin-info">
        <div className="plugin-name">
          {plugin.name}
          {plugin.apiVersion !== undefined && <span className="plugin-apiver">API v{plugin.apiVersion}</span>}
        </div>
        <div className={`plugin-desc${plugin.problem !== undefined ? ' problem' : ''}`}>
          {plugin.problem !== undefined
            ? `⚠ ${plugin.problem}`
            : plugin.description || `${plugin.file} · 无描述，可导出 name 与 description 提供展示`}
        </div>
      </div>
      <button
        className={`switch${plugin.enabled ? ' on' : ''}${plugin.toggleable ? '' : ' locked'}`}
        role="switch"
        aria-checked={plugin.enabled}
        data-tip={plugin.toggleable ? (plugin.enabled ? '停用，即时生效' : '启用，即时生效') : '运行内核的一部分，不可停用'}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(plugin.file, !plugin.enabled)
        }}
      />
    </div>
  )
}

/**
 * 插件详情页：整卡点进来的那一层（对照 dsh 的 detail——面包屑返回、图标加
 * 名称加开关的头部，下面是配置表单）。配置表单直接复用设置面板的通用字段
 * 渲染器：插件贡献的分区本来就是同一张声明表，没理由画两遍。
 */
function PluginDetail(props: {
  plugin: PluginInfoView
  proxy: RuntimeProxy
  onToggle(file: string, next: boolean): void
  onBack(): void
}): JSX.Element {
  const plugin = props.plugin
  // undefined = 还在读；null = 没有配置；其余 = 画表单
  const [section, setSection] = useState<SettingsSectionView | null | undefined>(undefined)

  // 分区只在插件挂着时才存在：停用的插件查不到分区，开关一翻就得重查
  useEffect(() => {
    if (plugin.settingsSection === undefined || !plugin.enabled) {
      setSection(null)
      return
    }
    let alive = true
    setSection(undefined)
    void props.proxy
      .getSettingsSections()
      .then((list) => {
        if (alive) setSection(list.find((item) => item.id === plugin.settingsSection) ?? null)
      })
      .catch(() => {
        if (alive) setSection(null)
      })
    return () => {
      alive = false
    }
  }, [plugin.enabled, plugin.settingsSection, props.proxy])

  /**
   * 详情页里的按钮跑完之后不出声地重取一次分区。
   * 有的分区（安全钩子那种）控件清单跟着内容走：多加一条规则，下拉里就多一项。
   */
  const reloadQuiet = (): void => {
    if (plugin.settingsSection === undefined || !plugin.enabled) return
    void props.proxy
      .getSettingsSections()
      .then((list) => setSection(list.find((item) => item.id === plugin.settingsSection) ?? null))
      .catch(() => {})
  }

  return (
    <div className="plugin-detail">
      <div className="plugin-detail-top">
        <button className="plugin-back" data-tip="返回插件列表" onClick={props.onBack}>
          <IconChevronRight size={14} />
          插件
        </button>
      </div>
      <div className={`plugin-detail-head${plugin.enabled ? '' : ' off'}`}>
        <div className="plugin-icon" style={{ background: iconColor(plugin.name) }}>
          {plugin.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="plugin-info">
          <div className="plugin-name">
            {plugin.name}
            {plugin.apiVersion !== undefined && <span className="plugin-apiver">API v{plugin.apiVersion}</span>}
          </div>
          <div className={`plugin-detail-desc${plugin.problem !== undefined ? ' problem' : ''}`}>
            {plugin.problem !== undefined ? `⚠ ${plugin.problem}` : plugin.description || '无描述'}
          </div>
        </div>
        {plugin.toggleable && (
          <button
            className={`switch${plugin.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={plugin.enabled}
            data-tip={plugin.enabled ? '停用，即时生效' : '启用，即时生效'}
            onClick={() => props.onToggle(plugin.file, !plugin.enabled)}
          />
        )}
      </div>
      <div className="plugin-detail-meta">
        <span className="mono">{plugin.file}</span>
        <span className="plugin-detail-src">
          {plugin.source === 'external' ? '自定义' : plugin.toggleable ? '官方' : '运行内核'}
        </span>
      </div>
      <div className="plugin-detail-config">
        <div className="settings-group-title">配置</div>
        {section === undefined ? (
          <div className="settings-empty">正在读取配置…</div>
        ) : section === null ? (
          plugin.enabled ? (
            <div className="settings-empty">该插件没有可配置项。</div>
          ) : (
            <div className="settings-empty">插件已停用，启用后才能配置。</div>
          )
        ) : (
          <GenericFields section={section} proxy={props.proxy} onAction={reloadQuiet} />
        )}
      </div>
    </div>
  )
}

/** 运行内核默认露几行（其余折叠，这一档本来就少有人翻）。 */
const KERNEL_PREVIEW = 3

export function PluginsView(props: {
  plugins: PluginInfoView[]
  proxy: RuntimeProxy
  onToggle(file: string, next: boolean): void
  onRefresh(): void
  onInstall(): void
  onRestartHost(): void
}): JSX.Element {
  // ?kernelopen=1 直接展开运行内核那一档（自检截图用，好拍清展开后的样子）
  const [kernelOpen, setKernelOpen] = useState(() => new URLSearchParams(location.search).has('kernelopen'))
  // 详情页选中的插件：存 file 键，渲染时回 props.plugins 里取最新值——
  // 开关一翻列表就换成新数组，存对象会让详情页看到过期的 enabled
  const [detailFile, setDetailFile] = useState<string | null>(null)
  const detail = detailFile === null ? null : (props.plugins.find((plugin) => plugin.file === detailFile) ?? null)
  const custom = props.plugins.filter((plugin) => plugin.source === 'external')
  const official = props.plugins.filter((plugin) => plugin.source === 'builtin' && plugin.toggleable)
  const kernel = props.plugins.filter((plugin) => plugin.source === 'builtin' && !plugin.toggleable)
  const kernelShown = kernelOpen ? kernel : kernel.slice(0, KERNEL_PREVIEW)

  // 插件被卸载/改名后 detail 找不到了，落回列表——详情态不用单独清理
  if (detail !== null) {
    return (
      <div className="plugins">
        <div className="plugins-inner">
          <PluginDetail
            plugin={detail}
            proxy={props.proxy}
            onToggle={props.onToggle}
            onBack={() => setDetailFile(null)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>插件</h1>
            <p>管理插件，点击卡片查看详情与配置</p>
          </div>
          <div className="plugins-actions">
            <button className="icon-btn" data-tip="刷新列表" onClick={props.onRefresh}>
              <IconRefresh size={16} />
            </button>
            <button className="icon-btn" data-tip="重启宿主，重新加载插件目录" onClick={props.onRestartHost}>
              <IconRestart size={16} />
            </button>
            <button className="btn-primary plugins-add" onClick={props.onInstall}>
              + 添加插件
            </button>
          </div>
        </div>

        {/* 启停/安装/重启的回执统一走右下角 Toast（components/toast.ts） */}

        <div className="plugin-group-label">
          <IconPuzzle size={13} /> 自定义 <span className="count">{custom.length}</span>
          <span className="group-hint">~/.dsc/plugins/*.js</span>
        </div>
        {custom.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpen={setDetailFile} />
        ))}
        {custom.length === 0 && (
          <div className="plugins-empty">
            尚未安装外部插件。点击「+ 添加插件」选择 .js 文件，
            或将文件放入 <code>~/.dsc/plugins/</code> 后重启宿主。
          </div>
        )}

        <div className="plugin-group-label">
          官方可开关 <span className="count">{official.length}</span>
          <span className="group-hint">随包发布，按需开关，点击卡片进入详情配置</span>
        </div>
        {official.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpen={setDetailFile} />
        ))}

        <div className="plugin-group-label">
          运行内核 <span className="count">{kernel.length}</span>
          <span className="group-hint">构成 Muse Code 本身，不可停用</span>
        </div>
        {kernelShown.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpen={setDetailFile} />
        ))}
        {kernel.length > KERNEL_PREVIEW && (
          <button className="plugin-more" onClick={() => setKernelOpen((open) => !open)}>
            {kernelOpen ? '收起' : `展开其余 ${kernel.length - KERNEL_PREVIEW} 个`}
          </button>
        )}
      </div>
    </div>
  )
}
