import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import type { Show, LayerTrack, TriggerTrack, AutomationTrack, AutomationSubTrack, CueEvent, LaneKind } from '../shared/show'
import { toFrameKeyframes, sampleLane } from '../shared/automation'
import { toRestValue, type LaneTarget } from '../shared/paramTree'

export type { LaneTarget }

const SEEK_THRESHOLD = 30

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

  // Ticks only fire when the frame changes; play/stop/locate call this so the UI
  // sees the new transport state even when the frame stays the same.
  notify() { this.tickCb?.(this.transport.now()) }

  start() {
    if (this.tickHandle) return
    this.tickHandle = setInterval(() => this.tick(), 8)
  }

  stop() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null }
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
        if (layer < 1 || lt.muted) continue  // gone from Resolume, or muted
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
    for (const track of this.show.tracks) {
      if (track.type === 'automation') {
        const at = track as AutomationTrack
        const sample = sampleLane(toFrameKeyframes(at.keyframes, t => smpteToFrames(t, fps)), T)
        if (sample && (force || this.lastSent.get(at.id) !== sample.value)) {
          this.osc.setParam(at.target, sample.value)
          this.lastSent.set(at.id, sample.value)
        }
      } else if (track.type === 'layer') {
        if ((track as LayerTrack).muted) continue
        for (const auto of (track as LayerTrack).automations) this.updateLane(auto, T, fps, force)
      }
    }
  }

  private updateLane(auto: AutomationSubTrack, T: number, fps: number, force: boolean) {
    if (auto.enabled === false || !auto.keyframes.length) return
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
      this.restSend(target.paramId, toRestValue(target.kind ?? kind, v, target, option))
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
        if (layer < 1 || lt.muted) continue  // gone from Resolume, or muted
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
