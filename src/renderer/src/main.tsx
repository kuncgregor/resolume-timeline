import './web-shim'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles/tokens.css'
import './styles/chrome.css'
import './styles/canvas.css'
import './styles/panels.css'
import './styles/remote.css'
import './styles/touch.css'
import { applyTouchMode } from './touch'

applyTouchMode()

window.onerror = (msg, src, line, col, err) => {
  console.error('[RENDERER CRASH]', msg, src, line, col, err)
}
window.onunhandledrejection = (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
