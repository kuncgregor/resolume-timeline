// Browser dev mode: `npm run web` → http://localhost:5174
// Serves the renderer and runs the engine in-process via the timeline bridge.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { timelineBridge } from './src/web/bridge'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), timelineBridge()],
  server: { port: 5174, strictPort: true, host: '127.0.0.1' },
})
