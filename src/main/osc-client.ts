import { Client } from 'node-osc'

export class OscClient {
  private client: Client | null = null
  host: string
  port: number
  private lastConnectedClip = new Map<number, number>()

  constructor(host = '127.0.0.1', port = 7000) {
    this.host = host
    this.port = port
  }

  connect(host?: string, port?: number) {
    if (host) this.host = host
    if (port) this.port = port
    if (this.client) {
      try { this.client.close() } catch {}
    }
    this.client = new Client(this.host, this.port)
    // node-osc adds no error listener to its UDP socket: an error event would be uncaught
    ;(this.client as any)._sock?.on?.('error', (e: Error) => console.error('[OSC] socket error:', e.message))
  }

  send(address: string, ...args: (number | string)[]) {
    if (!this.client) return
    try {
      this.client.send(address, ...args, (err: Error | null) => {
        if (err) console.error('[OSC] send error:', err.message)
      })
    } catch (e) {
      console.error('[OSC] exception:', e)
    }
  }

  close() {
    if (this.client) {
      try { this.client.close() } catch {}
      this.client = null
    }
  }

  get isConnected() { return this.client !== null }

  connectClip(layer: number, clip: number, releaseMs = 40) {
    this.lastConnectedClip.set(layer, clip)
    this.send(`/composition/layers/${layer}/clips/${clip}/connect`, 1)
    if (releaseMs > 0) {
      setTimeout(() => {
        this.send(`/composition/layers/${layer}/clips/${clip}/connect`, 0)
      }, releaseMs)
    }
  }

  connectColumn(column: number) {
    this.send(`/composition/columns/${column}/connect`, 1)
  }

  clearLayer(layer: number) {
    // Release the specific clip if it was held (release=false)
    const lastClip = this.lastConnectedClip.get(layer)
    if (lastClip !== undefined) {
      this.send(`/composition/layers/${layer}/clips/${lastClip}/connect`, 0)
      this.lastConnectedClip.delete(layer)
    }
    // Send clear as momentary pulse
    this.send(`/composition/layers/${layer}/clear`, 1)
    setTimeout(() => this.send(`/composition/layers/${layer}/clear`, 0), 50)
  }

  setParam(address: string, value: number) {
    this.send(address, value)
  }
}
