/**
 * 远程控制的数据文件：`~/.dsc/remote/` 下的几份 JSON。
 *
 *   pending.json     还没被用掉的配对码（只存盐与哈希，明文码永不落盘）
 *   devices.json     已配对设备的 token 哈希、名字与时间
 *   .owner.json      主控位：哪个进程在伺服（pid + 启动指纹 + 端口）
 *   push-keys.json   Web Push 的 VAPID 密钥对（公钥给浏览器订阅，私钥只在本机）
 *   push-subs.json   浏览器推送订阅（endpoint + 密钥 + 哪台设备）
 *
 * 写盘一律「先写同目录临时文件再 rename」：进程正好在写的那一刻挂掉时，
 * 读到的只可能是旧文件，不会是半个 JSON。
 *
 * @module dsc/core/remote/store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dscPath } from '../path-policy.js'

/** 远程控制的数据目录。 */
export const REMOTE_DIR = dscPath('remote')

/** 几份文件的位置；`dir` 只在自检脚本里换（默认就是 `~/.dsc/remote`）。 */
export interface RemoteFiles {
  dir: string
  pending: string
  devices: string
  owner: string
  pushKeys: string
  pushSubs: string
}

export function remoteFiles(dir: string = REMOTE_DIR): RemoteFiles {
  return {
    dir,
    pending: join(dir, 'pending.json'),
    devices: join(dir, 'devices.json'),
    owner: join(dir, '.owner.json'),
    pushKeys: join(dir, 'push-keys.json'),
    pushSubs: join(dir, 'push-subs.json'),
  }
}

/** 读一份 JSON；文件不在、读不动、内容不是对象时一律给 null（调用方按「空」处理）。 */
export function readJsonFile(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 原子写一份 JSON（临时文件 + rename）。 */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 删一份文件（不在了就当成功，删不掉也不抛）。 */
export function removeFile(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // 已经被人删掉了 / 权限不对：下一个进程会按「主人已死」接管，不碍事
  }
}
