// Keyframe interpolation shared by the engine (what is sent) and the UI (what is drawn).
import type { Keyframe, LaneKind } from './show'

// Basic curves first; then Resolume's envelope families (quad, sine, circ, expo, elastic,
// back, bounce × In/Out/InOut) so programmers find the vocabulary they know from Arena.
const FAMILIES = ['quad', 'sine', 'circ', 'expo', 'elastic', 'back', 'bounce'] as const
const DIRS = ['In', 'Out', 'InOut'] as const
export const BASIC_CURVES = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut'] as const
export const FAMILY_CURVES = FAMILIES.flatMap(f => DIRS.map(d => `${f}${d}` as const))
export const CURVES = [...BASIC_CURVES, ...FAMILY_CURVES] as const
export type CurveName = typeof BASIC_CURVES[number] | typeof FAMILY_CURVES[number]

// Older shows stored the cubic names
const LEGACY: Record<string, CurveName> = { easeInCubic: 'easeIn', easeOutCubic: 'easeOut', easeInOutCubic: 'easeInOut' }

export function curveOf(ease: string | undefined): CurveName {
  if (!ease) return 'linear'
  if ((CURVES as readonly string[]).includes(ease)) return ease as CurveName
  return LEGACY[ease] ?? 'linear'
}

// Standard easing equations (easings.net); "In" shapes, Out/InOut derived from them
const IN: Record<typeof FAMILIES[number], (t: number) => number> = {
  quad: t => t * t,
  sine: t => 1 - Math.cos((t * Math.PI) / 2),
  circ: t => 1 - Math.sqrt(1 - t * t),
  expo: t => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
  elastic: t => t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / 3),
  back: t => 2.70158 * t * t * t - 1.70158 * t * t,
  bounce: t => 1 - bounceOut(1 - t),
}
function bounceOut(t: number): number {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
const out = (f: (t: number) => number) => (t: number) => 1 - f(1 - t)
const inOut = (f: (t: number) => number) => (t: number) => t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2

const SHAPE: Record<CurveName, (t: number) => number> = {
  linear: t => t,
  hold: () => 0,
  easeIn: t => t * t * t,
  easeOut: t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  ...Object.fromEntries(FAMILIES.flatMap(f => [
    [`${f}In`, IN[f]], [`${f}Out`, out(IN[f])], [`${f}InOut`, inOut(IN[f])],
  ])) as Record<typeof FAMILY_CURVES[number], (t: number) => number>,
}

/** Human label for a curve name: "sineInOut" → "Sine In-Out". */
export function curveLabel(c: CurveName): string {
  const base: Record<string, string> = { linear: 'Linear', hold: 'Hold', easeIn: 'Ease In', easeOut: 'Ease Out', easeInOut: 'Ease In-Out' }
  if (base[c]) return base[c]
  const m = /^([a-z]+)(InOut|In|Out)$/.exec(c)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2] === 'InOut' ? 'In-Out' : m[2]}` : c
}

export interface FrameKeyframe { frame: number; value: number; curve: CurveName; option?: string }

export function toFrameKeyframes(kfs: Keyframe[], toFrames: (smpte: string) => number): FrameKeyframe[] {
  return kfs
    .map(k => ({ frame: toFrames(k.time), value: k.value, curve: curveOf(k.ease), option: k.option }))
    .sort((a, b) => a.frame - b.frame)
}

// Parsed keyframes per lane: the engine and the UI sample every lane at frame rate, and parsing
// the "hh:mm:ss:ff" times each time costs more than the rest of a frame. Keyframe arrays are
// never changed in place (every edit makes a new array), so the array itself is the key.
const parsed = new WeakMap<readonly Keyframe[], { fps: number; kfs: FrameKeyframe[] }>()

/** toFrameKeyframes, cached until the lane's keyframes change. Don't modify the result. */
export function frameKeyframes(kfs: Keyframe[], fps: number, toFrames: (smpte: string) => number): FrameKeyframe[] {
  const hit = parsed.get(kfs)
  if (hit && hit.fps === fps) return hit.kfs
  const out = toFrameKeyframes(kfs, toFrames)
  parsed.set(kfs, { fps, kfs: out })
  return out
}

/** First index whose frame is >= frame (kfs.length if none). */
export function lowerBound(kfs: readonly { frame: number }[], frame: number): number {
  let lo = 0, hi = kfs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (kfs[mid].frame < frame) lo = mid + 1; else hi = mid
  }
  return lo
}

/** Value at a frame. The curve of a segment is the curve of its first keyframe; discrete
 *  lanes (choice / boolean) always step. Before the first / after the last keyframe the
 *  edge value holds. Returns the keyframe that owns the value for discrete lanes. */
export function sampleLane(
  kfs: FrameKeyframe[], frame: number, kind: LaneKind = 'range',
): { value: number; option?: string } | null {
  if (!kfs.length) return null
  if (frame <= kfs[0].frame) return { value: kfs[0].value, option: kfs[0].option }
  const last = kfs[kfs.length - 1]
  if (frame >= last.frame) return { value: last.value, option: last.option }
  // The segment is the first one that ends at or after the frame (it starts before it)
  const j = lowerBound(kfs, frame)
  const k0 = kfs[j - 1], k1 = kfs[j]
  if (kind !== 'range' || k0.curve === 'hold' || k1.frame === k0.frame)
    return frame >= k1.frame ? { value: k1.value, option: k1.option } : { value: k0.value, option: k0.option }
  const t = (frame - k0.frame) / (k1.frame - k0.frame)
  return { value: k0.value + (k1.value - k0.value) * SHAPE[k0.curve](t) }
}
