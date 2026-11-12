// Arena's recorder (Record button), driven over OSC: /composition/recorder/record 1 = start,
// 0 = stop (verified on Arena 7.24: the file appears ~38 ms after the command, and the
// recording ends ~0 ms after the stop). Recording is not in the REST API.
// To start a recording exactly at the timeline start, the app sends the start command and
// starts the timeline only once Arena has created the file (watching the recordings folder).
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { OscClient } from './osc-client'

const PREFS = path.join(os.homedir(), 'Documents', 'Resolume Arena', 'Preferences', 'config.xml')
const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'Resolume Arena', 'Recorded')
const START_TIMEOUT_MS = 1500

export interface RecordStart { ok: boolean; latencyMs: number; file: string | null; dir: string }

/** Arena's recordings folder (Preferences › Recording); its default when the stored one is gone. */
export function recordingsDir(): string {
  try {
    const xml = fs.readFileSync(PREFS, 'utf8')
    const m = /<RecordSettings>[\s\S]*?<OutputPath[^>]*Path="([^"]+)"/.exec(xml)
    if (m && fs.existsSync(m[1])) return m[1]
  } catch { /* no prefs: default */ }
  return DEFAULT_DIR
}

export class ArenaRecorder {
  private recording = false
  constructor(private osc: OscClient) {}

  get isRecording() { return this.recording }

  /** Start recording; resolves when Arena has created the file (or after a timeout, ok = false). */
  start(): Promise<RecordStart> {
    const dir = recordingsDir()
    const t0 = Date.now()
    return new Promise(resolve => {
      let watcher: fs.FSWatcher | null = null
      let done = false
      const finish = (ok: boolean, file: string | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        watcher?.close()
        resolve({ ok, latencyMs: Date.now() - t0, file, dir })
      }
      const before = new Set(safeList(dir))
      try {
        watcher = fs.watch(dir, (_ev, f) => {
          const name = f?.toString()
          if (name && !name.startsWith('.') && !before.has(name)) finish(true, path.join(dir, name))
        })
      } catch { /* folder missing: fall back to the timeout */ }
      const timer = setTimeout(() => finish(false, null), START_TIMEOUT_MS)
      this.recording = true
      console.info('[recorder] start → watching', dir)
      this.osc.send('/composition/recorder/record', 1)
    })
  }

  // Always sends: a stop while Arena isn't recording does nothing, a lost stop would keep it
  // recording (and a recorder created anew — app restart — wouldn't know it was recording)
  stop() {
    console.info('[recorder] stop', this.recording ? '' : '(was not marked recording)')
    this.recording = false
    this.osc.send('/composition/recorder/record', 0)
  }
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}
