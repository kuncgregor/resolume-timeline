import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import type { Show, LayerTrack, GroupTrack, TriggerTrack, AutomationTrack, AutomationSubTrack, CueEvent, LaneKind } from '../shared/show'
import { toFrameKeyframes, sampleLane } from '../shared/automation'
import { toRestValue, normalize, type LaneTarget } from '../shared/paramTree'

export type { LaneTarget }

const SEEK_THRESHOLD = 30
const ECHO_MS = 600        // how long a value we sent may still come back from Resolume
const RELEASE_MS = 600     // REC: no operator change for this long = parameter released

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
  private eventCb: ((channel: string, payload: unknown) => void) | null = null
  private tickHandle: NodeJS.Timeout | null = null
  private tickCb: ((frame: number) => void) | null = null
  // Which cue is currently showing on each Resolume layer (1-based index → cue id).
  // A clip end only clears the layer if that clip is still the one showing.
  private activeCue = new Map<number, string>()
  // Last-wins REST queue: one request in flight per parameter, newest value waits
  private restInFlight = new Set<number>()
  private restPending = new Map<number, number | string | boolean>()

  constructor(transport: Transport, osc: OscClient, rest: ResolumeRest) {
    this.transport = transport
    this.osc = osc
    this.rest = rest
  }

  loadShow(show: Show) {
    const first = this.show === null
    this.show = show
    if (show.frameRate !== this.transport.fps) this.transport.setFps(show.frameRate)
    this.transport.freewheelFrames = show.clock.freewheelFrames ?? 5
    // Edits arrive many times while playing; resetting lastFrame here would skip the
    // cues between the last tick and now.
    if (first) this.lastFrame = this.transport.now()
    // Only lanes whose value at the playhead changed are sent (dedupe by lane); re-sending
    // everything on every edit would overwrite what the operator does in Resolume.
    this.updateAllAutomation(this.transport.now())
  }

  /** Resolved targets from the renderer's resolver (lane id → Resolume parameter). */
  setTargets(map: Record<string, LaneTarget>) {
    this.targets = new Map(Object.entries(map))
    this.updateAllAutomation(this.transport.now())
  }

  onTick(cb: (frame: number) => void) { this.tickCb = cb }
  onEvent(cb: (channel: string, payload: unknown) => void) { this.eventCb = cb }

  /** REC armed: operator changes in Resolume become keyframes instead of overrides. */
  setRecordArmed(armed: boolean) { this.recordArmed = armed }

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
    return (this.recentSent.get(paramId) ?? []).some(e => now - e.at < ECHO_MS && sameValue(e.value, value, t))
  }

  private emitOverrides() { this.eventCb?.('engine:overrides', Object.fromEntries(this.overridden)) }

  // Ticks only fire when the frame changes; play/stop/locate call this so the UI
  // sees the new transport state even when the frame stays the same.
  notify() { this.tickCb?.(this.transport.now()) }

  start() {
    if (this.tickHandle) return
    this.tickHandle = setInterval(() => this.tick(), 8)
    this.watchHandle = setInterval(() => { this.watchManualChanges() }, 250)
  }

  stop() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null }
    if (this.watchHandle) { clearInterval(this.watchHandle); this.watchHandle = null }
  }

  // Polls automated parameters (REST by id, ~0.3 ms each on localhost) to notice when the
  // operator moves one in Resolume. Our own sends are ignored for 400 ms and by value.
  private watching = false
  private async watchManualChanges() {
    if (this.watching || !this.show) return
    this.watching = true
    try {
      const mutedGroups = mutedGroupIds(this.show)
      for (const track of this.show.tracks) {
        if (track.type === 'group' ? (track as GroupTrack).muted
          : track.type !== 'layer' || isMuted(track as LayerTrack, mutedGroups)) continue
        for (const auto of (track as LayerTrack | GroupTrack).automations) {
          const target = this.targets.get(auto.id)
          if (!target || auto.enabled === false) continue
          const p = await this.rest.getParamById(target.paramId)
          if (!p || p.value === undefined) continue
          const value = p.value as number | string | boolean
          const seen = this.lastSeen.get(auto.id)
          this.lastSeen.set(auto.id, value)
          if (seen === undefined || sameValue(seen, value, target)) continue
          if (this.isEcho(target.paramId, value, target)) continue
          const v = normalize({ kind: target.kind, min: target.min, max: target.max, options: target.options }, value)
          if (this.recordArmed) {
            // Touch: the lane stops sending while the operator holds the parameter
            this.touchedAt.set(auto.id, Date.now())
            this.eventCb?.('engine:record', { laneId: auto.id, value: v, option: target.kind === 'choice' ? String(value) : undefined })
          } else {
            this.overridden.set(auto.id, v)
            this.emitOverrides()
          }
        }
      }
    } finally {
      this.watching = false
    }
  }

  private tick() {
    const T = this.transport.now()
    if (T === this.lastFrame) return
    const delta = T - this.lastFrame
    if (Math.abs(delta) >= SEEK_THRESHOLD || delta < 0) {
      this.recallStateAt(T)
    } else {
      this.fireBetween(this.lastFrame, T)
    }
    this.updateAllAutomation(T)
    this.lastFrame = T
    this.tickCb?.(T)
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
        // does not clear the new clip.
        for (const clip of lt.clips) {
          const durF = smpteToFrames(clip.duration, fps)
          if (durF <= 0) continue
          const endF = smpteToFrames(clip.time, fps) + durF
          if (endF > lo && endF <= hi && this.activeCue.get(layer) === clip.id) {
            this.osc.clearLayer(layer)
            this.activeCue.delete(layer)
          }
        }
        for (const clip of lt.clips) {
          const sf = smpteToFrames(clip.time, fps)
          if (sf > lo && sf <= hi) {
            this.osc.connectClip(layer, clip.clipIndex, clip.release ? 40 : 0)
            this.activeCue.set(layer, clip.id)
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
        const sample = sampleLane(toFrameKeyframes(at.keyframes, t => smpteToFrames(t, fps)), T)
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
    const kfs = toFrameKeyframes(auto.keyframes, t => smpteToFrames(t, fps))
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
    if (!force && last !== undefined && (typeof key === 'string' || typeof last === 'string'
      ? key === last : Math.abs(key - last) <= 0.001)) return
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
      this.restSend(target.paramId, real)
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
        const sorted = [...lt.clips]
          .filter(c => smpteToFrames(c.time, fps) <= T)
          .sort((a, b) => smpteToFrames(b.time, fps) - smpteToFrames(a.time, fps))
        const last = sorted[0]
        if (last) {
          const sf = smpteToFrames(last.time, fps)
          const dur = smpteToFrames(last.duration, fps)
          if (dur === 0 || T < sf + dur) {
            // Clip is active at T — trigger it (short release so button doesn't get stuck)
            this.osc.connectClip(layer, last.clipIndex, 50)
            this.activeCue.set(layer, last.id)
          } else {
            // Clip duration has passed — clear the layer
            this.osc.clearLayer(layer)
            this.activeCue.delete(layer)
          }
        } else {
          // No clip before T — clear
          this.osc.clearLayer(layer)
          this.activeCue.delete(layer)
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
