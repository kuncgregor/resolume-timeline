// Crash/refresh recovery: the whole rundown (all open shows, unsaved edits included) is
// mirrored to localStorage and restored on the next start. Show files on disk are never
// written by autosave — saving stays an explicit action.
import type { RundownEntry } from '../../shared/concert'

const KEY = 'resolume-timeline:autosave:v1'

export interface AutosaveData {
  savedAt: number
  rundown: RundownEntry[]
  activeId: string
  concertFilePath: string | null
  concertDirty: boolean
}

export function loadAutosave(): AutosaveData | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as AutosaveData
    const valid = Array.isArray(data.rundown) && data.rundown.length > 0 &&
      data.rundown.every(e => e && typeof e.id === 'string' &&
        (e.type === 'break' || (e.type === 'show' && Array.isArray(e.show?.tracks))))
    return valid ? data : null
  } catch (e) {
    console.warn('[autosave] restore failed', e)
    return null
  }
}

// Returns false when the browser refused the write (e.g. storage quota exceeded)
export function writeAutosave(data: AutosaveData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
    return true
  } catch (e) {
    console.warn('[autosave] write failed', e)
    return false
  }
}

export function clearAutosave() {
  try { localStorage.removeItem(KEY) } catch {}
}
