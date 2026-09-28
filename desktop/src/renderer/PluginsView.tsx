/**
 * 插件中心（对照 dsh「插件」页）：三档从上到下——
 * ① 自定义（用户放进 `~/.dsc/plugins/` 的 .js，永远排在最前）
 * ② 官方可开关（随包发布但有开关，例如子智能体团队、电脑操作）
 * ③ 运行内核（内置不可停用；默认只露 3 行，其余折叠，且放在页面最底部）
 * 有设置分区的插件给一个「配置」按钮，点了直接跳到那个分区。
 *
 * @module desktop/renderer/PluginsView
 */
import { useState, type JSX } from 'react'
import type { PluginInfoView } from '@dsc/runtime/contract.js'
import { IconPuzzle, IconRefresh, IconRestart } from './icons.js'

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
  onOpenSettings,
}: {
  plugin: PluginInfoView
  onToggle(file: string, next: boolean): void
  onOpenSettings(sectionId: string): void
}): JSX.Element {
  return (
    <div className={`plugin-row${plugin.enabled ? '' : ' off'}`}>
      <div className="plugin-icon" style={{ background: iconColor(plugin.name) }}>
        {plugin.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="plugin-info" data-tip={plugin.description || plugin.name}>
        <div className="plugin-name">
          {plugin.name}
          {plugin.apiVersion !== undefined && <span className="plugin-apiver">API v{plugin.apiVersion}</span>}
        </div>
        <div className={`plugin-desc${plugin.problem !== undefined ? ' problem' : ''}`}>
          {plugin.problem !== undefined
            ? `⚠ ${plugin.problem}`
            : plugin.description || `${plugin.file} · 无描述（可导出 name / description 提供展示）`}
        </div>
      </div>
      {/* 没打开的插件还没挂上来，它的设计分区也就不存在，此时不给「配置」入口 */}
      {plugin.enabled && plugin.settingsSection !== undefined && (
        <button className="plugin-config" data-tip="打开这个插件的设置项" onClick={() => onOpenSettings(plugin.settingsSection!)}>
          配置
        </button>
      )}
      <button
        className={`switch${plugin.enabled ? ' on' : ''}${plugin.toggleable ? '' : ' locked'}`}
        role="switch"
        aria-checked={plugin.enabled}
        data-tip={plugin.toggleable ? (plugin.enabled ? '停用（即时生效）' : '启用（即时生效）') : '运行内核的一部分，不可停用'}
        onClick={() => onToggle(plugin.file, !plugin.enabled)}
      />
    </div>
  )
}

/** 运行内核默认露几行（其余折叠，这一档本来就少有人翻）。 */
const KERNEL_PREVIEW = 3

export function PluginsView(props: {
  plugins: PluginInfoView[]
  onToggle(file: string, next: boolean): void
  onRefresh(): void
  onInstall(): void
  onRestartHost(): void
  onOpenSettings(sectionId: string): void
}): JSX.Element {
  // ?kernelopen=1 直接展开运行内核那一档（自检截图用，好拍清展开后的样子）
  const [kernelOpen, setKernelOpen] = useState(() => new URLSearchParams(location.search).has('kernelopen'))
  const custom = props.plugins.filter((plugin) => plugin.source === 'external')
  const official = props.plugins.filter((plugin) => plugin.source === 'builtin' && plugin.toggleable)
  const kernel = props.plugins.filter((plugin) => plugin.source === 'builtin' && !plugin.toggleable)
  const kernelShown = kernelOpen ? kernel : kernel.slice(0, KERNEL_PREVIEW)

  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>插件</h1>
            <p>添加和管理插件</p>
          </div>
          <div className="plugins-actions">
            <button className="icon-btn" data-tip="刷新列表" onClick={props.onRefresh}>
              <IconRefresh size={16} />
            </button>
            <button className="icon-btn" data-tip="重启宿主（重新加载目录里的插件文件）" onClick={props.onRestartHost}>
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
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpenSettings={props.onOpenSettings} />
        ))}
        {custom.length === 0 && (
          <div className="plugins-empty">
            还没有安装外部插件。点击「+ 添加插件」选择 .js 文件，
            或把文件放进 <code>~/.dsc/plugins/</code> 后重启宿主。
          </div>
        )}

        <div className="plugin-group-label">
          官方可开关 <span className="count">{official.length}</span>
          <span className="group-hint">随包发布，按需开关；打开后才有「配置」入口</span>
        </div>
        {official.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpenSettings={props.onOpenSettings} />
        ))}

        <div className="plugin-group-label">
          运行内核 <span className="count">{kernel.length}</span>
          <span className="group-hint">构成 dsc 本身，不可停用</span>
        </div>
        {kernelShown.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} onOpenSettings={props.onOpenSettings} />
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
