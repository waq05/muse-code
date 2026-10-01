import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import { registerServiceWorker } from './lib/push.js'
import { installViewportHeight } from './lib/viewport.js'

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root 挂载点')

// service worker 只负责收推送（不缓存任何东西，免得和宿主的产物版本打架）。
// 注册被 registerServiceWorker 自己收口在「https 或 localhost」里。
registerServiceWorker()

// 把真实可见高度写进 --app-h（见 lib/viewport.ts 的说明：dvh 在带底部工具栏的
// 手机浏览器里算得偏高，会把发送框顶到工具栏下面）。装一次，整页生命周期都在。
installViewportHeight()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
