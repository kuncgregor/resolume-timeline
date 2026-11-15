import type { Show } from './show'

export type RundownEntry = ShowEntry | BreakEntry

export interface ShowEntry {
  id: string
  type: 'show'
  show: Show
  filePath: string | null
  dirty: boolean
  color: string
  notes: string
}

export interface BreakEntry {
  id: string
  type: 'break'
  label: string
  duration: string   // SMPTE estimated duration for display
  color: string
  notes: string
}

// Serialized format saved to .concert.json — no embedded Show data
export interface ConcertFile {
  version: 1
  name: string
  entries: ConcertFileEntry[]
}

export interface ConcertFileEntry {
  id: string
  type: 'show' | 'break'
  filePath?: string | null
  label?: string
  duration?: string
  color: string
  notes: string
}

export interface LoadedConcert {
  name: string
  filePath: string
  entries: ConcertFileEntry[]
  shows: Record<string, Show>   // keyed by entry id
}

// Times the engine and the UI parse without checks (a missing one would throw mid-render or
// in the engine's tick, on every device that gets the session)
const SMPTE = /^\d{1,3}:\d{1,2}:\d{1,2}:\d{1,3}$/
const isTime = (t: unknown) => typeof t === 'string' && SMPTE.test(t)
const isKeys = (k: unknown) => Array.isArray(k) && k.every((kf: any) => kf && isTime(kf.time) && Number.isFinite(kf.value))
const isLanes = (a: unknown) => Array.isArray(a) && a.every((l: any) => l && typeof l.id === 'string' && isKeys(l.keyframes))
const isClips = (c: unknown) => Array.isArray(c) && c.every((x: any) => x && isTime(x.time) && isTime(x.duration))
const isCues = (c: unknown) => Array.isArray(c) && c.every((x: any) => x && isTime(x.time))
// Each kind of track with the arrays the engine walks without checks
const isTrack = (t: any) => !!t && typeof t.id === 'string' && (
  t.type === 'layer' ? isClips(t.clips) && isLanes(t.automations)
  : t.type === 'group' ? isLanes(t.automations)
  : t.type === 'trigger' ? isCues(t.events)
  : t.type === 'automation' ? isKeys(t.keyframes)
  : false)

/** A timeline the engine and the UI can run: tracks, clips, cues, lanes and keys with valid times. */
export function isValidShow(s: any): s is Show {
  return !!s && typeof s === 'object' && Number.isFinite(s.frameRate) && s.frameRate >= 1 && s.frameRate <= 120 &&
    !!s.clock && typeof s.clock === 'object' && !!s.resolume && typeof s.resolume.host === 'string' &&
    Number.isFinite(s.resolume.oscPort) && Number.isFinite(s.resolume.restPort) &&
    (s.markers === undefined || (Array.isArray(s.markers) && s.markers.every((m: any) => m && isTime(m.time)))) &&
    Array.isArray(s.tracks) && s.tracks.every(isTrack)
}

/** A rundown read from storage or another UI can be used: entries with ids, valid shows. */
export function isValidRundown(rundown: unknown): rundown is RundownEntry[] {
  return Array.isArray(rundown) && rundown.length > 0 && rundown.every((e: any) =>
    e && typeof e.id === 'string' && (e.type === 'break' || (e.type === 'show' && isValidShow(e.show))))
}
