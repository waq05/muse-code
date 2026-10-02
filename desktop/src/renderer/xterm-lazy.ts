/**
 * xterm 的懒装载缝：Dock 常驻挂载（收起只是滑出屏幕），终端类库静态 import 会让
 * 每个会话启动都付这份解析成本——不管用户开没开过终端页签。这里把 xterm 与
 * FitAddon 收成第一次使用时的动态 import（缓存同一份 Promise），CSS 仍走静态
 * import（几 KB，换来首开终端不闪无样式帧）。
 */
import '@xterm/xterm/css/xterm.css'

export interface XtermModules {
  Terminal: typeof import('@xterm/xterm').Terminal
  FitAddon: typeof import('@xterm/addon-fit').FitAddon
}

let modules: Promise<XtermModules> | null = null

/** 装载 xterm（幂等；第一次调用才拉 chunk）。 */
export function loadXterm(): Promise<XtermModules> {
  modules ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
    ([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }),
  )
  return modules
}
