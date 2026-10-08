/**
 * 会话用量投影的壳进程入口：`dsc:session-usage` IPC 的实现。
 *
 * 折叠口径不在这里——唯一原件是 dsc 根仓库的 `core/usage-log.ts`（`readSessionUsage`），
 * 这个模块只把它转出口：electron-vite 在构建 main 时按 `@dsc/runtime` 别名把它打进
 * out/main（与渲染层用 `../lib` 同一套别名，见 electron.vite.config.ts）。
 * 之前这里手抄过一份逐行解析：写入端加字段（0.6.67 的 lm/ft/d 与工具行）就得回来改两处，
 * 于是改成共用一份——格式只允许有一个解释器。
 *
 * 为什么在壳里读文件、而不是问宿主：这份日志本来就是纯数据文件（宿主每次模型请求追加
 * 一条），壳进程读它只多一次 IO，既不写文件也不改宿主的任何运行状态；宿主忙着跑回合或
 * 正在重启时，状态栏这段读数照样在。只读是硬约束：失败一律返回 null（对应那段自然省略，
 * 比显示一个错数好）。路径同样取自宿主那份口径，`DSC_HOME` 一改两边一起跟。
 *
 * @module desktop/main/session-usage
 */
export { readSessionUsage } from '@dsc/runtime/core/usage-log.js'
export type { SessionUsageView } from '@dsc/runtime/contract.js'
