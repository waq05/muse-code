import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

createRoot(document.getElementById('root') ?? document.body).render(
  React.createElement(App),
)
