// The UI over HTTP: RPC calls (POST /__tl/rpc), engine events (Server-Sent Events on
// /__tl/events) and audio files (/__tl/audio). Used by the Vite dev bridge (`npm run web`)
// and by the app's tablet server, which also serves the built UI to browsers on the LAN.
// Renderer side: src/renderer/src/web-shim.ts.
import http, { type IncomingMessage, type ServerResponse } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { loadAudioFile } from './audio-file'
import type { EngineHost } from './engine-host'

const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  let body = ''
  // A session with many timelines is a few MB; anything far bigger is not one of ours
  req.on('data', c => { body += c; if (body.length > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')) } })
  req.on('end', () => resolve(body))
  req.on('error', reject)
})

const sameKey = (given: unknown, key: string) => {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given), b = Buffer.from(key)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Handles /__tl/* requests; false for any other path. `key`: required access key (LAN server;
 *  the dev bridge on 127.0.0.1 has none). */
export async function handleTl(host: EngineHost, req: IncomingMessage, res: ServerResponse, key?: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x')
  if (!url.pathname.startsWith('/__tl/')) return false
  // Only the page this server serves: another site open in the same browser must not reach
  // the engine (a cross-site form post would otherwise trigger clips)
  const origin = req.headers.origin
  let foreign = false
  try { foreign = !!origin && new URL(origin).host !== req.headers.host } catch { foreign = true }
  if (foreign) { res.statusCode = 403; res.end(); return true }
  if (key !== undefined && !(key && (sameKey(url.searchParams.get('k'), key) || sameKey(req.headers['x-tl-key'], key)))) {
    res.statusCode = 401; res.end('{"error":"access key missing or wrong"}')
    return true
  }

  if (url.pathname === '/__tl/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    // A tablet whose Wi-Fi died keeps its socket until TCP gives up (minutes): everything sent
    // meanwhile would pile up here. Past a few MB it is dropped (its page reconnects anew).
    req.socket.setKeepAlive(true, 5000)
    const send = (channel: string, payload: unknown) => {
      if (res.writableLength > MAX_BUFFERED) { res.destroy(); return }
      res.write(`event: ${channel}\ndata: ${jsonOnce(payload)}\n\n`)
    }
    send('resolume:status', { connected: host.resolumeConnected })
    const remove = host.addSink(send)
    // Keeps idle connections (tablet Wi-Fi, proxies) open between events, and lets the page
    // notice a link that died silently (a phone's Wi-Fi): a named event, comments never reach JS
    const ping = setInterval(() => res.write('event: hb\ndata: 0\n\n'), HEARTBEAT_MS)
    req.on('close', () => { remove(); clearInterval(ping) })
    return true
  }

  // Binary, so a long WAV is not inflated through JSON. Not on the LAN server: a tablet
  // doesn't play the audio track, and it would read files off this computer
  if (url.pathname === '/__tl/audio') {
    if (key !== undefined) { res.statusCode = 403; res.end(); return true }
    const filePath = url.searchParams.get('path') ?? ''
    const audio = filePath ? await loadAudioFile(filePath) : null
    if (!audio) { res.statusCode = 404; res.end(); return true }
    res.setHeader('Content-Type', 'audio/wav')
    res.end(Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength))
    return true
  }

  if (url.pathname === '/__tl/rpc' && req.method === 'POST' && req.headers['content-type']?.startsWith('application/json')) {
    try {
      const { method, args } = JSON.parse(await readBody(req))
      // Files on this computer: only the app window, never a browser on the network
      const fn = key !== undefined && LOCAL_ONLY.has(method) ? undefined : Object.hasOwn(host.methods, method) ? host.methods[method] : undefined
      res.setHeader('Content-Type', 'application/json')
      if (!fn) { res.statusCode = 404; res.end(JSON.stringify({ error: `unknown method ${method}` })); return true }
      const result = await fn(...(args ?? []))
      res.end(JSON.stringify({ result: result ?? null }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e) }))
    }
    return true
  }

  res.statusCode = 404; res.end()
  return true
}

const MAX_BUFFERED = 4 * 1024 * 1024
// One event goes to every tablet: serialized once (a composition update is ~1 MB of JSON)
let lastPayload: unknown = undefined, lastJson = ''
function jsonOnce(payload: unknown) {
  if (payload !== lastPayload || lastJson === '') {
    lastPayload = payload; lastJson = JSON.stringify(payload) ?? 'null'
    // Only within one emit to all sinks: an object sent again later may have changed
    queueMicrotask(() => { lastPayload = undefined; lastJson = '' })
  }
  return lastJson
}
const HEARTBEAT_MS = 3000   // web-shim marks the link down after LINK_TIMEOUT_MS without one

const LOCAL_ONLY = new Set(['showfileDefaultPath', 'showfileWrite', 'showfileRename', 'showfileRead'])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wav': 'audio/wav',
}

// Interfaces a tablet can't be on: virtual machines, Docker, VPN tunnels, Internet Sharing bridges,
// Apple's peer-to-peer links. A Mac often has several, each with its own address.
const VIRTUAL_IF = /^(bridge|utun|vmnet|vboxnet|docker|veth|br-|awdl|llw|anpi|ap\d|gif|stf|tap|tun|zt|tailscale|wg)/i

/** IPv4 addresses a tablet on the same network can reach this computer at: the real network
 *  (Wi-Fi, Ethernet) first, virtual ones after it, each with its interface's name. */
export function lanAddresses(): { address: string; name: string; virtual: boolean }[] {
  const out: { address: string; name: string; virtual: boolean }[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, name, virtual: VIRTUAL_IF.test(name) })
    }
  }
  // Real before virtual; among them en0 / eth0 (built-in) before en5 (adapters)
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** The built UI + the engine API on the LAN (port, access key). The page it serves runs as a
 *  remote: the app on this computer keeps LTC, the audio track and the link to Resolume. */
export class WebServer {
  private server: http.Server | null = null
  constructor(private host: EngineHost, private staticDir: string) {}

  get running() { return !!this.server?.listening }

  start(port: number, key: string): Promise<string | null> {
    if (this.server) return Promise.resolve(null)
    const server = http.createServer(async (req, res) => {
      try {
        if (await handleTl(this.host, req, res, key)) return
        this.serveStatic(req, res)
      } catch (e) {
        res.statusCode = 500; res.end(String(e))
      }
    })
    return new Promise(resolve => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.server = null
        resolve(e.code === 'EADDRINUSE' ? `port ${port} is in use` : String(e.message))
      })
      server.listen(port, '0.0.0.0', () => { this.server = server; resolve(null) })
    })
  }

  stop() {
    this.server?.closeAllConnections?.()
    this.server?.close()
    this.server = null
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? '/', 'http://x')
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const file = path.resolve(this.staticDir, rel)
    if (!file.startsWith(path.resolve(this.staticDir) + path.sep)) { res.statusCode = 403; res.end(); return }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end(); return }
      res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
      if (rel === 'index.html') {
        // The page runs as a remote of this app (see class comment)
        res.setHeader('Cache-Control', 'no-cache')
        res.end(data.toString('utf8').replace('<head>', '<head><script>window.__TL_REMOTE__=true</script>'))
        return
      }
      res.end(data)
    })
  }
}
