/**
 * 归档会话管理（设置 → 归档）：按工作区分组列出已归档会话，支持恢复与永久删除。
 *
 * 归档件住在 `~/.dsc/sessions/.archived/<工作区目录>/<uuid>.jsonl`；点「永久删除」
 * 会先弹确认框（components/confirm.ts），确认后把文件移进 `~/.dsc/.trash/`，
 * 保留 30 天后由宿主自动清空，所以这里没有「立刻抹掉」。操作回执走全局 Toast。
 *
 * @module desktop/renderer/ArchivedView
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ArchivedPage, ArchivedSessionView, SettingsMutation } from '@dsc/runtime/contract.js'
import { confirmAction } from './components/confirm.js'
import { toastErr, toastOk } from './components/toast.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { IconArchive, IconRefresh, IconRestart, IconTrash } from './icons.js'

export function ArchivedView(props: { proxy: RuntimeProxy }): JSX.Element {
  const [page, setPage] = useState<ArchivedPage | null>(null)
  const [loadError, setLoadError] = useState('')

  const reload = (): void => {
    void props.proxy
      .listArchivedSessions()
      .then((next) => {
        setPage(next)
        setLoadError('')
      })
      .catch((error: unknown) => setLoadError(text(error)))
  }
  useEffect(reload, [])

  /** 执行一次归档区操作，成功 Toast 回执并重取列表（文件已被挪走）。 */
  const write = (task: Promise<SettingsMutation>, fallbackNotice: string): void => {
    void task
      .then((result) => {
        if (!result.ok) {
          toastErr(`操作失败：${result.error}`)
          return
        }
        toastOk(result.notice ?? fallbackNotice)
        reload()
      })
      .catch((error: unknown) => toastErr(`操作失败：${text(error)}`))
  }

  const groups = useMemo(() => groupByWorkspace(page?.items ?? []), [page])

  if (page === null) {
    return <div className="settings-empty">{loadError === '' ? '正在读取归档会话…' : `读取失败：${loadError}`}</div>
  }

  return (
    <div className="settings-fields archived">
      <div className="arch-head">
        <span>
          已归档会话 <span className="count">{page.items.length}</span> 个
        </span>
        <button className="btn-ghost" data-tip="重新读取归档区" onClick={reload}>
          <IconRefresh size={14} /> 刷新
        </button>
      </div>

      {page.items.length === 0 && (
        <div className="settings-empty">
          归档区是空的。在侧栏会话行点击归档按钮可归档单个会话，或在工作区行点击归档按钮归档整组会话。
        </div>
      )}

      {groups.map((group) => (
        <div className="arch-group" key={group.cwd}>
          <div className="arch-group-head">
            <IconArchive size={14} />
            <span className="dir" data-tip={group.cwd}>
              {lastSegment(group.cwd)}
            </span>
            <span className="count">{group.items.length}</span>
            <button
              className="text-btn"
              data-tip={`恢复这个工作区里的 ${group.items.length} 个会话`}
              onClick={() =>
                write(
                  props.proxy.restoreSessions(group.items.map((item) => item.path)),
                  `已恢复这个工作区的 ${group.items.length} 个会话`,
                )
              }
            >
              <IconRestart size={13} /> 全部恢复
            </button>
          </div>
          {group.items.map((item) => (
            <div className="arch-row" key={item.path} data-tip={item.path}>
              <span className="title">{item.title ?? '未命名会话'}</span>
              <span className="when" data-tip={`${new Date(item.archivedAt).toLocaleString()} 归档`}>
                归档于 {ago(item.archivedAt)}
              </span>
              <span className="arch-actions">
                <button
                  className="text-btn"
                  data-tip="放回会话列表，回到原工作区"
                  onClick={() => write(props.proxy.restoreSessions([item.path]), '已恢复到会话列表')}
                >
                  <IconRestart size={13} /> 恢复
                </button>
                {/* 不可逆操作先弹确认框说清后果，点了确认才移进回收站（主按钮走红色危险档）。 */}
                <button
                  className="text-btn danger"
                  data-tip="移进回收站，30 天后自动清空"
                  onClick={() => {
                    const trash = page.trashDir
                    void confirmAction({
                      title: `永久删除会话「${item.title ?? '未命名会话'}」？`,
                      detail: `会将其从归档区移入回收站 ${trash}，回收站文件保留 30 天后自动清空，此后无法找回。`,
                      confirmLabel: '永久删除',
                      danger: true,
                    }).then((yes) => {
                      if (yes) write(props.proxy.purgeSessions([item.path]), '已移入回收站')
                    })
                  }}
                >
                  <IconTrash size={13} /> 永久删除
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}

      <div className="arch-foot">
        <span>
          「永久删除」先把文件移进回收站 <span className="mono">{page.trashDir}</span>，保留 30 天后自动清空，
          现在里面有 {page.trashCount} 个文件。
        </span>
        <button
          className="text-btn"
          data-tip="在文件管理器里打开回收站"
          onClick={() => {
            void dsc.openPath(page.trashDir).then((problem) => {
              if (problem !== '') toastErr(`打开失败：${problem}`)
            })
          }}
        >
          打开回收站目录
        </button>
      </div>
    </div>
  )
}

/** 按工作区分组：组内按归档时间倒序，组之间按各自最新的归档时间倒序。 */
function groupByWorkspace(items: ArchivedSessionView[]): Array<{ cwd: string; items: ArchivedSessionView[] }> {
  const map = new Map<string, ArchivedSessionView[]>()
  for (const item of items) {
    const list = map.get(item.cwd) ?? []
    list.push(item)
    map.set(item.cwd, list)
  }
  return [...map.entries()]
    .map(([cwd, list]) => ({ cwd, items: [...list].sort((a, b) => b.archivedAt - a.archivedAt) }))
    .sort((a, b) => (b.items[0]?.archivedAt ?? 0) - (a.items[0]?.archivedAt ?? 0))
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function ago(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
