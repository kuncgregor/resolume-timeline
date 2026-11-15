// What the show view needs from a timeline, worked out once per timeline (not per frame): per
// layer the clip spans and the lanes that move, every event in time order (clip changes, key
// moves, song sections from the markers), and the wording an operator reads from two metres.
import type { Show, LayerTrack, GroupTrack, AutomationSubTrack, LaneKind, Marker } from '../../shared/show'
import { frameKeyframes, sampleLane, type FrameKeyframe } from '../../shared/automation'
import { movesOf, moveAtOrAfter, stepRuns, type Move, type StepRun } from '../../shared/moves'
import { formatValue } from '../../shared/paramTree'
import type { LaneStatusMap } from './laneStatus'
import { smpteToFrames } from './components/timeUtils'
import { beatFrames, frameToBeats, type Tempo } from './grid'

export interface ClipSpan { start: number; end: number; name: string; color?: string }

export interface ShowLane {
  lane: AutomationSubTrack
  name: string              // the parameter, short: "Opacity", "Blur"
  kind: LaneKind
  kfs: FrameKeyframe[]
  moves: Move[]
  runs: StepRun[]           // quick step runs (strobes): one event each
  lo: number                // the span of values the lane uses (normalised): curves and bars are drawn
  hi: number                // in it, so 100 → 125 % on a 0–1000 % parameter is not a flat line
}

export interface ShowLayer {
  id: string
  tag: string               // "L2", "G1"
  name: string
  color?: string
  clips: ClipSpan[]
  lanes: ShowLane[]
}

export type ShowEvent =
  | { kind: 'section'; frame: number; marker: Marker }
  | { kind: 'clip'; frame: number; layer: ShowLayer; name: string; from: string | null }
  | { kind: 'clear'; frame: number; layer: ShowLayer; name: string }
  | { kind: 'move'; frame: number; layer: ShowLayer; lane: ShowLane; move: Move }
  // A run of quick steps on one lane (a strobe, a flicker): one event, not one per step
  | { kind: 'steps'; frame: number; layer: ShowLayer; lane: ShowLane; count: number; to: number }

export interface Section { start: number; end: number; marker: Marker }

export interface ShowModel {
  layers: ShowLayer[]
  events: ShowEvent[]       // time order; sections first at the same frame
  sections: Section[]
}

const cache = new WeakMap<Show, ShowModel>()

/** The show view's model of a timeline; cached per show object (edits make a new one). */
export function showModelOf(show: Show): ShowModel {
  const hit = cache.get(show)
  if (hit) return hit
  const model = build(show)
  cache.set(show, model)
  return model
}

/** The short parameter name of a lane ("Layer 2 › Transform › Scale" → "Scale"). */
export const laneShortName = (a: AutomationSubTrack) => {
  const label = a.ref?.label ?? a.name
  return label.includes(' › ') ? label.split(' › ').pop()! : label
}

function build(show: Show): ShowModel {
  const fps = show.frameRate
  const toF = (t: string) => smpteToFrames(t, fps)
  // A muted group mutes its layers; muted tracks and disabled lanes send nothing, so they don't show
  const mutedGroups = new Set(show.tracks.filter(t => t.type === 'group' && (t as GroupTrack).muted).map(t => (t as GroupTrack).resolumeGroupId))
  const layers: ShowLayer[] = []
  for (const t of show.tracks) {
    if (t.type !== 'layer' && t.type !== 'group') continue
    const tr = t as LayerTrack | GroupTrack
    if (tr.muted || (t.type === 'layer' && (t as LayerTrack).groupId != null && mutedGroups.has((t as LayerTrack).groupId!))) continue
    const lanes: ShowLane[] = []
    for (const a of tr.automations) {
      if (a.enabled === false || a.keyframes.length < 2) continue
      const kind = a.kind ?? 'range'
      const kfs = frameKeyframes(a.keyframes, fps, toF)
      const moves = movesOf(kfs, kind)
      // Steps under a second apart make a run (a strobe)
      if (moves.length) lanes.push({ lane: a, name: laneShortName(a), kind, kfs, moves, runs: stepRuns(moves, fps), ...valueSpan(kfs) })
    }
    const clips = t.type === 'layer' ? clipSpans(t as LayerTrack, toF) : []
    if (!lanes.length && !clips.length) continue
    layers.push({
      id: t.id, name: t.name, color: tr.color ?? tr.appColor, clips, lanes,
      tag: t.type === 'layer' ? `L${(t as LayerTrack).resolumeLayerIndex}` : `G${(t as GroupTrack).resolumeGroupIndex}`,
    })
  }

  const markers = [...show.markers].sort((a, b) => toF(a.time) - toF(b.time))
  const sections: Section[] = markers.map((m, i) => ({
    marker: m, start: toF(m.time), end: i + 1 < markers.length ? toF(markers[i + 1].time) : Infinity,
  }))

  const events: ShowEvent[] = sections.map(s => ({ kind: 'section' as const, frame: s.start, marker: s.marker }))
  // A gap shorter than this between two clips reads as a change (A → B), not as a clear and a start
  const changeGap = Math.round(fps / 2)
  for (const layer of layers) {
    layer.clips.forEach((c, i) => {
      const prev = layer.clips[i - 1]
      events.push({ kind: 'clip', frame: c.start, layer, name: c.name, from: prev && c.start - prev.end <= changeGap ? prev.name : null })
      const next = layer.clips[i + 1]
      if (c.end !== Infinity && (!next || next.start - c.end > changeGap)) events.push({ kind: 'clear', frame: c.end, layer, name: c.name })
    })
    for (const lane of layer.lanes) {
      const ms = lane.moves
      for (let i = 0; i < ms.length; i++) {
        const run = lane.runs.find(r => r.first === i)
        if (run) { events.push({ kind: 'steps', frame: run.from, layer, lane, count: run.last - run.first + 1, to: run.to }); i = run.last; continue }
        events.push({ kind: 'move', frame: ms[i].from, layer, lane, move: ms[i] })
      }
    }
  }
  events.sort((a, b) => a.frame - b.frame || (a.kind === 'section' ? -1 : 0) - (b.kind === 'section' ? -1 : 0))
  return { layers, events, sections }
}

// The values a lane moves between, a little wider than its keys (never flatter than 2 % of the range)
function valueSpan(kfs: FrameKeyframe[]): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity
  for (const k of kfs) { lo = Math.min(lo, k.value); hi = Math.max(hi, k.value) }
  const pad = Math.max(0.02 - (hi - lo), 0) / 2
  return { lo: Math.max(0, lo - pad), hi: Math.min(1, hi + pad) }
}

/** A value on the lane's own span: 0 at its lowest key, 1 at its highest. */
export const inSpan = (lane: ShowLane, v: number) =>
  lane.hi > lane.lo ? Math.max(0, Math.min(1, (v - lane.lo) / (lane.hi - lane.lo))) : 0.5

// What the layer shows from frame to frame, as the engine plays it: the last clip started, while
// its duration runs (a trigger-only clip, duration 0, until the next one)
function clipSpans(lt: LayerTrack, toF: (t: string) => number): ClipSpan[] {
  // Two clips at the same frame: the engine plays the first in the layer's list (stable sort)
  const starts = lt.clips.map(c => ({ c, f: toF(c.time), d: toF(c.duration) })).sort((a, b) => a.f - b.f)
    .filter((s, i, all) => i === 0 || all[i - 1].f !== s.f)
  return starts.map(({ c, f, d }, i) => {
    const nextF = i + 1 < starts.length ? starts[i + 1].f : Infinity
    return { start: f, end: Math.min(d > 0 ? f + d : Infinity, nextF), name: c.clipName, color: c.color ?? c.resolumeColor }
  })
}

// ── At a frame ───────────────────────────────────────────────────────────────

export const clipAtFrame = (layer: ShowLayer, frame: number) =>
  layer.clips.find(c => frame >= c.start && frame < c.end) ?? null

/** The lane's move running at the frame (a ramp under way), if any. */
export function moveAt(lane: ShowLane, frame: number): Move | null {
  const m = lane.moves[moveAtOrAfter(lane.moves, frame)]
  return m && m.from <= frame && frame < m.to ? m : null
}

/** The lane's step run (strobe) under way at the frame, if any. */
export const runAt = (lane: ShowLane, frame: number) => lane.runs.find(r => r.from <= frame && frame <= r.to) ?? null

/** Where a running move goes next: its next turning point (or its end). */
export function moveTarget(m: Move, frame: number): number {
  const i = m.frames.findIndex(f => f > frame)
  return m.values[i < 0 ? m.values.length - 1 : i]
}

export const sampleAt = (lane: ShowLane, frame: number) => sampleLane(lane.kfs, frame, lane.kind)

/** Index of the first event at or after the frame (events.length if none). */
export function eventAtOrAfter(events: readonly ShowEvent[], frame: number): number {
  let lo = 0, hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].frame < frame) lo = mid + 1; else hi = mid
  }
  return lo
}

export const sectionAt = (sections: readonly Section[], frame: number) =>
  sections.find(s => frame >= s.start && frame < s.end) ?? null

// ── Words ────────────────────────────────────────────────────────────────────

/** A lane value in real units, as Resolume shows it ("45 %", "180 °", "On", "Mirror"). */
export function laneValue(lane: ShowLane, laneStatus: LaneStatusMap, value: number, option?: string): string {
  const a = lane.lane, st = laneStatus[a.id]
  const range = { min: st?.info?.min ?? a.min, max: st?.info?.max ?? a.max, options: st?.info?.options ?? a.options, multiplier: st?.info?.multiplier }
  return formatValue(lane.kind, value, range, option, st?.info?.suffix)
}

/** A move in words: "FADE OUT", "Strobe ON", "Blur 0 → 45 %", "Scale 100 → 140 → 100 %". */
export function moveText(lane: ShowLane, m: Move, laneStatus: LaneStatusMap): string {
  const v = m.values, last = v[v.length - 1]
  if (/^opacity$/i.test(lane.name) && lane.kind === 'range' && v.length === 2) {
    // A ramp fades, a step (hold) cuts
    const step = m.to === m.from
    if (last < 0.01) return step ? 'CUT OUT' : 'FADE OUT'
    if (v[0] < 0.01) return step ? 'CUT IN' : 'FADE IN'
  }
  if (lane.kind === 'boolean') return `${lane.name} ${last >= 0.5 ? 'ON' : 'OFF'}`
  if (lane.kind === 'choice') return `${lane.name} → ${m.options?.[m.options.length - 1] || '—'}`
  // The unit once, at the end: "0 → 45 %"
  const parts = v.map(x => laneValue(lane, laneStatus, x))
  const unit = /\s(\S+)$/.exec(parts[parts.length - 1])?.[1]
  const bare = unit ? parts.map((p, i) => i < parts.length - 1 && p.endsWith(` ${unit}`) ? p.slice(0, -unit.length - 1) : p) : parts
  return `${lane.name} ${bare.join(' → ').replace(/ (\S+)$/, '\u00a0$1')}`
}

/** Frames from now to an event in the words a musician counts in: "2 BARS", "3 BEATS";
 *  without a tempo, seconds: "6 s", "1:05". */
export function countdown(frames: number, tempo: Tempo | null, fps: number): string {
  if (tempo) {
    const beats = Math.max(0, frames / beatFrames(tempo.bpm, fps))
    if (beats <= tempo.beatsPerBar) { const n = Math.max(1, Math.ceil(beats - 1e-6)); return `${n} BEAT${n > 1 ? 'S' : ''}` }
    const n = Math.ceil(beats / tempo.beatsPerBar - 1e-6)
    return `${n} BAR${n > 1 ? 'S' : ''}`
  }
  return seconds(frames, fps)
}

/** "6 s", "1:05", "1:02:30": time left, rounded up (as on a countdown). */
export function seconds(frames: number, fps: number): string {
  const t = Math.max(0, Math.ceil(frames / fps - 1e-6))
  if (t < 60) return `${t} s`
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Under a bar (with a tempo) or two seconds: the row turns blue, the operator gets ready. */
export function imminent(frames: number, tempo: Tempo | null, fps: number): boolean {
  return tempo ? frameToBeats(frames, { ...tempo, downbeatF: 0 }) < tempo.beatsPerBar : frames < 2 * fps
}

/** "0:06", "4:07", "1:02:30": a duration on a clock face (time to end). `up` rounds up. */
export function clockText(frames: number, fps: number, up = false): string {
  const t = Math.max(0, (up ? Math.ceil : Math.floor)(frames / fps - (up ? 1e-6 : 0)))
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
