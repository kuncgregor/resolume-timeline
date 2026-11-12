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
    const comp = await this.rest.getComposition()
    if (!comp) return
    this.emit('resolume:compositionUpdate', comp)
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

    loadShowDirect: (show: Show) => this.loadShow(show),
    getCurrentShow: () => this.currentShow,
    sessionGet: () => this.session && { ...this.session, rev: this.rev },
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

  dispose() {
    clearInterval(this.pingTimer)
    this.flushSession()
    this.scheduler.stop()
    this.osc.close()
  }
}
