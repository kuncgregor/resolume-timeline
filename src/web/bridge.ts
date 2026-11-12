// Dev-only bridge: runs the real engine inside the Vite dev server so the renderer can be
// opened in a plain browser (Chrome) without Electron. Start with `npm run web`.
// The engine and the HTTP API are the app's own (src/main/engine-host.ts, web-server.ts).
import type { Plugin } from 'vite'
import { EngineHost } from '../main/engine-host'
import { handleTl } from '../main/web-server'

export function timelineBridge(): Plugin {
  return {
    name: 'timeline-bridge',
    apply: 'serve',
    configureServer(server) {
      const host = new EngineHost()
      server.middlewares.use((req, res, next) => {
        handleTl(host, req, res).then(handled => { if (!handled) next() }, next)
      })
      server.httpServer?.on('close', () => host.dispose())
    },
  }
}
