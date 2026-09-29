/**
 * 顶层界面：快照订阅（useSyncExternalStore）+ 键盘路由（审批/选择器/Ctrl+C/ctrl+t）。
 *
 * 键盘优先级：Ctrl+C（打断/退出）→ 审批卡（y/n）→ 会话选择器 → ctrl+t → 其余交给
 * Composer。审批或选择器打开时 Composer 置 disabled，不再吃键。
 *
 * @module dsc-tui/app/App
 */
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from 'ink'
import type { JSX } from 'react'
import type { DscRuntime } from '../contract.js'
import { runCommand } from '../plugins/commands.js'
import { ApprovalCard } from './ApprovalCard.js'
import { ChatView } from './ChatView.js'
import { Composer } from './Composer.js'
import { SessionPicker } from './SessionPicker.js'
import { StatusBar } from './StatusBar.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 双击 Ctrl+C 的判定窗口。 */
const EXIT_WINDOW_MS = 2000

export function App({ runtime }: { runtime: DscRuntime }): JSX.Element {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const [picker, setPicker] = useState(false)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [expandThinking, setExpandThinking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  /** 可切换模型列表：进程内静态，取一次即可。 */
  const models = useMemo(() => runtime.listModels(), [runtime])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastCtrlC.current < EXIT_WINDOW_MS) {
        runtime.exit()
        return
      }
      lastCtrlC.current = now
      if (snapshot.status.turnState !== 'idle') runtime.interrupt()
      else setNotice('再按一次 Ctrl+C 退出')
      return
    }
    if (snapshot.surfaces.pendingApproval !== null) {
      if (input === 'y' || input === 'Y') runtime.answerApproval('allow-once')
      else if (input === 'n' || input === 'N' || key.escape) runtime.answerApproval('reject')
      return
    }
    if (picker) {
      if (key.escape) setPicker(false)
      else if (key.return) {
        const session = snapshot.sessions[pickerIndex]
        setPicker(false)
        if (session !== undefined) void runtime.openSession(session.id)
      } else if (key.upArrow) setPickerIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow)
        setPickerIndex((current) => Math.min(snapshot.sessions.length - 1, current + 1))
      return
    }
    if (key.ctrl && input === 't') {
      setExpandThinking((current) => !current)
      return
    }
  })

  const handleSubmit = (text: string): void => {
    setNotice(null)
    if (text.startsWith('/')) {
      runCommand(text, runtime, {
        openPicker: () => {
          setPicker(true)
          setPickerIndex(0)
          void runtime.refreshSessions()
        },
        notice: setNotice,
      })
      return
    }
    runtime.submit(text)
  }

  const modal = snapshot.surfaces.pendingApproval !== null || picker

  return (
    <Box flexDirection="column" width="100%" gap={GAP.none}>
      <ChatView
        entries={snapshot.entries}
        turnState={snapshot.status.turnState}
        expandThinking={expandThinking}
      />
      {snapshot.surfaces.pendingApproval !== null ? (
        <ApprovalCard request={snapshot.surfaces.pendingApproval} />
      ) : null}
      {notice !== null ? (
        <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} marginTop={GAP.tight}>
          <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
            {notice}
          </Text>
        </Box>
      ) : null}
      {picker ? (
        <SessionPicker
          sessions={snapshot.sessions}
          loading={snapshot.sessionsLoading}
          index={pickerIndex}
          onIndex={setPickerIndex}
        />
      ) : (
        <Composer disabled={modal} models={models} onSubmit={handleSubmit} />
      )}
      <StatusBar status={snapshot.status} />
    </Box>
  )
}
