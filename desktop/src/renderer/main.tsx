import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyAppearance, loadCachedAppearance } from './appearance.js'
// 顺序即层叠：令牌 → 全局基线 → 原语 → 各视图。反了就会互相覆盖。
import './styles/tokens.css'
import './styles/base.css'
import './styles/primitives.css'
import './styles.css'

// 首帧先按上次的设置上色，等宿主把 settings.json 的真值送上来再覆盖一次。
applyAppearance(loadCachedAppearance())

createRoot(document.getElementById('root') ?? document.body).render(
  React.createElement(App),
)
