/**
 * 跨进程文件锁：`O_EXCL` 独占创建锁文件 + 锁内记 `pid + 进程指纹`，主人死了就接管。
 *
 * 用在哪：会话 jsonl 的写租约（两个 Muse Code 进程同开一个工作区，绝不能往同一份
 * 对话日志里交错 append）与 meta.json 的读改写。调度器的 `.lock`（schedule/runner.ts）
 * 是同一套思路的另一个实现——那边是长持有 + 只读降级，这边提供「短临界区」与「长租约」
 * 两种姿势。个人版单机语义：不跨用户、不跨机器。
 *
 * 同一进程内可重入（计数持有）：会话恢复链路上「load 新会话时旧会话还握着同一把锁」
 * 是真实场景（同进程重复打开同一个会话），没有重入计数就是自己锁死自己。
 *
 * @module dsc/core/lockfile
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 锁文件内容：pid 是持有者，birth 是进程启动指纹（光靠 pid 会被回收复用骗过去）。 */
interface LockContents {
  pid: number
  birth: number
  at: number
}

/** 本进程的启动指纹（模块加载时定死，进程内恒定）。 */
const BIRTH = Math.round(Date.now() - process.uptime() * 1000)

/** 本进程当前握着的锁（锁路径 → 重入计数）。 */
const held = new Map<string, number>()

/** 锁文件后缀：追加在目标路径后面（`foo.jsonl` → `foo.jsonl.lock`）。 */
export const LOCK_SUFFIX = '.lock'

/** 一把握在手里的锁：长期持有的写租约用它自己调 `release()` 还锁。 */
export interface FileLock {
  release(): void
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 拿一把长期持有的锁（写租约）。拿不到（别的进程活着握着）返回 null；主人已死或
 * 锁文件读不出来（半截 JSON）就清掉陈锁接管。拿到的人负责调 `release()`，进程
 * 崩溃留下的陈锁由下一个来的人按「主人已死」接管。
 */
export function acquireLock(target: string): FileLock | null {
  const path = `${target}${LOCK_SUFFIX}`
  const reentered = held.get(path)
  if (reentered !== undefined) {
    held.set(path, reentered + 1)
    return { release: () => dropLock(path) }
  }
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, birth: BIRTH, at: Date.now() } satisfies LockContents), {
        flag: 'wx',
      })
      held.set(path, 1)
      return { release: () => dropLock(path) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null // 目录不可写等：按拿不到锁处理
    }
    // 锁已被占：主人活着就认输；死了（或锁读不出来）就清掉再抢一次
    let stale = true
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockContents>
      if (typeof info.pid === 'number' && isProcessAlive(info.pid)) stale = false
    } catch {
      // 半截 JSON 按陈锁处理
    }
    if (!stale) return null
    try {
      unlinkSync(path)
    } catch {
      return null // 抢手速没抢过对方（对方刚重建了锁）：认输
    }
  }
  return null
}

/** 归还一次重入；计数归零才真放锁。 */
function dropLock(path: string): void {
  const count = held.get(path)
  if (count === undefined) return
  if (count > 1) {
    held.set(path, count - 1)
    return
  }
  held.delete(path)
  try {
    unlinkSync(path)
  } catch {
    // 删不掉就算了：下一任按「主人已死」接管
  }
}

/**
 * 短临界区：拿锁 → 跑 → 还锁；拿不到就抛 `busy` 给出的错误。
 * 只包同步代码——跨进程的文件移动与读改写都是同步的，这正是它的服务对象。
 */
export function withExclusiveLock<T>(target: string, busy: string, fn: () => T): T {
  const lock = acquireLock(target)
  if (lock === null) throw new Error(busy)
  try {
    return fn()
  } finally {
    lock.release()
  }
}
