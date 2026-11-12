// Musical grid (tempo, bars, beats). Pure helpers shared by the canvas ruler/grid, the
// transport bar position and keyframe snapping. Everything is frame-based: grid positions
// may be fractional frames; callers round only where a whole frame is needed (snapping).
import type { Show } from '../../shared/show'
import { smpteToFrames } from './components/timeUtils'

export const BPM_MIN = 20
export const BPM_MAX = 300
export const BEATS_PER_BAR_MIN = 2
export const BEATS_PER_BAR_MAX = 12
export const DEFAULT_BEATS_PER_BAR = 4

export interface Tempo {
  bpm: number
  beatsPerBar: number
  downbeatF: number   // timeline frame of bar 1 beat 1
  fps: number
}

export interface BarBeat { bar: number; beat: number; sixteenth: number }

export interface MusicalSteps {
  major: number        // beats between labelled ruler lines
  minor: number        // beats between the finest drawn grid lines (divides major)
}

export const beatFrames = (bpm: number, fps: number) => (fps * 60) / bpm
export const barFrames = (bpm: number, fps: number, beatsPerBar = DEFAULT_BEATS_PER_BAR) =>
  beatFrames(bpm, fps) * beatsPerBar

export const validBpm = (bpm: number | undefined): bpm is number =>
  bpm != null && Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX

/** BPM as stored: two decimals at most. */
export const roundBpm = (bpm: number) => Math.round(bpm * 100) / 100

/** "128", "128.5", "127.98"; "—" without a tempo. */
export const formatBpm = (bpm: number | undefined) => (validBpm(bpm) ? String(roundBpm(bpm)) : '—')

/** The show's tempo, or null when it has no (usable) BPM. */
export function tempoOf(show: Pick<Show, 'bpm' | 'beatsPerBar' | 'downbeat' | 'frameRate'>): Tempo | null {
  const fps = show.frameRate
  if (!validBpm(show.bpm) || !(fps > 0)) return null
  const bpb = show.beatsPerBar
  const beatsPerBar = bpb != null && Number.isInteger(bpb) && bpb >= 1 ? bpb : DEFAULT_BEATS_PER_BAR
  return { bpm: show.bpm, beatsPerBar, downbeatF: show.downbeat ? smpteToFrames(show.downbeat, fps) || 0 : 0, fps }
}

/** Ruler mode in effect: 'bars' only with a tempo; without an explicit choice, bars when a BPM is set. */
export function rulerModeOf(show: Pick<Show, 'bpm' | 'rulerMode'>): 'timecode' | 'bars' {
  if (!validBpm(show.bpm)) return 'timecode'
  return show.rulerMode ?? 'bars'
}

// Float slack so a frame that lands exactly on a grid line is not floored into the previous one
const EPS = 1e-6

/** Beats from the downbeat (negative before it). */
export const frameToBeats = (frame: number, t: Tempo) => (frame - t.downbeatF) / beatFrames(t.bpm, t.fps)
export const beatsToFrame = (beats: number, t: Tempo) => t.downbeatF + beats * beatFrames(t.bpm, t.fps)

/** Bar 1 starts at the downbeat; frames before it count down like a DAW pre-roll (bar 0, -1, …).
 *  Beat and sixteenth are 1-based; sixteenth = quarter of a beat. */
export function frameToBarBeat(frame: number, t: Tempo): BarBeat {
  const beats = frameToBeats(frame, t) + EPS
  const barIdx = Math.floor(beats / t.beatsPerBar)
  const inBar = beats - barIdx * t.beatsPerBar
  const beat = Math.min(t.beatsPerBar - 1, Math.floor(inBar))
  const sixteenth = Math.min(3, Math.floor((inBar - beat) * 4))
  return { bar: barIdx + 1, beat: beat + 1, sixteenth: sixteenth + 1 }
}

/** "17.3.2"; parts = 1 → "17", 2 → "17.3". */
export function formatBarBeat(bb: BarBeat, parts: 1 | 2 | 3 = 3): string {
  if (parts === 1) return String(bb.bar)
  if (parts === 2) return `${bb.bar}.${bb.beat}`
  return `${bb.bar}.${bb.beat}.${bb.sixteenth}`
}

/** Grid step ladder in beats: bar groups (powers of two, so a 3 h show still fits), one bar, beat, 1/2, 1/4 (16th), 1/8 (32nd). */
function ladder(beatsPerBar: number): number[] {
  return [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1].map(n => n * beatsPerBar).concat([1, 0.5, 0.25, 0.125])
    .filter((v, i, a) => a.indexOf(v) === i)
}

/** Major = coarsest-to-finest first rung at least ~80 px apart (labelled); minor = finest rung that
 *  divides the major and is at least ~12 px apart (drawn). Mirrors rulerSteps in TimelineCanvas. */
export function musicalSteps(ppf: number, t: Pick<Tempo, 'bpm' | 'fps' | 'beatsPerBar'>, majorPx = 80, minorPx = 12): MusicalSteps {
  const beatPx = beatFrames(t.bpm, t.fps) * ppf
  const rungs = ladder(t.beatsPerBar)
  // Finest rung that is still ≥ majorPx apart (rungs are coarse → fine)
  let major = rungs[0]
  for (const r of rungs) if (r * beatPx >= majorPx) major = r
  let minor = major
  for (const r of rungs) {
    if (r >= major) continue
    const n = major / r
    if (r * beatPx >= minorPx && Math.abs(n - Math.round(n)) < EPS) minor = r
  }
  return { major, minor }
}

const onStep = (beats: number, step: number) => {
  const q = beats / step
  return Math.abs(q - Math.round(q)) < EPS
}
export const isBarLine = (beats: number, t: Pick<Tempo, 'beatsPerBar'>) => onStep(beats, t.beatsPerBar)
export const isBeatLine = (beats: number) => onStep(beats, 1)
export const isOnStep = onStep

/** Calls fn for each grid line `step` beats apart (from the downbeat) inside [f0, f1].
 *  f = fractional frame; beats = position from the downbeat in beats (exact multiples of step). */
export function forEachGridLine(t: Tempo, step: number, f0: number, f1: number, fn: (f: number, beats: number) => void) {
  const bf = beatFrames(t.bpm, t.fps)
  if (!(step > 0) || !(bf > 0)) return
  const stepF = step * bf
  const first = Math.ceil((f0 - t.downbeatF) / stepF - EPS)
  const last = Math.floor((f1 - t.downbeatF) / stepF + EPS)
  if (last - first > 20000) return   // safety: never draw a solid wall of lines
  for (let i = first; i <= last; i++) fn(t.downbeatF + i * stepF, i * step)
}

/** Nearest grid position (`step` beats, default one beat) to a frame, as a whole frame. */
export function snapFrame(frame: number, t: Tempo, step = 1): number {
  const stepF = step * beatFrames(t.bpm, t.fps)
  return Math.round(t.downbeatF + Math.round((frame - t.downbeatF) / stepF) * stepF)
}
