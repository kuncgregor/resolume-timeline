import type { ResolumeComposition } from '../shared/resolume'

export type { ResolumeComposition }

export class ResolumeRest {
  host: string
  port: number

  constructor(host = '127.0.0.1', port = 8080) {
    this.host = host
    this.port = port
  }

  get base() { return `http://${this.host}:${this.port}/api/v1` }

  setBase(host: string, port: number) { this.host = host; this.port = port }

  async getComposition(): Promise<ResolumeComposition | null> {
    try {
      const res = await fetch(`${this.base}/composition`)
      if (!res.ok) return null
      return await res.json() as ResolumeComposition
    } catch { return null }
  }

  async getThumbnail(layerId: number, clipId: number): Promise<string | null> {
    // Clip ids are unique across the composition; the layer-scoped by-id path returns 404
    const urls = [
      `${this.base}/composition/clips/by-id/${clipId}/thumbnail`,
      `${this.base}/composition/layers/by-id/${layerId}/clips/by-id/${clipId}/thumbnail`,
    ]
    for (const url of urls) {
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const ct = res.headers.get('content-type') ?? 'image/jpeg'
        const buf = await res.arrayBuffer()
        if (buf.byteLength < 100) continue // empty/invalid
        return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`
      } catch { continue }
    }
    return null
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/composition`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch { return false }
  }

  // Set a parameter by its path (works for layer-level REST params).
  async setParam(path: string, value: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
      return res.ok
    } catch { return false }
  }

  // Set any parameter by its Resolume internal ID.
  async setParamById(id: number, value: number): Promise<boolean> {
    try {
      const url = `${this.base}/parameter/by-id/${id}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[REST] PUT ${url} → ${res.status}: ${body.slice(0, 80)}`)
      }
      return res.ok
    } catch (e) {
      console.warn('[REST] setParamById error:', e)
      return false
    }
  }
}
