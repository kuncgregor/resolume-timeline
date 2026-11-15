// Resolume's WebSocket API (ws://host:port/api/v1, same port as REST). Used to hear
// operator changes on automated parameters as they happen, instead of polling them.
// Verified against Arena 7: on connect Resolume sends the full composition (≈300 KB),
// sources and effects lists; {action:'subscribe', parameter:'/parameter/by-id/<id>'} answers
// 'parameter_subscribed' and then 'parameter_update' with { id, value, path } per change.
import WebSocket from 'ws'

type Value = number | string | boolean
const RECONNECT_MS = 3000
const PING_MS = 5000          // a half-open socket (Resolume on another machine) is noticed
const MAX_BUFFERED = 64 * 1024 // Resolume busy (loading a composition): only the latest values wait

export class ResolumeWs {
  private ws: WebSocket | null = null
  private url = ''
  private wanted = new Set<number>()      // ids the scheduler wants to hear about
  private live = new Set<number>()        // ids Resolume confirmed (parameter_subscribed)
  private retry: NodeJS.Timeout | null = null
  private stopped = true
  private updateCb: ((id: number, value: Value, initial: boolean) => void) | null = null
  private pending = new Map<number, Value>()   // values held back while the socket is backed up
  private pinger: NodeJS.Timeout | null = null

  constructor(private endpoint: () => { host: string; port: number }) {}

  /** initial = the value Resolume reports when the subscription starts (a baseline, not a change). */
  onUpdate(cb: (id: number, value: Value, initial: boolean) => void) { this.updateCb = cb }

  /** True when changes of this parameter arrive over the socket (no polling needed). */
  isLive(id: number) { return this.live.has(id) }

  start() {
    this.stopped = false
    this.open()
  }

  stop() {
    this.stopped = true
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null }
    this.ws?.close()
    this.ws = null
    this.pending.clear()
    this.live.clear()
  }

  /** The parameters to watch; subscribes the new ones, unsubscribes the dropped ones. */
  setParams(ids: Iterable<number>) {
    const next = new Set(ids)
    for (const id of this.wanted) if (!next.has(id)) { this.send('unsubscribe', id); this.live.delete(id) }
    for (const id of next) if (!this.wanted.has(id)) this.send('subscribe', id)
    this.wanted = next
    // Resolume moved (host/port changed in the show): reconnect there
    if (this.url && this.url !== this.endpointUrl()) this.reconnect()
    else if (!this.ws && !this.retry) this.open()
  }

  /** Drop the socket and connect again now (host changed / user pressed reconnect). */
  reconnect() {
    if (this.stopped) return
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    const old = this.ws
    this.ws = null
    this.live.clear()
    old?.removeAllListeners()
    old?.on('error', () => {})
    old?.close()
    this.open()
  }

  private endpointUrl() {
    const { host, port } = this.endpoint()
    return `ws://${host.trim()}:${port}/api/v1`
  }

  /** Sets a parameter over the open socket (much lighter than a REST PUT per value: automation
   *  sends up to 60 values a second per lane). False when the socket isn't open: use REST. */
  set(id: number, value: Value): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.flush()
    // Backed up: a burst of stale values would play out late; the newest one waits instead
    if (this.ws.bufferedAmount > MAX_BUFFERED) { this.pending.set(id, value); return true }
    this.pending.delete(id)
    this.ws.send(JSON.stringify({ action: 'set', parameter: `/parameter/by-id/${id}`, value }))
    return true
  }

  private flush() {
    const ws = this.ws
    if (!this.pending.size || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) return
    for (const [id, value] of this.pending) ws.send(JSON.stringify({ action: 'set', parameter: `/parameter/by-id/${id}`, value }))
    this.pending.clear()
  }

  private send(action: 'subscribe' | 'unsubscribe', id: number) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ action, parameter: `/parameter/by-id/${id}` }))
  }

  private open() {
    if (this.stopped) return
    this.url = this.endpointUrl()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 3000 })
    } catch {
      // Invalid host (typo in settings): the constructor throws; keep polling and try later
      this.scheduleRetry()
      return
    }
    this.ws = ws
    let alive = true
    ws.on('pong', () => { alive = true })
    ws.on('open', () => {
      for (const id of this.wanted) this.send('subscribe', id)
      if (this.pinger) clearInterval(this.pinger)
      this.pinger = setInterval(() => {
        if (this.ws !== ws) return
        if (!alive) { ws.terminate(); return }   // 'close' follows: polling, then a new socket
        alive = false
        try { ws.ping() } catch { /* closing */ }
        this.flush()
      }, PING_MS)
    })
    ws.on('message', (data: WebSocket.RawData) => this.handle(data.toString()))
    ws.on('error', () => { /* 'close' follows and schedules the retry */ })
    ws.on('close', () => {
      if (this.ws !== ws) return   // replaced by reconnect()
      this.ws = null
      if (this.pinger) { clearInterval(this.pinger); this.pinger = null }
      this.pending.clear()
      this.live.clear()   // back to polling until we are subscribed again
      this.scheduleRetry()
    })
  }

  private scheduleRetry() {
    if (!this.stopped && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.open() }, RECONNECT_MS)
  }

  private handle(text: string) {
    // Composition / sources / effects dumps are large and not needed here
    if (text.length > 20000 || !text.includes('"type":"parameter_')) return
    let m: any
    try { m = JSON.parse(text.replace(/[\x00-\x1f]/g, ' ')) } catch { return }
    const id = Number(m?.id)
    if (!Number.isFinite(id)) return
    if (m.type === 'parameter_subscribed') {
      if (!this.wanted.has(id)) return
      this.live.add(id)
      if (m.value !== undefined) this.updateCb?.(id, m.value as Value, true)
    } else if (m.type === 'parameter_update') {
      if (this.wanted.has(id) && m.value !== undefined) this.updateCb?.(id, m.value as Value, false)
    }
  }
}
