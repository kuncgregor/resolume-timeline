// Keyframe interpolation shared by the engine (what is sent) and the UI (what is drawn).
import type { Keyframe, LaneKind } from './show'

export const CURVES = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut'] as const
export type CurveName = typeof CURVES[number]

// Older shows stored the cubic names
const LEGACY: Record<string, CurveName> = { easeInCubic: 'easeIn', easeOutCubic: 'easeOut', easeInOutCubic: 'easeInOut' }

export function curveOf(ease: string | undefined): CurveName {
  if (!ease) return 'linear'
  if ((CURVES as readonly string[]).includes(ease)) return ease as CurveName
  return LEGACY[ease] ?? 'linear'
}

const SHAPE: Record<CurveName, (t: number) => number> = {
  linear: t => t,
  hold: () => 0,
  easeIn: t => t * t * t,
  easeOut: t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
}

export interface FrameKeyframe { frame: number; value: number; curve: CurveName; option?: string }

export function toFrameKeyframes(kfs: Keyframe[], toFrames: (smpte: string) => number): FrameKeyframe[] {
  return kfs
    .map(k => ({ frame: toFrames(k.time), value: k.value, curve: curveOf(k.ease), option: k.option }))
    .sort((a, b) => a.frame - b.frame)
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
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1]
    if (frame < k0.frame || frame > k1.frame) continue
    if (kind !== 'range' || k0.curve === 'hold' || k1.frame === k0.frame)
      return frame >= k1.frame ? { value: k1.value, option: k1.option } : { value: k0.value, option: k0.option }
    const t = (frame - k0.frame) / (k1.frame - k0.frame)
    return { value: k0.value + (k1.value - k0.value) * SHAPE[k0.curve](t) }
  }
  return null
}
