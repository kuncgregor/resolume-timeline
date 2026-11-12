import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24, color: '#ff8888', background: '#1a0a0a',
          fontFamily: 'monospace', height: '100vh', overflow: 'auto'
        }}>
          <h2 style={{ color: '#ff4444', marginBottom: 12 }}>Render error</h2>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: 16 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ fontSize: 11, color: '#cc6666', whiteSpace: 'pre-wrap' }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '6px 16px', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
