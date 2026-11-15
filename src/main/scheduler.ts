import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import { ResolumeWs } from './resolume-ws'
import type { Show, LayerTrack, GroupTrack, TriggerTrack, AutomationTrack, AutomationSubTrack, CueEvent, LaneKind, ClipCue } from '../shared/show'
import { frameKeyframes, sampleLane } from '../shared/automation'
import { toRestValue, normalize, type LaneTarget } from '../shared/paramTree'
import { rv } from '../shared/resolume'
import { continuesFrom, mediaStartOf } from '../shared/cues'

export type { LaneTarget }

const SEEK_THRESHOLD = 30
const ECHO_MS = 600        // how long a value we sent may still come back from Resolume
const AUTOMATION_MS = 16   // playing: lanes are sampled and sent this often (≈ 60 a second)
const AUTOMATION_STEP = 1e-5   // smallest change sent (normalised; 0.3 px of Position X)
const RELEASE_MS = 600     // REC: no operator change for this long = parameter released
const RECORD_MS = 40       // REC: at most one keyframe per lane per 40 ms (one frame at 25 fps)
const PREROLL_MS = 150     // cross-deck cues: deck switch starts this early (deck load ~100 ms)
const DRIFT_FRAMES = 2            // drift guard: a playing clip further off than this is corrected
const DRIFT_CHECK_MS = 2000       // ... checked this often (and after any small jump of the clock)
const TAKEOVER_FRAMES = 2         // a clip starting this soon after the previous one ends replaces it (no clear)
const AWAY_RESTORE_MS = 150      // a prepared connect puts the clip's playmodeaway back after this
const LINK_AFTER_CONNECT_MS = 30   // Resolume restarts a clip on connect; position it after that (~10 ms measured)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Equal within half a percent of the range (Resolume rounds floats), exact for discrete values
function sameValue(a: number | string | boolean, b: number | string | boolean, t: LaneTarget): boolean {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= Math.max(1e-6, 0.005 * Math.abs((t.max ?? 1) - (t.min ?? 0)))
  return a === b
}

// Layers inside a muted group are muted too
function mutedGroupIds(show: Show): Set<number> {
  return new Set(show.tracks.filter(t => t.type === 'group' && (t as GroupTrack).muted)
    .map(t => (t as GroupTrack).resolumeGroupId))
}
const isMuted = (lt: LayerTrack, mutedGroups: Set<number>) =>
  !!lt.muted || (lt.groupId !== undefined && mutedGroups.has(lt.groupId))
const follows = (cue: ClipCue) => cue.follow !== false
// What of a cue decides how it is linked: an edit of these while stopped links it again
const linkSig = (cue: ClipCue) => `${cue.id}|${follows(cue)}|${mediaStartOf(cue)}|${cue.time}`

// The clip a layer shows at frame T: the last one started, while its duration runs
// (trigger-only clips, duration 0, until the next one)
function clipAt(lt: LayerTrack, T: number, fps: number): ClipCue | null {
  let best: ClipCue | null = null, bestF = -1
  for (const c of lt.clips) {
    const f = smpteToFrames(c.time, fps)
    if (f <= T && f > bestF) { best = c; bestF = f }
  }
  if (!best) return null
  const dur = smpteToFrames(best.duration, fps)
  return dur === 0 || T < bestF + dur ? best : null
}

// Where a cue's media should be at a playhead frame, from its clip's JSON: time since the cue's
// start plus its media start, × speed, inside in/out per play mode. null = not positioned
// (BPM Sync transport, Random play mode).
function mediaMsAt(cue: ClipCue, c: any, frame: number, fps: number): number | null {
  if (rv(c.transporttype, 'Timeline') !== 'Timeline') return null
  const pos = c.transport.position, ctl = c.transport.controls
  const ms = ((frame - smpteToFrames(cue.time, fps) + mediaStartOf(cue)) / fps) * 1000 * Number(rv(ctl?.speed, 1))
  return mediaPosition(Math.max(0, ms), Number(pos.in ?? pos.min ?? 0), Number(pos.out ?? pos.max ?? 0), String(rv(ctl?.playmode, 'Loop')))
}

// Where a clip's media is after `ms` of playing, per Resolume play mode (in..out range)
function mediaPosition(ms: number, inMs: number, outMs: number, mode: string): number | null {
  const len = outMs - inMs
  if (!(len > 0)) return null
  if (mode === 'Random') return null
  if (mode === 'Loop') return inMs + (ms % len)
  if (mode === 'Bounce') { const p = ms % (2 * len); return inMs + (p < len ? p : 2 * len - p) }
  return inMs + Math.min(ms, len)   // play once: holds / clears at the end
}

export class Scheduler {
  private transport: Transport
  private osc: OscClient
  private rest: ResolumeRest
  private show: Show | null = null
  private lastFrame = -1
  // Last value sent per automation lane (lane id → normalized value or option name)
  private lastSent = new Map<string, number | string>()
  // Lanes whose keyframe span contained the playhead on the previous tick
  private wasInside = new Set<string>()
  private targets = new Map<string, LaneTarget>()
  // Manual changes in Resolume on automated parameters: last value we sent / last value seen
  // per lane, lanes suspended because the operator took over, and whether changes are recorded
  // Values sent per parameter id in the last ECHO_MS: Resolume reports them back with some
  // lag, so a read matching any of them is our own echo, anything else is the operator
  private recentSent = new Map<number, { value: number | string | boolean; at: number }[]>()
  private touchedAt = new Map<string, number>()      // REC: lane held by the operator (until release)
  private lastSeen = new Map<string, number | string | boolean>()
  private overridden = new Map<string, number>()   // lane id → operator's value, normalized
  private recordArmed = false
  private watchHandle: NodeJS.Timeout | null = null
  // Resolume decks as last seen (composition polls). `homeDeck` is the deck the operator is on,
  // `shownDeck` what Resolume shows right now (we switch it while firing cross-deck cues).
  private decks: { id: number; name: string }[] = []
  private homeDeck = 0
  private shownDeck = 0
  private deckJobs = 0
  private deckQueue: Promise<void> = Promise.resolve()
  // Bumped by stop, jumps and a new timeline: a queued cross-deck connect checks it is still wanted
  private epoch = 0
  private prerolled = new Set<string>()
  private eventCb: ((channel: string, payload: unknown) => void) | null = null
  private tickHandle: NodeJS.Timeout | null = null
  private tickCb: ((frame: number) => void) | null = null
  // Which cue is currently showing on each Resolume layer (1-based index → cue id).
  // A clip end only clears the layer if that clip is still the one showing.
  private activeCue = new Map<number, string>()
  private connectedAt = new Map<number, number>()   // layer → Date.now() of our last connect
  // Clips follow the playhead: stopped = paused on the playhead's frame, Play = resume from it.
  // pausedDir holds the play direction we replaced with '||' (clip id → layer, param, value).
  private linkedPlaying = false
  private pausedDir = new Map<number, { layer: number; paramId: number; value: string }>()
  private linkPending = new Map<number, { cue: ClipCue; delayMs: number; check: boolean; connectMs?: number }>()
  private driftCheckedAt = 0
  private linkRunning = new Set<number>()
  // Last-wins REST queue: one request in flight per parameter, newest value waits
  private restInFlight = new Set<number>()
  private restPending = new Map<number, number | string | boolean>()

  // Resolume's composition tempo (tempocontroller) as last seen, and what we pushed to it.
  // The BPM is pushed when a timeline loads or its BPM changes — not continuously, so an
  // operator who changes Arena's tempo during live VJing is not overruled.
  private arenaTempo: { id: number; value: number } | null = null
  private tempoPushed = ''

  // Operator changes arrive over Resolume's WebSocket; polling covers what it doesn't (yet)
  private ws: ResolumeWs
  private lastFullPoll = 0

  constructor(transport: Transport, osc: OscClient, rest: ResolumeRest) {
    this.transport = transport
    this.osc = osc
    this.rest = rest
    this.ws = new ResolumeWs(() => ({ host: rest.host, port: rest.port }))
    this.ws.onUpdate((id, value, initial) => this.onParamUpdate(id, value, initial))
  }

  loadShow(show: Show) {
    const first = this.show === null
    this.show = show
    if (show.frameRate !== this.transport.fps) this.transport.setFps(show.frameRate)
    this.transport.freewheelFrames = show.clock.freewheelFrames ?? 5
    // Edits arrive many times while playing; resetting lastFrame here would skip the
    // cues between the last tick and now.
    if (first) this.lastFrame = this.transport.now()
    this.dropGoneLanes()
    this.indexLanes()
    this.pushTempo()
    // Only lanes whose value at the playhead changed are sent (dedupe by lane); re-sending
    // everything on every edit would overwrite what the operator does in Resolume.
    this.updateAllAutomation(this.transport.now())
    this.relinkEdited()
  }

  // An edit of the clip the playhead stands in (follow switched, media start, moved) takes
  // effect at once while stopped: it is parked on the playhead again, or let go to run free.
  private linkedSig = new Map<number, string>()
  private relinkEdited() {
    if (!this.show || this.transport.playing) return
    const fps = this.show.frameRate, T = this.transport.now()
    for (const track of this.show.tracks) {
      if (track.type !== 'layer') continue
      const lt = track as LayerTrack, layer = lt.resolumeLayerIndex
      const clip = clipAt(lt, T, fps)
      if (layer < 1 || !clip || this.activeCue.get(layer) !== clip.id) continue
      const sig = linkSig(clip)
      const prev = this.linkedSig.get(layer)
      this.linkedSig.set(layer, sig)
      if (prev === undefined || prev === sig) continue
      if (follows(clip)) this.linkClip(layer, clip)
      else {
        // Runs free now: the direction we paused it with goes back
        const p = this.pausedDir.get(clip.clipId)
        if (p) { this.pausedDir.delete(clip.clipId); this.rest.setParamById(p.paramId, p.value) }
      }
    }
  }

  /** Tempo parameter from the latest composition poll (composition.tempocontroller.tempo). */
  setArenaTempo(t: { id: number; value: number } | null) {
    if (t?.id !== this.arenaTempo?.id) this.tempoPushed = ''   // new composition: push again
    this.arenaTempo = t
    this.pushTempo()
  }

  private linkedBpm(): number | null {
    const s = this.show
    if (!s || s.linkTempo === false || typeof s.bpm !== 'number' || !(s.bpm >= 20 && s.bpm <= 300)) return null
    return s.bpm
  }

  private pushTempo() {
    const bpm = this.linkedBpm()
    // Unlinked (or no BPM): forget the last push, so linking again sends the tempo at once
    if (bpm == null) { this.tempoPushed = ''; return }
    if (!this.arenaTempo) return
    const key = `${this.show!.name}|${bpm}|${this.arenaTempo.id}`
    if (key === this.tempoPushed) return
    this.tempoPushed = key
    if (Math.abs(this.arenaTempo.value - bpm) < 0.001) return
    this.rest.setParamById(this.arenaTempo.id, bpm)
      .then(ok => { if (ok && this.arenaTempo) this.arenaTempo.value = bpm; else if (!ok) this.tempoPushed = '' })
  }

  // Playing over a bar line resyncs Arena's beat, so clips the operator triggers by hand
  // (and Arena's beat-synced effects) run in phase with the timeline's bars
  // Arena's beat resynced to the timeline's bars (linked tempo) only when the timeline asks for it
  // (Beat resync: Once; off by default), once: at the first bar line after Play or a jump. Both clocks then run at the same tempo and stay together to a few ms over a
  // song. Pressing it every bar (the old way) made beat-synced content in Arena jump each bar: the
  // line is seen on the next frame, so the press lands up to a frame late.
  private resyncedSinceStart = false
  private resyncAtBars(lo: number, hi: number) {
    const bpm = this.linkedBpm()
    // Only while playing (scrubbing across a bar line stopped doesn't press it)
    if (bpm == null || !this.arenaTempo || !this.show || this.show.tempoResync !== 'start' || !this.transport.playing) return
    const fps = this.show.frameRate
    const barF = (fps * 60 / bpm) * (this.show.beatsPerBar ?? 4)
    const db = this.show.downbeat ? smpteToFrames(this.show.downbeat, fps) : 0
    if (hi < db || !(barF > 0)) return
    if (this.resyncedSinceStart || Math.floor((lo - db) / barF) >= Math.floor((hi - db) / barF)) return
    this.resyncedSinceStart = true
    this.osc.send('/composition/tempocontroller/resync', 1)   // press + release, like the button
    setTimeout(() => this.osc.send('/composition/tempocontroller/resync', 0), 30)
  }

  /** Resolved targets from the renderer's resolver (lane id → Resolume parameter). */
  setTargets(map: Record<string, LaneTarget>) {
    this.targets = new Map(Object.entries(map))
    this.dropGoneLanes()
    this.ws.setParams(new Set([...this.targets.values()].map(t => t.paramId)))
    this.indexLanes()
    this.updateAllAutomation(this.transport.now())
  }

  // Lanes no longer in the show (another timeline): what was seen of them is stale; when they
  // come back their parameter may have changed meanwhile (reset, another timeline) without the
  // operator touching it, so they start from a fresh baseline and not overridden. A lane still
  // in the show but unresolved for a moment (its clip's deck not shown, Resolume reconnecting)
  // keeps its override: the operator's hand stays on that parameter.
  private dropGoneLanes() {
    const ids = new Set<string>()
    for (const t of this.show?.tracks ?? []) if (t.type === 'layer' || t.type === 'group')
      for (const a of (t as LayerTrack | GroupTrack).automations) ids.add(a.id)
    for (const id of [...this.lastSeen.keys()]) if (!ids.has(id)) this.lastSeen.delete(id)
    let dropped = false
    for (const id of [...this.overridden.keys()]) if (!ids.has(id)) { this.overridden.delete(id); dropped = true }
    if (dropped) this.emitOverrides()
  }

  onTick(cb: (frame: number) => void) { this.tickCb = cb }
  onEvent(cb: (channel: string, payload: unknown) => void) { this.eventCb = cb }

  /** Deck list from the latest composition poll. */
  setDecks(decks: { id: number; name: string; selected: boolean }[]) {
    this.decks = decks.map(d => ({ id: d.id, name: d.name }))
    // While our own deck switches run, the poll may show a transient deck
    const sel = decks.findIndex(d => d.selected) + 1
    if (sel > 0 && this.deckJobs === 0) { this.homeDeck = sel; this.shownDeck = sel }
  }

  /** The app selected a deck itself (clip browser tabs). */
  noteDeckSelected(index: number) {
    if (this.deckJobs === 0) { this.homeDeck = index; this.shownDeck = index }
  }

  // 1-based deck index of a cue's deck: by id, else by name, else the stored index
  private deckIndexOf(cue: ClipCue): number {
    if (cue.deckId === undefined && cue.deckIndex === undefined) return 0
    const byId = this.decks.findIndex(d => d.id === cue.deckId)
    if (byId >= 0) return byId + 1
    const byName = cue.deckName ? this.decks.findIndex(d => d.name === cue.deckName) : -1
    if (byName >= 0) return byName + 1
    return cue.deckIndex ?? 0
  }

  // Fire a clip from its deck. Only the shown deck's clips can be triggered and Resolume loads a
  // deck asynchronously (~100 ms measured), so a cross-deck cue selects the deck, waits until
  // the slot shows the clip, connects over REST and (by default) returns to the operator's deck;
  // the clip keeps playing. While such a job runs, every other clip trigger joins the same queue
  // so it cannot hit the wrong deck. `atMs` delays the connect for cues queued ahead of time.
  private connectCue(layer: number, cue: ClipCue, releaseMs: number, atMs?: number) {
    const target = this.deckIndexOf(cue)
    if (this.deckJobs === 0 && (!target || target === this.shownDeck || !this.decks.length)) {
      this.osc.connectClip(layer, cue.clipIndex, releaseMs)
      return
    }
    this.deckJobs++
    const epoch = this.epoch
    this.deckQueue = this.deckQueue.then(async () => {
      const want = target || this.homeDeck
      if (want && want !== this.shownDeck) {
        if (await this.rest.selectDeck(want)) {
          this.shownDeck = want
          await this.waitForSlot(layer, cue.clipIndex, cue.clipId)
        }
      }
      if (atMs !== undefined) { const d = atMs - Date.now(); if (d > 0) await sleep(d) }
      // Stop, a jump or another timeline while it waited (deck load, preroll): not on air now
      if (epoch !== this.epoch) return
      await this.rest.connectClip(layer, cue.clipIndex)
    }).catch(() => {}).then(async () => {
      if (--this.deckJobs > 0) return
      if (this.show?.deckReturn === false) { this.homeDeck = this.shownDeck; return }
      if (this.homeDeck && this.shownDeck !== this.homeDeck) {
        await sleep(30)
        if (await this.rest.selectDeck(this.homeDeck)) this.shownDeck = this.homeDeck
      }
    })
  }

  // Until the slot reports the expected clip (deck loaded), at most 400 ms
  private async waitForSlot(layer: number, slot: number, clipId: number) {
    const t0 = Date.now()
    while (Date.now() - t0 < 400) {
      const c = await this.rest.getJson(`/composition/layers/${layer}/clips/${slot}`)
      if (c?.id === clipId) return
      await sleep(8)
    }
  }

  // Every clip the timeline connects goes through here: the layer's clip is ours from now on
  // Returns true when the connect also brings the clip to the playhead (no linkClip needed):
  // a clip starting inside its media (mediaStart), or any following clip while stopped, is
  // paused, positioned and then connected, so Resolume never shows its first frame.
  private connectLayer(layer: number, cue: ClipCue, releaseMs: number, atMs?: number): boolean {
    this.restoreLayer(layer, cue.clipId)
    const target = this.deckIndexOf(cue)
    const shown = this.deckJobs === 0 && (!target || target === this.shownDeck || !this.decks.length)
    const prepared = shown && atMs === undefined && (mediaStartOf(cue) > 0 || (!this.transport.playing && follows(cue)))
    // The layer is this clip's before the connect job runs (it checks it)
    this.linkedSig.set(layer, linkSig(cue))
    this.activeCue.set(layer, cue.id)
    this.connectedAt.set(layer, Date.now())
    if (prepared) {
      this.linkPending.set(layer, { cue, delayMs: 0, check: false, connectMs: releaseMs })
      if (!this.linkRunning.has(layer)) void this.runLinks(layer)
    } else this.connectCue(layer, cue, releaseMs, atMs)
    return prepared
  }

  private clearLayer(layer: number) {
    this.restoreLayer(layer)
    this.osc.clearLayer(layer)
    this.activeCue.delete(layer)
  }

  // Clips we paused on a layer get their play direction back when they leave it, so a clip
  // the operator triggers later by hand doesn't sit frozen
  private restoreLayer(layer: number, keepClipId?: number) {
    for (const [clipId, p] of this.pausedDir) {
      if (p.layer !== layer || clipId === keepClipId) continue
      this.pausedDir.delete(clipId)
      this.rest.setParamById(p.paramId, p.value)
    }
  }

  /** All clips we paused play on (the app quits). Resolves when Resolume has answered. */
  restoreAllClips(): Promise<unknown> {
    const sent = [...this.pausedDir.values()].map(p => this.rest.setParamById(p.paramId, p.value))
    this.pausedDir.clear()
    return Promise.all(sent)
  }

  // Bring a connected clip's media to the playhead: position = time since the clip's start
  // (Timeline transport; speed, in/out and play mode applied), paused while the transport is
  // stopped. One job per layer, the newest request wins (scrubbing sends many). Clips set to
  // run free (follow: false) are left alone.
  private linkClip(layer: number, cue: ClipCue, delayMs = 0) {
    this.linkedSig.set(layer, linkSig(cue))
    if (!follows(cue)) return
    if (this.linkPending.get(layer)?.connectMs !== undefined && this.linkPending.get(layer)!.cue.id === cue.id) return   // its connect positions it
    this.linkPending.set(layer, { cue, delayMs, check: false })
    if (!this.linkRunning.has(layer)) void this.runLinks(layer)
  }

  // Drift guard: read where a playing clip is and correct it only when it is more than
  // DRIFT_FRAMES off (a small LTC jump, a stall). A link already queued wins.
  private checkClip(layer: number, cue: ClipCue) {
    if (!follows(cue) || this.linkPending.has(layer) || this.linkRunning.has(layer)) return
    this.linkPending.set(layer, { cue, delayMs: 0, check: true })
    void this.runLinks(layer)
  }

  private async runLinks(layer: number) {
    this.linkRunning.add(layer)
    try {
      for (let job = this.linkPending.get(layer); job; job = this.linkPending.get(layer)) {
        this.linkPending.delete(layer)
        if (this.deckJobs > 0) await this.deckQueue      // cross-deck connect still running
        if (job.delayMs > 0) await sleep(job.delayMs)    // Resolume restarts a clip on connect
        if (this.linkPending.has(layer)) continue
        await this.syncClip(layer, job.cue, job.check, job.connectMs)
      }
    } finally { this.linkRunning.delete(layer) }
  }

  // connectMs: connect the clip here (prepared connect, see connectLayer), release after ms
  private async syncClip(layer: number, cue: ClipCue, check = false, connectMs?: number) {
    if (!this.show || this.activeCue.get(layer) !== cue.id) return   // another clip took the layer
    const t0 = this.transport.exactFrame()
    const c = await this.rest.getJson(`/composition/clips/by-id/${cue.clipId}`)
    const pos = c?.transport?.position, dirP = c?.transport?.controls?.playdirection
    if (connectMs !== undefined && (!pos || !dirP)) { this.osc.connectClip(layer, cue.clipIndex, connectMs); return }
    if (!pos || !dirP || this.activeCue.get(layer) !== cue.id) return
    const fps = this.show.frameRate
    const playing = this.transport.playing
    if (connectMs !== undefined) { await this.connectPositioned(layer, cue, c, connectMs); return }
    if (check && !playing) return
    const dir = String(dirP.value)
    const setDirection = async () => {
      if (playing) {
        const p = this.pausedDir.get(cue.clipId)
        this.pausedDir.delete(cue.clipId)
        if (p && dir === '||') await this.rest.setParamById(p.paramId, p.value)
      } else if (dir !== '||') {   // a clip the operator paused stays theirs
        this.pausedDir.set(cue.clipId, { layer, paramId: dirP.id, value: dir })
        await this.rest.setParamById(dirP.id, '||')
      }
    }
    if (!playing && !check) await setDirection()   // pause first, so the position set below holds
    if (check) {
      // Compare with where the media should have been when Resolume answered (the middle of
      // the request); a loop wrapping between the two counts the short way round
      const want = mediaMsAt(cue, c, (t0 + this.transport.exactFrame()) / 2, fps)
      if (want === null || dir === '||') return
      const len = Number(pos.out ?? pos.max ?? 0) - Number(pos.in ?? pos.min ?? 0)
      let off = Math.abs(Number(pos.value) - want)
      if (rv(c.transport.controls?.playmode, 'Loop') === 'Loop' && len > 0) off = Math.min(off, len - off)
      if (off <= (DRIFT_FRAMES * 1000) / fps) return
    }
    const ms = mediaMsAt(cue, c, playing ? this.transport.exactFrame() : this.transport.now(), fps)
    if (ms !== null) await this.rest.setParamById(pos.id, ms)
    if (check) return
    if (playing) await setDirection()   // resume once the media is on the playhead
  }

  // Prepared connect: positioned, then connected with the clip's "playmodeaway" set to Continue
  // for the moment, so Resolume keeps the position instead of restarting the clip (measured:
  // with Restart the reset lands on Resolume's next frame, sometimes after our position set).
  // A clip that should hold on the playhead (stopped) is paused first. The clip's own setting
  // is put back once Resolume has taken the connect.
  private async connectPositioned(layer: number, cue: ClipCue, c: any, releaseMs: number) {
    const fps = this.show!.frameRate
    const pos = c.transport.position, dirP = c.transport.controls.playdirection
    const awayP = c.transport.controls.playmodeaway
    const dir = String(dirP.value)
    const away = awayP ? String(awayP.value) : null
    const hold = !this.transport.playing && follows(cue)
    // The three sets are independent (each only has to land before the connect): sent together,
    // the connect waits one round trip, not three — during playback every one of them is late
    // A free-running clip starts from its own start, a following one from the playhead
    const ms = mediaMsAt(cue, c, follows(cue) ? this.transport.exactFrame() : smpteToFrames(cue.time, fps), fps)
    await Promise.all([
      awayP && away !== 'Continue' ? this.rest.setParamById(awayP.id, 'Continue') : null,
      hold && dir !== '||' ? this.rest.setParamById(dirP.id, '||') : null,
      ms !== null ? this.rest.setParamById(pos.id, ms) : null,
    ])
    const restoreAway = () => { if (awayP && away && away !== 'Continue') setTimeout(() => this.rest.setParamById(awayP.id, away), AWAY_RESTORE_MS) }
    if (this.activeCue.get(layer) !== cue.id) {   // another clip took the layer meanwhile
      if (hold && dir !== '||') this.rest.setParamById(dirP.id, dir)
      restoreAway()
      return
    }
    this.osc.connectClip(layer, cue.clipIndex, releaseMs)
    this.connectedAt.set(layer, Date.now())   // the poll's grace counts from the real connect
    restoreAway()
    if (hold) {
      if (dir !== '||') this.pausedDir.set(cue.clipId, { layer, paramId: dirP.id, value: dir })
      return
    }
    // Playing (or running free): a clip we had paused before gets its direction back
    const p = this.pausedDir.get(cue.clipId)
    this.pausedDir.delete(cue.clipId)
    if (dir === '||' && p) await this.rest.setParamById(dirP.id, p.value)
  }

  // Drift guard over every following clip the playhead is in (playing only)
  private checkClips(T: number) {
    if (!this.show) return
    const fps = this.show.frameRate
    const mutedGroups = mutedGroupIds(this.show)
    for (const track of this.show.tracks) {
      if (track.type !== 'layer') continue
      const lt = track as LayerTrack
      const layer = lt.resolumeLayerIndex
      if (layer < 1 || isMuted(lt, mutedGroups)) continue
      const clip = clipAt(lt, T, fps)
      if (clip && this.activeCue.get(layer) === clip.id) this.checkClip(layer, clip)
    }
  }

  // Connected clips from a composition poll (shown deck): a layer the operator cleared or
  // retriggered in Resolume is not ours any more, so the next seek connects our clip again
  // instead of only moving its position. Polls started before our last connect are ignored.
  noteClipStates(layers: { clips?: { id: number; connected?: unknown }[] }[], polledAt: number) {
    if (!this.show || this.deckJobs > 0) return
    const cues = new Map<string, ClipCue>()
    for (const t of this.show.tracks) if (t.type === 'layer') for (const c of (t as LayerTrack).clips) cues.set(c.id, c)
    for (const [layer, cueId] of this.activeCue) {
      const cue = cues.get(cueId)
      if (!cue || polledAt < (this.connectedAt.get(layer) ?? 0) + 200) continue
      // A prepared connect still on its way (REST sets before the OSC connect): not disconnected
      if (this.linkPending.get(layer)?.connectMs !== undefined || this.linkRunning.has(layer)) continue
      const deck = this.deckIndexOf(cue)
      if (deck && deck !== this.shownDeck) continue
      const clip = layers[layer - 1]?.clips?.find(c => c.id === cue.clipId)
      const state = String(rv(clip?.connected as any, ''))
      if (!state.startsWith('Connected')) { this.activeCue.delete(layer); this.restoreLayer(layer) }
    }
  }

  /** REC armed: operator changes in Resolume become keyframes instead of overrides. */
  setRecordArmed(armed: boolean) {
    this.recordArmed = armed
    if (!armed && this.recordTimer) { clearTimeout(this.recordTimer); this.recordTimer = null; this.recordPending.clear() }
  }

  /** The show's state at the playhead now (clips, lanes), whether or not the frame changed. */
  recallNow() {
    const T = this.transport.now()
    this.recallStateAt(T)
    this.lastFrame = T
    this.linkTransport(T, true)
  }

  /** A parameter was reset to its default: lanes on it send again as soon as they cover the playhead. */
  forgetParam(paramId: number) {
    for (const [laneId, t] of this.targets) if (t.paramId === paramId) { this.lastSent.delete(laneId); this.wasInside.delete(laneId); this.lastSeen.delete(laneId) }
    this.resetAt.set(paramId, Date.now())
  }
  // Parameters the app reset to their default: the change that follows is ours, not the operator's
  private resetAt = new Map<number, number>()

  /** Hand overridden lanes back to the timeline (all, or the given ids). */
  reenable(ids?: string[]) {
    for (const id of ids ?? [...this.overridden.keys()]) {
      this.overridden.delete(id)
      this.lastSent.delete(id)
    }
    this.emitOverrides()
    this.updateAllAutomation(this.transport.now(), true)
  }

  /** Value set by the app itself (engine or inspector fader): not an operator change. */
  noteSent(paramId: number, value: number | string | boolean) {
    const now = Date.now()
    const list = (this.recentSent.get(paramId) ?? []).filter(e => now - e.at < ECHO_MS)
    list.push({ value, at: now })
    this.recentSent.set(paramId, list)
  }

  private isEcho(paramId: number, value: number | string | boolean, t: LaneTarget): boolean {
    const now = Date.now()
    if (now - (this.resetAt.get(paramId) ?? 0) < ECHO_MS) return true
    return (this.recentSent.get(paramId) ?? []).some(e => now - e.at < ECHO_MS && sameValue(e.value, value, t))
  }

  private emitOverrides() { this.eventCb?.('engine:overrides', Object.fromEntries(this.overridden)) }

  // Ticks only fire when the frame changes; play/stop/locate call this so the UI
  // sees the new transport state even when the frame stays the same.
  notify() { this.tickCb?.(this.transport.now()) }

  start() {
    if (this.tickHandle) return
    this.tickHandle = setInterval(() => this.tick(), 8)
    this.watchHandle = setInterval(() => { this.watchManualChanges().catch(e => console.error('[scheduler] watch error', e)) }, 250)
    this.ws.start()
  }

  stop() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null }
    if (this.watchHandle) { clearInterval(this.watchHandle); this.watchHandle = null }
    this.ws.stop()
  }

  // Automated lanes Resolume should be watched for, with their targets (muted / disabled skip)
  private *watchedLanes(): Generator<[AutomationSubTrack, LaneTarget]> {
    if (!this.show) return
    const mutedGroups = mutedGroupIds(this.show)
    for (const track of this.show.tracks) {
      if (track.type === 'group' ? (track as GroupTrack).muted
        : track.type !== 'layer' || isMuted(track as LayerTrack, mutedGroups)) continue
      for (const auto of (track as LayerTrack | GroupTrack).automations) {
        const target = this.targets.get(auto.id)
        if (target && auto.enabled !== false) yield [auto, target]
      }
    }
  }

  // A value of an automated parameter as Resolume reports it (WebSocket push or poll).
  // Not our own echo and different from the last one seen = the operator moved it.
  private observe(auto: AutomationSubTrack, target: LaneTarget, value: number | string | boolean) {
    const seen = this.lastSeen.get(auto.id)
    this.lastSeen.set(auto.id, value)
    if (seen === undefined || sameValue(seen, value, target)) return
    if (this.isEcho(target.paramId, value, target)) return
    const v = normalize({ kind: target.kind, min: target.min, max: target.max, options: target.options }, value)
    if (this.recordArmed) {
      // Touch: the lane stops sending while the operator holds the parameter
      this.touchedAt.set(auto.id, Date.now())
      this.queueRecord(auto.id, v, target.kind === 'choice' ? String(value) : undefined)
    } else {
      this.overridden.set(auto.id, v)
      this.emitOverrides()
    }
  }

  // Pushes arrive at frame rate (our own sends echo back too): look lanes up by parameter id
  private lanesByParam = new Map<number, [AutomationSubTrack, LaneTarget][]>()
  private indexLanes() {
    this.lanesByParam.clear()
    for (const [auto, target] of this.watchedLanes()) {
      const list = this.lanesByParam.get(target.paramId)
      if (list) list.push([auto, target]); else this.lanesByParam.set(target.paramId, [[auto, target]])
    }
  }

  // REC: WebSocket pushes come per fader step; the renderer writes one keyframe per lane per
  // RECORD_MS (the latest value), so a recorded move doesn't rebuild the show 60 times a second
  private recordPending = new Map<string, { value: number; option?: string }>()
  private recordTimer: NodeJS.Timeout | null = null
  private queueRecord(laneId: string, value: number, option?: string) {
    this.recordPending.set(laneId, { value, option })
    if (this.recordTimer) return
    this.recordTimer = setTimeout(() => {
      this.recordTimer = null
      for (const [id, r] of this.recordPending) this.eventCb?.('engine:record', { laneId: id, value: r.value, option: r.option })
      this.recordPending.clear()
    }, RECORD_MS)
  }

  private onParamUpdate(id: number, value: number | string | boolean, initial: boolean) {
    for (const [auto, target] of this.lanesByParam.get(id) ?? []) {
      if (initial) { if (!this.lastSeen.has(auto.id)) this.lastSeen.set(auto.id, value) }
      else this.observe(auto, target, value)
    }
  }

  /** Reconnect the WebSocket now (Resolume host changed / reconnect pressed). */
  reconnectWs() { this.ws.reconnect() }

  // Polls automated parameters (REST by id, ~0.3 ms each on localhost) that the WebSocket
  // doesn't cover yet; every 2 s all of them, in case a push was missed.
  private watching = false
  private async watchManualChanges() {
    if (this.watching || !this.show) return
    this.watching = true
    try {
      const full = Date.now() - this.lastFullPoll > 2000
      if (full) this.lastFullPoll = Date.now()
      for (const [auto, target] of [...this.watchedLanes()]) {
        if (!full && this.ws.isLive(target.paramId)) continue
        const p = await this.rest.getParamById(target.paramId)
        if (!p || p.value === undefined) continue
        this.observe(auto, target, p.value as number | string | boolean)
      }
    } finally {
      this.watching = false
    }
  }

  private wasPlaying = false
  private autoAt = 0
  /** Playing: the lanes at the exact playhead (between frames too). */
  private updateAutomationNow() {
    this.autoAt = performance.now()
    this.updateAllAutomation(this.transport.exactFrame())
  }
  // An error in one tick must not stop the show: logged (now and then), and the playhead taken
  // as reached, so the same frame doesn't throw again every 8 ms
  private tickErrors = 0
  private tick() {
    try { this.tickFrame() } catch (e) {
      if (this.tickErrors++ % 500 === 0) console.error('[scheduler] tick error', e)
      this.lastFrame = this.transport.now()
    }
  }
  private tickFrame() {
    const T = this.transport.now()
    if (this.transport.playing !== this.linkedPlaying) {
      this.linkedPlaying = this.transport.playing
      if (!this.transport.playing) this.epoch++   // stopped: queued cross-deck connects are off
      this.linkTransport(T)
    }
    // Stopped = the next frame change starts playback (the first frames after Play may not move)
    if (T === this.lastFrame) {
      if (!this.transport.playing) { this.wasPlaying = false; return }
      // Between frames: the lanes move on at the exact (fractional) position, at most every
      // AUTOMATION_MS — a fade or a move reaches Resolume as smoothly as it draws, not in
      // 25 steps a second
      if (performance.now() - this.autoAt >= AUTOMATION_MS) this.updateAutomationNow()
      return
    }
    const starting = !this.wasPlaying
    this.wasPlaying = this.transport.playing
    if (starting) this.resyncedSinceStart = false   // Play: the next bar line resyncs Arena's beat
    const delta = T - this.lastFrame
    if (Math.abs(delta) >= SEEK_THRESHOLD || delta < 0) {
      this.recallStateAt(T)
    } else {
      this.fireBetween(this.lastFrame, T)
      // Starting playback exactly on a bar line (Play at bar 1) counts as crossing it
      this.resyncAtBars(starting ? this.lastFrame - 0.5 : this.lastFrame, T)
      // Small steps while stopped (scrubbing, nudging) move the paused clips along
      if (!this.transport.playing) this.linkTransport(T, true)
      // Playing: check the clips now and then, and at once after a jump too small to count
      // as a seek (LTC skipping a few frames, a stalled tick)
      else if (delta > 2 || Date.now() - this.driftCheckedAt > DRIFT_CHECK_MS) {
        this.driftCheckedAt = Date.now()
        this.checkClips(T)
      }
    }
    if (this.transport.playing) this.updateAutomationNow(); else this.updateAllAutomation(T)
    this.lastFrame = T
    this.tickCb?.(T)
  }

  // Play / stop (internal clock or LTC): clips at the playhead pause on its frame or resume
  // from it. Play and moves while stopped also connect a clip the playhead stands in that
  // isn't showing yet (a clip starting on the frame Play starts from is never crossed);
  // Stop leaves a layer the operator cleared alone.
  private linkTransport(T: number, connect = this.transport.playing) {
    if (!this.show) return
    const fps = this.show.frameRate
    const playing = this.transport.playing
    const mutedGroups = mutedGroupIds(this.show)
    const linked = new Set<number>()
    for (const track of this.show.tracks) {
      if (track.type !== 'layer') continue
      const lt = track as LayerTrack
      const layer = lt.resolumeLayerIndex
      if (layer < 1 || isMuted(lt, mutedGroups)) continue
      const clip = clipAt(lt, T, fps)
      if (!clip) continue
      if (this.activeCue.get(layer) === clip.id) this.linkClip(layer, clip)
      else if (connect) { if (!this.connectLayer(layer, clip, 50)) this.linkClip(layer, clip, LINK_AFTER_CONNECT_MS) }
      else continue
      if (follows(clip)) linked.add(clip.clipId)
    }
    if (!playing) return
    for (const [clipId, p] of this.pausedDir) {
      if (linked.has(clipId)) continue
      this.pausedDir.delete(clipId)
      this.rest.setParamById(p.paramId, p.value)
    }
  }

  private fireBetween(lo: number, hi: number) {
    if (!this.show) return
    const fps = this.show.frameRate
    const mutedGroups = mutedGroupIds(this.show)
    for (const track of this.show.tracks) {
      if (track.type === 'trigger') {
        const t = track as TriggerTrack
        for (const evt of t.events) {
          const f = smpteToFrames(evt.time, fps)
          if (f > lo && f <= hi) this.fireCue(evt, t.resolumeLayer)
        }
      } else if (track.type === 'layer') {
        const lt = track as LayerTrack
        const layer = lt.resolumeLayerIndex
        if (layer < 1 || isMuted(lt, mutedGroups)) continue  // gone from Resolume, or muted
        // Ends before starts, so a clip ending on the frame the next one starts
        // does not clear the new clip. A clip followed by another one on the layer (from its
        // end up to TAKEOVER_FRAMES later) isn't cleared at all: the next one replaces it,
        // so Resolume's layer transition blends A into B instead of A into an empty layer.
        for (const clip of lt.clips) {
          const durF = smpteToFrames(clip.duration, fps)
          if (durF <= 0) continue
          const endF = smpteToFrames(clip.time, fps) + durF
          if (!(endF > lo && endF <= hi && this.activeCue.get(layer) === clip.id)) continue
          const next = lt.clips.some(c => { const f = smpteToFrames(c.time, fps); return c !== clip && f > lo && f <= endF + TAKEOVER_FRAMES })
          if (!next) this.clearLayer(layer)
        }
        // Cross-deck cues start their deck switch PREROLL_MS early so they fire on time
        const pre = Math.ceil((PREROLL_MS / 1000) * fps)
        for (const clip of lt.clips) {
          const sf = smpteToFrames(clip.time, fps)
          const target = this.deckIndexOf(clip)
          const crossDeck = target !== 0 && target !== this.homeDeck && this.decks.length > 0
          if (crossDeck && sf - pre > lo && sf - pre <= hi && !this.prerolled.has(clip.id)) {
            this.prerolled.add(clip.id)
            this.connectCue(layer, clip, clip.release ? 40 : 0, Date.now() + ((sf - hi) / fps) * 1000)
          }
          if (sf > lo && sf <= hi) {
            let prepared = false
            const prev = lt.clips.find(c => c.id === this.activeCue.get(layer))
            if (prev && continuesFrom(prev, clip, t => smpteToFrames(t, fps)) && this.transport.playing) {
              // The same clip carrying on (an editor split): it keeps playing, no retrigger
              this.activeCue.set(layer, clip.id)
              continue
            }
            if (this.prerolled.delete(clip.id)) {
              this.restoreLayer(layer, clip.clipId)
              this.activeCue.set(layer, clip.id)
              this.connectedAt.set(layer, Date.now())
            } else prepared = this.connectLayer(layer, clip, clip.release ? 40 : 0)
            // A small step while stopped, a clip we paused before, or one starting inside its
            // media that couldn't be prepared (other deck): bring it to the playhead
            if (!prepared && (!this.transport.playing || this.pausedDir.has(clip.clipId) || mediaStartOf(clip) > 0))
              this.linkClip(layer, clip, LINK_AFTER_CONNECT_MS)
          }
        }
      }
    }
  }

  private updateAllAutomation(T: number, force = false) {
    if (!this.show) return
    const fps = this.show.frameRate
    const mutedGroups = mutedGroupIds(this.show)
    for (const track of this.show.tracks) {
      if (track.type === 'automation') {
        const at = track as AutomationTrack
        const sample = sampleLane(frameKeyframes(at.keyframes, fps, t => smpteToFrames(t, fps)), T)
        if (sample && (force || this.lastSent.get(at.id) !== sample.value)) {
          this.osc.setParam(at.target, sample.value)
          this.lastSent.set(at.id, sample.value)
        }
      } else if (track.type === 'layer' || track.type === 'group') {
        if (track.type === 'group' ? (track as GroupTrack).muted : isMuted(track as LayerTrack, mutedGroups)) continue
        for (const auto of (track as LayerTrack | GroupTrack).automations) this.updateLane(auto, T, fps, force)
      }
    }
  }

  private updateLane(auto: AutomationSubTrack, T: number, fps: number, force: boolean) {
    if (auto.enabled === false || !auto.keyframes.length || this.overridden.has(auto.id)) return
    // REC touch: released after RELEASE_MS without a new operator change
    const touched = this.touchedAt.get(auto.id)
    if (touched !== undefined) {
      if (Date.now() - touched < RELEASE_MS) return
      this.touchedAt.delete(auto.id)
      this.lastSent.delete(auto.id)
    }
    const kind = auto.kind ?? 'range'
    const kfs = frameKeyframes(auto.keyframes, fps, t => smpteToFrames(t, fps))
    const inside = T >= kfs[0].frame && T <= kfs[kfs.length - 1].frame
    const hold = auto.outside === 'hold'
    const afterEnd = T > kfs[kfs.length - 1].frame
    // Outside its keyframe span a lane leaves the parameter to the operator. Exceptions:
    // crossing the last keyframe sends the exact end value once (fades land where they
    // should), and after a seek a lane whose span has already ended chases to its end
    // value, so jumping past a fade-out shows the faded state.
    const crossedEnd = afterEnd && this.wasInside.has(auto.id)
    if (inside) this.wasInside.add(auto.id); else this.wasInside.delete(auto.id)
    if (!inside && !hold && !crossedEnd && !(force && afterEnd)) return
    const sample = sampleLane(kfs, T, kind)
    if (!sample) return
    const key = kind === 'choice' ? (sample.option ?? sample.value) : sample.value
    const last = this.lastSent.get(auto.id)
    // Unchanged values aren't sent again. The step is tiny: 0.1 % of the range (what it was) is
    // 33 px on Position X, so a slow move went out in visible jumps a few times a second
    if (!force && last !== undefined && (typeof key === 'string' || typeof last === 'string'
      ? key === last : Math.abs(key - last) <= AUTOMATION_STEP)) return
    this.lastSent.set(auto.id, key)
    this.dispatchLane(auto, kind, sample.value, sample.option)
  }

  // Lanes resolved to a Resolume parameter id are sent over REST by id (real values;
  // works for every effect and duplicate instances). OSC is only used for old lanes
  // without a stable target, and a lane whose target is missing sends nothing.
  private dispatchLane(auto: AutomationSubTrack, kind: LaneKind, v: number, option?: string) {
    const target = this.targets.get(auto.id)
    if (target) {
      const real = toRestValue(target.kind ?? kind, v, target, option)
      this.noteSent(target.paramId, real)
      this.lastSeen.set(auto.id, real)
      if (!this.ws.set(target.paramId, real)) this.restSend(target.paramId, real)
      return
    }
    if (auto.ref) return
    this.osc.setParam(auto.target, v)
  }

  private restSend(id: number, value: number | string | boolean) {
    if (this.restInFlight.has(id)) { this.restPending.set(id, value); return }
    this.restInFlight.add(id)
    this.rest.setParamById(id, value)
      .then(ok => { if (!ok) console.warn('[REST] set failed', id, value) })
      .finally(() => {
        this.restInFlight.delete(id)
        if (this.restPending.has(id)) {
          const next = this.restPending.get(id)!
          this.restPending.delete(id)
          this.restSend(id, next)
        }
      })
  }

  private recallStateAt(T: number) {
    if (!this.show) return
    this.epoch++   // a jump: what was queued for the old position is not wanted any more
    this.resyncedSinceStart = false   // a jump: the next bar line resyncs Arena's beat
    this.prerolled.clear()
    const fps = this.show.frameRate
    const mutedGroups = mutedGroupIds(this.show)
    for (const track of this.show.tracks) {
      if (track.type === 'trigger') {
        const t = track as TriggerTrack
        const cue = t.events
          .filter(e => smpteToFrames(e.time, fps) <= T)
          .sort((a, b) => smpteToFrames(b.time, fps) - smpteToFrames(a.time, fps))[0]
        if (cue) this.fireCue(cue, t.resolumeLayer)
        else this.osc.clearLayer(t.resolumeLayer)
      } else if (track.type === 'layer') {
        const lt = track as LayerTrack
        const layer = lt.resolumeLayerIndex
        if (layer < 1 || isMuted(lt, mutedGroups)) continue  // gone from Resolume, or muted
        const clip = clipAt(lt, T, fps)
        if (!clip) this.clearLayer(layer)   // no clip at T, or its duration has passed
        else if (this.activeCue.get(layer) === clip.id) this.linkClip(layer, clip)   // already showing: move it
        else {
          // Trigger it (short release so the button doesn't get stuck), then bring it to T
          if (!this.connectLayer(layer, clip, 50)) this.linkClip(layer, clip, LINK_AFTER_CONNECT_MS)
        }
      }
    }
    // Re-send automation at the new position (lanes whose span contains it, or 'hold' lanes)
    this.lastSent.clear()
    this.wasInside.clear()
    this.updateAllAutomation(T, true)
  }

  fireCue(cue: CueEvent, layer: number) {
    switch (cue.action) {
      case 'connectClip':
        if (cue.clip != null) this.osc.connectClip(layer, cue.clip, cue.release ? 40 : 0)
        break
      case 'connectColumn':
        if (cue.column != null) this.osc.connectColumn(cue.column)
        break
      case 'clearLayer':
        this.osc.clearLayer(layer)
        break
    }
  }

  manualTriggerCue(cue: CueEvent, layer: number) { this.fireCue(cue, layer) }
}
