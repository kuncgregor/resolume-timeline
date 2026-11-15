// The "key moves" of an automation lane: where its value really changes, for the show view
// (what moves now, what comes next). Flat stretches and holds are left out, back-to-back ramps
// are one move (100 → 140 → 100 %), and changes under MIN_DELTA of the range don't count.
import type { LaneKind } from './show'
import type { FrameKeyframe } from './automation'

/** Smallest change that counts as a move (normalised 0..1 range). */
export const MIN_DELTA = 0.01

export interface Move {
  from: number            // frame the move starts
  to: number              // frame it ends (= from for a step: hold, choice, on / off)
  values: number[]        // normalised values it passes through: start, turning points, end
  frames: number[]        // the frame of each of them
  options?: (string | undefined)[]   // choice / boolean lanes: the option at each value
}

const cache = new WeakMap<readonly FrameKeyframe[], { kind: LaneKind; moves: Move[] }>()

/** The lane's moves, in time order. Cached per keyframe array (they are never changed in place). */
export function movesOf(kfs: readonly FrameKeyframe[], kind: LaneKind = 'range'): Move[] {
  const hit = cache.get(kfs)
  if (hit && hit.kind === kind) return hit.moves
  const moves = kind === 'range' ? rangeMoves(kfs) : stepMoves(kfs)
  cache.set(kfs, { kind, moves })
  return moves
}

// Choice / boolean lanes step at each key whose option / value differs from the one before
function stepMoves(kfs: readonly FrameKeyframe[]): Move[] {
  const out: Move[] = []
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1], b = kfs[i]
    if (a.value === b.value && (a.option ?? '') === (b.option ?? '')) continue
    out.push({ from: b.frame, to: b.frame, values: [a.value, b.value], frames: [b.frame, b.frame], options: [a.option, b.option] })
  }
  return out
}

function rangeMoves(kfs: readonly FrameKeyframe[]): Move[] {
  const out: Move[] = []
  let cur: Move | null = null
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1], b = kfs[i]
    if (Math.abs(b.value - a.value) < MIN_DELTA) { cur = null; continue }   // flat: ends a move
    if (a.curve === 'hold' || b.frame === a.frame) {
      // A hold jumps at the next key
      out.push({ from: b.frame, to: b.frame, values: [a.value, b.value], frames: [b.frame, b.frame] })
      cur = null
      continue
    }
    if (cur && cur.to === a.frame) {
      // Continues the ramp before it: a turning point when the direction changes, else a longer ramp
      const v = cur.values, f = cur.frames, n = v.length
      const turned = Math.sign(b.value - a.value) !== Math.sign(v[n - 1] - v[n - 2])
      if (turned) { v.push(b.value); f.push(b.frame) } else { v[n - 1] = b.value; f[n - 1] = b.frame }
      cur.to = b.frame
    } else {
      cur = { from: a.frame, to: b.frame, values: [a.value, b.value], frames: [a.frame, b.frame] }
      out.push(cur)
    }
  }
  return out
}

/** First move that ends at or after the frame (a move running at the frame, or the next one). */
export function moveAtOrAfter(moves: readonly Move[], frame: number): number {
  let lo = 0, hi = moves.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (moves[mid].to < frame) lo = mid + 1; else hi = mid
  }
  return lo
}

/** A run of quick steps on one lane (a strobe, a flicker): moves[first..last], three steps or more,
 *  each within `maxGap` frames of the one before. The show view treats it as one event. */
export interface StepRun { first: number; last: number; from: number; to: number }

const runCache = new WeakMap<readonly Move[], { gap: number; runs: StepRun[] }>()

export function stepRuns(moves: readonly Move[], maxGap: number): StepRun[] {
  const hit = runCache.get(moves)
  if (hit && hit.gap === maxGap) return hit.runs
  const runs: StepRun[] = []
  const step = (m: Move) => m.to === m.from
  for (let i = 0; i < moves.length; i++) {
    let j = i
    while (j + 1 < moves.length && step(moves[j]) && step(moves[j + 1]) && moves[j + 1].from - moves[j].from <= maxGap) j++
    if (j - i >= 2) { runs.push({ first: i, last: j, from: moves[i].from, to: moves[j].from }); i = j }
  }
  runCache.set(moves, { gap: maxGap, runs })
  return runs
}
