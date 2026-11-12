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

/** A rundown read from storage or another UI can be used: entries with ids, shows with tracks. */
export function isValidRundown(rundown: unknown): rundown is RundownEntry[] {
  return Array.isArray(rundown) && rundown.length > 0 && rundown.every((e: any) =>
    e && typeof e.id === 'string' &&
    (e.type === 'break' || (e.type === 'show' && e.show && Array.isArray(e.show.tracks) && e.show.clock && e.show.resolume)))
}
