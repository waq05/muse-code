/**
 * 远程控制的主控位：同一台机器上可能有不止一个 Muse Code 进程（桌面端一个、终端一个），
 * 而一个端口只能被一个进程听。谁先拿到 `~/.dsc/remote/.owner.json` 谁负责伺服，
 * 其余的进程保持休眠（不监听、不起服务），每 30 秒回头看一眼主控位空出来没有。
 *
 * 判据与调度锁同款：`pid + 进程启动时刻指纹`。只看 pid 会被系统回收骗过去——
 * 前任进程死了、pid 被一个无关进程占了，我们就会一直让位；加上启动指纹就不会。
 *
 * @module dsc/core/remote/owner
 */
import { isProcessAlive } from '../schedule/runner.js'
import { readJsonFile, remoteFiles, removeFile, writeJsonFile, type RemoteFiles } from './store.js'

/** `.owner.json` 的内容。 */
export interface OwnerInfo {
  pid: number
  /** 本进程启动时的墙钟时刻（`now - uptime`），锁的主人是不是「原来那个进程」靠它分辨。 */
  birth: number
  /** 主人正在听的端口（休眠方只用来显示「谁占着、在哪个口」）。 */
  port: number
  /** 最后一次抢/刷主控位的时刻。 */
  at: number
}

export class RemoteOwnerLock {
  private readonly files: RemoteFiles
  private readonly now: () => number
  private readonly birth: number
  private held = false

  constructor(options: { dir?: string; now?: () => number } = {}) {
    this.files = remoteFiles(options.dir)
    this.now = options.now ?? (() => Date.now())
    this.birth = Math.round(this.now() - process.uptime() * 1_000)
  }

  /** 本进程现在握着主控位吗。 */
  get mine(): boolean {
    return this.held
  }

  /** 看一眼主控位被谁拿着（没有返回 null）。 */
  peek(): OwnerInfo | null {
    const doc = readJsonFile(this.files.owner)
    if (doc === null) return null
    if (typeof doc['pid'] !== 'number' || typeof doc['birth'] !== 'number') return null
    return {
      pid: Math.round(doc['pid']),
      birth: Math.round(doc['birth']),
      port: typeof doc['port'] === 'number' ? Math.round(doc['port']) : 0,
      at: typeof doc['at'] === 'number' ? doc['at'] : 0,
    }
  }

  /**
   * 抢主控位。
   * @returns true = 现在归本进程（可以起服务了）；false = 别的活进程拿着，本进程休眠
   */
  tryAcquire(port: number): boolean {
    const info = this.peek()
    if (info === null) {
      this.write(port)
      return true
    }
    if (info.pid === process.pid && info.birth === this.birth) {
      // 本来就是自己的（可能是同一进程里第二次起服务）：刷新端口
      this.write(port)
      return true
    }
    if (isProcessAlive(info.pid)) {
      this.held = false
      return false
    }
    // 前任已经不在（或 pid 被复用了）：接管
    this.write(port)
    return true
  }

  /** 让出主控位（只删自己的那份；别人的文件一个字节都不动）。 */
  release(): void {
    const info = this.peek()
    if (info !== null && info.pid === process.pid && info.birth === this.birth) removeFile(this.files.owner)
    this.held = false
  }

  private write(port: number): void {
    writeJsonFile(this.files.owner, { pid: process.pid, birth: this.birth, port, at: this.now() })
    this.held = true
  }
}
