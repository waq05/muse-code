import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import { registerServiceWorker } from './lib/push.js'

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root 挂载点')

// service worker 只负责收推送（不缓存任何东西，免得和宿主的产物版本打架）。
// 注册被 registerServiceWorker 自己收口在「https 或 localhost」里。
registerServiceWorker()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
