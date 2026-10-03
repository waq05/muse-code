/**
 * 智能体团队：会话标题旁的两颗入口 + 它们共用的名册行。
 *
 *   - 「N 个子智能体」下拉：只看**本会话**派出的队友（数量为 0 时整颗不渲染）；
 *   - 「智能体团队」面板：同样以**本会话**的队伍为主（对照 dsh——团队挂在 lead 会话之下，
 *     切会话就是另一支队伍）；别的会话派出的队友收进底部折叠组，只读列出。
 *
 * 为什么从侧栏搬过来：dsh 把这两件事都放在会话区标题旁边，侧栏那一档因此撤掉。
 * 原来「队友」tab 的三件能力在这里原地复刻：点一行进只读运行记录、working/stopped 的行
 * 可以停、任何一行都能发一句话。停止与发话的回执都就地显示（失败原因是宿主的原话）。
 *
 * 诚实边界：
 *   - 运行记录是只读的（点开的是 TeammatePeek，那里不给发言口）；
 *   - 「停止」是尽力而为——宿主只能拦下还肯收手的队友，已经自己跑完的它改不了结果，
 *     接口回执原样显示，界面不替宿主打包票；
 *   - 其它会话的行不给停止与发话（管活请切回派出它的那个会话），但收工的可以
 *     从这里移除——名册清理不必千里迢迢切回去；运行记录文件随移除一并删除。
 *
 * @module desktop/renderer/TeamPanel
 */
import { useEffect, useState, type JSX } from 'react'
import type { TeammateView } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { confirmAction } from './components/confirm.js'
import { IconChevronDown, IconClose } from './icons.js'
import { formatDuration } from './turn-timing.js'

/** 状态 → 中文标签（只读视图与名册行共用一张表）。 */
export const TEAMMATE_STATE_LABEL: Record<TeammateView['state'], string> = {
  working: '运行中',
  idle: '已完成',
  stopped: '已停止',
  failed: '已失败',
}

/**
 * 某一个会话派出的队友：标题旁那颗数字与下拉内容都按它算。
 *
 * 老名册记录没有 `sessionId`（宿主按契约给的是可选字段），它们不归任何会话——宁可不显示，
 * 也不拿「当前会话」冒充它的出生会话。
 */
export function matesOf(mates: readonly TeammateView[], sessionId: string | null): TeammateView[] {
  if (sessionId === null || sessionId === '') return []
  return mates.filter((mate) => mate.sessionId === sessionId)
}

/** 失败原因的统一口径：宿主抛出来的 Error 用 message，别的原样转字符串。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 名册的一行：状态点 / 名称 / 角色 / 任务截短 / 第 N 轮 / 用时，行尾挂停止与发话。
 *
 * 点击整行 = 打开它的运行记录（只读）；停止与发话按钮各自 stopPropagation，不会跟着跳走。
 * working 的「已进行时长」每秒跳一次；其余状态显示总耗时（拿不到起止时刻就不画这一格）。
 */
export function TeamMateRow(props: {
  mate: TeammateView
  /** 正在看它的运行记录：高亮这一行。 */
  active: boolean
  /** 团队面板里多认一列「哪来的」；下拉里不需要（本来就是本会话的）。 */
  currentSessionId: string | null
  compact: boolean
  /**
   * false = 只读行（其它会话派出的队友）：不给停止与发话——管它请切回派出它的
   * 那个会话；点开运行记录不受影响。缺省 true。
   */
  managed?: boolean
  proxy: RuntimeProxy
  onPeek(mate: TeammateView): void
  /** 停止 / 发话之后请外面重读一次名册。 */
  onChanged(): void
}): JSX.Element {
  const { mate } = props
  const manageable = props.managed !== false
  /** 就地回执：宿主返回的那句话，或失败原因。 */
  const [note, setNote] = useState('')
  const [noteBad, setNoteBad] = useState(false)
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 只有跑动中的队友需要节拍器；收工的行显示的就是总耗时，不会变。
  useEffect(() => {
    if (mate.state !== 'working') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [mate.state])

  const startedAt = Number.isFinite(mate.startedAt) && mate.startedAt > 0 ? mate.startedAt : null
  const endedAt = mate.finishedAt ?? (mate.state === 'working' ? now : null)
  const used =
    startedAt === null || endedAt === null ? null : formatDuration(Math.max(0, endedAt - startedAt))

  const stop = (): void => {
    void confirmAction({
      title: `停掉队友「${mate.name}」？`,
      detail:
        '它会停在这一步：已经写进运行记录的内容一个字不删，但它不再往下干。要是它已经自己收工，这次停止不会改变结果（尽力而为）。',
      confirmLabel: '停止',
    }).then((yes) => {
      if (!yes) return
      setBusy(true)
      setNote('')
      void props.proxy
        .stopTeammate(mate.name)
        .then(
          (text) => {
            setNoteBad(false)
            setNote(text)
            props.onChanged()
          },
          (error: unknown) => {
            setNoteBad(true)
            setNote(reasonOf(error))
          },
        )
        .finally(() => setBusy(false))
    })
  }

  const send = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    setNote('')
    void props.proxy
      .messageTeammate(mate.name, text)
      .then(
        (reply) => {
          setNoteBad(false)
          setNote(reply)
          setDraft('')
          setWriting(false)
          props.onChanged()
        },
        (error: unknown) => {
          setNoteBad(true)
          setNote(reasonOf(error))
        },
      )
      .finally(() => setBusy(false))
  }

  /** 从名册移除（只对收工的队友开放）：名册记录与运行记录文件一并清掉，名字随之释放。 */
  const removeSelf = (): void => {
    void confirmAction({
      title: `移除队友「${mate.name}」？`,
      detail:
        '会把它从名册摘掉，运行记录文件一并删除（这个操作不进回收站）；名字随之释放，之后派出的新队友可以再叫这个名字。还在干活的队友要先停止才能移除。',
      confirmLabel: '移除',
      danger: true,
    }).then((yes) => {
      if (!yes) return
      setBusy(true)
      setNote('')
      void props.proxy
        .removeTeammate(mate.name)
        .then(
          (text) => {
            setNoteBad(false)
            setNote(text)
            props.onChanged()
          },
          (error: unknown) => {
            setNoteBad(true)
            setNote(reasonOf(error))
          },
        )
        .finally(() => setBusy(false))
    })
  }

  // 「哪来的」：本会话派出的标「本会话」，别的会话只给一段短 id（完整 id 进悬浮提示），
  // 老记录没有出生会话就整格不画。
  const sessionTag =
    mate.sessionId === undefined
      ? null
      : mate.sessionId === props.currentSessionId
        ? { text: '本会话', tip: '这个队友是你的当前会话派出的' }
        : { text: mate.sessionId.slice(0, 8), tip: `出自会话 ${mate.sessionId}` }

  return (
    <div
      className={`team-row${props.active ? ' on' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={`任务：${mate.task}`}
      onClick={() => props.onPeek(mate)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onPeek(mate)
        }
      }}
    >
      <span className={`tm-dot ${mate.state}`} />
      <span className="tm-name">{mate.name}</span>
      <span className="tm-role">{mate.role}</span>
      <span className="team-task">{mate.task}</span>
      {!props.compact && sessionTag !== null && (
        <span className="team-origin" data-tip={sessionTag.tip}>
          {sessionTag.text}
        </span>
      )}
      <span className="team-round">第 {mate.rounds} 轮</span>
      <span
        className="tm-time"
        data-tip={mate.state === 'working' ? '已经跑了多久（每秒刷新）' : '从派活到收工的总耗时'}
      >
        {used ?? ''}
      </span>
      <span className="tm-state">{TEAMMATE_STATE_LABEL[mate.state]}</span>
      {/* 行尾动作：停止只对还在干活的（已停止的再点停止是空话）；移除对所有收工的开放——
          包括其它会话派出的（这正是清名册的入口），正在干活的先停止。 */}
      {(manageable || mate.state !== 'working') && (
        <span className="team-acts">
          {manageable && mate.state === 'working' && (
            <button
              className="text-btn danger"
              disabled={busy}
              data-tip="停掉这个队友（尽力而为，已跑完的改不了结果）"
              onClick={(event) => {
                event.stopPropagation()
                stop()
              }}
            >
              停止
            </button>
          )}
          {manageable && (
            <button
              className="text-btn"
              aria-pressed={writing}
              disabled={busy}
              data-tip="给这个队友发一句话（走宿主转发）"
              onClick={(event) => {
                event.stopPropagation()
                setWriting((current) => !current)
              }}
            >
              发话
            </button>
          )}
          {mate.state !== 'working' && (
            <button
              className="text-btn danger"
              disabled={busy}
              data-tip="从名册移除，运行记录一并删除（不进回收站）"
              onClick={(event) => {
                event.stopPropagation()
                removeSelf()
              }}
            >
              移除
            </button>
          )}
        </span>
      )}
      {/* 回执与输入口各占整行：行首那几格在窄面板里也不用为了它们让位 */}
      {(writing || note !== '') && (
        <span className="team-side" onClick={(event) => event.stopPropagation()}>
          {writing && (
            <span className="team-write">
              <input
                autoFocus
                value={draft}
                placeholder={`发给 ${mate.name} 的一句话`}
                aria-label={`发给队友 ${mate.name} 的话`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // 这一行的 Enter 是「看运行记录」，别让输入框里的回车把它带起来
                  event.stopPropagation()
                  if (event.key === 'Enter') send()
                  if (event.key === 'Escape') setWriting(false)
                }}
              />
              <button className="text-btn" disabled={busy || draft.trim() === ''} onClick={send}>
                发送
              </button>
            </span>
          )}
          {note !== '' && (
            <span className={`team-note${noteBad ? ' bad' : ''}`} role="status">
              {note}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * 会话标题旁的「N 个子智能体」下拉：本会话派出的队友，一行一个。
 *
 * 数量为 0 时调用方整颗不渲染（没有子智能体就不占标题旁的位置）。
 */
export function SubagentMenu(props: {
  mates: TeammateView[]
  currentSessionId: string | null
  open: boolean
  onToggle(): void
  proxy: RuntimeProxy
  peekFile: string | null
  onPeek(mate: TeammateView): void
  onChanged(): void
}): JSX.Element {
  return (
    <div className="sub-open">
      <button
        className={`sub-btn${props.open ? ' on' : ''}`}
        aria-expanded={props.open}
        data-tip="本会话派出的子智能体：状态、耗时，点一行看运行记录"
        onClick={props.onToggle}
      >
        {props.mates.length} 个子智能体
        <IconChevronDown size={13} />
      </button>
      {props.open && (
        <>
          <div className="menu-backdrop" onClick={props.onToggle} />
          {/* 渲染表沿用侧栏的 .row-menu（弹层底色 + 发丝边 + shadow-md），只改挂点 */}
          <div className="row-menu sub-menu" role="menu" aria-label="本会话的子智能体">
            {props.mates.map((mate) => (
              <TeamMateRow
                key={mate.file}
                mate={mate}
                active={props.peekFile === mate.file}
                currentSessionId={props.currentSessionId}
                compact
                proxy={props.proxy}
                onPeek={props.onPeek}
                onChanged={props.onChanged}
              />
            ))}
            <p className="team-hint">
              点一行看它的运行记录（只读）；「停止」是尽力而为，「发话」由宿主转交，收工的可以移除。
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 「智能体团队」面板：本会话的队伍（对照 dsh 团队挂在 lead 会话之下——切会话
 * 就是另一支队伍）；其它会话派出的队友收进底部折叠组，只读。
 *
 * 层级照设置面板那一档（.settings-mask + .settings），Esc 与点遮罩都关。
 */
export function TeamPanel(props: {
  mates: TeammateView[]
  currentSessionId: string | null
  proxy: RuntimeProxy
  peekFile: string | null
  onClose(): void
  onPeek(mate: TeammateView): void
  onChanged(): void
}): JSX.Element {
  // 本会话的队伍在前；其它会话（含没有出生会话记录的老名册行）收进折叠组
  const mine = matesOf(props.mates, props.currentSessionId)
  const others = props.mates.filter((mate) => !mine.includes(mate))
  const [othersOpen, setOthersOpen] = useState(false)

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="settings team-panel" role="dialog" aria-modal="true" aria-label="智能体团队">
        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>智能体团队</h2>
              <p>这里是本会话派出的队伍，切到别的会话就是另一支；其它会话的队友在底部列出，可点开记录或移除。</p>
            </div>
            <button className="icon-btn" autoFocus data-tip="关闭，快捷键 Esc" onClick={props.onClose}>
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-body">
            {mine.length === 0 ? (
              <div className="settings-empty">
                本会话还没有队友：「子智能体」插件开着时，模型用 subagent 工具派活，会在这里出现。
              </div>
            ) : (
              <div className="team-list">
                {mine.map((mate) => (
                  <TeamMateRow
                    key={mate.file}
                    mate={mate}
                    active={props.peekFile === mate.file}
                    currentSessionId={props.currentSessionId}
                    compact={false}
                    proxy={props.proxy}
                    onPeek={props.onPeek}
                    onChanged={props.onChanged}
                  />
                ))}
              </div>
            )}
            {others.length > 0 && (
              <>
                <button
                  className="team-others-toggle"
                  aria-expanded={othersOpen}
                  onClick={() => setOthersOpen((open) => !open)}
                >
                  <IconChevronDown size={13} />
                  其它会话的队友（{others.length}）
                </button>
                {othersOpen && (
                  <div className="team-list team-others">
                    {others.map((mate) => (
                      <TeamMateRow
                        key={mate.file}
                        mate={mate}
                        active={props.peekFile === mate.file}
                        currentSessionId={props.currentSessionId}
                        compact={false}
                        managed={false}
                        proxy={props.proxy}
                        onPeek={props.onPeek}
                        onChanged={props.onChanged}
                      />
                    ))}
                    <p className="team-hint">
                      这些队友是别的会话（或更早的版本）派出的：点一行看运行记录，收工的可以移除；
                      正在干活的请切回派出它的会话再管。
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
