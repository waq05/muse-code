/**
 * 审批与授权审计：每一次「要不要放行」的决定落一行 JSON 到 `~/.dsc/audit.jsonl`。
 *
 * 为什么要成对：DSH 的做法是 `approval/asked` 与 `approval/decided` 必须在同一个 turn 内配平
 * （`packages/interaction/user-approval/src/index.ts:215-234`），Hermes 则是所有自动放行都打
 * 固定前缀行（`AUTO-APPROVED …`、`Smart approval: auto-approved …`）。
 * dsc 取两者折中：一次决定一行，但 `asked` 与 `decided` 用同一个 `id` 串起来，
 * 出事之后能回答「谁在什么时候放行了哪条命令」。
 *
 * @module dsc/core/audit
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 审计文件（跟 config.yaml 同级）。 */
export const AUDIT_FILE = join(homedir(), '.dsc', 'audit.jsonl')

/** 审计事件种类。 */
export type AuditKind =
  /** 弹了卡并等到用户答案。 */
  | 'approval'
  /** 没弹卡直接放行（权限模式或规则允许）。 */
  | 'auto-allow'
  /** 没弹卡直接拒（硬地板、探索模式、无人在场）。 */
  | 'auto-deny'
  /** 权限模式或协作模式被切换。 */
  | 'mode-change'
  /** 往规则文件里加了永久规则。 */
  | 'rule-added'
  /** 目标文件被路径护栏拦住。 */
  | 'path-block'
  /** 输出里遮掉了密钥形状的内容。 */
  | 'redact'
  /** 安全钩子说话：命中规则、脚本给出结论、或脚本没跑成按拦处理。 */
  | 'hook'

/** 一行审计记录。 */
export interface AuditRecord {
  /** 毫秒时间戳（ISO 文本由 UI 自己格式化）。 */
  ts: number
  kind: AuditKind
  /** 关联 id：asked 与 decided 共用一个，用来配对。 */
  id?: string
  /** 阶段：asked = 问出口，decided = 有答案。 */
  phase?: 'asked' | 'decided' | 'cancelled' | 'timeout'
  tool?: string
  /** 命令或目标摘要（已经过遮红，绝不放原始密钥）。 */
  summary?: string
  decision?: 'allow-once' | 'allow-session' | 'allow-always' | 'reject' | 'timeout' | 'cancelled' | 'blocked'
  /** 授权范围（session 档按会话键控，不跨会话生效）。 */
  scope?: 'once' | 'session' | 'always'
  reason?: string
  /** 当时的权限模式与协作模式，回放时能还原现场。 */
  policy?: string
  mode?: string
  sessionId?: string
  /** 命中或新增的规则前缀（`git diff` 这种）。 */
  rule?: string[]
  /** 会话工作目录。 */
  cwd?: string
  /**
   * 这个答案是从哪儿点下来的：`'app'` = 宿主自己的界面（桌面端 / 终端），
   * `'web'` = 手机浏览器（远程控制）。
   * 只有「真的有人答了」的 decided 记录才带它；超时与打断没人答，写这栏没有意义。
   */
  source?: 'app' | 'web'
}

let enabled = true

/** 自检脚本会临时关掉落盘（避免测试写脏用户的审计文件）。 */
export function setAuditEnabled(value: boolean): void {
  enabled = value
}

/**
 * 追加一行审计记录。
 *
 * 写失败一律吞掉：审计是辅助面，绝不能因为磁盘问题把用户的工具调用卡住。
 */
export function audit(record: AuditRecord): void {
  if (!enabled) return
  try {
    if (!existsSync(dirname(AUDIT_FILE))) mkdirSync(dirname(AUDIT_FILE), { recursive: true })
    appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    enabled = false // 连续写不进去就别再试了，省得每条工具调用都撞一次磁盘
  }
}

/** 读最近 N 行审计记录（倒序，最新在前）；文件不存在返回空数组。 */
export function readAudit(limit = 200): AuditRecord[] {
  if (!existsSync(AUDIT_FILE)) return []
  const size = statSync(AUDIT_FILE).size
  const text = readFileSync(AUDIT_FILE, 'utf8')
  // 只看文件尾部：审计文件会一直长，超过 512KB 的前面部分没意义。
  const cap = 512 * 1024
  const tail = size > cap ? text.slice(text.length - cap) : text
  const lines = tail.split(/\r?\n/).filter((line) => line !== '')
  const records: AuditRecord[] = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as AuditRecord)
    } catch {
      // 半行（写到一半断电）直接跳过，不影响其余记录
    }
  }
  return records.reverse().slice(0, limit)
}
