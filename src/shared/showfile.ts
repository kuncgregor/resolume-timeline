// Showfile: one file with every timeline of a show (and the breaks between them), saved by
// the user or by autosave. Timelines are no longer saved one by one; a single timeline can be
// exported / imported as a .json file.
import { isValidRundown, type RundownEntry } from './concert'
import type { Show } from './show'

export const SHOWFILE_EXT = 'rtshow'
export const SHOWFILE_FORMAT = 'resolume-timeline-showfile'

/** Which showfile the session is: its name (shown and used as the file name), where it is
 *  saved (null = not yet) and whether every change is saved automatically. */
export interface ShowfileMeta {
  name: string        // '' = not named yet: the Resolume composition's name is used
  path: string | null
  autosave: boolean
  settings?: ProjectSettings   // missing in older showfiles / sessions: taken from a timeline
}

/** What the whole showfile shares, set once per project (⚙ Project settings): where Resolume
 *  is, the LTC inputs and the audio output of this rig, and how cues and LTC behave. Each
 *  timeline keeps only its own clock (which input it follows, its start TC, fps, freewheel). */
export interface ProjectSettings {
  resolume: { host: string; oscPort: number; restPort: number }
  ltcA: { device?: string; channel: number }    // SMPTE A input (audio device, 0-based channel)
  ltcB: { device?: string; channel: number }    // SMPTE B input
  audioOut: { device?: string; left: number; right: number }   // the audio track's output
  deckReturn: boolean   // after a cue from another deck, Resolume shows the previous deck again
  followTc: boolean     // incoming LTC selects the timeline whose start TC it belongs to
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  resolume: { host: '127.0.0.1', oscPort: 7000, restPort: 8080 },
  ltcA: { channel: 0 }, ltcB: { channel: 0 }, audioOut: { left: 0, right: 1 },
  deckReturn: true, followTc: false,
}

/** Settings of an older showfile: what its timeline had (they were stored per timeline). */
export function settingsFromShow(show: Show | null | undefined, followTc = false): ProjectSettings {
  if (!show) return { ...DEFAULT_SETTINGS, followTc }
  const c = show.clock
  return {
    resolume: { host: show.resolume?.host || '127.0.0.1', oscPort: show.resolume?.oscPort || 7000, restPort: show.resolume?.restPort || 8080 },
    ltcA: { device: c.ltcDeviceA ?? c.ltcDevice, channel: c.ltcChannelA ?? 0 },
    ltcB: { device: c.ltcDeviceB, channel: c.ltcChannelB ?? 0 },
    audioOut: { device: c.audioOutputDevice, left: c.audioOutputChannelL ?? 0, right: c.audioOutputChannelR ?? 1 },
    deckReturn: show.deckReturn !== false,
    followTc,
  }
}

/** A timeline as the engine and the decoders run it: with the project's rig settings. */
export function withProject(show: Show, p: ProjectSettings): Show {
  return {
    ...show,
    resolume: { ...show.resolume, host: p.resolume.host, oscPort: p.resolume.oscPort, restPort: p.resolume.restPort },
    clock: {
      ...show.clock,
      ltcDeviceA: p.ltcA.device, ltcChannelA: p.ltcA.channel, ltcDevice: p.ltcA.device,
      ltcDeviceB: p.ltcB.device, ltcChannelB: p.ltcB.channel,
      audioOutputDevice: p.audioOut.device, audioOutputChannelL: p.audioOut.left, audioOutputChannelR: p.audioOut.right,
    },
    deckReturn: p.deckReturn,
  }
}

export interface ShowfileData {
  format: typeof SHOWFILE_FORMAT
  version: 1
  name: string
  composition?: string   // Resolume composition it was made for (informative)
  savedAt: number
  activeId: string
  autosave: boolean
  settings?: ProjectSettings
  entries: RundownEntry[]
}

// Per-timeline file state belongs to the old model (a file per timeline)
const clean = (e: RundownEntry): RundownEntry =>
  e.type === 'show' ? { ...e, filePath: null, dirty: false } : e

export function showfileData(meta: ShowfileMeta, name: string, rundown: RundownEntry[], activeId: string, composition?: string): ShowfileData {
  return {
    format: SHOWFILE_FORMAT, version: 1, name,
    ...(composition ? { composition } : {}),
    savedAt: Date.now(), activeId, autosave: meta.autosave,
    ...(meta.settings ? { settings: meta.settings } : {}), entries: rundown.map(clean),
  }
}

/** What counts as a change to the showfile (the active timeline and save time don't). */
export function showfileKey(name: string, rundown: RundownEntry[], settings?: ProjectSettings): string {
  return JSON.stringify([name, rundown.map(clean), settings ?? null])
}

export function isShowfile(d: any): d is ShowfileData {
  return d?.format === SHOWFILE_FORMAT && isValidRundown(d.entries)
}

/** File name for a showfile name: what macOS / Windows accept. */
export function showfileFileName(name: string): string {
  const base = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 120)
  return `${base || 'Showfile'}.${SHOWFILE_EXT}`
}
