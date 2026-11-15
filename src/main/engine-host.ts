// The engine (Transport + Scheduler + OSC + REST + Arena recorder) and every call the UI
// makes into it. One instance per process: the Electron main process (its window over IPC,
// tablets over the LAN web server) or the Vite dev bridge (`npm run web`).
// Also holds the session (all open timelines) so every connected UI shows the same state,
// persisted to disk as the crash/restart recovery.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ArenaRecorder } from './recorder'
import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import { Scheduler, type LaneTarget } from './scheduler'
import { rv } from '../shared/resolume'
import { isValidRundown } from '../shared/concert'
import { SHOWFILE_EXT, SHOWFILE_FORMAT, isShowfile, showfileFileName } from '../shared/showfile'
import type { Show, CueEvent } from '../shared/show'

/** Per-user data folder, the same for the packaged app and the dev bridge. */
export function appDataDir(): string {
  const home = os.homedir()
  const dir = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Resolume Timeline')
    : process.platform === 'win32' ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Resolume Timeline')
    : path.join(home, '.config', 'resolume-timeline')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* read-only: session stays in memory */ }
  return dir
}

/** Where showfiles go unless the user saves one elsewhere. */
export function showfilesDir(): string {
  return path.join(os.homedir(), 'Documents', 'Resolume Timeline')
}

const isShowfilePath = (p: unknown): p is string =>
  typeof p === 'string' && path.isAbsolute(p) && p.toLowerCase().endsWith(`.${SHOWFILE_EXT}`)

/** A path for a new showfile with this name that doesn't overwrite another one. */
export function freeShowfilePath(dir: string, name: string, keep?: string): string {
  const file = showfileFileName(name)
  const stem = file.slice(0, -(SHOWFILE_EXT.length + 1))
  for (let n = 1; ; n++) {
    const p = path.join(dir, n === 1 ? file : `${stem} ${n}.${SHOWFILE_EXT}`)
    if (p === keep || !fs.existsSync(p)) return p
  }
}

/** Reads a showfile, or an old .concert.json (timelines in their own files) as one. */
export function readShowfile(file: string): { data: unknown; path: string | null } | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isShowfile(d)) return { data: d, path: file }
    if (!Array.isArray(d?.entries)) return null
    const entries = d.entries.map((e: any, i: number) => {
      if (e.type !== 'show') return { id: e.id ?? `b${i}`, type: 'break', label: e.label ?? 'Break', duration: e.duration ?? '00:20:00:00', color: e.color ?? '#333333', notes: e.notes ?? '' }
      let show = null
      try { show = e.filePath ? JSON.parse(fs.readFileSync(e.filePath, 'utf8')) : null } catch { /* missing file */ }
      return show && { id: e.id ?? `s${i}`, type: 'show', show, filePath: null, dirty: false, color: e.color ?? '#56636e', notes: e.notes ?? '' }
    }).filter(Boolean)
    const name = d.name || path.basename(file).replace(/\.concert\.json$|\.json$/, '')
    // Converted: saved as a new showfile (path null), the old files stay as they are
    return { data: { format: SHOWFILE_FORMAT, version: 1, name, savedAt: Date.now(), activeId: entries[0]?.id, autosave: true, entries }, path: null }
  } catch { return null }
}

/** The UI session: what the renderer autosaves (rundown, active timeline, concert file, SHOW mode). */
export interface Session { savedAt: number; rundown: unknown; [k: string]: unknown }

type Sink = (channel: string, payload: unknown) => void

const SESSION_WRITE_MS = 1000

export class EngineHost {
  readonly transport = new Transport(25)
  readonly osc = new OscClient('127.0.0.1', 7000)
  readonly recorder = new ArenaRecorder(this.osc)
  readonly rest = new ResolumeRest('127.0.0.1', 8080)
  readonly scheduler = new Scheduler(this.transport, this.osc, this.rest)
  currentShow: Show | null = null
  resolumeConnected = false

  private sinks = new Set<Sink>()
  private pingTimer: NodeJS.Timeout
  private session: Session | null = null
  // Revision of the session: a UI pushes the revision its change is based on, so a tablet
  // that missed changes (asleep, reconnecting) can't overwrite them with an older state.
  // Starts at the clock so revisions from before an app restart are always older.
  private rev = Date.now()
  private sessionFile = path.join(appDataDir(), 'session.json')
  private sessionTimer: NodeJS.Timeout | null = null
  // Arena recording as the app window last reported it (that window runs the recorder;
  // tablets and phones show it and ask the window to arm / stop over 'remote:cmd')
  private arenaRec: unknown = null

  constructor() {
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      if (isValidRundown(s?.rundown)) this.session = s
    } catch { /* first start */ }
    this.scheduler.onEvent((channel, payload) => this.emit(channel, payload))
    this.scheduler.onTick(() => this.emit('engine:tick', this.state()))
    this.scheduler.start()
    this.osc.connect()
    this.pingTimer = setInterval(() => this.checkResolume(), 2000)  // also feeds the live state strip
    this.checkResolume()
  }

  /** Receive every engine event (ticks, Resolume status, overrides, session changes). */
  addSink(sink: Sink): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  emit(channel: string, payload: unknown) {
    for (const sink of this.sinks) { try { sink(channel, payload) } catch { /* a closed client */ } }
  }

  state() {
    return {
      frame: this.transport.now(), playing: this.transport.playing, fps: this.transport.fps,
      showName: this.currentShow?.name ?? '', resolumeConnected: this.resolumeConnected,
    }
  }

  private async checkResolume() {
    const ok = await this.rest.ping()
    if (ok !== this.resolumeConnected) {
      this.resolumeConnected = ok
      this.emit('resolume:status', { connected: ok })
    }
    if (!ok) return
    const polledAt = Date.now()
    const comp = await this.rest.getComposition()
    if (!comp) return
    this.emit('resolume:compositionUpdate', comp)
    this.scheduler.noteClipStates((comp as any).layers ?? [], polledAt)
    this.scheduler.setDecks((comp.decks ?? []).map(d => ({ id: d.id, name: rv(d.name, ''), selected: !!rv(d.selected, false) })))
    const tc = (comp as any).tempocontroller?.tempo
    this.scheduler.setArenaTempo(tc?.id != null ? { id: tc.id, value: Number(rv(tc, 0)) } : null)
  }

  loadShow(show: Show) {
    this.currentShow = show
    this.osc.connect(show.resolume.host, show.resolume.oscPort)
    this.rest.setBase(show.resolume.host, show.resolume.restPort)
    this.scheduler.loadShow(show)
    return show
  }

  // Transport moves are announced, so the UI that plays the audio track follows a move
  // made on another UI (a tablet pressing Play)
  private transportCmd(cmd: 'play' | 'stop' | 'locate', from?: string) {
    this.scheduler.notify()
    this.emit('transport:cmd', { cmd, frame: this.transport.now(), playing: this.transport.playing, from: from ?? null })
    return null
  }

  private setSession(data: Session, from?: string, baseRev?: number) {
    if (!isValidRundown(data?.rundown)) return { ok: false, rev: this.rev, data: this.session }
    // Based on an older revision: refused, the UI takes the current session instead
    if (baseRev != null && baseRev !== this.rev && this.session) return { ok: false, rev: this.rev, data: this.session }
    this.session = data
    this.rev++
    this.emit('session:changed', { data, from: from ?? null, rev: this.rev })
    const result = { ok: true, rev: this.rev }
    if (this.sessionTimer) return result
    this.sessionTimer = setTimeout(() => this.flushSession(), SESSION_WRITE_MS)
    return result
  }

  flushSession() {
    if (this.sessionTimer) { clearTimeout(this.sessionTimer); this.sessionTimer = null }
    if (!this.session) return
    try {
      const tmp = `${this.sessionFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.session))
      fs.renameSync(tmp, this.sessionFile)
    } catch (e) { console.warn('[session] write failed', e) }
  }

  /** Calls the UI makes, by name (Electron IPC and the web RPC use the same names). */
  readonly methods: Record<string, (...args: any[]) => unknown> = {
    play: (from?: string) => { this.transport.play(); return this.transportCmd('play', from) },
    stop: (from?: string) => { this.transport.stop(); return this.transportCmd('stop', from) },
    locate: (frame: number, from?: string) => { this.transport.locate(frame); return this.transportCmd('locate', from) },
    getState: () => this.state(),
    recordStart: () => this.recorder.start(),
    recordStop: () => { this.recorder.stop(); return null },
    arenaRecPublish: (state: unknown) => { this.arenaRec = state; this.emit('arena:rec', state); return null },
    arenaRecGet: () => this.arenaRec,
    // A tablet / phone asks the app window to do what only it can ('arenaRec', 'play' armed)
    remoteCommand: (cmd: string, from?: string) => { this.emit('remote:cmd', { cmd, from: from ?? null }); return null },

    loadShowDirect: (show: Show) => this.loadShow(show),
    // Another timeline selected: loaded, stopped and at its start in one step, so the locate
    // recalls the new timeline's state (not the old one's), also when the playhead was at 0
    selectShow: (show: Show, from?: string) => {
      this.transport.stop()
      this.loadShow(show)
      this.transport.locate(0)
      this.scheduler.recallNow()
      return this.transportCmd('locate', from)
    },
    getCurrentShow: () => this.currentShow,
    sessionGet: () => this.session && { ...this.session, rev: this.rev },

    // Showfile on disk (only .rtshow files; not reachable from the tablet server)
    showfileDefaultPath: (name: string) => freeShowfilePath(showfilesDir(), name),
    showfileWrite: (file: string, data: unknown) => {
      if (!isShowfilePath(file) || !isShowfile(data)) return { ok: false, error: 'not a showfile' }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
        fs.renameSync(tmp, file)
        return { ok: true, savedAt: Date.now() }
      } catch (e) { return { ok: false, error: String((e as Error).message ?? e) } }
    },
    // Renaming the showfile in the app renames its file (same folder, never over another file)
    showfileRename: (file: string, name: string) => {
      if (!isShowfilePath(file)) return { ok: false, path: file }
      const next = freeShowfilePath(path.dirname(file), name, file)
      if (next === file) return { ok: true, path: file }
      try {
        if (fs.existsSync(file)) fs.renameSync(file, next)
        return { ok: true, path: next }
      } catch { return { ok: false, path: file } }
    },
    showfileRead: (file: string) => readShowfile(file),
    sessionSet: (data: Session, from?: string, baseRev?: number) => this.setSession(data, from, baseRev),

    getComposition: () => this.rest.getComposition(),
    getThumbnail: (layerId: number, clipId: number) => this.rest.getThumbnail(layerId, clipId),
    getLayerRaw: (layerIndex: number) => this.rest.getJson(`/composition/layers/${layerIndex}`),
    getGroupRaw: (groupIndex: number) => this.rest.getJson(`/composition/layergroups/${groupIndex}`),
    // By clip id: also reaches a clip of a deck Resolume isn't showing, while it is playing
    getClipById: (clipId: number) => this.rest.getJson(`/composition/clips/by-id/${clipId}`),
    getClipRaw: (layerIndex: number, clipIndex: number) =>
      this.rest.getJson(`/composition/layers/${layerIndex}/clips/${clipIndex}`),

    triggerClip: (layer: number, clip: number) => { this.osc.connectClip(layer, clip, 40); return null },
    triggerColumn: (column: number) => { this.osc.connectColumn(column); return null },
    clearLayer: (layer: number) => { this.osc.clearLayer(layer); return null },
    sendOsc: (address: string, value: number) => { this.osc.send(address, value); return null },
    selectDeck: async (index: number) => {
      const ok = await this.rest.selectDeck(index)
      if (ok) this.scheduler.noteDeckSelected(index)
      return ok
    },
    setParamById: (id: number, value: number | string | boolean) => {
      this.scheduler.noteSent(id, value)  // inspector fader: the app's own change, not an operator override
      return this.rest.setParamById(id, value)
    },
    getParamById: (id: number) => this.rest.getParamById(id),
    resetParam: (id: number) => { this.scheduler.forgetParam(id); return this.rest.resetParam(id) },
    // Several at once (a timeline switch): all requests in flight together
    resetParams: async (ids: number[]) => {
      for (const id of ids) this.scheduler.forgetParam(id)
      return (await Promise.all(ids.map(id => this.rest.resetParam(id)))).every(Boolean)
    },
    setTargets: (map: Record<string, LaneTarget>) => { this.scheduler.setTargets(map); return null },
    reenableAutomation: (ids?: string[]) => { this.scheduler.reenable(ids); return null },
    setRecordArmed: (armed: boolean) => { this.scheduler.setRecordArmed(armed); return null },
    connectResolume: async (host: string, oscPort: number, restPort: number) => {
      this.osc.connect(host, oscPort)
      this.rest.setBase(host, restPort)
      this.scheduler.reconnectWs()
      this.resolumeConnected = await this.rest.ping()
      this.emit('resolume:status', { connected: this.resolumeConnected })
      if (this.resolumeConnected) {
        const comp = await this.rest.getComposition()
        if (comp) this.emit('resolume:compositionUpdate', comp)
      }
      return this.resolumeConnected
    },
    fireCue: (cue: CueEvent, layer: number) => { this.scheduler.manualTriggerCue(cue, layer); return null },

    // LTC timecode from the renderer's audio decoder
    sendLtcFrame: (ltcAbsFrame: number) => {
      const show = this.currentShow
      if (!show) return null
      const src = show.clock.source
      if (src !== 'ltc' && src !== 'ltc-a' && src !== 'ltc-b') return null
      const offsetFrame = smpteToFrames(show.clock.offset || '00:00:00:00', this.transport.fps)
      this.transport.setLtcFrame(Math.max(0, ltcAbsFrame - offsetFrame))
      return null
    },
    sendLtcStop: () => {
      this.transport.clearLtc()
      this.scheduler.notify()   // ticks only fire on frame changes: tell the UI the transport stopped
      return null
    },
  }

  /** Before quitting: clips the engine paused play on again (at most `ms` waiting for Resolume). */
  releaseClips(ms = 500): Promise<unknown> {
    return Promise.race([this.scheduler.restoreAllClips(), new Promise(r => setTimeout(r, ms))])
  }

  dispose() {
    clearInterval(this.pingTimer)
    this.flushSession()
    void this.scheduler.restoreAllClips()   // usually done by releaseClips() already
    this.scheduler.stop()
    this.osc.close()
  }
}
