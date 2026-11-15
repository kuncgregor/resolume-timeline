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
    return this.getJson<ResolumeComposition>('/composition')
  }

  // Resolume sometimes puts raw control characters into strings (clip names, paths), which
  // strict JSON parsers reject; blank them before parsing.
  async getJson<T = any>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      return JSON.parse((await res.text()).replace(/[\u0000-\u001f]/g, ' ')) as T
    } catch { return null }
  }

  /** Trigger the clip in a slot of the shown deck (layer/slot 1-based). */
  async connectClip(layer: number, slot: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/composition/layers/${layer}/clips/${slot}/connect`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch { return false }
  }

  /** Select a deck (1-based index). Only the selected deck's clips can be triggered. */
  async selectDeck(index: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/composition/decks/${index}/select`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch { return false }
  }

  async getParamById(id: number): Promise<any | null> {
    return this.getJson(`/parameter/by-id/${id}`)
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

  async getParamRange(id: number): Promise<{ min: number; max: number } | null> {
    try {
      const res = await fetch(`${this.base}/parameter/by-id/${id}`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      const p = await res.json() as { min?: unknown; max?: unknown }
      return typeof p.min === 'number' && typeof p.max === 'number' ? { min: p.min, max: p.max } : null
    } catch { return null }
  }

  /** Parameter back to its Resolume default (POST /parameter/by-id/{id}/reset, Arena 7.24;
   *  its animation settings are left alone). */
  async resetParam(id: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/parameter/by-id/${id}/reset`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetanimation: false }), signal: AbortSignal.timeout(2000),
      })
      return res.ok
    } catch { return false }
  }

  // Set any parameter by its Resolume internal ID. Real values: number for ranges, the exact
  // option string for choices, true/false for booleans (verified on Arena 7).
  async setParamById(id: number, value: number | string | boolean): Promise<boolean> {
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
