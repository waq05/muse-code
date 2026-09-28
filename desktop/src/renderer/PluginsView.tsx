/**
 * 插件管理页（对照 dsh「插件」页）：标题区 + 内置分组（只读）+ 已安装分组
 * （开关切换）+ 「+ 添加插件」（系统文件选择器复制到 ~/.dsc/plugins/）。
 * 开关写入 plugins.json，重启宿主后生效。
 *
 * @module desktop/renderer/PluginsView
 */
import type { JSX } from 'react'
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

function PluginRow({ plugin, onToggle }: { plugin: PluginInfoView; onToggle(file: string, next: boolean): void }): JSX.Element {
  return (
    <div className={`plugin-row${plugin.enabled ? '' : ' off'}`}>
      <div className="plugin-icon" style={{ background: iconColor(plugin.name) }}>
        {plugin.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="plugin-info" title={plugin.description || plugin.name}>
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
      <button
        className={`switch${plugin.enabled ? ' on' : ''}${plugin.source === 'builtin' ? ' locked' : ''}`}
        role="switch"
        aria-checked={plugin.enabled}
        title={plugin.source === 'builtin' ? '内置插件不可停用' : plugin.enabled ? '停用（即时生效）' : '启用（即时生效）'}
        onClick={() => onToggle(plugin.file, !plugin.enabled)}
      />
    </div>
  )
}

export function PluginsView(props: {
  plugins: PluginInfoView[]
  notice: string | null
  onToggle(file: string, next: boolean): void
  onRefresh(): void
  onInstall(): void
  onRestartHost(): void
}): JSX.Element {
  const builtin = props.plugins.filter((plugin) => plugin.source === 'builtin')
  const external = props.plugins.filter((plugin) => plugin.source === 'external')

  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>插件</h1>
            <p>添加和管理插件</p>
          </div>
          <div className="plugins-actions">
            <button className="icon-btn" title="刷新列表" onClick={props.onRefresh}>
              <IconRefresh size={16} />
            </button>
            <button className="icon-btn" title="重启宿主（重新加载目录里的插件文件）" onClick={props.onRestartHost}>
              <IconRestart size={16} />
            </button>
            <button className="btn-primary plugins-add" onClick={props.onInstall}>
              + 添加插件
            </button>
          </div>
        </div>

        {props.notice !== null && <div className="notice">{props.notice}</div>}

        <div className="plugin-group-label">
          <IconPuzzle size={13} /> 内置 <span className="count">{builtin.length}</span>
          <span className="group-hint">构成运行内核，不可停用</span>
        </div>
        {builtin.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} />
        ))}

        <div className="plugin-group-label">
          已安装 <span className="count">{external.length}</span>
          <span className="group-hint">~/.dsc/plugins/*.js</span>
        </div>
        {external.map((plugin) => (
          <PluginRow key={plugin.file} plugin={plugin} onToggle={props.onToggle} />
        ))}
        {external.length === 0 && (
          <div className="plugins-empty">
            还没有安装外部插件。点击「+ 添加插件」选择 .js 文件，
            或把文件放进 <code>~/.dsc/plugins/</code> 后重启宿主。
          </div>
        )}
      </div>
    </div>
  )
}
