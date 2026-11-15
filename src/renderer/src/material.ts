// Ableton Live style editing: what a selection holds ("material") and the edits on it — cut,
// copy, paste, duplicate, delete, move, split. Pure functions on the show's tracks; App
// applies each edit as one (undoable) change.
//
// Two kinds of selection, as in Live's Arrangement View:
// - a time selection: a span of time over some rows (a layer's clip row, automation lanes).
//   Edits take everything in the span: clips are split at its edges, lanes get breakpoints at
//   its edges so the curve outside keeps its shape.
// - selected clips (clicked): edits take the whole clips.
// Lock Envelopes off (Live's default): a clip-row selection or a selected clip also takes the
// layer's automation under it. Lanes bound to a clip always go with their clip.
import type { Track, LayerTrack, GroupTrack, ClipCue, AutomationSubTrack, Keyframe, LaneKind } from '../../shared/show'
import { curveOf, frameKeyframes, sampleLane } from '../../shared/automation'
import { smpteToFrames, framesToSmpte } from './components/timeUtils'

// Clips in 'edit' trim mode keep their picture where it is: a part that now starts later in
// the clip starts that much later in its media. 'loop' clips start at their media start anyway.
const shiftMedia = (cue: ClipCue, df: number): ClipCue =>
  cue.trim === 'edit' && df > 0 ? { ...cue, mediaStart: (cue.mediaStart ?? 0) + df } : cue

/** A timeline row: a layer's clip row (no laneId; a group's own row) or one automation lane. */
export interface Row { trackId: string; laneId?: string }
/** Live's time selection: frames [a, b] over rows (top to bottom). */
export interface TimeSel { a: number; b: number; rows: Row[] }

export interface EditCtx {
  fps: number
  lockEnvelopes: boolean
  newId: (prefix: string) => string
}

/** A keyframe at a frame (relative to the material's start inside a Material). */
interface FKey { f: number; kf: Keyframe }

interface CueMat {
  cue: ClipCue                 // id is the source cue's (new ids are made on paste)
  f: number; dur: number       // start (relative) and length in frames
  bound: { lane: AutomationSubTrack; keys: FKey[] }[]   // lanes that move with the cue
}
interface LaneMat {
  trackId: string; laneId: string; kind: LaneKind
  keys: FKey[]
  spans: [number, number][]    // relative spans this lane material covers (overwritten on paste)
}
export interface Material {
  kind: 'time' | 'cues'        // from a time selection, or whole clips
  rows: Row[]                  // the rows it came from (time selection)
  len: number
  clips: { trackId: string; cues: CueMat[] }[]
  lanes: LaneMat[]
}

const NONE: Material = { kind: 'cues', rows: [], len: 0, clips: [], lanes: [] }
export const isEmptyMaterial = (m: Material) => !m.clips.some(c => c.cues.length) && !m.lanes.some(l => l.keys.length)

// ── Small helpers ─────────────────────────────────────────────────────────────

const kindOf = (a: AutomationSubTrack): LaneKind => a.kind ?? 'range'
const isLayer = (t: Track): t is LayerTrack => t.type === 'layer'
const hasLanes = (t: Track): t is LayerTrack | GroupTrack => t.type === 'layer' || t.type === 'group'
/** Lanes that belong to the timeline, not to a clip (Live's track automation). */
const isTrackLane = (a: AutomationSubTrack) => !!a.layerBound || !a.clipId
const boundTo = (a: AutomationSubTrack, cueId: string) => !a.layerBound && a.clipId === cueId

function framesOf(lane: AutomationSubTrack, fps: number): FKey[] {
  return lane.keyframes.map(kf => ({ f: smpteToFrames(kf.time, fps), kf }))
    .sort((x, y) => x.f - y.f)
}
function toKeyframes(keys: FKey[], fps: number): Keyframe[] {
  return [...keys].sort((x, y) => x.f - y.f).map(({ f, kf }) => ({ ...kf, time: framesToSmpte(Math.max(0, f), fps) }))
}
// Marks the breakpoints an edit adds at its edges (not saved: JSON drops symbol keys)
const EDGE = Symbol('edge')

/** The lane's value at a frame, as a keyframe whose segment keeps `ease`. */
function keyAt(lane: AutomationSubTrack, f: number, fps: number, ease: string): Keyframe | null {
  const s = sampleLane(frameKeyframes(lane.keyframes, fps, t => smpteToFrames(t, fps)), f, kindOf(lane))
  if (!s) return null
  return { time: framesToSmpte(f, fps), value: parseFloat(s.value.toFixed(6)), ease, ...(s.option !== undefined ? { option: s.option } : {}), [EDGE]: true } as Keyframe
}
/** Ease of the segment a frame falls in (the last keyframe before it). */
const easeAt = (keys: FKey[], f: number) => [...keys].reverse().find(k => k.f < f)?.kf.ease ?? 'linear'
/** Is f strictly inside the lane's keyframe span (so an edge breakpoint keeps the shape)? */
/** Does the curve run through [lo, hi] (keys at or after lo and at or before hi)? Before the
 *  first / after the last key the edge value holds, so that counts too. */
const touches = (keys: FKey[], lo: number, hi: number) => keys.some(k => k.f >= lo) && keys.some(k => k.f <= hi)

/** The keys of [lo, hi], with breakpoints at lo / hi carrying the curve's value there. */
function sliceKeys(lane: AutomationSubTrack, lo: number, hi: number, fps: number): FKey[] {
  const keys = framesOf(lane, fps)
  const out = keys.filter(k => k.f >= lo && k.f <= hi)
  if (!touches(keys, lo, hi)) return out
  if (!out.some(k => k.f === lo)) { const k = keyAt(lane, lo, fps, easeAt(keys, lo)); if (k) out.unshift({ f: lo, kf: k }) }
  if (!out.some(k => k.f === hi)) { const k = keyAt(lane, hi, fps, 'linear'); if (k) out.push({ f: hi, kf: k }) }
  return out
}

/** The lane without its keys in [lo, hi]; breakpoints at the edges keep the curve outside
 *  (also the value held before the first / after the last key). */
function cutKeys(lane: AutomationSubTrack, lo: number, hi: number, fps: number): AutomationSubTrack {
  const keys = framesOf(lane, fps)
  if (!touches(keys, lo, hi)) return lane
  const out = keys.filter(k => k.f < lo || k.f > hi)
  // Across the cleared span the curve runs straight from the value at lo to the value at hi
  const discrete = kindOf(lane) !== 'range'
  const kLo = keyAt(lane, lo, fps, discrete ? easeAt(keys, lo) : 'linear'), kHi = keyAt(lane, hi, fps, easeAt(keys, hi))
  if (kLo) out.push({ f: lo, kf: kLo })
  if (kHi && hi !== lo) out.push({ f: hi, kf: kHi })
  return { ...lane, keyframes: toKeyframes(out, fps) }
}

/** Keys merged into a lane at an offset; pasted keys replace keys on the same frames. */
function mergeKeys(lane: AutomationSubTrack, keys: FKey[], at: number, fps: number): AutomationSubTrack {
  if (!keys.length) return lane
  const add = keys.map(k => ({ f: at + k.f, kf: k.kf })).filter(k => k.f >= 0)
  const taken = new Set(add.map(k => k.f))
  return { ...lane, keyframes: toKeyframes([...framesOf(lane, fps).filter(k => !taken.has(k.f)), ...add], fps) }
}

const shiftKeys = (keys: FKey[], d: number): FKey[] => keys.map(k => ({ f: k.f + d, kf: k.kf }))

/** Start, length and shown length (cut by the next clip on the layer) of each cue. */
function cueSpans(lt: LayerTrack, fps: number): Map<string, { sf: number; dur: number; shown: number }> {
  const spans = lt.clips.map(c => ({ id: c.id, sf: smpteToFrames(c.time, fps), dur: smpteToFrames(c.duration, fps) }))
  const order = [...spans].sort((x, y) => x.sf - y.sf)
  const out = new Map<string, { sf: number; dur: number; shown: number }>()
  order.forEach((s, i) => {
    const next = order[i + 1]
    const shown = s.dur > 0 && next && next.sf < s.sf + s.dur ? Math.max(0, next.sf - s.sf) : s.dur
    out.set(s.id, { sf: s.sf, dur: s.dur, shown })
  })
  return out
}

const sortCues = (clips: ClipCue[], fps: number) =>
  [...clips].sort((x, y) => smpteToFrames(x.time, fps) - smpteToFrames(y.time, fps))

function rowsByTrack(rows: Row[]): Map<string, { clipRow: boolean; lanes: Set<string> }> {
  const m = new Map<string, { clipRow: boolean; lanes: Set<string> }>()
  for (const r of rows) {
    const e = m.get(r.trackId) ?? { clipRow: false, lanes: new Set<string>() }
    if (r.laneId) e.lanes.add(r.laneId); else e.clipRow = true
    m.set(r.trackId, e)
  }
  return m
}

/** Lanes a selection of the track covers: its lane rows, plus its track automation when the
 *  clip row is selected and envelopes are not locked. */
function lanesCovered(t: LayerTrack | GroupTrack, sel: { clipRow: boolean; lanes: Set<string> }, ctx: EditCtx): AutomationSubTrack[] {
  // A clip's lanes go with the clip when its row is selected (not a second time as lane rows)
  return t.automations.filter(a => sel.clipRow
    ? isTrackLane(a) && (sel.lanes.has(a.id) || !ctx.lockEnvelopes)
    : sel.lanes.has(a.id))
}

// ── Time selection ────────────────────────────────────────────────────────────

/** What a time selection holds, relative to its start. */
export function extractTime(tracks: Track[], sel: TimeSel, ctx: EditCtx): Material {
  const { a, b } = sel
  if (b <= a) return NONE
  const mat: Material = { kind: 'time', rows: sel.rows, len: b - a, clips: [], lanes: [] }
  for (const [trackId, rs] of rowsByTrack(sel.rows)) {
    const t = tracks.find(x => x.id === trackId)
    if (!t || !hasLanes(t)) continue
    if (rs.clipRow && isLayer(t)) {
      const spans = cueSpans(t, ctx.fps)
      const cues: CueMat[] = []
      for (const cue of t.clips) {
        const { sf, dur } = spans.get(cue.id)!
        const ef = sf + dur
        if (dur === 0 ? sf < a || sf >= b : ef <= a || sf >= b) continue
        const lo = Math.max(sf, a), hi = dur === 0 ? lo : Math.min(ef, b)
        const whole = sf >= a && (dur === 0 || ef <= b)
        const bound = t.automations.filter(l => boundTo(l, cue.id)).map(lane => ({
          lane, keys: shiftKeys(whole ? framesOf(lane, ctx.fps) : sliceKeys(lane, lo, hi, ctx.fps), -a),
        }))
        cues.push({ cue: shiftMedia(cue, lo - sf), f: lo - a, dur: dur === 0 ? 0 : hi - lo, bound })
      }
      if (cues.length) mat.clips.push({ trackId, cues })
    }
    for (const lane of lanesCovered(t, rs, ctx)) {
      const keys = shiftKeys(sliceKeys(lane, a, b, ctx.fps), -a)
      mat.lanes.push({ trackId, laneId: lane.id, kind: kindOf(lane), keys, spans: [[0, b - a]] })
    }
  }
  return mat
}

/** Everything in a time selection removed: clips split at its edges, lanes cleared. */
export function deleteTime(tracks: Track[], sel: TimeSel, ctx: EditCtx): Track[] {
  const { a, b } = sel
  const { fps } = ctx
  const byTrack = rowsByTrack(sel.rows)
  return tracks.map(t => {
    const rs = byTrack.get(t.id)
    if (!rs || !hasLanes(t)) return t
    let clips = isLayer(t) ? t.clips : []
    let automations = t.automations
    if (rs.clipRow && isLayer(t)) {
      const spans = cueSpans(t, fps)
      const out: ClipCue[] = []
      const extraLanes: AutomationSubTrack[] = []
      const goneLanes = new Set<string>()
      const laneEdits = new Map<string, AutomationSubTrack>()
      for (const cue of t.clips) {
        const { sf, dur } = spans.get(cue.id)!
        const ef = sf + dur
        const bound = automations.filter(l => boundTo(l, cue.id))
        if (dur === 0) {
          if (sf >= a && sf < b) bound.forEach(l => goneLanes.add(l.id)); else out.push(cue)
          continue
        }
        if (ef <= a || sf >= b) { out.push(cue); continue }
        if (sf >= a && ef <= b) { bound.forEach(l => goneLanes.add(l.id)); continue }
        if (sf < a && ef > b) {
          // Split around the selection: the right part is a new cue with its own copies of the lanes
          const right: ClipCue = { ...shiftMedia(cue, b - sf), id: ctx.newId('c'), time: framesToSmpte(b, fps), duration: framesToSmpte(ef - b, fps) }
          out.push({ ...cue, duration: framesToSmpte(a - sf, fps) }, right)
          for (const l of bound) {
            const keys = framesOf(l, fps)
            laneEdits.set(l.id, { ...l, keyframes: toKeyframes(sliceKeysOpen(l, keys, a, 'left', fps), fps) })
            extraLanes.push({ ...l, id: ctx.newId('auto-'), clipId: right.id, keyframes: toKeyframes(sliceKeysOpen(l, keys, b, 'right', fps), fps) })
          }
          continue
        }
        if (sf < a) out.push({ ...cue, duration: framesToSmpte(a - sf, fps) })
        else out.push({ ...shiftMedia(cue, b - sf), time: framesToSmpte(b, fps), duration: framesToSmpte(ef - b, fps) })
        for (const l of bound) laneEdits.set(l.id, cutKeys(l, a, b, fps))
      }
      clips = sortCues(out, fps)
      automations = [...automations.filter(l => !goneLanes.has(l.id)).map(l => laneEdits.get(l.id) ?? l), ...extraLanes]
    }
    const cover = new Set(lanesCovered({ ...t, automations }, rs, ctx).map(l => l.id))
    automations = automations.map(l => cover.has(l.id) ? cutKeys(l, a, b, fps) : l)
    return isLayer(t) ? { ...t, clips, automations } : { ...t, automations }
  })
}

/** Keys of one side of a split, with a breakpoint on the split frame. */
function sliceKeysOpen(lane: AutomationSubTrack, keys: FKey[], at: number, side: 'left' | 'right', fps: number): FKey[] {
  const out = keys.filter(k => side === 'left' ? k.f <= at : k.f >= at)
  // Each piece keeps the value at the split, also when all keys are on the other side
  if (keys.length && !out.some(k => k.f === at)) {
    const k = keyAt(lane, at, fps, side === 'left' ? 'linear' : easeAt(keys, at))
    if (k) side === 'left' ? out.push({ f: at, kf: k }) : out.unshift({ f: at, kf: k })
  }
  return out
}

/** Clips split at a frame on the given layers (Live's Split, ⌘E). Returns the new cue ids. */
export function splitAt(tracks: Track[], trackIds: string[], f: number, ctx: EditCtx): { tracks: Track[]; ids: string[] } {
  const ids: string[] = []
  const next = tracks.map(t => {
    if (!isLayer(t) || !trackIds.includes(t.id)) return t
    const spans = cueSpans(t, ctx.fps)
    let automations = t.automations
    const clips = t.clips.flatMap(cue => {
      const { sf, dur } = spans.get(cue.id)!
      if (dur === 0 || f <= sf || f >= sf + dur) return [cue]
      const right: ClipCue = { ...shiftMedia(cue, f - sf), id: ctx.newId('c'), time: framesToSmpte(f, ctx.fps), duration: framesToSmpte(sf + dur - f, ctx.fps) }
      ids.push(right.id)
      automations = automations.flatMap(l => {
        if (!boundTo(l, cue.id)) return [l]
        const keys = framesOf(l, ctx.fps)
        return [
          { ...l, keyframes: toKeyframes(sliceKeysOpen(l, keys, f, 'left', ctx.fps), ctx.fps) },
          { ...l, id: ctx.newId('auto-'), clipId: right.id, keyframes: toKeyframes(sliceKeysOpen(l, keys, f, 'right', ctx.fps), ctx.fps) },
        ]
      })
      return [{ ...cue, duration: framesToSmpte(f - sf, ctx.fps) }, right]
    })
    return { ...t, clips: sortCues(clips, ctx.fps), automations }
  })
  return { tracks: next, ids }
}

// ── Selected clips ────────────────────────────────────────────────────────────

/** Whole clips with their lanes (and, envelopes not locked, the layer automation under them),
 *  relative to the earliest start. */
export function extractCues(tracks: Track[], cueIds: string[], ctx: EditCtx): Material {
  const found: { t: LayerTrack; cue: ClipCue; sf: number; dur: number; shown: number }[] = []
  for (const t of tracks) {
    if (!isLayer(t)) continue
    const spans = cueSpans(t, ctx.fps)
    for (const cue of t.clips) if (cueIds.includes(cue.id)) found.push({ t, cue, ...spans.get(cue.id)! })
  }
  if (!found.length) return NONE
  const f0 = Math.min(...found.map(x => x.sf))
  const end = Math.max(...found.map(x => x.sf + Math.max(1, x.dur)))
  const mat: Material = { kind: 'cues', rows: [], len: end - f0, clips: [], lanes: [] }
  for (const { t, cue, sf, dur, shown } of found) {
    let entry = mat.clips.find(c => c.trackId === t.id)
    if (!entry) { entry = { trackId: t.id, cues: [] }; mat.clips.push(entry) }
    entry.cues.push({
      cue, f: sf - f0, dur,
      bound: t.automations.filter(l => boundTo(l, cue.id)).map(lane => ({ lane, keys: shiftKeys(framesOf(lane, ctx.fps), -f0) })),
    })
    if (ctx.lockEnvelopes || shown <= 0) continue
    for (const lane of t.automations.filter(isTrackLane)) {
      const keys = shiftKeys(sliceKeys(lane, sf, sf + shown, ctx.fps), -f0)
      let lm = mat.lanes.find(l => l.laneId === lane.id)
      if (!lm) { lm = { trackId: t.id, laneId: lane.id, kind: kindOf(lane), keys: [], spans: [] }; mat.lanes.push(lm) }
      lm.keys.push(...keys)
      lm.spans.push([sf - f0, sf + shown - f0])
    }
  }
  return mat
}

/** Selected clips removed with their lanes (and the layer automation under them, unlocked). */
export function deleteCues(tracks: Track[], cueIds: string[], ctx: EditCtx): Track[] {
  const gone = new Set(cueIds)
  return tracks.map(t => {
    if (!isLayer(t) || !t.clips.some(c => gone.has(c.id))) return t
    const spans = cueSpans(t, ctx.fps)
    let automations = t.automations.filter(l => !(l.clipId && gone.has(l.clipId) && !l.layerBound))
    if (!ctx.lockEnvelopes) {
      for (const id of gone) {
        const s = spans.get(id)
        if (!s || s.shown <= 0) continue
        automations = automations.map(l => isTrackLane(l) ? cutKeys(l, s.sf, s.sf + s.shown, ctx.fps) : l)
      }
    }
    return { ...t, clips: t.clips.filter(c => !gone.has(c.id)), automations }
  })
}

// ── Paste ─────────────────────────────────────────────────────────────────────

export interface PasteOpts {
  keepIds?: boolean          // a move: the cues and their lanes keep their ids
  moveFrom?: number          // a move: where the material was (its old place is not kept as a jump)
  // One lane of material onto another lane (any parameter): values converted to its kind
  laneTarget?: { trackId: string; laneId: string; kind: LaneKind; options: string[] }
}

/** Material placed at a frame, replacing what is there. Returns the ids of the pasted cues. */
export function pasteMaterial(tracks: Track[], mat: Material, at: number, ctx: EditCtx, opts: PasteOpts = {}): { tracks: Track[]; ids: string[] } {
  const { fps } = ctx
  const ids: string[] = []
  const singleLane = opts.laneTarget && !mat.clips.length && mat.lanes.length === 1
  const lanes = singleLane
    ? [{ ...mat.lanes[0], trackId: opts.laneTarget!.trackId, laneId: opts.laneTarget!.laneId }]
    : mat.lanes
  const before = tracks
  // A time selection pasted replaces the span it lands on (clips there are split, as in Live)
  if (mat.kind === 'time') {
    const rows: Row[] = [...mat.clips.map(c => ({ trackId: c.trackId })), ...lanes.map(l => ({ trackId: l.trackId, laneId: l.laneId }))]
    tracks = deleteTime(tracks, { a: at, b: at + mat.len, rows }, { ...ctx, lockEnvelopes: true })
  }
  const laneBefore = (id: string) => {
    for (const t of before) if (hasLanes(t)) { const l = t.automations.find(x => x.id === id); if (l) return l }
    return undefined
  }
  const next = tracks.map(t => {
    if (!hasLanes(t)) return t
    let clips = isLayer(t) ? t.clips : []
    let automations = t.automations
    const cm = mat.clips.find(c => c.trackId === t.id)
    if (cm && isLayer(t)) {
      // Clips in the way: cut where the pasted clips go (a layer plays one clip at a time)
      const spans = cueSpans({ ...t, clips } as LayerTrack, fps)
      for (const c of cm.cues) {
        const lo = at + c.f, hi = lo + Math.max(1, c.dur)
        const moving = opts.keepIds ? clips.find(x => x.id === c.cue.id) : undefined
        if (moving) continue
        for (const cue of clips) {
          const s = spans.get(cue.id)
          if (!s) continue
          if (s.dur === 0 ? s.sf >= lo && s.sf < hi : s.sf >= lo && s.sf + s.dur <= hi) {
            clips = clips.filter(x => x.id !== cue.id)
            automations = automations.filter(l => !boundTo(l, cue.id))
          }
        }
      }
      for (const c of cm.cues) {
        const id = opts.keepIds ? c.cue.id : ctx.newId('c')
        ids.push(id)
        const cue: ClipCue = { ...c.cue, id, time: framesToSmpte(Math.max(0, at + c.f), fps), duration: framesToSmpte(c.dur, fps) }
        clips = [...clips.filter(x => x.id !== id), cue]
        for (const { lane, keys } of c.bound) {
          const copy: AutomationSubTrack = {
            ...lane, id: opts.keepIds ? lane.id : ctx.newId('auto-'), clipId: id,
            keyframes: toKeyframes(shiftKeys(keys, at), fps),
          }
          automations = [...automations.filter(l => l.id !== copy.id), copy]
        }
      }
      clips = sortCues(clips, fps)
    }
    for (const lm of lanes.filter(l => l.trackId === t.id)) {
      automations = automations.map(l => {
        if (l.id !== lm.laneId) return l
        let lane = l
        for (const [lo, hi] of lm.spans) lane = cutKeys(lane, at + lo, at + hi, fps)
        const keys = singleLane ? convertKeys(lm.keys, lm.kind, opts.laneTarget!.kind, opts.laneTarget!.options) : lm.keys
        const vacated = opts.moveFrom != null ? lm.spans.map(([lo, hi]) => [opts.moveFrom! + lo, opts.moveFrom! + hi] as [number, number]) : []
        return keepJumps(mergeKeys(lane, keys, at, fps), laneBefore(l.id) ?? l, keys, lm.spans, at, fps, vacated)
      })
    }
    return isLayer(t) ? { ...t, clips, automations } : { ...t, automations }
  })
  return { tracks: next, ids }
}

/** Where pasted keys start or end on another value than the curve they replace, the frame
 *  next to them keeps the old curve: a jump, as Live does with two breakpoints on one time
 *  (here a key is one per frame). */
function keepJumps(lane: AutomationSubTrack, before: AutomationSubTrack, keys: FKey[], spans: [number, number][], at: number, fps: number,
  vacated: [number, number][] = []): AutomationSubTrack {
  // Where a move came from there is no old curve to keep, only the gap it left
  const left = (f: number) => vacated.some(([lo, hi]) => f >= lo && f <= hi)
  if (kindOf(lane) !== 'range') return lane   // stepped lanes jump anyway
  const old = framesOf(before, fps)
  if (!old.length) return lane
  const now = () => new Set(framesOf(lane, fps).map(k => k.f))
  const span = () => { const f = framesOf(lane, fps); return [f[0]?.f ?? 0, f[f.length - 1]?.f ?? 0] }
  for (const [lo, hi] of spans) {
    const LO = at + lo, HI = at + hi
    const first = keys.find(k => k.f === lo), last = keys.find(k => k.f === hi)
    if (first && LO > 0 && span()[0] < LO - 1 && !now().has(LO - 1) && !left(LO - 1)) {
      const k = keyAt(before, LO - 1, fps, easeAt(old, LO - 1))
      if (k && Math.abs(k.value - first.kf.value) > 1e-6) lane = mergeKeys(lane, [{ f: LO - 1, kf: k }], 0, fps)
    }
    if (last && span()[1] > HI + 1 && !now().has(HI + 1) && !left(HI + 1)) {
      const k = keyAt(before, HI + 1, fps, easeAt(old, HI + 1))
      if (k && Math.abs(k.value - last.kf.value) > 1e-6) lane = mergeKeys(lane, [{ f: HI + 1, kf: k }], 0, fps)
    }
  }
  return lane
}

/** Edge breakpoints edits added (this one or earlier ones in the session) that change nothing
 *  (on the straight line between their neighbours, or the same step value) are removed, so
 *  repeated edits don't pile them up. The user's own breakpoints are never touched. */
export function pruneAddedKeys(after: Track[], fps: number): Track[] {
  return after.map(t => {
    if (!hasLanes(t)) return t
    let changed = false
    const automations = t.automations.map(l => {
      if (!l.keyframes.some(k => (k as any)[EDGE])) return l
      const keys = framesOf(l, fps)
      const step = kindOf(l) !== 'range'
      const keep = keys.filter((k, i) => {
        if (!(k.kf as any)[EDGE] || i === 0 || i === keys.length - 1) return true
        const p = keys[i - 1], n = keys[i + 1]
        const same = (x: Keyframe, y: Keyframe) => Math.abs(x.value - y.value) < 1e-4 && (x.option ?? '') === (y.option ?? '')
        if (step || curveOf(p.kf.ease) === 'hold') return !(same(p.kf, k.kf) && (step || curveOf(k.kf.ease) === 'hold'))
        const straight = (kf: Keyframe) => curveOf(kf.ease) === 'linear' && !kf.bend
        if (!straight(p.kf) || !straight(k.kf)) return true
        const v = p.kf.value + (n.kf.value - p.kf.value) * (k.f - p.f) / Math.max(1, n.f - p.f)
        return Math.abs(v - k.kf.value) > 1e-3
      })
      if (keep.length === keys.length) return l
      changed = true
      return { ...l, keyframes: toKeyframes(keep, fps) }
    })
    return changed ? { ...t, automations } : t
  })
}

// ── Values between lane kinds ─────────────────────────────────────────────────

/** A keyframe as copied: offset from the copy's first key, value 0..1, curve, choice option. */
export interface KeyframePasteItem { offsetFrames: number; value: number; ease: string; option?: string; bend?: number }

/** Normalized value of a choice / boolean lane snapped to a step. */
export function snapValue(kind: LaneKind, v: number, nOpts: number): number {
  if (kind === 'boolean') return v >= 0.5 ? 1 : 0
  if (kind === 'choice' && nOpts > 1) return Math.round(Math.max(0, Math.min(1, v)) * (nOpts - 1)) / (nOpts - 1)
  if (kind === 'choice' && nOpts === 1) return 0
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
}
export const optionAt = (v: number, opts: string[]): string | undefined =>
  opts.length ? opts[Math.round(Math.max(0, Math.min(1, v)) * (opts.length - 1))] : undefined

/** Keyframes copied from a lane of one kind, for a lane of another: values snap to its steps
 *  (choice: the same option when it exists there), curves become holds on stepped lanes. */
export function convertItems(items: KeyframePasteItem[], from: LaneKind, to: LaneKind, opts: string[]): KeyframePasteItem[] {
  if (from === to && to !== 'choice') return items
  return items.map(i => {
    const value = snapValue(to, i.value, opts.length)
    const option = to === 'choice' ? (from === 'choice' && i.option && opts.includes(i.option) ? i.option : optionAt(value, opts)) : undefined
    return {
      offsetFrames: i.offsetFrames, value, ease: to === 'range' ? i.ease : 'hold',
      ...(to === 'range' && i.bend ? { bend: i.bend } : {}), ...(option !== undefined ? { option } : {}),
    }
  })
}

function convertKeys(keys: FKey[], from: LaneKind, to: LaneKind, opts: string[]): FKey[] {
  const items = convertItems(keys.map(k => ({ offsetFrames: k.f, value: k.kf.value, ease: k.kf.ease, option: k.kf.option, bend: k.kf.bend })), from, to, opts)
  return items.map(i => {
    const { offsetFrames, ...rest } = i
    const kf: Keyframe = { time: '', value: rest.value, ease: rest.ease, ...(rest.option !== undefined ? { option: rest.option } : {}), ...(rest.bend ? { bend: rest.bend } : {}) }
    return { f: offsetFrames, kf }
  })
}

// ── Breakpoint drags ──────────────────────────────────────────────────────────

export interface KeyMove { trackId: string; laneId: string; kfIdx: number; f: number; value?: number; option?: string }

/** Breakpoints moved (time and / or value). As in Live, a breakpoint dragged over a neighbour
 *  removes it: keys between a moved key's old and new time on its lane are dropped. */
export function moveKeys(tracks: Track[], moves: KeyMove[], fps: number): Track[] {
  const byLane = new Map<string, KeyMove[]>()
  for (const m of moves) byLane.set(m.laneId, [...(byLane.get(m.laneId) ?? []), m])
  return tracks.map(t => {
    if (!hasLanes(t) || !t.automations.some(l => byLane.has(l.id))) return t
    return {
      ...t,
      automations: t.automations.map(l => {
        const ms = byLane.get(l.id)
        if (!ms) return l
        const moved = new Set(ms.map(m => m.kfIdx))
        const old = l.keyframes.map(kf => smpteToFrames(kf.time, fps))
        // The moved keys share one time offset; what they pass over on the way is removed
        const df = ms[0].f - old[ms[0].kfIdx]
        const olds = ms.map(m => old[m.kfIdx]), news = ms.map(m => m.f)
        const crossed = (i: number) => !moved.has(i) && (
          df > 0 ? old[i] > Math.max(...olds) && old[i] <= Math.max(...news)
          : df < 0 ? old[i] >= Math.min(...news) && old[i] < Math.min(...olds) : false)
        const newF = new Set(news)
        const keys: FKey[] = []
        l.keyframes.forEach((kf, i) => {
          const m = ms.find(x => x.kfIdx === i)
          if (m) keys.push({ f: m.f, kf: { ...kf, ...(m.value !== undefined ? { value: m.value } : {}), ...(m.option !== undefined ? { option: m.option } : {}) } })
          else if (!crossed(i) && !newF.has(old[i])) keys.push({ f: old[i], kf })
        })
        return { ...l, keyframes: toKeyframes(keys, fps) }
      }),
    }
  })
}

/** The keyframe indices of a lane inside [a, b] (Live: the selected breakpoints). */
export function keysIn(lane: AutomationSubTrack, a: number, b: number, fps: number): number[] {
  return lane.keyframes.flatMap((kf, i) => { const f = smpteToFrames(kf.time, fps); return f >= a && f <= b ? [i] : [] })
}

// ── Crossfade ─────────────────────────────────────────────────────────────────

interface Placed { track: LayerTrack; cue: ClipCue; sf: number; ef: number }

function placeCue(tracks: Track[], cueId: string, fps: number): Placed | null {
  for (const t of tracks) {
    if (!isLayer(t)) continue
    const cue = t.clips.find(c => c.id === cueId)
    if (cue) { const sf = smpteToFrames(cue.time, fps); return { track: t, cue, sf, ef: sf + smpteToFrames(cue.duration, fps) } }
  }
  return null
}

// Why two clips can't crossfade, or the plan: the top clip (higher Resolume layer, drawn
// over the other) fades over the overlap, in when it starts later, out when it ends first.
// The lower clip stays at full opacity: with Alpha blending that is a true dissolve.
// Rarely needed: clips one after another on a layer blend with Resolume's layer transition.
function crossfadePlan(tracks: Track[], idA: string, idB: string, fps: number):
  { error: string } | { top: Placed; edge: 'fadeIn' | 'fadeOut'; len: number } {
  const a = placeCue(tracks, idA, fps), b = placeCue(tracks, idB, fps)
  if (!a || !b) return { error: 'Select two clips' }
  if (a.track.id === b.track.id) return { error: 'The clips are on the same layer: put one on another layer' }
  if (a.ef <= a.sf || b.ef <= b.sf) return { error: 'Trigger-only clips have no length to fade' }
  if (a.track.resolumeLayerIndex < 1 || b.track.resolumeLayerIndex < 1) return { error: 'A layer is no longer in Resolume' }
  const lo = Math.max(a.sf, b.sf), hi = Math.min(a.ef, b.ef)
  if (hi <= lo) return { error: 'The clips don\'t overlap: drag one so they overlap where the blend should be' }
  if ((a.sf <= b.sf && a.ef >= b.ef) || (b.sf <= a.sf && b.ef >= a.ef))
    return { error: 'One clip lies inside the other: a crossfade needs one to start while the other ends' }
  const top = a.track.resolumeLayerIndex > b.track.resolumeLayerIndex ? a : b
  const low = top === a ? b : a
  return { top, edge: top.sf > low.sf ? 'fadeIn' : 'fadeOut', len: hi - lo }
}

/** Why the two clips can't crossfade (menu tooltip), or null when they can. */
export function crossfadeProblem(tracks: Track[], idA: string, idB: string, fps: number): string | null {
  const p = crossfadePlan(tracks, idA, idB, fps)
  return 'error' in p ? p.error : null
}

/** Clips on other layers a cue can crossfade with (right-click menu). */
export function crossfadePartners(tracks: Track[], cueId: string, fps: number): { cue: ClipCue; layerName: string }[] {
  const out: { cue: ClipCue; layerName: string }[] = []
  for (const t of tracks) {
    if (!isLayer(t)) continue
    for (const c of t.clips) if (c.id !== cueId && !crossfadeProblem(tracks, cueId, c.id, fps)) out.push({ cue: c, layerName: t.name })
  }
  return out
}

/** The fade a crossfade puts on the top clip (an opacity lane, made by App's clip fade). */
export function crossfadeFade(tracks: Track[], idA: string, idB: string, fps: number): { cueId: string; mode: 'in' | 'out'; frames: number } | null {
  const p = crossfadePlan(tracks, idA, idB, fps)
  return 'error' in p ? null : { cueId: p.top.cue.id, mode: p.edge === 'fadeIn' ? 'in' : 'out', frames: p.len }
}

/** A clip's start moved by a left-edge trim: 'edit' clips move their media start with it (the
 *  picture stays put; never before the media's start), 'loop' clips keep theirs. */
export function trimStart(cue: ClipCue, newSf: number, fps: number): { sf: number; cue: ClipCue } {
  const sf0 = smpteToFrames(cue.time, fps)
  if (cue.trim !== 'edit') return { sf: newSf, cue }
  const sf = Math.max(newSf, sf0 - (cue.mediaStart ?? 0))
  const ms = (cue.mediaStart ?? 0) + (sf - sf0)
  const next = { ...cue }
  if (ms > 0) next.mediaStart = ms; else delete next.mediaStart
  return { sf, cue: next }
}
