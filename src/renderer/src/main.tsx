import './web-shim'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './index.css'

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
