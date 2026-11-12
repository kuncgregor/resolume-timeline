// Showfile: one file with every timeline of a show (and the breaks between them), saved by
// the user or by autosave. Timelines are no longer saved one by one; a single timeline can be
// exported / imported as a .json file.
import { isValidRundown, type RundownEntry } from './concert'

export const SHOWFILE_EXT = 'rtshow'
export const SHOWFILE_FORMAT = 'resolume-timeline-showfile'

/** Which showfile the session is: its name (shown and used as the file name), where it is
 *  saved (null = not yet) and whether every change is saved automatically. */
export interface ShowfileMeta {
  name: string        // '' = not named yet: the Resolume composition's name is used
  path: string | null
  autosave: boolean
}

export interface ShowfileData {
  format: typeof SHOWFILE_FORMAT
  version: 1
  name: string
  composition?: string   // Resolume composition it was made for (informative)
  savedAt: number
  activeId: string
  autosave: boolean
  entries: RundownEntry[]
}

// Per-timeline file state belongs to the old model (a file per timeline)
const clean = (e: RundownEntry): RundownEntry =>
  e.type === 'show' ? { ...e, filePath: null, dirty: false } : e

export function showfileData(meta: ShowfileMeta, name: string, rundown: RundownEntry[], activeId: string, composition?: string): ShowfileData {
  return {
    format: SHOWFILE_FORMAT, version: 1, name,
    ...(composition ? { composition } : {}),
    savedAt: Date.now(), activeId, autosave: meta.autosave, entries: rundown.map(clean),
  }
}

/** What counts as a change to the showfile (the active timeline and save time don't). */
export function showfileKey(name: string, rundown: RundownEntry[]): string {
  return JSON.stringify([name, rundown.map(clean)])
}

export function isShowfile(d: any): d is ShowfileData {
  return d?.format === SHOWFILE_FORMAT && isValidRundown(d.entries)
}

/** File name for a showfile name: what macOS / Windows accept. */
export function showfileFileName(name: string): string {
  const base = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 120)
  return `${base || 'Showfile'}.${SHOWFILE_EXT}`
}
