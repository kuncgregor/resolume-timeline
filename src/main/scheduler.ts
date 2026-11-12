import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import type { Show, LayerTrack, TriggerTrack, AutomationTrack, CueEvent, Keyframe } from '../shared/show'

const SEEK_THRESHOLD = 30

function easeLinear(t: number) { return t }
function easeInCubic(t: number) { return t * t * t }
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3) }
function easeInOutCubic(t: number) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2 }
const EASES: Record<string, (t: number) => number> = { linear: easeLinear, easeInCubic, easeOutCubic, easeInOutCubic }

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

function valueAt(keyframes: Keyframe[], frame: number, fps: number): number | null {
  if (!keyframes.length) return null
  const kfs = keyframes
    .map(k => ({ ...k, frame: smpteToFrames(k.time, fps) }))
    .sort((a, b) => a.frame - b.frame)
  if (frame <= kfs[0].frame) return kfs[0].value
  if (frame >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1]
    if (frame >= k0.frame && frame <= k1.frame) {
      const span = k1.frame - k0.frame
      if (span === 0) return k0.value
      return lerp(k0.value, k1.value, (EASES[k0.ease] ?? easeLinear)((frame - k0.frame) / span))
    }
  }
  return null
}

export class Scheduler {
  private transport: Transport
  private osc: OscClient
  private rest: ResolumeRest
  private show: Show | null = null
  private lastFrame = -1
  private lastSent = new Map<string, number>()
  private tickHandle: NodeJS.Timeout | null = null
  private tickCb: ((frame: number) => void) | null = null
  // Which cue is currently showing on each Resolume layer (1-based index → cue id).
  // A clip end only clears the layer if that clip is still the one showing.
  private activeCue = new Map<number, string>()
  // Prevents overlapping REST requests for the same parameter
  private restInFlight = new Set<string>()
  // Parameter ranges by paramId, for converting normalized values to REST values
  private ranges = new Map<number, { min: number; max: number } | null>()

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
    this.lastSent.clear()
    for (const track of show.tracks) {
      if (track.type !== 'layer') continue
      for (const a of (track as LayerTrack).automations) {
        if (a.paramId !== undefined && a.min !== undefined && a.max !== undefined)
          this.ranges.set(a.paramId, { min: a.min, max: a.max })
      }
    }
    // Immediately send current automation values (even if not playing)
    this.forceUpdateAutomation()
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
        if (layer < 1) continue  // layer no longer exists in Resolume
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

  private updateAllAutomation(T: number) {
    if (!this.show) return
    const fps = this.show.frameRate
    for (const track of this.show.tracks) {
      if (track.type === 'automation') {
        const at = track as AutomationTrack
        this.sendAuto(at.target, undefined, at.keyframes, T, fps)
      } else if (track.type === 'layer') {
        for (const auto of (track as LayerTrack).automations) {
          this.sendAuto(auto.target, auto.paramId, auto.keyframes, T, fps)
        }
      }
    }
  }

  private forceUpdateAutomation() {
    if (!this.show) return
    const fps = this.show.frameRate
    const T = this.transport.now()
    for (const track of this.show.tracks) {
      if (track.type === 'automation') {
        const at = track as AutomationTrack
        this.forceSendAuto(at.target, undefined, at.keyframes, T, fps)
      } else if (track.type === 'layer') {
        for (const auto of (track as LayerTrack).automations) {
          this.forceSendAuto(auto.target, auto.paramId, auto.keyframes, T, fps)
        }
      }
    }
  }

  private sendAuto(target: string, paramId: number | undefined, keyframes: Keyframe[], T: number, fps: number) {
    const v = valueAt(keyframes, T, fps)
    if (v === null) return
    const last = this.lastSent.get(target)
    if (last === undefined || Math.abs(v - last) > 0.001) {
      this.dispatchParam(target, paramId, v)
      this.lastSent.set(target, v)
    }
  }

  private forceSendAuto(target: string, paramId: number | undefined, keyframes: Keyframe[], T: number, fps: number) {
    const v = valueAt(keyframes, T, fps)
    if (v === null) return
    this.dispatchParam(target, paramId, v)
    this.lastSent.set(target, v)
  }

  // Dispatch strategy for clip-level parameters:
  // Send via BOTH OSC and REST simultaneously — one of them will work depending on
  // Resolume version and parameter type. For layer/composition params, OSC only.
  private dispatchParam(target: string, paramId: number | undefined, value: number) {
    const isClipParam = target.includes('/clips/')
    const key = paramId !== undefined ? `id:${paramId}` : target

    if (!isClipParam) {
      // Layer/composition level → OSC only (fast, proven to work)
      this.osc.setParam(target, value)
      return
    }

    // Clip-level: send via OSC AND REST in parallel
    // OSC path (e.g. /composition/layers/6/clips/2/video/effects/strobe/frequency)
    this.osc.setParam(target, value)

    // REST by parameter ID — most reliable, bypasses path naming issues.
    // Needs the real value, so the range must be known (fetched once for older shows).
    if (paramId === undefined || this.restInFlight.has(key)) return
    if (!this.ranges.has(paramId)) {
      this.restInFlight.add(key)
      this.rest.getParamRange(paramId)
        .then(r => { this.ranges.set(paramId, r) })
        .finally(() => this.restInFlight.delete(key))
      return
    }
    const range = this.ranges.get(paramId)
    if (!range) return
    const raw = range.min + value * (range.max - range.min)
    this.restInFlight.add(key)
    this.rest.setParamById(paramId, raw)
      .then(ok => { if (!ok) console.warn('[REST by-id FAILED] paramId:', paramId, 'value:', raw) })
      .finally(() => this.restInFlight.delete(key))
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
        if (layer < 1) continue
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
    // Always re-send automation at new position
    this.lastSent.clear()
    this.forceUpdateAutomation()
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
