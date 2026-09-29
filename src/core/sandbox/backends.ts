/**
 * 沙箱的后端探测与容器执行器：决定 `enforcement` 到底是 full 还是 partial。
 *
 * 为什么分「策略后端」与「容器后端」两档，而不是像 dsh 那样 fail-closed：
 * 进程内的策略围栏（路径白名单 + 命令规则）拦得住 dsc 自己发起的工具调用，
 * 但拦不住命令内部的任意写（`node build.js` 里那行 fs.writeFile）。
 * 真隔离只有换执行体才拿得到。可换执行体要求本机装了 docker——
 * 装不上就不许用电脑，那是骚扰用户；照 codex 的姿态降级为
 * 「照常执行 + 审批卡兜底」，并把 `enforced: partial` 如实上报（见插件的挂载提示与系统提示段）。
 *
 * **受限令牌后端自 2026-09-30 起由 `src/core/sandbox/win/` 提供**（koffi FFI，见
 * `win/backend.ts`）。本文件头旧的「不实现受限令牌」决定已推翻：当时的理由是
 * 零 npm 依赖硬约束与「半可靠比明说 partial 更危险」；用户拍板引入 koffi（预构建
 * N-API，dsh 同款路线）换真隔离，「半可靠装可靠」的顾虑由 enforcement 与缺口
 * 清单如实上报解决。本文件保持容器后端这一半不动；两级的取舍对比看两处文件头。
 *
 * @module dsc/core/sandbox/backends
 */
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { CommandRunner, SpawnPlan } from '../tools/command-runner.js'

/** 探测结果。 */
export interface DockerProbeResult {
  available: boolean
  /** 给用户看的一句话：成功了给版本号，失败了给原因。 */
  detail: string
}

/** 探测超时（3 秒）：docker 守护没起来时会一直卡，不能拖住挂载流程。 */
const PROBE_TIMEOUT_MS = 3000

/** 探测输出封顶（版本号就一行，多的不要）。 */
const PROBE_OUTPUT_LIMIT = 4096

/**
 * 探一次容器后端：`docker version --format {{.Server.Version}}`。
 *
 * 看的是 **Server** 版本而不是 Client：只有客户端时（Windows 上常见）容器跑不起来。
 *
 * @param options.executable - 换一个可执行文件名（自检里用它验「docker 不在」这条路）。
 * @param options.timeoutMs - 探测超时。
 */
export function probeDocker(options: { executable?: string; timeoutMs?: number } = {}): Promise<DockerProbeResult> {
  const executable = options.executable ?? 'docker'
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return new Promise<DockerProbeResult>((resolvePromise) => {
    let output = ''
    let settled = false
    const finish = (result: DockerProbeResult): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ available: false, detail: `起不来：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ available: false, detail: `探测超过 ${String(timeoutMs)}ms 没回应（docker 守护进程没起来？）` })
    }, timeoutMs)
    const append = (chunk: Buffer | string): void => {
      if (output.length < PROBE_OUTPUT_LIMIT) output += String(chunk)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ available: false, detail: `跑不了 ${executable}：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = output.trim().split(/\r?\n/)[0]?.trim() ?? ''
      if (code === 0 && text !== '') finish({ available: true, detail: `docker Server ${text}` })
      else finish({ available: false, detail: text === '' ? `docker 返回退出码 ${String(code)}` : text })
    })
  })
}

/** 认得出的 shell 形态：bash 工具在 win32 用 powershell，POSIX 用 sh。 */
const POWERSHELL_HEADS = new Set(['powershell', 'pwsh'])
const POSIX_SHELL_HEADS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])

/**
 * 从一份执行计划里取出「用户真正要跑的那条命令」。
 *
 * 只认三种明确的 shell 形态（PowerShell 的 `-Command`、POSIX 的 `-c`、cmd 的 `/c`），
 * 认不出就返回 null——执行器缝的原则是「不猜」：猜错等于把别的东西塞进容器跑。
 */
export function unwrapShellCommand(plan: SpawnPlan): string | null {
  const file = basename(plan.file).toLowerCase().replace(/\.exe$/, '')
  const args = plan.args

  const flagValue = (names: readonly string[]): string | null => {
    for (let i = 0; i < args.length; i += 1) {
      const raw = args[i]!
      const lowered = raw.toLowerCase()
      for (const name of names) {
        if (lowered === name) return args[i + 1] ?? null
        // `-Command:X` 这种黏一起的写法
        if (lowered.startsWith(`${name}:`)) return raw.slice(name.length + 1)
      }
    }
    return null
  }

  if (POWERSHELL_HEADS.has(file)) return flagValue(['-command', '-c'])
  if (POSIX_SHELL_HEADS.has(file)) return flagValue(['-c'])
  if (file === 'cmd') return flagValue(['/c', '/k'])
  return null
}

/**
 * 透传进容器的环境变量白名单。
 *
 * 刻意**不含 PATH 与 HOME**：容器里该用镜像自己的 PATH（宿主 Windows 的 PATH 传进去
 * 会让 `node`/`pnpm` 全找不到），HOME 也该是容器内的 `/root`。
 * 代理与 registry 变量在「网络开关打开」时才透传，否则容器里也没网，给了也没用。
 */
export const CONTAINER_ENV_PASSTHROUGH: readonly string[] = [
  'LANG', 'LC_ALL', 'LANGUAGE', 'TZ', 'TERM', 'CI', 'NODE_ENV', 'NO_COLOR', 'SOURCE_DATE_EPOCH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL',
]

export interface DockerRunnerOptions {
  /** 容器镜像（默认 alpine:3，设置里可改）。 */
  image: string
  /** 网络开关（决定 `--network none` 还是 `bridge`）。 */
  networkAccess: () => boolean
  /** 只读档：把工作区挂成 `:ro`。 */
  readOnly?: () => boolean
  id?: string
  order?: number
  /** 容器名生成器（自检里换成固定名字）。 */
  containerName?: () => string
  /** 覆盖透传白名单。 */
  envPassthrough?: readonly string[]
  /** docker 可执行文件（自检可换掉）。 */
  executable?: string
  /** 找容器的收尾命令（默认 `docker rm -f <name>`）。 */
  remove?: (name: string) => void
}

/** 宿主目录 → docker 认的挂载源（Windows 的反斜杠换成正斜杠，Docker Desktop 两种都收）。 */
function hostMountPath(path: string): string {
  return path.replace(/\\/g, '/')
}

let containerSeq = 0

/**
 * 容器执行器：把 `powershell -NoProfile -Command X` / `sh -c X` 换成
 * `docker run --rm --network none -v <工作区>:/work -w /work <镜像> sh -c X`。
 *
 * 三个老实交代的边界（设置分区说明里也写了）：
 *   1. 容器里**只有 sh**：Windows 的 PowerShell 语法在容器里跑不通，
 *      所以这个后端适合 pnpm/npm/pytest 这类跨平台构建与测试，不适合 cmdlet 脚本；
 *   2. 只挂工作区：沙箱私有临时目录与别的盘符不挂（少挂一处就少一处泄漏面）；
 *   3. 认不出 shell 形态时返回 null（不改计划），命令照常在宿主上跑——
 *      此时 enforcement 该报 partial 而不是 full。
 */
export function createDockerRunner(options: DockerRunnerOptions): CommandRunner {
  const executable = options.executable ?? 'docker'
  const image = options.image
  const passthrough = options.envPassthrough ?? CONTAINER_ENV_PASSTHROUGH
  const nameOf = options.containerName ?? (() => `dsc-sandbox-${String(process.pid)}-${String((containerSeq += 1))}`)

  return {
    id: options.id ?? 'sandbox-docker',
    order: options.order ?? 20,
    plan(run, current) {
      // 已经是 docker 计划（别的执行器或上一位换过了）：不套两层
      if (basename(current.file).toLowerCase().replace(/\.exe$/, '') === 'docker') return null
      const inner = unwrapShellCommand(current)
      if (inner === null || inner.trim() === '') return null

      const container = nameOf()
      const mount = `${hostMountPath(run.cwd)}:/work${options.readOnly?.() === true ? ':ro' : ''}`
      const args = [
        'run', '--rm', '--name', container,
        '--network', options.networkAccess() ? 'bridge' : 'none',
        '-v', mount,
        '-w', '/work',
      ]
      for (const key of passthrough) {
        const value = current.env[key]
        if (value !== undefined && value !== '') args.push('-e', `${key}=${value}`)
      }
      args.push(image, 'sh', '-c', inner)
      // docker CLI 本身跑在宿主上，所以它的环境用宿主那份（已经过 scrubbed 脱敏）；
      // 容器里只拿到上面 -e 透传的那几个。
      return { file: executable, args, env: current.env, cwd: run.cwd }
    },
    done(_run, plan) {
      // `--rm` 管正常退出；超时被 SIGKILL 的 docker CLI 会把容器留下，这里兜一次
      const index = plan.args.indexOf('--name')
      const container = index >= 0 ? plan.args[index + 1] : undefined
      if (container === undefined) return
      if (options.remove !== undefined) {
        options.remove(container)
        return
      }
      try {
        const child = spawn(executable, ['rm', '-f', container], { stdio: 'ignore', detached: true })
        child.on('error', () => {
          // 收尾失败不该影响工具结果：容器留一份不致命（下次 `docker ps` 能看到）
        })
        child.unref()
      } catch {
        // 同上：静默
      }
    },
  }
}
