/**
 * headless 宿主入口解析：dev 用源仓库编译产物（../lib/headless.js，模块解析
 * 直接走 D:\dsc\node_modules）；打包后用 extraResources 携带的 dsc-core 副本
 * （process.resourcesPath/dsc-core/lib/headless.js，由 scripts/prepare-runtime.mjs 组装）。
 *
 * @module desktop/main/dsc-core
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function resolveHeadlessEntry(): string {
  // CJS shim（bin/headless.cjs）：utilityProcess 只加载 CJS，shim 同步保活并
  // 动态 import ESM 产物 lib/headless.js
  const packaged = join(process.resourcesPath, 'dsc-core', 'bin', 'headless.cjs')
  if (app.isPackaged) {
    if (!existsSync(packaged)) throw new Error(`打包产物缺少宿主入口：${packaged}`)
    return packaged
  }
  // dev：__dirname = desktop/out/main → 上三级是 dsc 根；cwd 兜底（electron-vite dev 与
  // 直接 electron out/main/index.js 的工作目录都是 desktop/）
  const candidates = [
    join(__dirname, '..', '..', '..', 'bin', 'headless.cjs'),
    join(process.cwd(), '..', 'bin', 'headless.cjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`未找到 Muse Code 宿主入口（${candidates.join(' 或 ')}）；先在项目根目录运行 pnpm build`)
}

/** 工作目录记忆文件（~/.dsc/desktop.json）。 */
export interface DesktopState {
  lastCwd?: string
  /** 最近用过的工作目录，最新的排最前（侧栏切换工作区菜单的数据源）。 */
  recentCwds?: string[]
  /** 缩到托盘的那次气泡提示是否已经弹过（只弹一次）。 */
  trayHintShown?: boolean
  /** 窗口大小/位置记忆：关窗与退出时由主进程落盘，下次开窗恢复。 */
  windowBounds?: { width: number; height: number; x: number; y: number; maximized: boolean }
}

export function statePath(): string {
  return join(app.getPath('home'), '.dsc', 'desktop.json')
}

export function readState(): DesktopState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as DesktopState
  } catch {
    return {}
  }
}

/**
 * 合并写：先读旧文件再覆盖给定的字段。各处调用只传自己要改的字段，
 * 全量覆盖会把别人写的字段抹掉（换工作目录曾抹掉 trayHintShown）。
 */
export function writeState(patch: DesktopState): void {
  try {
    mkdirSync(join(app.getPath('home'), '.dsc'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2))
  } catch {
    // 记忆失败不致命
  }
}
