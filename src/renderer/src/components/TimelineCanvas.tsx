import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import type { Track, LayerTrack, GroupTrack, ClipCue, Keyframe, Show, AutomationSubTrack, LaneKind } from '../../../shared/show'
import { BASIC_CURVES, FAMILY_CURVES, curveLabel, curveOf, sampleLane } from '../../../shared/automation'
import type { CurveName, FrameKeyframe } from '../../../shared/automation'
import type { WaveformInfo } from '../audio-engine'
import type { DragClipData } from '../App'
import type { LaneStatus, LaneStatusMap } from '../laneStatus'
import { formatValue } from '../../../shared/paramTree'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { T, TAG_COLORS } from '../theme'
import { laneColor } from '../laneColor'
import { deckOfCue, type DeckInfo } from '../decks'
import { RULER_H, AUDIO_LANE_H, DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_AUTO_H } from '../layout'
import { type Tempo, type SnapSettings, musicalSteps, forEachGridLine, frameToBarBeat, formatBarBeat, isBarLine, isBeatLine, isOnStep, snapFrame, rulerSteps, gridSnapOf, snapToGrid } from '../grid'

// Picker offers the muted tags first; saturated ones stay for shows that already use them
const SATURATED_COLORS = ['#E74C3C', '#E2934A', '#F1C40F', '#2ECC71', '#1ABC9C', '#3498DB', '#9B59B6', '#E91E63']

const TC_BAND_H = 19            // ruler: timecode band on top, marker strip below
const CLIP_PAD = 2              // gap between block and lane edge (room for the state halo)
const CLIP_TITLE_H = 16
const RESIZE_HANDLE_W = 10
const AUTO_RESIZE_ZONE = 6      // px at bottom of auto lane to start resize
const TRACKS_TOP = RULER_H + AUDIO_LANE_H
const KF_R = 4                  // keyframe glyph: 8px, 10px on hover
const KF_HIT = 6                // half of the 12px keyframe hit area
const MAX_CHOICE_BANDS = 12     // more options than this: no band separators
const SNAP_PX = 6               // drags snap to markers / playhead (/ clip edges, keys) this close
const DRAG_START_PX = 3         // a clip moves only after this much mouse travel (a click must not nudge it)
const AXIS_LOCK_PX = 4          // Shift-drag picks its axis after this much movement
const FINE = 0.1                // Cmd/Ctrl drag: movement scale

// ── Automation values ─────────────────────────────────────────────────────────

type BasicCurve = typeof BASIC_CURVES[number]
const BASIC_GLYPH: Record<BasicCurve, string> = { linear: '◆', hold: '■', easeIn: '●', easeOut: '●', easeInOut: '●' }
// Resolume families as menu rows: FAMILY_CURVES is family × [In, Out, InOut]
const FAMILY_ROWS: CurveName[][] = []
for (let i = 0; i < FAMILY_CURVES.length; i += 3) FAMILY_ROWS.push(FAMILY_CURVES.slice(i, i + 3))

interface LaneRange { min?: number; max?: number; options?: string[]; suffix?: string; multiplier?: number }

const laneKind = (auto: AutomationSubTrack): LaneKind => auto.kind ?? 'range'

// Live parameter info wins over the range/options last stored in the show
function laneRange(auto: AutomationSubTrack, status: LaneStatus | undefined): LaneRange {
  const info = status?.info
  return {
    min: info?.min ?? auto.min,
    max: info?.max ?? auto.max,
    options: info?.options ?? auto.options,
    suffix: info?.suffix,
    multiplier: info?.multiplier,
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

/** Normalized value a keyframe is drawn at: choice keys sit on their option's step
 *  (the option name wins, it survives Resolume adding/removing options), booleans on 0/1. */
function kfValue(kind: LaneKind, kf: Keyframe, opts: string[]): number {
  if (kind === 'boolean') return kf.value >= 0.5 ? 1 : 0
  if (kind === 'choice') {
    const n = opts.length
    if (n === 0) return clamp01(kf.value)
    if (n === 1) return 0
    const i = kf.option ? opts.indexOf(kf.option) : -1
    return i >= 0 ? i / (n - 1) : Math.round(clamp01(kf.value) * (n - 1)) / (n - 1)
  }
  return clamp01(kf.value)
}

/** Snap a free 0..1 value to the lane's steps (choice options, boolean off/on). */
function snapValue(kind: LaneKind, v: number, nOpts: number): number {
  if (kind === 'boolean') return v >= 0.5 ? 1 : 0
  if (kind === 'choice' && nOpts >= 2) return Math.round(clamp01(v) * (nOpts - 1)) / (nOpts - 1)
  if (kind === 'choice' && nOpts === 1) return 0
  return clamp01(v)
}

const optionAt = (v: number, opts: string[]): string | undefined =>
  opts.length ? opts[Math.round(clamp01(v) * Math.max(0, opts.length - 1))] : undefined

const laneTitle = (auto: AutomationSubTrack) => auto.ref?.label ?? auto.name
const laneParamName = (auto: AutomationSubTrack, status: LaneStatus | undefined) =>
  status?.info?.name ?? auto.ref?.label.split(' › ').pop() ?? auto.name

// Range lanes: editable text in real units ↔ normalized value
// Typed values use Resolume's display units (real × multiplier, e.g. opacity in %)
function realText(v: number, r: LaneRange): string {
  const min = r.min ?? 0, max = r.max ?? 1, m = r.multiplier ?? 1
  return String(+((min + clamp01(v) * (max - min)) * m).toFixed(Math.abs(max - min) * m > 10 ? 2 : 4))
}
function realToNorm(text: string, r: LaneRange): number | null {
  const n = parseFloat(text.replace(',', '.')) / (r.multiplier ?? 1)
  if (!Number.isFinite(n)) return null
  const min = r.min ?? 0, max = r.max ?? 1
  return max === min ? 0 : +clamp01((n - min) / (max - min)).toFixed(6)
}

/** New index of every keyframe of a lane after a batch edit. Mirrors the App: updates are
 *  applied by old index, then the lane is re-sorted once, stably, by time. */
function indicesAfterUpdates(kfs: Keyframe[], ups: Map<number, Partial<Keyframe>>, fps: number): number[] {
  const next = kfs.map((k, i) => ({ k: ups.has(i) ? { ...k, ...ups.get(i) } : k, i }))
  if ([...ups.values()].some(u => u.time !== undefined))
    next.sort((a, b) => smpteToFrames(a.k.time, fps) - smpteToFrames(b.k.time, fps))
  const map: number[] = []
  next.forEach((e, ni) => { map[e.i] = ni })
  return map
}

/** New indices of pasted keyframes. Mirrors the App: keyframes at a pasted time are
 *  replaced, then the lane is sorted stably by time. */
function pastedIndices(kfs: Keyframe[], frames: number[], fps: number): number[] {
  const taken = new Set(frames)
  const all = [
    ...kfs.map(k => smpteToFrames(k.time, fps)).filter(f => !taken.has(f)).map(f => ({ f, j: -1 })),
    ...frames.map((f, j) => ({ f, j })),
  ].sort((a, b) => a.f - b.f)
  return all.flatMap((e, i) => (e.j >= 0 ? [i] : []))
}

/** Copied keyframe values for a lane of another kind: range ↔ choice ↔ on/off by the same
 *  0..1 position (a choice lane takes the option at that position). */
function convertItems(items: KeyframePasteItem[], from: LaneKind, to: LaneKind, opts: string[]): KeyframePasteItem[] {
  if (from === to && to !== 'choice') return items
  return items.map(i => {
    const value = snapValue(to, i.value, opts.length)
    const option = to === 'choice' ? (from === 'choice' && i.option && opts.includes(i.option) ? i.option : optionAt(value, opts)) : undefined
    return { offsetFrames: i.offsetFrames, value, ease: to === 'range' ? i.ease : 'hold', ...(option !== undefined ? { option } : {}) }
  })
}

// ── Layout ────────────────────────────────────────────────────────────────────

// One entry per automation index (indices stay aligned with track.automations); a hidden
// lane (auto.visible === false) has h = 0 and is skipped by every draw and hit test.
interface AutoLaneLayout { y: number; h: number; id: string }
interface TrackLayout { y: number; totalH: number; autoLanes: AutoLaneLayout[]; hidden?: boolean }

// Rail colour of a group without a Resolume colour tag (tokens.css --group-none)
const GROUP_NONE = '#7a7a7a'

// What the canvas draws per row. Group tracks are drawn as clip-less rows carrying their own
// automation lanes (so all lane editing works for them unchanged); members of a collapsed
// group are hidden, and members inherit the group's mute/lock for display.
type ViewTrack = LayerTrack & { group?: GroupTrack; hidden?: boolean; groupColor?: string }

function toViewTracks(tracks: Track[]): Track[] {
  const groups = new Map(tracks.filter(t => t.type === 'group').map(t => [(t as GroupTrack).resolumeGroupId, t as GroupTrack]))
  return tracks.map(t => {
    if (t.type === 'group') {
      const g = t as GroupTrack
      return { ...g, type: 'layer', clips: [], resolumeLayerId: -1, resolumeLayerIndex: g.resolumeGroupIndex, group: g } as unknown as Track
    }
    const g = t.type === 'layer' && (t as LayerTrack).groupId !== undefined ? groups.get((t as LayerTrack).groupId!) : undefined
    if (!g) return t
    const lt = t as LayerTrack
    return { ...lt, hidden: !!g.collapsed, groupColor: g.color ?? GROUP_NONE, muted: lt.muted || g.muted, locked: lt.locked || g.locked } as ViewTrack
  })
}

function buildLayout(
  tracks: Track[], clipH: (id: string) => number,
  autoH: (id: string) => number, scrollY = 0
): TrackLayout[] {
  // Start below ruler + pinned audio lane, offset by vertical scroll
  let y = TRACKS_TOP - scrollY
  return tracks.map(track => {
    if ((track as ViewTrack).hidden) return { y, totalH: 0, autoLanes: [], hidden: true }
    const curClipH = clipH(track.id)
    const autoLanes: AutoLaneLayout[] = []
    if (track.type === 'layer' && (track as LayerTrack).expanded) {
      let ay = y + curClipH
      for (const auto of (track as LayerTrack).automations) {
        const h = auto.visible === false ? 0 : autoH(auto.id)
        autoLanes.push({ y: ay, h, id: auto.id })
        ay += h
      }
    }
    const totalH = curClipH + autoLanes.reduce((s, l) => s + l.h, 0)
    const layout: TrackLayout = { y, totalH, autoLanes }
    y += totalH
    return layout
  })
}

function getTrackAtY(layout: TrackLayout[], y: number) {
  for (let i = 0; i < layout.length; i++) {
    if (y >= layout[i].y && y < layout[i].y + layout[i].totalH) return i
  }
  return null
}

function getAutoLaneAt(layout: TrackLayout[], y: number): { trackIdx: number; autoIdx: number; lane: AutoLaneLayout } | null {
  for (let ti = 0; ti < layout.length; ti++) {
    for (let ai = 0; ai < layout[ti].autoLanes.length; ai++) {
      const lane = layout[ti].autoLanes[ai]
      if (lane.h > 0 && y >= lane.y && y < lane.y + lane.h) return { trackIdx: ti, autoIdx: ai, lane }
    }
  }
  return null
}

// Convert value [0,1] to canvas Y within a lane, and back
const kfToY = (lane: AutoLaneLayout) => (v: number) =>
  lane.y + 6 + (lane.h - 13) * (1 - Math.max(0, Math.min(1, v)))
const kfFromY = (lane: AutoLaneLayout, y: number) =>
  Math.max(0, Math.min(1, 1 - (y - lane.y - 6) / (lane.h - 13)))

// ── Hit tests ─────────────────────────────────────────────────────────────────

export interface KeyframeRef { trackIdx: number; autoIdx: number; kfIdx: number }
export interface KeyframeUpdate extends KeyframeRef { updates: Partial<Keyframe> }
export interface KeyframePasteItem { offsetFrames: number; value: number; ease: string; option?: string }
type KfHit = KeyframeRef

function hitTestKeyframe(
  cx: number, cy: number, layout: TrackLayout[],
  tracks: Track[], fps: number,
  frameToX: (f: number) => number,
  laneStatus: LaneStatusMap,
): KfHit | null {
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti]
    if (track.type !== 'layer') continue
    const lt = track as LayerTrack
    for (let ai = 0; ai < lt.automations.length; ai++) {
      const lane = layout[ti].autoLanes[ai]
      if (!lane || lane.h <= 0 || cy < lane.y || cy >= lane.y + lane.h) continue
      const auto = lt.automations[ai]
      const kind = laneKind(auto)
      const opts = laneRange(auto, laneStatus[auto.id]).options ?? []
      const toY = kfToY(lane)
      let best: KfHit | null = null, bestD = Infinity
      for (let ki = 0; ki < auto.keyframes.length; ki++) {
        const kf = auto.keyframes[ki]
        const dx = Math.abs(cx - frameToX(smpteToFrames(kf.time, fps)))
        const dy = Math.abs(cy - toY(kfValue(kind, kf, opts)))
        if (dx <= KF_HIT && dy <= KF_HIT && dx + dy < bestD) { best = { trackIdx: ti, autoIdx: ai, kfIdx: ki }; bestD = dx + dy }
      }
      if (best) return best
    }
  }
  return null
}

const sameKf = (a: KfHit | null | undefined, b: KfHit | null | undefined) =>
  !!a && !!b && a.trackIdx === b.trackIdx && a.autoIdx === b.autoIdx && a.kfIdx === b.kfIdx
const kfRef = (h: KfHit): KfHit => ({ trackIdx: h.trackIdx, autoIdx: h.autoIdx, kfIdx: h.kfIdx })
const laneKey = (h: { trackIdx: number; autoIdx: number }) => `${h.trackIdx}:${h.autoIdx}`
const selHas = (sel: KfHit[], h: KfHit) => sel.some(s => sameKf(s, h))
const sameSel = (a: KfHit[], b: KfHit[]) => a.length === b.length && a.every(h => selHas(b, h))

/** Selection after deleting keyframes: deleted ones drop out, later ones in their lane shift down. */
function selAfterDelete(sel: KfHit[], del: KfHit[]): KfHit[] {
  return sel.filter(s => !selHas(del, s)).map(s => ({
    ...s, kfIdx: s.kfIdx - del.filter(d => laneKey(d) === laneKey(s) && d.kfIdx < s.kfIdx).length,
  }))
}

/** Selection after a batch update that may re-sort the touched lanes. */
function selAfterUpdates(sel: KfHit[], ups: KeyframeUpdate[], tracks: Track[], fps: number): KfHit[] {
  const maps = new Map<string, number[]>()
  for (const key of new Set(ups.map(laneKey))) {
    const lu = ups.filter(u => laneKey(u) === key)
    const auto = (tracks[lu[0].trackIdx] as LayerTrack | undefined)?.automations?.[lu[0].autoIdx]
    if (auto) maps.set(key, indicesAfterUpdates(auto.keyframes, new Map(lu.map(u => [u.kfIdx, u.updates])), fps))
  }
  return sel.map(s => ({ ...s, kfIdx: maps.get(laneKey(s))?.[s.kfIdx] ?? s.kfIdx }))
}

function findLane(tracks: Track[], laneId: string): { trackIdx: number; autoIdx: number; auto: AutomationSubTrack } | null {
  for (let ti = 0; ti < tracks.length; ti++) {
    const t = tracks[ti]
    if (t.type !== 'layer') continue
    const ai = t.automations.findIndex(a => a.id === laneId)
    if (ai >= 0) return { trackIdx: ti, autoIdx: ai, auto: t.automations[ai] }
  }
  return null
}

function hitTestAutoResize(layout: TrackLayout[], y: number): { autoId: string } | null {
  for (const tl of layout) {
    for (const lane of tl.autoLanes) {
      if (lane.h <= 0) continue
      const bottom = lane.y + lane.h
      if (Math.abs(y - bottom) <= AUTO_RESIZE_ZONE) return { autoId: lane.id }
    }
  }
  return null
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxMenu { x: number; y: number; trackIdx: number; autoIdx: number; kfIdx: number }

// ── Keyframe drag / marquee / clipboard ───────────────────────────────────────

// f/v: where the key is drawn during the drag; valued = the drag also changes its value
interface DragItem extends KfHit { kind: LaneKind; opts: string[]; f0: number; v0: number; f: number; v: number; valued: boolean }
interface KfDrag {
  primary: DragItem; items: DragItem[]; lane: AutoLaneLayout
  startX: number; startY: number; lastX: number; lastY: number
  accX: number; accY: number           // movement in px, already scaled by fine mode
  axis: 'x' | 'y' | null; moved: boolean
  click: 'remove' | 'collapse' | null  // what a click without movement does to the selection
  altDelete: boolean                   // Alt-click (no movement) deletes
  copy: boolean                        // Alt held while dragging: drop copies, the originals stay
  snapTargets: number[]; snapF: number | null
}
interface Marquee {
  trackIdx: number; autoIdx: number; lane: AutoLaneLayout
  x0: number; y0: number; x1: number; y1: number; base: KfHit[]
}
interface KfClipboard { lanes: { laneId: string; kind: LaneKind; items: KeyframePasteItem[] }[] }
// Module level: survives the canvas remounting on view switches
let kfClipboard: KfClipboard | null = null
/** A clip copied (⌘C, ⌘D, Alt-drag) with the automation lanes that move with it. */
export interface CueCopy { trackId: string; cue: ClipCue; lanes: AutomationSubTrack[]; frame: number }
let clipClipboard: CueCopy[] | null = null
// ⌘V pastes what was copied last: keyframes or clips
let lastCopied: 'keys' | 'clips' | null = null

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  tracks: Track[]
  markers: { id: string; time: string; name: string; color: string }[]
  fps: number
  tempo: Tempo | null                 // musical grid (null = no BPM)
  onSetDownbeat: (frame: number) => void   // ruler right-click: where bar 1 beat 1 is
  rulerMode: 'timecode' | 'bars'      // in effect; 'bars' only with a tempo
  snap: SnapSettings                  // snap to grid in effect (⌘ during a drag = free; Alt = copy)
  frame: number
  pxPerFrame: number
  scrollFrame: number
  draggingClip: DragClipData | null
  autoLaneHeights: Record<string, number>
  layerRowHeights: Record<string, number>
  audioTrack?: Show['audioTrack']
  audioDuration: number
  waveformInfo?: WaveformInfo | null
  scrollY: number
  readOnly: boolean   // SHOW mode: selection and seeking only
  laneStatus: LaneStatusMap  // runtime target state per automation lane id (range, options, broken)
  // lane id → Resolume's current value (normalized 0..1), only while the operator overrides the lane
  overrides: Record<string, number>
  decks: DeckInfo[]            // Resolume decks; cues show which deck they fire from
  onScrollY: (delta: number) => void
  onScrollFrame: (f: number) => void
  onSeek: (frame: number) => void
  onZoom: (factor: number) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onDropClip: (trackIdx: number, frame: number, data: DragClipData) => void
  onUpdateCue: (trackIdx: number, cueIdx: number, updates: Partial<ClipCue>) => void
  // Several clips at once (multi-selection): move to new start frames, insert copies (returns
  // the new cue ids, in order), delete with the lanes bound to them
  onMoveCues: (moves: { trackIdx: number; cueId: string; frame: number }[]) => void
  onInsertCues: (items: CueCopy[]) => string[]
  onDeleteCues: (cueIds: string[]) => void
  // option: choice lanes, the option name of the snapped value
  onAddKeyframe: (trackIdx: number, autoIdx: number, frame: number, value: number, option?: string) => void
  // updates may carry time, value, ease (Curve) and option (choice lanes)
  onUpdateKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number, updates: Partial<Keyframe>) => void
  onDeleteKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number) => void
  // Batch edits, applied atomically. Indices refer to the lanes BEFORE the call; updates
  // are applied by index, then each touched lane is re-sorted once (stable) by time.
  onUpdateKeyframes: (items: KeyframeUpdate[]) => void
  onDeleteKeyframes: (items: KeyframeRef[]) => void
  // Keyframes at atFrame + offsetFrames; existing keyframes at those exact times are replaced
  onPasteKeyframes: (trackIdx: number, autoIdx: number, atFrame: number, items: KeyframePasteItem[]) => void
  // Clip right-click automation templates: opacity fade on the cue's clip, copy / paste of
  // every lane bound to the cue. clipFadeUnavailable → reason the fade can't be made, or null.
  onClipFade: (trackIdx: number, cueIdx: number, mode: 'in' | 'out' | 'inout', seconds: number) => void
  clipFadeUnavailable: (trackIdx: number, cueIdx: number) => string | null
  onCopyClipAutomation: (trackIdx: number, cueIdx: number) => void
  onPasteClipAutomation: (trackIdx: number, cueIdx: number) => void
  canPasteClipAutomation: boolean
  onResizeAutoLane: (autoId: string, height: number) => void
  selectedTrackIdx: number | null
  selectedCueIdx: number | null
}

interface ClipColorPicker { x: number; y: number; trackIdx: number; cueIdx: number }

export function TimelineCanvas({
  tracks: tracksProp, markers, fps, tempo, rulerMode: rulerModeProp, snap, frame, pxPerFrame, scrollFrame, draggingClip,
  autoLaneHeights, layerRowHeights, audioTrack, audioDuration, waveformInfo,
  scrollY, readOnly, laneStatus, overrides, decks, onScrollY, onScrollFrame, onSeek, onZoom, onSelectCue,
  onDropClip, onUpdateCue, onMoveCues, onInsertCues, onDeleteCues, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
  onUpdateKeyframes, onDeleteKeyframes, onPasteKeyframes,
  onClipFade, clipFadeUnavailable, onCopyClipAutomation, onPasteClipAutomation, canPasteClipAutomation, onSetDownbeat,
  onResizeAutoLane, selectedTrackIdx, selectedCueIdx,
}: Props) {
  const tracks = useMemo(() => toViewTracks(tracksProp), [tracksProp])
  const bars = rulerModeProp === 'bars' && tempo ? tempo : null   // musical ruler + grid in effect
  // Snap to grid: null when off. 'auto' follows the zoom, so it is recomputed every render.
  const gridSnap = gridSnapOf(snap, tempo, rulerModeProp, pxPerFrame, fps)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [ctxInputVal, setCtxInputVal] = useState('')
  const [clipColorPicker, setClipColorPicker] = useState<ClipColorPicker | null>(null)
  const [rulerMenu, setRulerMenu] = useState<{ x: number; y: number; frame: number } | null>(null)
  // The Bar 1 menu closes on any click outside it (headers, transport, panels) and on Escape
  useEffect(() => {
    if (!rulerMenu) return
    const close = () => setRulerMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [rulerMenu])
  const [fadeSeconds, setFadeSeconds] = useState(1)   // clip menu fade length, kept for the session
  const [sel, setSel] = useState<KfHit[]>([])
  const [hoverKf, setHoverKf] = useState<KfHit | null>(null)
  // Handlers read the selection through the ref, so a change is visible before the re-render
  const selRef = useRef(sel)
  const updateSel = (next: KfHit[]) => { selRef.current = next; setSel(next) }
  const frameRef = useRef(frame)
  frameRef.current = frame
  // Last clicked automation lane (by id): paste target for a single-lane clipboard
  const focusLaneRef = useRef<string | null>(null)

  // Clip multi-selection (cue ids). The App's selected cue (inspector) is one of them.
  const [clipSel, setClipSel] = useState<string[]>([])
  const clipSelRef = useRef(clipSel)
  const updateClipSel = (next: string[]) => { clipSelRef.current = next; setClipSel(next) }
  const primaryCueId = selectedTrackIdx != null && selectedCueIdx != null
    ? (tracksProp[selectedTrackIdx] as LayerTrack | undefined)?.clips?.[selectedCueIdx]?.id ?? null : null
  useEffect(() => {
    if (primaryCueId && !clipSelRef.current.includes(primaryCueId)) updateClipSel([primaryCueId])
  }, [primaryCueId])
  /** Where a cue is now (indices change when clips are re-sorted). */
  const cueById = (id: string): { trackIdx: number; cueIdx: number; lt: LayerTrack; cue: ClipCue } | null => {
    for (let ti = 0; ti < tracks.length; ti++) {
      const lt = tracks[ti] as LayerTrack
      if (lt.type !== 'layer') continue
      const ci = lt.clips.findIndex(c => c.id === id)
      if (ci >= 0) return { trackIdx: ti, cueIdx: ci, lt, cue: lt.clips[ci] }
    }
    return null
  }
  /** Copies of clips with the lanes that move with them (bound to the cue). */
  const snapshotCues = (ids: string[]): CueCopy[] => ids.flatMap(id => {
    const at = cueById(id)
    if (!at) return []
    const lanes = at.lt.automations.filter(a => a.clipId === id && !a.layerBound)
    return [{ trackId: at.lt.id, cue: at.cue, lanes, frame: smpteToFrames(at.cue.time, fps) }]
  })

  const autoH = (id: string) => autoLaneHeights[id] ?? DEFAULT_AUTO_H
  const clipH = (id: string) => layerRowHeights[id] ?? DEFAULT_LANE_H
  const canEdit = (ti: number) => !readOnly && !(tracks[ti] as LayerTrack | undefined)?.locked
  const autoAt = (ti: number, ai: number): AutomationSubTrack | undefined =>
    (tracks[ti] as LayerTrack | undefined)?.automations?.[ai]
  // A broken lane keeps its keyframes but refuses edits until it is retargeted
  const canEditLane = (ti: number, ai: number) => {
    const auto = autoAt(ti, ai)
    return !!auto && canEdit(ti) && laneStatus[auto.id]?.state !== 'broken'
  }

  // Drag state refs
  const isDraggingPlayhead = useRef(false)
  // anchorMouseFrame: fractional frame under the cursor at mousedown (cursor-to-start offset)
  // group: every selected clip moves with the one dragged; collapse: a click without movement
  // on a clip of a multi-selection selects just that clip
  const moveClipRef = useRef<{
    trackIdx: number; cueIdx: number; startX: number; moved: boolean; anchorMouseFrame: number; anchorCueFrame: number
    group: { trackIdx: number; cueIdx: number; f0: number }[]; collapse: string | null
  } | null>(null)
  const resizeClipRef = useRef<{ trackIdx: number; cueIdx: number; startX: number; moved: boolean; startF: number; startDurF: number } | null>(null)
  // Snap guide of a clip move / resize / clip-browser drop (keyframe drags keep theirs in KfDrag)
  const snapGuideRef = useRef<number | null>(null)
  const kfDragRef = useRef<KfDrag | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const autoResizeRef = useRef<{ autoId: string; startY: number; startH: number } | null>(null)
  // Clips being dragged at their new start; copy: Alt held, the originals stay where they are
  const ghostClipRef = useRef<{ copy: boolean; items: { trackIdx: number; cueIdx: number; frame: number }[] } | null>(null)
  // Marquee over clip rows: selects every clip it touches (base: selection it adds to, Shift)
  const clipMarqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number; base: string[] } | null>(null)
  const ghostDurRef = useRef<{ trackIdx: number; cueIdx: number; durF: number } | null>(null)

  const frameToX = (f: number) => (f - scrollFrame) * pxPerFrame
  const xToFrame = (x: number) => Math.max(0, Math.round(x / pxPerFrame + scrollFrame))

  /** Where a dragged clip edge / dropped clip / new key lands. Snap on: the nearest grid line, or a
   *  marker / the playhead within SNAP_PX when that is nearer. Snap off or free (⌘): the whole
   *  frame under the cursor, no snapping. guide = the frame to draw the snap line at. */
  const snapDrag = (rawF: number, free: boolean): { f: number; guide: number | null } => {
    if (free || !gridSnap) return { f: Math.max(0, Math.round(rawF)), guide: null }
    let best = snapToGrid(rawF, gridSnap.stepF, gridSnap.tempo)
    let bestD = Math.abs(best - rawF)
    const near = SNAP_PX / pxPerFrame
    for (const c of [...markers.map(m => smpteToFrames(m.time, fps)), Math.round(frameRef.current)]) {
      const d = Math.abs(c - rawF)
      if (d <= near && d < bestD) { best = c; bestD = d }
    }
    best = Math.max(0, best)
    return { f: best, guide: best }
  }

  useEffect(() => {
    if (readOnly) { setContextMenu(null); setClipColorPicker(null); updateSel([]) }
  }, [readOnly])

  // Keys removed elsewhere (undo, lane deleted) leave the selection
  useEffect(() => {
    const s = selRef.current.filter(h => {
      const a = autoAt(h.trackIdx, h.autoIdx)
      return !!a?.keyframes[h.kfIdx] && a.visible !== false
    })
    if (s.length !== selRef.current.length) updateSel(s)
  }, [tracks])

  // ── Draw ──────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current, container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Backing store in device pixels, all drawing and hit-testing in CSS pixels
    const W = container.clientWidth, H = container.clientHeight
    if (W === 0 || H === 0) return
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const layout = buildLayout(tracks, clipH, autoH, scrollY)
    const last = layout[layout.length - 1]
    const tracksBottom = Math.min(H, last ? last.y + last.totalH : TRACKS_TOP)
    const tips: { text: string; x: number; y: number }[] = []
    const kd = kfDragRef.current
    const dragMap = new Map<string, DragItem>()
    // A copy-drag leaves the originals in place: the copies are drawn as ghosts
    if (kd?.moved && !kd.copy) kd.items.forEach(i => dragMap.set(`${laneKey(i)}:${i.kfIdx}`, i))
    const pxToFrame = (px: number) => px / pxPerFrame + scrollFrame

    // Clip automation: the lane's cue spans as boxes in the cue colour, the rest dimmed
    // (the parameter only matters while the clip plays). Keyframes stay on top, editable.
    const drawClipScope = (lt: LayerTrack, auto: AutomationSubTrack, lane: AutoLaneLayout, spans: ClipSpan[], trackColor: string) => {
      const cues = laneCues(lt, auto)
      const ly = lane.y, lh = lane.h - 1
      ctx.save()
      ctx.beginPath(); ctx.rect(0, ly, W, lh); ctx.clip()
      const boxes = cues.map(ci => {
        const { sf, shownF } = spans[ci]
        const x = Math.round(frameToX(sf))
        return { ci, x, w: Math.round(spanWidth(shownF, pxPerFrame)) }
      }).sort((a, b) => a.x - b.x)
      // Dim everything outside the boxes
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      let cx = 0
      for (const b of boxes) {
        if (b.x > cx) ctx.fillRect(cx, ly, Math.min(b.x, W) - cx, lh)
        cx = Math.max(cx, b.x + b.w)
        if (cx >= W) break
      }
      if (cx < W) ctx.fillRect(cx, ly, W - cx, lh)
      for (const b of boxes) {
        if (b.x + b.w < 0 || b.x > W) continue
        const clip = lt.clips[b.ci]
        const c = clip.color ?? clip.resolumeColor ?? trackColor
        ctx.fillStyle = rgba(c, 0.14); ctx.fillRect(b.x, ly, b.w, lh)
        ctx.fillStyle = rgba(c, 0.7); ctx.fillRect(b.x, ly, b.w, 1)
        const tx = Math.max(b.x, 0) + 4, tw = b.x + b.w - tx - 4
        if (tw > 6 && lh >= 14) {
          ctx.save()
          ctx.beginPath(); ctx.rect(b.x, ly, b.w, lh); ctx.clip()
          ctx.font = `10px ${T.fontCond}`; ctx.fillStyle = 'rgba(255,255,255,0.7)'
          ctx.textAlign = 'left'; ctx.textBaseline = 'top'
          ctx.fillText(fitText(ctx, clip.clipName || `Clip ${clip.clipIndex}`, tw), tx, ly + 3)
          ctx.restore()
        }
      }
      ctx.restore()
    }

    // One automation lane: curve by kind, keyframe glyphs, playhead dot
    const drawAutoLane = (trackIdx: number, ai: number, auto: AutomationSubTrack, lane: AutoLaneLayout) => {
      const kind = laneKind(auto)
      const status = laneStatus[auto.id]
      const range = laneRange(auto, status)
      const opts = range.options ?? []
      const broken = status?.state === 'broken'
      const disabled = auto.enabled === false
      const ovr = overrides[auto.id]
      const overridden = typeof ovr === 'number' && Number.isFinite(ovr)
      const faded = broken || disabled || overridden
      const laneC = laneColor(auto, tracks[trackIdx] as LayerTrack, T.text)
      const lineC = faded ? T.textFaint : laneC
      const kfC = broken ? T.textFaint : laneC
      const toY = kfToY(lane)

      ctx.save()
      ctx.beginPath(); ctx.rect(0, lane.y, W, lane.h - 1); ctx.clip()
      ctx.textAlign = 'left'

      // Display range (real units) at the left edge
      if (kind === 'range') {
        ctx.font = `11px ${T.fontUi}`; ctx.fillStyle = T.textDim
        ctx.textBaseline = 'top'
        ctx.fillText(formatValue('range', 1, range, undefined, range.suffix), 8, lane.y + 2)
        ctx.textBaseline = 'bottom'
        ctx.fillText(formatValue('range', 0, range, undefined, range.suffix), 8, lane.y + lane.h - 3)
      }

      // Keyframes as drawn: dragged ones sit at their drag position
      const keys = auto.keyframes.map((kf, ki) => {
        const d = dragMap.get(`${trackIdx}:${ai}:${ki}`)
        const f = d ? d.f : smpteToFrames(kf.time, fps)
        const v = d ? d.v : kfValue(kind, kf, opts)
        const c: CurveName = kind === 'range' ? curveOf(kf.ease) : 'hold'
        return { ki, kf, f, v, c, x: frameToX(f), y: toY(v), dragging: !!d, primary: !!d && d === kd?.primary }
      })
      const sorted = [...keys].sort((a, b) => a.f - b.f || a.ki - b.ki)
      // Same interpolation as the engine; kfToY clamps elastic/back overshoot to the lane
      const fks: FrameKeyframe[] = sorted.map(k => ({ frame: k.f, value: k.v, curve: k.c }))

      if (sorted.length) {
        // Curve outline: holds as steps, eased segments sampled every 2px
        const pts: [number, number][] = [[sorted[0].x, sorted[0].y]]
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i + 1]
          if (a.c === 'hold') { pts.push([b.x, a.y], [b.x, b.y]); continue }
          if (a.c !== 'linear') {
            const seg = [fks[i], fks[i + 1]]
            const xe = Math.min(b.x, W)
            for (let px = Math.ceil(Math.max(a.x, 0)); px < xe; px += 2) {
              const s = sampleLane(seg, pxToFrame(px), kind)
              if (s) pts.push([px, toY(s.value)])
            }
          }
          pts.push([b.x, b.y])
        }
        const first = sorted[0], lastK = sorted[sorted.length - 1]

        if (kind === 'range') {
          ctx.beginPath(); ctx.moveTo(first.x, toY(0))
          pts.forEach(p => ctx.lineTo(p[0], p[1]))
          ctx.lineTo(lastK.x, toY(0)); ctx.closePath()
          ctx.fillStyle = rgba(lineC, faded ? 0.06 : 0.12); ctx.fill()
        } else if (kind === 'boolean') {
          ctx.fillStyle = rgba(lineC, faded ? 0.25 : 0.55)
          for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i], b = sorted[i + 1]
            if (a.v >= 0.5 && b.x > a.x) ctx.fillRect(a.x, toY(1), b.x - a.x, toY(0) - toY(1))
          }
        }

        ctx.strokeStyle = lineC; ctx.lineWidth = kind === 'boolean' ? 1 : 1.5
        ctx.setLineDash(disabled || overridden ? [4, 3] : [])
        ctx.beginPath()
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
        ctx.stroke()

        // Value held before the first and after the last keyframe
        ctx.strokeStyle = rgba(lineC, 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 4])
        ctx.beginPath()
        ctx.moveTo(0, first.y); ctx.lineTo(first.x, first.y)
        ctx.moveTo(lastK.x, lastK.y); ctx.lineTo(W, lastK.y)
        ctx.stroke(); ctx.setLineDash([])

        // Discrete lanes: option name / On-Off written on each plateau
        if (kind !== 'range') {
          ctx.font = `11px ${T.fontUi}`
          sorted.forEach((a, i) => {
            const x0 = Math.max(a.x, 0) + 6
            const x1 = (i + 1 < sorted.length ? Math.min(sorted[i + 1].x, W) : W) - 6
            if (x1 - x0 < 12) return
            const label = fitText(ctx, formatValue(kind, a.v, range, a.dragging ? undefined : a.kf.option), x1 - x0)
            if (!label) return
            if (kind === 'boolean') {
              const on = a.v >= 0.5
              ctx.fillStyle = broken || disabled ? T.textFaint : on ? T.textHi : T.textDim
              ctx.textBaseline = on ? 'top' : 'bottom'
              ctx.fillText(label, x0, on ? toY(1) + 2 : toY(0) - 2)
            } else {
              const above = a.y - lane.y >= 16
              ctx.fillStyle = broken || disabled ? T.textFaint : T.text
              ctx.textBaseline = above ? 'bottom' : 'top'
              ctx.fillText(label, x0, above ? a.y - 3 : a.y + 3)
            }
          })
        }
      }

      // Operator override: Resolume's current value as a line, OVR tag at the right edge
      if (overridden) {
        const oy = Math.round(toY(ovr)) + 0.5
        ctx.font = `bold 9px ${T.fontUi}`
        const tw = Math.ceil(ctx.measureText('OVR').width) + 8, th = 12
        const tx = W - tw - 4
        ctx.strokeStyle = T.loop; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(tx, oy); ctx.stroke()
        const ty = Math.round(Math.max(lane.y + 1, Math.min(lane.y + lane.h - 2 - th, oy - th / 2)))
        ctx.fillStyle = T.loop; ctx.fillRect(tx, ty, tw, th)
        ctx.fillStyle = T.textOnLive; ctx.textBaseline = 'middle'
        ctx.fillText('OVR', tx + 4, ty + th / 2 + 0.5)
      }

      // Keyframe glyphs: ◆ linear, ■ hold, ● eased (basic and Resolume families)
      const paramName = laneParamName(auto, status)
      keys.forEach(k => {
        if (k.x < -20 || k.x > W + 20) return
        const hit = { trackIdx, autoIdx: ai, kfIdx: k.ki }
        const active = k.dragging || selHas(sel, hit) || sameKf(contextMenu, hit)
        const hover = !kd && sameKf(hoverKf, hit)
        const r = hover || k.primary ? KF_R + 1 : KF_R
        ctx.globalAlpha = disabled ? 0.45 : 1
        if (active) { kfGlyph(ctx, k.c, k.x, k.y, r + 1.5); ctx.fillStyle = T.gutter; ctx.fill() }
        kfGlyph(ctx, k.c, k.x, k.y, r)
        ctx.fillStyle = active && !broken ? T.select : kfC; ctx.fill()
        if (!active) { ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke() }
        ctx.globalAlpha = 1
        if (k.primary && kd) {
          const n = kd.items.length
          tips.push({ text: `${formatValue(kind, k.v, range, undefined, range.suffix)} · ${framesToSmpte(k.f, fps)}${n > 1 ? `  (${n})` : ''}`, x: k.x, y: k.y })
        } else if (hover)
          tips.push({ text: `${paramName}: ${formatValue(kind, k.v, range, k.kf.option, range.suffix)} · ${k.kf.time}`, x: k.x, y: k.y })
      })

      // Alt-drag: the copies at their drop position
      if (kd?.moved && kd.copy) kd.items.forEach(i => {
        if (i.trackIdx !== trackIdx || i.autoIdx !== ai) return
        const src = auto.keyframes[i.kfIdx]
        const gx = frameToX(i.f), gy = toY(i.v)
        kfGlyph(ctx, kind === 'range' && src ? curveOf(src.ease) : 'hold', gx, gy, KF_R + 1)
        ctx.fillStyle = rgba(T.select, 0.55); ctx.fill()
        ctx.strokeStyle = T.select; ctx.lineWidth = 1; ctx.stroke()
        if (i === kd.primary) tips.push({ text: `+ copy  ${formatValue(kind, i.v, range, undefined, range.suffix)} · ${framesToSmpte(i.f, fps)}${kd.items.length > 1 ? `  (${kd.items.length})` : ''}`, x: gx, y: gy })
      })

      // Value at the playhead
      const cur = sampleLane(fks, frame, kind)?.value
      const lx = frameToX(frame)
      if (cur != null && lx >= -4 && lx <= W + 4) {
        ctx.beginPath(); ctx.arc(lx, toY(cur), 2.5, 0, Math.PI * 2)
        ctx.fillStyle = faded ? T.textFaint : T.live; ctx.fill()
        ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
      }
      ctx.restore()
    }

    ctx.fillStyle = T.well
    ctx.fillRect(0, 0, W, H)

    drawRuler(ctx, W, fps, pxPerFrame, scrollFrame, markers, bars)
    drawAudioLane(ctx, W, audioTrack, fps, pxPerFrame, scrollFrame, audioDuration, waveformInfo ?? null)
    // Bars mode: bar lines only, very faint, over the waveform, so the downbeat can be checked against the song
    if (bars) drawBarGrid(ctx, W, RULER_H, AUDIO_LANE_H - 1, pxPerFrame, scrollFrame, bars, true)

    // Track area (below ruler + audio lane)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, TRACKS_TOP, W, H - TRACKS_TOP)
    ctx.clip()

    // Lane backgrounds
    tracks.forEach((track, i) => {
      const { y, autoLanes, hidden } = layout[i]
      if (hidden) return
      const curClipH = clipH(track.id)
      const base = i % 2 === 0 ? T.lane : T.laneAlt
      const vt = track as ViewTrack
      ctx.fillStyle = base
      ctx.fillRect(0, y, W, curClipH - 1)
      if (vt.group) {
        // Group row: tinted with the group colour; collapsed, it summarises member clips
        ctx.fillStyle = rgba(vt.group.color ?? T.text, 0.1); ctx.fillRect(0, y, W, curClipH - 1)
        ctx.fillStyle = rgba(vt.group.color ?? T.text, 0.8); ctx.fillRect(0, y, W, 2)
        if (vt.group.collapsed) drawGroupSummary(ctx, tracksProp, vt.group, y + 6, curClipH - 12, W, fps, frameToX)
      } else if (vt.groupColor) {
        // Group member: faint group tint + the group's rail
        ctx.fillStyle = rgba(vt.groupColor, 0.03); ctx.fillRect(0, y, W, curClipH - 1)
        ctx.fillStyle = rgba(vt.groupColor, 0.7); ctx.fillRect(0, y, 3, curClipH - 1)
      }
      if (i === selectedTrackIdx) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(0, y, W, curClipH - 1) }
      ctx.fillStyle = T.gutter; ctx.fillRect(0, y + curClipH - 1, W, 1)

      if (track.type === 'layer' && (track as LayerTrack).expanded) {
        const lt = track as LayerTrack
        // Lanes hang under their parent row: darkened parent background, a faint tint of the
        // parent colour, and a parent-coloured seam where the first lane meets the row
        const parentC = vt.group?.color ?? lt.color ?? TAG_COLORS[0]
        const railW = vt.groupColor ? 3 : 0
        let first = true
        autoLanes.forEach((lane, ai) => {
          if (lane.h <= 0) return
          const auto = lt.automations[ai]
          ctx.fillStyle = base; ctx.fillRect(0, lane.y, W, lane.h - 1)
          ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, lane.y, W, lane.h - 1)
          ctx.fillStyle = rgba(parentC, 0.03); ctx.fillRect(0, lane.y, W, lane.h - 1)
          if (vt.groupColor) { ctx.fillStyle = rgba(vt.groupColor, 0.03); ctx.fillRect(0, lane.y, W, lane.h - 1) }
          if (first) { ctx.fillStyle = rgba(parentC, 0.35); ctx.fillRect(0, lane.y, W, 1); first = false }
          const kind = auto ? laneKind(auto) : 'range'
          const toY = kfToY(lane)
          if (kind === 'choice') {
            // One band per option, separators halfway between neighbouring steps
            const n = (auto && laneRange(auto, laneStatus[auto.id]).options?.length) || 0
            ctx.fillStyle = 'rgba(255,255,255,0.06)'
            if (n >= 2 && n <= MAX_CHOICE_BANDS)
              for (let i = 0; i < n - 1; i++) ctx.fillRect(0, Math.round(toY((i + 0.5) / (n - 1))), W, 1)
          } else if (kind === 'boolean') {
            ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, Math.round(toY(0.5)), W, 1)
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.05)'
            ;[0.25, 0.5, 0.75].forEach(v => ctx.fillRect(0, Math.round(toY(v)), W, 1))
          }
          if (auto && laneStatus[auto.id]?.state === 'broken') hatch(ctx, 0, lane.y, W, lane.h - 1, rgba(T.danger, 0.08), 8)
          // Group members: the group rail continues through the lanes, lane accent beside it
          if (railW) { ctx.fillStyle = rgba(vt.groupColor!, 0.7); ctx.fillRect(0, lane.y, railW, lane.h - 1) }
          // Layer-bound automation (never moves with clips) gets the wider accent
          ctx.fillStyle = rgba(auto?.color ?? T.text, 0.6)
          ctx.fillRect(railW, lane.y, auto?.layerBound ? 4 : 2, lane.h - 1)
          ctx.fillStyle = T.gutter; ctx.fillRect(0, lane.y + lane.h - 1, W, 1)
        })
      }
    })

    // Time grid (TC mode) or bar / beat grid (BARS mode) over the tracks
    if (tracksBottom > TRACKS_TOP) {
      const gh = tracksBottom - TRACKS_TOP
      if (bars) drawBarGrid(ctx, W, TRACKS_TOP, gh, pxPerFrame, scrollFrame, bars, false)
      else {
        const { major } = rulerSteps(fps, pxPerFrame)
        ctx.fillStyle = 'rgba(255,255,255,0.04)'
        forEachStep(major, scrollFrame, W, pxPerFrame, x => ctx.fillRect(Math.round(x), TRACKS_TOP, 1, gh))
      }
    }

    // Drag drop highlight
    if (draggingClip && !readOnly) {
      tracks.forEach((track, i) => {
        if (track.type !== 'layer') return
        const lt = track as LayerTrack
        if (lt.resolumeLayerId !== draggingClip.layerId || lt.locked) return
        const { y } = layout[i]
        const ch = clipH(track.id) - 1
        ctx.fillStyle = rgba(T.select, 0.08); ctx.fillRect(0, y, W, ch)
        ctx.strokeStyle = T.select; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
        ctx.strokeRect(0.5, y + 0.5, W - 1, ch - 1)
        ctx.setLineDash([])
      })
    }

    ctx.restore()

    // Marker lines through audio lane and tracks (labels live in the ruler)
    markers.forEach(mk => {
      const x = Math.round(frameToX(smpteToFrames(mk.time, fps)))
      if (x < -1 || x > W + 1) return
      ctx.fillStyle = rgba(mk.color || T.loop, 0.35)
      ctx.fillRect(x, RULER_H, 1, H - RULER_H)
    })

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, TRACKS_TOP, W, H - TRACKS_TOP)
    ctx.clip()

    // Clips
    tracks.forEach((track, trackIdx) => {
      if (track.type !== 'layer') return
      const lt = track as LayerTrack
      const { y, totalH, autoLanes, hidden } = layout[trackIdx]
      if (hidden || y > H || y + totalH < TRACKS_TOP) return
      const trackColor = lt.color ?? TAG_COLORS[0]
      const muted = !!lt.muted
      const curClipH = clipH(lt.id)
      const by = y + CLIP_PAD, bh = curClipH - 1 - CLIP_PAD * 2
      const titleH = Math.min(CLIP_TITLE_H, bh)

      const gc = ghostClipRef.current
      const ghostMove = gc && !gc.copy
        ? new Map(gc.items.filter(g => g.trackIdx === trackIdx).map(g => [g.cueIdx, g.frame])) : null
      const ghostDur = ghostDurRef.current?.trackIdx === trackIdx ? ghostDurRef.current : null
      const spans = clipSpans(lt, fps, ghostMove, ghostDur)
      const cutOutlines: { x: number; w: number }[] = []

      lt.clips.forEach((clip, cueIdx) => {
        const isGhost = !!ghostMove?.has(cueIdx)
        const { sf, durF, shownF } = spans[cueIdx]
        const x = Math.round(frameToX(sf))
        const blockW = Math.round(spanWidth(shownF, pxPerFrame))
        const fullW = Math.round(spanWidth(durF, pxPerFrame))
        if (x + blockW < -4 || x > W + 4) return
        const isSel = clipSel.includes(clip.id)
        const isLive = !muted && !isGhost && shownF > 0 && frame >= sf && frame < sf + shownF
        const isCut = shownF < durF
        const color = clip.color ?? clip.resolumeColor ?? trackColor

        ctx.globalAlpha = (muted ? 0.4 : 1) * (isGhost ? 0.6 : 1)
        // Body at 55% over the lane, title strip opaque; both capped in luminance so
        // saturated legacy colours keep white text readable without touching stored data
        ctx.fillStyle = capLum(color, 0.12, 0.55)
        ctx.fillRect(x, by + titleH, blockW, bh - titleH)
        ctx.fillStyle = capLum(color, 0.18)
        ctx.fillRect(x, by, blockW, titleH)

        // Deck: coloured left edge + "D2" badge, only when the composition has several decks
        let badgeW = 0
        const hasDeck = decks.length > 1 && (clip.deckId !== undefined || clip.deckIndex !== undefined)
        if (hasDeck) {
          const deck = deckOfCue(decks, clip)
          const dc = deck?.color ?? T.danger
          ctx.fillStyle = dc
          ctx.fillRect(x, by, 3, bh)
          if (blockW > 30) {
            const label = deck ? `D${deck.index}` : 'D?'
            ctx.font = `bold 10px ${T.fontTc}`
            badgeW = Math.ceil(ctx.measureText(label).width) + 8
            const bx = Math.max(0, x) + 5
            ctx.fillRect(bx, by + 2, badgeW, titleH - 4)
            ctx.fillStyle = T.textOnLive; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            ctx.fillText(label, bx + 4, by + titleH / 2 + 0.5)
            badgeW += 4
          }
        }
        const tx = Math.max(0, x) + 4 + (badgeW ? badgeW + 1 : 0)
        const textW = Math.min(x + blockW, W) - tx - 4
        if (textW > 6) {
          ctx.save()
          ctx.beginPath(); ctx.rect(x, by, blockW, bh); ctx.clip()
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
          ctx.fillStyle = T.textHi; ctx.font = `bold 12px ${T.fontCond}`
          ctx.fillText(fitText(ctx, clip.clipName || `Clip ${clip.clipIndex}`, textW), tx, by + titleH / 2 + 0.5)
          if (bh - titleH >= 13) {
            ctx.font = `10px ${T.fontTc}`; ctx.fillStyle = 'rgba(255,255,255,0.7)'
            ctx.textBaseline = 'top'
            const slot = `#${clip.clipIndex}`
            const slotW = ctx.measureText(slot).width
            if (slotW <= textW) ctx.fillText(slot, tx, by + titleH + 3)
            if (durF > 0) {
              const dur = framesToSmpte(durF, fps)
              if (slotW + 8 + ctx.measureText(dur).width <= textW) ctx.fillText(dur, tx + slotW + 8, by + titleH + 3)
            }
          }
          ctx.restore()
        }

        if (isCut) {
          // Cut by the next clip on this layer: hatched edge marks where it stops showing
          ctx.save()
          ctx.beginPath(); ctx.rect(x + blockW - 7, by, 7, bh); ctx.clip()
          ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.5
          ctx.beginPath()
          for (let hy = -8; hy < bh + 8; hy += 4) { ctx.moveTo(x + blockW - 8, by + hy + 8); ctx.lineTo(x + blockW, by + hy) }
          ctx.stroke()
          ctx.restore()
          if (isSel) cutOutlines.push({ x: x + blockW, w: fullW - blockW })
        }

        // Trim grip (only where hitTestClip offers one)
        if (!isGhost && resizeZoneW(isCut ? 0 : durF, blockW) > 0 && bh - titleH >= 10) {
          ctx.fillStyle = 'rgba(255,255,255,0.3)'
          const gy = by + titleH + 3, gh = bh - titleH - 6
          ctx.fillRect(x + blockW - 7, gy, 1, gh)
          ctx.fillRect(x + blockW - 5, gy, 1, gh)
        }

        if (isLive) {
          const p = Math.max(0, Math.min(1, (frame - sf) / shownF))
          ctx.fillStyle = T.liveFill
          ctx.fillRect(x + 2, by + bh - 4, Math.max(1, (blockW - 4) * p), 2)
        }

        // State outlines: 2px inside the block, 1px black halo outside
        if (isGhost) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = T.textHi; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
          ctx.strokeRect(x + 0.5, by + 0.5, blockW - 1, bh - 1)
          ctx.setLineDash([])
        } else if (isLive || isSel) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1
          ctx.strokeRect(x - 0.5, by - 0.5, blockW + 1, bh + 1)
          ctx.strokeStyle = isLive ? T.live : T.select; ctx.lineWidth = 2
          ctx.strokeRect(x + 1, by + 1, blockW - 2, bh - 2)
          if (isLive && isSel) {
            ctx.strokeStyle = T.select; ctx.lineWidth = 1
            ctx.strokeRect(x + 2.5, by + 2.5, blockW - 5, bh - 5)
          }
        }
        ctx.globalAlpha = 1
      })

      // Alt-drag: the copies at their drop position, the originals stay
      if (gc?.copy) gc.items.forEach(g => {
        if (g.trackIdx !== trackIdx || !lt.clips[g.cueIdx]) return
        const c = lt.clips[g.cueIdx]
        const gx = Math.round(frameToX(g.frame)), gw = Math.round(spanWidth(smpteToFrames(c.duration, fps), pxPerFrame))
        ctx.fillStyle = rgba(capLum(c.color ?? c.resolumeColor ?? trackColor, 0.18), 0.6)
        ctx.fillRect(gx, by, gw, bh)
        ctx.strokeStyle = T.select; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
        ctx.strokeRect(gx + 0.5, by + 0.5, gw - 1, bh - 1); ctx.setLineDash([])
        if (gw > 14) {
          ctx.fillStyle = T.select; ctx.font = `bold 12px ${T.fontCond}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
          ctx.fillText('+', gx + 4, by + titleH / 2 + 0.5)
        }
      })

      // Full length of a selected clip that the next clip cuts off, drawn over the other clips
      cutOutlines.forEach(o => {
        ctx.strokeStyle = rgba(T.select, 0.7); ctx.lineWidth = 1; ctx.setLineDash([4, 3])
        ctx.strokeRect(o.x + 0.5, by + 0.5, o.w - 1, bh - 1)
        ctx.setLineDash([])
      })

      if (lt.locked) hatch(ctx, 0, y, W, totalH - 1, 'rgba(255,255,255,0.05)')

      // Automation lanes
      autoLanes.forEach((lane, ai) => {
        const auto = lt.automations[ai]
        if (!auto || lane.h <= 0 || lane.y > H || lane.y + lane.h < TRACKS_TOP) return
        if (isClipLane(auto)) drawClipScope(lt, auto, lane, spans, trackColor)
        drawAutoLane(trackIdx, ai, auto, lane)
      })
    })

    // Snap guide while a keyframe / clip drag (or a clip-browser drop) sits on a snap target
    const guideF = kd?.moved && kd.snapF != null ? kd.snapF
      : (moveClipRef.current?.moved || resizeClipRef.current?.moved || draggingClip) ? snapGuideRef.current : null
    if (guideF != null) {
      const gx = Math.round(frameToX(guideF))
      ctx.fillStyle = T.select; ctx.fillRect(gx, TRACKS_TOP, 1, H - TRACKS_TOP)
    }

    // Marquee, kept inside its lane
    const mq = marqueeRef.current
    if (mq) {
      const x0 = Math.min(mq.x0, mq.x1), x1 = Math.max(mq.x0, mq.x1)
      const y0 = Math.max(mq.lane.y, Math.min(mq.y0, mq.y1))
      const y1 = Math.min(mq.lane.y + mq.lane.h - 1, Math.max(mq.y0, mq.y1))
      if (x1 - x0 >= 1 && y1 - y0 >= 1) {
        ctx.fillStyle = rgba(T.select, 0.08); ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
        ctx.strokeStyle = T.select; ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0) - 1, Math.round(y1 - y0) - 1)
      }
    }

    const cm = clipMarqueeRef.current
    if (cm) {
      const x0 = Math.min(cm.x0, cm.x1), x1 = Math.max(cm.x0, cm.x1)
      const y0 = Math.max(TRACKS_TOP, Math.min(cm.y0, cm.y1)), y1 = Math.max(cm.y0, cm.y1)
      if (x1 - x0 >= 1 && y1 - y0 >= 1) {
        ctx.fillStyle = rgba(T.select, 0.08); ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
        ctx.strokeStyle = T.select; ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0) - 1, Math.round(y1 - y0) - 1)
      }
    }

    // Tooltips / drag labels over every lane
    tips.forEach(t => drawTip(ctx, t.text, t.x, t.y, W, TRACKS_TOP))

    ctx.restore() // end track clip region

    // Playhead over everything, cap in the ruler
    const px = Math.round(frameToX(frame))
    if (px >= -6 && px <= W + 6) {
      ctx.fillStyle = T.live
      ctx.fillRect(px - 1, 0, 2, H)
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill()
    }
  }, [tracks, markers, fps, bars, frame, pxPerFrame, scrollFrame, selectedTrackIdx, selectedCueIdx, draggingClip, autoLaneHeights, layerRowHeights, scrollY, audioTrack, audioDuration, waveformInfo, readOnly, contextMenu, laneStatus, overrides, decks, sel, hoverKf, clipSel])

  // ── Resize / DPR ───────────────────────────────────────────────────────────

  const drawRef = useRef(draw)
  drawRef.current = draw
  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => drawRef.current())
    ro.observe(container)
    // Moving the window to a display with another pixel ratio; the query is re-armed
    // for the new ratio after each change
    let mq: MediaQueryList | null = null
    const onDpr = () => { drawRef.current(); watch() }
    const watch = () => {
      mq?.removeEventListener('change', onDpr)
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', onDpr)
    }
    watch()
    return () => { ro.disconnect(); mq?.removeEventListener('change', onDpr) }
  }, [])

  // ── Non-passive wheel ──────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fn = (e: WheelEvent) => {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        onZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.deltaX || e.deltaY
        onScrollFrame(Math.max(0, scrollFrame + d / pxPerFrame))
      } else {
        onScrollY(e.deltaY)
      }
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [pxPerFrame, scrollFrame, onScrollFrame, onScrollY, onZoom])

  // ── Hit test helpers ───────────────────────────────────────────────────────

  const getLayout = useCallback(() => buildLayout(tracks, clipH, autoH, scrollY),
    [tracks, autoLaneHeights, layerRowHeights, scrollY])

  const hitTestClip = useCallback((x: number, y: number) => {
    const layout = getLayout()
    const ti = getTrackAtY(layout, y)
    if (ti == null || tracks[ti].type !== 'layer') return null
    const lt = tracks[ti] as LayerTrack
    // Only the clip row: the automation lanes below belong to keyframes
    if (y >= layout[ti].y + clipH(lt.id)) return null
    const SLOP = 3
    const spans = clipSpans(lt, fps, null, null)
    // Later clips are drawn on top, so test them first
    for (let ci = lt.clips.length - 1; ci >= 0; ci--) {
      const { sf, durF, shownF } = spans[ci]
      const blockW = spanWidth(shownF, pxPerFrame)
      const cx = frameToX(sf)
      if (x >= cx - SLOP && x <= cx + blockW + SLOP) {
        const zone = resizeZoneW(shownF < durF ? 0 : durF, blockW)
        return { trackIdx: ti, cueIdx: ci, isResize: zone > 0 && x >= cx + blockW - zone }
      }
    }
    return null
  }, [tracks, fps, pxPerFrame, scrollFrame, getLayout])

  const localXY = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // ── Mouse down ─────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setContextMenu(null)
    setClipColorPicker(null)
    setRulerMenu(null)
    const { x, y } = localXY(e)
    const layout = getLayout()

    if (y < TRACKS_TOP) { isDraggingPlayhead.current = true; onSeek(xToFrame(x)); return }

    // Keyframes win over the lane-resize zone (value-0 keys sit right above the lane edge)
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX, laneStatus)
    const kfEditable = !!kfHit && canEditLane(kfHit.trackIdx, kfHit.autoIdx)

    // Auto lane height is view state, not show data, so it stays adjustable in SHOW mode
    const resizeTarget = kfEditable ? null : hitTestAutoResize(layout, y)
    if (resizeTarget) {
      autoResizeRef.current = { autoId: resizeTarget.autoId, startY: y, startH: autoH(resizeTarget.autoId) }
      return
    }

    const autoLane = getAutoLaneAt(layout, y)
    const autoHere = autoLane ? autoAt(autoLane.trackIdx, autoLane.autoIdx) : undefined
    focusLaneRef.current = autoHere?.id ?? null

    if (kfHit && kfEditable) {
      setHoverKf(null)
      const cur = selRef.current
      // Shift toggles; a click on a selected key keeps the selection so the drag moves it all.
      // Deselecting waits for mouse-up, a drag never drops the key it started on.
      const already = selHas(cur, kfHit)
      const next = already ? cur : e.shiftKey ? [...cur, kfHit] : [kfHit]
      if (next !== cur) updateSel(next)

      const items: DragItem[] = []
      for (const h of next) {
        const a = autoAt(h.trackIdx, h.autoIdx), k = a?.keyframes[h.kfIdx]
        if (!a || !k || !layout[h.trackIdx]?.autoLanes[h.autoIdx]?.h || !canEditLane(h.trackIdx, h.autoIdx)) continue
        const kind = laneKind(a), opts = laneRange(a, laneStatus[a.id]).options ?? []
        const f0 = smpteToFrames(k.time, fps), v0 = kfValue(kind, k, opts)
        items.push({ ...kfRef(h), kind, opts, f0, v0, f: f0, v: v0, valued: false })
      }
      const primary = items.find(i => sameKf(i, kfHit))
      if (!primary) return
      // Values move only for a lone key, or for range keys in the dragged key's lane
      items.forEach(i => {
        i.valued = items.length === 1 || (primary.kind === 'range' && i.kind === 'range' && laneKey(i) === laneKey(primary))
      })
      const lt = tracks[kfHit.trackIdx] as LayerTrack
      const snapTargets = markers.map(m => smpteToFrames(m.time, fps))
      clipSpans(lt, fps, null, null).forEach(s => { snapTargets.push(s.sf); if (s.durF > 0) snapTargets.push(s.sf + s.durF) })
      lt.automations[kfHit.autoIdx].keyframes.forEach((k, ki) => {
        if (!selHas(next, { trackIdx: kfHit.trackIdx, autoIdx: kfHit.autoIdx, kfIdx: ki })) snapTargets.push(smpteToFrames(k.time, fps))
      })
      kfDragRef.current = {
        primary, items, lane: layout[kfHit.trackIdx].autoLanes[kfHit.autoIdx],
        startX: x, startY: y, lastX: x, lastY: y, accX: 0, accY: 0, axis: null, moved: false,
        click: e.shiftKey ? (already ? 'remove' : null) : (already && cur.length > 1 ? 'collapse' : null),
        altDelete: e.altKey, copy: false, snapTargets, snapF: null,
      }
      updateClipSel([])
      return
    }

    // Empty space of an editable automation lane: marquee (Shift adds to the selection)
    if (!kfHit && autoLane && canEditLane(autoLane.trackIdx, autoLane.autoIdx)) {
      const base = e.shiftKey ? selRef.current : []
      if (!e.shiftKey) updateSel([])
      marqueeRef.current = { trackIdx: autoLane.trackIdx, autoIdx: autoLane.autoIdx, lane: autoLane.lane, x0: x, y0: y, x1: x, y1: y, base }
      return
    }

    // Any other click in the track area (clip, empty lane) drops the keyframe selection
    updateSel([])
    if (kfHit) return

    const clipHit = hitTestClip(x, y)
    if (!clipHit) {
      // Empty clip row: marquee over clips (Shift / ⌘ add to the selection)
      const add = e.shiftKey || e.metaKey || e.ctrlKey
      if (!add) updateClipSel([])
      if (!readOnly && getTrackAtY(layout, y) != null)
        clipMarqueeRef.current = { x0: x, y0: y, x1: x, y1: y, base: add ? clipSelRef.current : [] }
      return
    }
    {
      const lt = tracks[clipHit.trackIdx] as LayerTrack
      const clip = lt.clips[clipHit.cueIdx]
      // Shift / ⌘ click adds or removes a clip; a plain click on a selected clip keeps the
      // selection, so the drag moves all of it
      const toggle = e.shiftKey || e.metaKey || e.ctrlKey
      const cur = clipSelRef.current
      const next = toggle ? (cur.includes(clip.id) ? cur.filter(id => id !== clip.id) : [...cur, clip.id])
        : cur.includes(clip.id) ? cur : [clip.id]
      if (next !== cur) updateClipSel(next)
      if (!next.includes(clip.id)) return
      onSelectCue(clipHit.trackIdx, clipHit.cueIdx)
      if (!canEdit(clipHit.trackIdx)) return
      if (clipHit.isResize) {
        resizeClipRef.current = {
          trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx, startX: x, moved: false,
          startF: smpteToFrames(clip.time, fps), startDurF: smpteToFrames(clip.duration, fps),
        }
      } else {
        const group = next.flatMap(id => {
          const at = cueById(id)
          return at && canEdit(at.trackIdx) ? [{ trackIdx: at.trackIdx, cueIdx: at.cueIdx, f0: smpteToFrames(at.cue.time, fps) }] : []
        })
        moveClipRef.current = {
          trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx, startX: x, moved: false,
          anchorMouseFrame: x / pxPerFrame + scrollFrame,
          anchorCueFrame: smpteToFrames(clip.time, fps),
          group, collapse: !toggle && next.length > 1 ? clip.id : null,
        }
      }
    }
  }, [tracks, markers, fps, pxPerFrame, scrollFrame, readOnly, laneStatus, getLayout, hitTestClip, onSelectCue, onSeek, onDeleteKeyframe])

  // ── Mouse move ─────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: { clientX: number; clientY: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => {
    const { x, y } = localXY(e)
    const setCursor = (c: string) => { if (canvasRef.current) canvasRef.current.style.cursor = c }

    if (isDraggingPlayhead.current) { onSeek(xToFrame(x)); return }

    if (autoResizeRef.current) {
      const rs = autoResizeRef.current
      onResizeAutoLane(rs.autoId, Math.max(MIN_AUTO_H, rs.startH + (y - rs.startY)))
      setCursor('ns-resize')
      return
    }

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      // A plain click (selection) must not nudge the keyframe
      if (!kd.moved && Math.abs(x - kd.startX) < 3 && Math.abs(y - kd.startY) < 3) return
      kd.moved = true
      const fine = e.metaKey || e.ctrlKey
      kd.copy = e.altKey
      // Accumulated per event, so toggling fine mode mid-drag does not jump
      const k = fine ? FINE : 1
      kd.accX += (x - kd.lastX) * k; kd.accY += (y - kd.lastY) * k
      kd.lastX = x; kd.lastY = y
      const mx = Math.abs(x - kd.startX), my = Math.abs(y - kd.startY)
      if (!kd.axis && Math.max(mx, my) >= AXIS_LOCK_PX) kd.axis = mx >= my ? 'x' : 'y'
      const lock = e.shiftKey ? kd.axis : null
      const p = kd.primary

      // Time: whole frames. Snap on: the dragged key goes to the nearest grid line, or to a nearby
      // target (marker, clip edge, other key, playhead) when that is nearer. Snap off: nearby targets
      // only. Fine (Cmd/Ctrl) drags freely; Alt copies.
      const rawF = p.f0 + (lock === 'y' ? 0 : kd.accX / pxPerFrame)
      let tf = Math.round(rawF)
      let snapF: number | null = null
      if (!fine && lock !== 'y') {
        const cands = [...kd.snapTargets, Math.round(frameRef.current)]
        let best = SNAP_PX / pxPerFrame
        if (gridSnap) {
          snapF = snapToGrid(rawF, gridSnap.stepF, gridSnap.tempo)
          best = Math.min(best, Math.abs(snapF - rawF))
          for (const c of cands) { const d = Math.abs(c - rawF); if (d < best) { best = d; snapF = c } }
        } else {
          // Beats of the visible bar grid (from the downbeat); none in TC mode, where no beat grid is drawn
          if (bars) cands.push(snapFrame(rawF, bars))
          for (const c of cands) { const d = Math.abs(c - rawF); if (d <= best) { best = d; snapF = c } }
        }
        if (snapF != null) tf = snapF
      }
      const df = Math.max(-Math.min(...kd.items.map(i => i.f0)), tf - p.f0)
      kd.snapF = snapF != null && p.f0 + df === snapF ? snapF : null

      // Value: one delta for the range keys, limited so the group keeps its shape
      const dvRaw = lock === 'x' ? 0 : -kd.accY / Math.max(1, kd.lane.h - 13)
      const ranged = kd.items.filter(i => i.valued && i.kind === 'range')
      const dv = ranged.length
        ? Math.max(-Math.min(...ranged.map(i => i.v0)), Math.min(1 - Math.max(...ranged.map(i => i.v0)), dvRaw))
        : dvRaw
      kd.items.forEach(i => {
        i.f = i.f0 + df
        i.v = !i.valued ? i.v0 : i.kind === 'range' ? clamp01(i.v0 + dv) : snapValue(i.kind, i.v0 + dvRaw, i.opts.length)
      })
      draw()
      setCursor(kd.copy ? 'copy' : 'crosshair')
      return
    }

    if (marqueeRef.current) {
      const m = marqueeRef.current
      m.x1 = x; m.y1 = y
      const auto = autoAt(m.trackIdx, m.autoIdx)
      if (auto) {
        const kind = laneKind(auto), opts = laneRange(auto, laneStatus[auto.id]).options ?? []
        const toY = kfToY(m.lane)
        const xa = Math.min(m.x0, x), xb = Math.max(m.x0, x), ya = Math.min(m.y0, y), yb = Math.max(m.y0, y)
        const inside: KfHit[] = []
        auto.keyframes.forEach((kf, ki) => {
          const kx = frameToX(smpteToFrames(kf.time, fps)), ky = toY(kfValue(kind, kf, opts))
          if (kx >= xa && kx <= xb && ky >= ya && ky <= yb) inside.push({ trackIdx: m.trackIdx, autoIdx: m.autoIdx, kfIdx: ki })
        })
        const next = [...m.base, ...inside.filter(h => !selHas(m.base, h))]
        if (!sameSel(next, selRef.current)) updateSel(next)
      }
      draw()
      setCursor('crosshair')
      return
    }

    if (moveClipRef.current) {
      const mc = moveClipRef.current
      if (!mc.moved && Math.abs(x - mc.startX) < DRAG_START_PX) return
      mc.moved = true
      // The clip start keeps its offset to the cursor; the start is what snaps (⌘ = free).
      // Every selected clip moves by the same amount; none goes before 0.
      const rawStart = mc.anchorCueFrame + (x / pxPerFrame + scrollFrame - mc.anchorMouseFrame)
      const { f, guide } = snapDrag(rawStart, e.metaKey || e.ctrlKey)
      const df = Math.max(-Math.min(...mc.group.map(g => g.f0)), f - mc.anchorCueFrame)
      snapGuideRef.current = guide != null && mc.anchorCueFrame + df === guide ? guide : null
      ghostClipRef.current = { copy: e.altKey, items: mc.group.map(g => ({ trackIdx: g.trackIdx, cueIdx: g.cueIdx, frame: g.f0 + df })) }
      draw()
      setCursor(e.altKey ? 'copy' : 'grabbing')
      return
    }

    if (clipMarqueeRef.current) {
      const m = clipMarqueeRef.current
      m.x1 = x; m.y1 = y
      const xa = Math.min(m.x0, x), xb = Math.max(m.x0, x), ya = Math.min(m.y0, y), yb = Math.max(m.y0, y)
      const layout = getLayout()
      const inside: string[] = []
      tracks.forEach((t, ti) => {
        if (t.type !== 'layer' || layout[ti]?.hidden) return
        const lt = t as LayerTrack
        const top = layout[ti].y + CLIP_PAD, bottom = layout[ti].y + clipH(lt.id) - 1 - CLIP_PAD
        if (bottom < ya || top > yb) return
        clipSpans(lt, fps, null, null).forEach((sp, ci) => {
          const cx = frameToX(sp.sf), cw = Math.max(4, spanWidth(sp.shownF, pxPerFrame))
          if (cx <= xb && cx + cw >= xa) inside.push(lt.clips[ci].id)
        })
      })
      const next = [...m.base, ...inside.filter(id => !m.base.includes(id))]
      if (next.length !== clipSelRef.current.length || next.some((id, i) => id !== clipSelRef.current[i])) updateClipSel(next)
      draw()
      setCursor('crosshair')
      return
    }

    if (resizeClipRef.current) {
      const rs = resizeClipRef.current
      if (!rs.moved && Math.abs(x - rs.startX) < DRAG_START_PX) return
      rs.moved = true
      // The right edge (clip end) is what snaps; never shorter than one frame
      const { f, guide } = snapDrag(rs.startF + rs.startDurF + (x - rs.startX) / pxPerFrame, e.metaKey || e.ctrlKey)
      const newDur = Math.max(1, f - rs.startF)
      snapGuideRef.current = guide != null && rs.startF + newDur === guide ? guide : null
      ghostDurRef.current = { trackIdx: rs.trackIdx, cueIdx: rs.cueIdx, durF: newDur }
      draw()
      setCursor('ew-resize')
      return
    }

    // Cursor feedback
    if (y < TRACKS_TOP) { setCursor('pointer'); return }
    const layout = getLayout()
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX, laneStatus)
    setHoverKf(prev => (sameKf(prev, kfHit) || (!prev && !kfHit) ? prev : kfHit))
    const clipHit = hitTestClip(x, y)
    const ti = getTrackAtY(layout, y)
    const autoLane = getAutoLaneAt(layout, y)
    setCursor(
      kfHit ? (canEditLane(kfHit.trackIdx, kfHit.autoIdx) ? 'move' : 'not-allowed') :
      hitTestAutoResize(layout, y) ? 'ns-resize' :
      clipHit ? (!canEdit(clipHit.trackIdx) ? 'not-allowed' : clipHit.isResize ? 'ew-resize' : 'grab') :
      ti == null || readOnly ? 'default' :
      autoLane ? (canEditLane(autoLane.trackIdx, autoLane.autoIdx) ? 'crosshair' : 'not-allowed') :
      canEdit(ti) ? 'crosshair' : 'not-allowed'
    )
  }, [draw, onSeek, onResizeAutoLane, hitTestClip, getLayout, tracks, markers, fps, bars, gridSnap?.stepF, gridSnap?.tempo, pxPerFrame, scrollFrame, readOnly, laneStatus])

  // ── Mouse up ───────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    isDraggingPlayhead.current = false
    autoResizeRef.current = null

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      kfDragRef.current = null
      if (kd.moved && kd.copy) {
        // Alt-drag: copies at the drop position (per lane, keeping their spacing)
        const byLane = new Map<string, DragItem[]>()
        kd.items.forEach(i => { const k = laneKey(i); byLane.set(k, [...(byLane.get(k) ?? []), i]) })
        const next: KfHit[] = []
        byLane.forEach(items => {
          const { trackIdx, autoIdx } = items[0]
          const auto = autoAt(trackIdx, autoIdx)
          if (!auto) return
          const base = Math.min(...items.map(i => i.f))
          const paste = items.map(i => {
            const src = auto.keyframes[i.kfIdx]
            const value = parseFloat((i.valued ? i.v : i.v0).toFixed(i.kind === 'range' ? 4 : 6))
            const option = i.kind === 'choice' && i.opts.length ? optionAt(value, i.opts) : src?.option
            return { offsetFrames: i.f - base, value, ease: src?.ease ?? 'linear', ...(option !== undefined ? { option } : {}) }
          })
          onPasteKeyframes(trackIdx, autoIdx, base, paste)
          pastedIndices(auto.keyframes, paste.map(p => base + p.offsetFrames), fps)
            .forEach(kfIdx => next.push({ trackIdx, autoIdx, kfIdx }))
        })
        updateSel(next)
        draw()
      } else {
      const ups: KeyframeUpdate[] = []
      if (kd.moved) kd.items.forEach(i => {
        if (!autoAt(i.trackIdx, i.autoIdx)?.keyframes[i.kfIdx]) return
        const u: Partial<Keyframe> = {}
        if (i.f !== i.f0) u.time = framesToSmpte(i.f, fps)
        if (i.valued && i.v !== i.v0) {
          u.value = parseFloat(i.v.toFixed(i.kind === 'range' ? 4 : 6))
          if (i.kind === 'choice' && i.opts.length) u.option = optionAt(i.v, i.opts)
        }
        if (u.time !== undefined || u.value !== undefined) ups.push({ ...kfRef(i), updates: u })
      })
      if (ups.length) {
        onUpdateKeyframes(ups)
        // The App re-sorts the lanes by time: keep the moved keys selected
        updateSel(selAfterUpdates(selRef.current, ups, tracks, fps))
      } else if (!kd.moved && kd.altDelete) {
        // Alt-click deletes only when the key didn't move (Alt + drag copies)
        onDeleteKeyframe(kd.primary.trackIdx, kd.primary.autoIdx, kd.primary.kfIdx)
        updateSel(selAfterDelete(selRef.current, [kd.primary]))
      } else {
        if (!kd.moved && kd.click === 'remove') updateSel(selRef.current.filter(s => !sameKf(s, kd.primary)))
        else if (!kd.moved && kd.click === 'collapse') updateSel([kfRef(kd.primary)])
        draw()
      }
      }
    }
    if (marqueeRef.current) { marqueeRef.current = null; draw() }

    if (clipMarqueeRef.current) { clipMarqueeRef.current = null; draw() }

    const mc = moveClipRef.current, rs = resizeClipRef.current, gc = ghostClipRef.current
    if (mc && gc && mc.moved) {
      const at = (g: { trackIdx: number; cueIdx: number }) => (tracks[g.trackIdx] as LayerTrack).clips[g.cueIdx]
      if (gc.copy) {
        // Alt-drag: copies (with their lanes) at the drop position, which become the selection
        const copies = snapshotCues(gc.items.map(g => at(g)?.id).filter(Boolean) as string[])
          .map((c, i) => ({ ...c, frame: gc.items[i].frame }))
        const ids = onInsertCues(copies)
        if (ids.length) updateClipSel(ids)
      } else if (gc.items.some((g, i) => g.frame !== mc.group[i].f0)) {
        onMoveCues(gc.items.map(g => ({ trackIdx: g.trackIdx, cueId: at(g).id, frame: g.frame })))
      }
    } else if (mc && !mc.moved && mc.collapse) {
      updateClipSel([mc.collapse])
    }
    if (rs && ghostDurRef.current && ghostDurRef.current.durF !== rs.startDurF) {
      onUpdateCue(rs.trackIdx, rs.cueIdx, {
        duration: framesToSmpte(ghostDurRef.current.durF, fps),
      })
    }
    const hadGhost = !!(ghostClipRef.current || ghostDurRef.current)
    moveClipRef.current = null
    ghostClipRef.current = null
    resizeClipRef.current = null
    ghostDurRef.current = null
    snapGuideRef.current = null
    if (hadGhost) draw()
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }, [onUpdateCue, onMoveCues, onInsertCues, onPasteKeyframes, onUpdateKeyframes, fps, tracks, draw])

  // While a drag is active, follow the mouse on the window so leaving the canvas
  // neither drops nor freezes the drag.
  const dragHandlersRef = useRef({ move: handleMouseMove, up: handleMouseUp })
  dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp }
  const isDragging = () => !!(isDraggingPlayhead.current || autoResizeRef.current ||
    kfDragRef.current || marqueeRef.current || clipMarqueeRef.current || moveClipRef.current || resizeClipRef.current)

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    handleMouseDown(e)
    if (!isDragging()) return
    const move = (ev: MouseEvent) => dragHandlersRef.current.move(ev)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragHandlersRef.current.up()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [handleMouseDown])

  // ── Double click → add keyframe ────────────────────────────────────────────

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    const { x, y } = localXY(e)
    const layout = getLayout()
    const info = getAutoLaneAt(layout, y)
    if (!info || !canEditLane(info.trackIdx, info.autoIdx)) return
    if (hitTestKeyframe(x, y, layout, tracks, fps, frameToX, laneStatus)) return
    const auto = autoAt(info.trackIdx, info.autoIdx)!
    const kind = laneKind(auto)
    const opts = laneRange(auto, laneStatus[auto.id]).options ?? []
    const raw = kfFromY(info.lane, y)
    // Time snaps to the grid (⌘ = exactly under the cursor)
    const at = snapDrag(x / pxPerFrame + scrollFrame, e.metaKey || e.ctrlKey).f
    if (kind === 'range') {
      onAddKeyframe(info.trackIdx, info.autoIdx, at, parseFloat(raw.toFixed(3)))
    } else {
      // Choice: nearest option step (and its name); boolean: upper half = On
      const value = snapValue(kind, raw, opts.length)
      onAddKeyframe(info.trackIdx, info.autoIdx, at, parseFloat(value.toFixed(6)),
        kind === 'choice' ? optionAt(value, opts) : undefined)
    }
  }, [getLayout, onAddKeyframe, fps, markers, gridSnap?.stepF, gridSnap?.tempo, pxPerFrame, scrollFrame, readOnly, tracks, laneStatus])

  // ── Right click → context menu ─────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (readOnly) return
    const { x, y } = localXY(e)
    // Ruler: tempo menu (bar 1 = the downbeat the bar grid counts from)
    if (y < RULER_H) {
      if (tempo) { setRulerMenu({ x, y, frame: Math.max(0, Math.round(scrollFrame + x / pxPerFrame)) }); setContextMenu(null); setClipColorPicker(null) }
      return
    }
    const kfHit = hitTestKeyframe(x, y, getLayout(), tracks, fps, frameToX, laneStatus)
    if (kfHit && canEditLane(kfHit.trackIdx, kfHit.autoIdx)) {
      const auto = autoAt(kfHit.trackIdx, kfHit.autoIdx)!
      const kf = auto.keyframes[kfHit.kfIdx]
      setCtxInputVal(realText(kf.value, laneRange(auto, laneStatus[auto.id])))
      setContextMenu({ x, y, ...kfHit })
      focusLaneRef.current = auto.id
      // Right-click inside the selection edits all of it; outside, it selects just this key
      if (!selHas(selRef.current, kfHit)) updateSel([kfHit])
      setHoverKf(null)
      setClipColorPicker(null)
      return
    }
    if (kfHit) return
    const clipHit = hitTestClip(x, y)
    if (clipHit && canEdit(clipHit.trackIdx)) {
      setClipColorPicker({ x, y, trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx })
      setContextMenu(null)
    }
  }, [tracks, fps, readOnly, laneStatus, getLayout, hitTestClip, tempo, scrollFrame, pxPerFrame])

  // ── Keyboard on the selected keyframes ─────────────────────────────────────
  // Capture phase on window, so Delete/Backspace never also reaches the App's clip delete.

  /** Selected keys that still exist in an expanded (visible) lane, sorted by time. */
  const liveSel = (s: KfHit[] = selRef.current) => s
    .map(h => {
      const lt = tracks[h.trackIdx] as LayerTrack | undefined
      const auto = lt?.type === 'layer' && lt.expanded ? lt.automations[h.autoIdx] : undefined
      const kf = auto?.keyframes[h.kfIdx]
      return auto && kf && auto.visible !== false ? { h, auto, kf, f: smpteToFrames(kf.time, fps) } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.f - b.f)

  const copySelection = (): boolean => {
    const items = liveSel()
    if (!items.length) return false
    const f0 = items[0].f
    const lanes: KfClipboard['lanes'] = []
    // Lane order follows time, so lanes[0] is the lane of the first copied key
    for (const { auto, kf, f } of items) {
      let l = lanes.find(x => x.laneId === auto.id)
      if (!l) { l = { laneId: auto.id, kind: laneKind(auto), items: [] }; lanes.push(l) }
      l.items.push({ offsetFrames: f - f0, value: kf.value, ease: kf.ease, ...(kf.option !== undefined ? { option: kf.option } : {}) })
    }
    kfClipboard = { lanes }
    lastCopied = 'keys'
    return true
  }

  // ── Clips: copy / paste / duplicate / delete / select all ──
  const copyClips = (): boolean => {
    const copies = snapshotCues(clipSelRef.current)
    if (!copies.length) return false
    clipClipboard = copies
    lastCopied = 'clips'
    return true
  }
  /** Copies placed so the earliest starts at `at` (each on its own layer). */
  const insertCopies = (copies: CueCopy[], at: number) => {
    const f0 = Math.min(...copies.map(c => c.frame))
    const ok = copies.filter(c => { const ti = tracks.findIndex(t => t.id === c.trackId); return ti >= 0 && canEdit(ti) })
    if (!ok.length) return false
    const ids = onInsertCues(ok.map(c => ({ ...c, frame: Math.max(0, at + c.frame - f0) })))
    if (ids.length) updateClipSel(ids)
    return true
  }
  const pasteClips = (): boolean => !!clipClipboard?.length && !readOnly
    && insertCopies(clipClipboard, Math.max(0, Math.round(frameRef.current)))
  // ⌘D: copies right after the selection (as in Ableton Live)
  const duplicateClips = (): boolean => {
    const copies = snapshotCues(clipSelRef.current)
    if (!copies.length || readOnly) return false
    const end = Math.max(...copies.map(c => c.frame + Math.max(1, smpteToFrames(c.cue.duration, fps))))
    return insertCopies(copies, end)
  }
  const deleteClips = (): boolean => {
    const ids = clipSelRef.current.filter(id => { const at = cueById(id); return at && canEdit(at.trackIdx) })
    if (!ids.length) return false
    onDeleteCues(ids)
    updateClipSel([])
    return true
  }
  // ⌘A: every key of the lane last clicked, else every clip
  const selectAll = (): boolean => {
    const focus = focusLaneRef.current ? findLane(tracks, focusLaneRef.current) : null
    if (focus && focus.auto.visible !== false && (tracks[focus.trackIdx] as LayerTrack).expanded) {
      updateSel(focus.auto.keyframes.map((_, kfIdx) => ({ trackIdx: focus.trackIdx, autoIdx: focus.autoIdx, kfIdx })))
      updateClipSel([])
      return true
    }
    const ids = tracks.flatMap((t, ti) => t.type === 'layer' && canEdit(ti) ? (t as LayerTrack).clips.map(c => c.id) : [])
    if (!ids.length) return false
    updateSel([]); updateClipSel(ids)
    return true
  }

  const pasteClipboard = (): boolean => {
    if (lastCopied === 'clips') return pasteClips()
    const cb = kfClipboard
    if (!cb || readOnly) return false
    const at = Math.max(0, Math.round(frameRef.current))
    const focus = focusLaneRef.current ? findLane(tracks, focusLaneRef.current) : null
    // A single-lane clipboard goes to the lane last clicked, whatever parameter it drives:
    // the curve is the same shape there (values converted to that lane's kind)
    const targets = cb.lanes.length === 1 && focus
      ? [{ ...focus, items: convertItems(cb.lanes[0].items, cb.lanes[0].kind, laneKind(focus.auto), laneRange(focus.auto, laneStatus[focus.auto.id]).options ?? []) }]
      : cb.lanes.flatMap(l => { const t = findLane(tracks, l.laneId); return t ? [{ ...t, items: l.items }] : [] })
    const ok = targets.filter(t => t.auto.visible !== false && canEditLane(t.trackIdx, t.autoIdx))
    if (!ok.length) return false
    const next: KfHit[] = []
    for (const t of ok) {
      onPasteKeyframes(t.trackIdx, t.autoIdx, at, t.items)
      pastedIndices(t.auto.keyframes, t.items.map(i => at + i.offsetFrames), fps)
        .forEach(kfIdx => next.push({ trackIdx: t.trackIdx, autoIdx: t.autoIdx, kfIdx }))
    }
    updateSel(next)
    setContextMenu(null)
    return true
  }

  const keyStateRef = useRef({ liveSel, copySelection, pasteClipboard, canEditLane, onDeleteKeyframes, onUpdateKeyframes, copyClips, duplicateClips, deleteClips, selectAll })
  keyStateRef.current = { liveSel, copySelection, pasteClipboard, canEditLane, onDeleteKeyframes, onUpdateKeyframes, copyClips, duplicateClips, deleteClips, selectAll }

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const s = keyStateRef.current
      const mod = e.metaKey || e.ctrlKey
      const swallow = () => { e.preventDefault(); e.stopPropagation() }

      if (mod && !e.altKey && e.code === 'KeyC') { if (s.copySelection() || s.copyClips()) swallow(); return }
      if (mod && !e.altKey && e.code === 'KeyV') { if (s.pasteClipboard()) swallow(); return }
      if (mod && !e.altKey && e.code === 'KeyD') { swallow(); s.duplicateClips(); return }
      if (mod && !e.altKey && e.code === 'KeyA') { if (s.selectAll()) swallow(); return }

      if (!selRef.current.length) {
        // Clips: Delete removes every selected clip, Escape drops the selection
        if (!clipSelRef.current.length) return
        if (e.key === 'Escape') { updateClipSel([]); return }
        if (e.key === 'Delete' || e.key === 'Backspace') { swallow(); s.deleteClips() }
        return
      }
      if (e.key === 'Escape') { swallow(); updateSel([]); setContextMenu(null); return }

      const items = s.liveSel()
      if (!items.length) return
      const editable = items.filter(i => s.canEditLane(i.h.trackIdx, i.h.autoIdx))
      if (e.key === 'Delete' || e.key === 'Backspace') {
        swallow()
        if (!editable.length) return
        const del = editable.map(i => i.h)
        s.onDeleteKeyframes(del)
        updateSel(selAfterDelete(selRef.current, del))
        setContextMenu(null)
        return
      }
      if ((e.key === 'e' || e.key === 'E') && !mod && !e.altKey) {
        const ranged = items.filter(i => laneKind(i.auto) === 'range')
        if (!ranged.length) return
        swallow()
        const targets = ranged.filter(i => s.canEditLane(i.h.trackIdx, i.h.autoIdx))
        if (!targets.length) return
        // E cycles the basic curves; a Resolume family curve moves on to Linear
        const cur = (BASIC_CURVES as readonly string[]).indexOf(curveOf(targets[0].kf.ease))
        const next = BASIC_CURVES[(cur + 1) % BASIC_CURVES.length]
        s.onUpdateKeyframes(targets.map(i => ({ ...kfRef(i.h), updates: { ease: next } })))
      }
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [])

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const dropTrackAt = (e: React.DragEvent) => getTrackAtY(getLayout(), localXY(e).y)

  // Drop position: the clip starts at the cursor, snapped like a clip move (⌘ = free)
  const dropFrameAt = (e: React.DragEvent) => snapDrag(localXY(e).x / pxPerFrame + scrollFrame, e.metaKey || e.ctrlKey)
  const setDropGuide = (f: number | null) => {
    if (snapGuideRef.current === f) return
    snapGuideRef.current = f
    draw()
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly || !e.dataTransfer.types.includes('application/timeline-clip')) return
    const ti = dropTrackAt(e)
    if (ti != null && !canEdit(ti)) { setDropGuide(null); return }  // not preventing default = "no drop" cursor
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
    setDropGuide(ti != null ? dropFrameAt(e).guide : null)
  }, [readOnly, tracks, getLayout, draw, markers, gridSnap?.stepF, gridSnap?.tempo, scrollFrame, pxPerFrame])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Leaving the canvas (not just crossing onto an overlay inside it)
    if (containerRef.current && e.relatedTarget instanceof Node && containerRef.current.contains(e.relatedTarget)) return
    setDropGuide(null)
  }, [draw])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropGuide(null)
    if (readOnly) return
    const raw = e.dataTransfer.getData('application/timeline-clip')
    if (!raw) return
    try {
      const data: DragClipData = JSON.parse(raw)
      const ti = dropTrackAt(e)
      if (ti != null && canEdit(ti)) onDropClip(ti, dropFrameAt(e).f, data)
    } catch {}
  }, [readOnly, tracks, getLayout, onDropClip, draw, markers, gridSnap?.stepF, gridSnap?.tempo, scrollFrame, pxPerFrame])

  // Keep overlays inside the canvas area
  const clampPos = (x: number, y: number, w: number, h: number) => {
    const c = containerRef.current
    return {
      left: Math.max(0, Math.min(x, (c?.clientWidth ?? x + w) - w)),
      top: Math.max(0, Math.min(y, (c?.clientHeight ?? y + h) - h)),
    }
  }

  const pickerClip = clipColorPicker
    ? (tracks[clipColorPicker.trackIdx] as LayerTrack | undefined)?.clips[clipColorPicker.cueIdx]
    : undefined
  const swatch = (c: string) => (
    <button
      key={c}
      className={`ccp-swatch${pickerClip?.color?.toLowerCase() === c.toLowerCase() ? ' on' : ''}`}
      style={{ background: c }}
      title={c}
      onClick={() => {
        onUpdateCue(clipColorPicker!.trackIdx, clipColorPicker!.cueIdx, { color: c })
        setClipColorPicker(null)
      }}
    />
  )

  return (
    <div ref={containerRef} className="timeline-canvas-container"
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={e => { if (!isDragging()) handleMouseMove(e) }}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => { if (!isDragging()) setHoverKf(null) }}
      />

      {contextMenu && (() => {
        const { trackIdx: ti, autoIdx: ai, kfIdx: ki } = contextMenu
        const auto = autoAt(ti, ai)
        const kf = auto?.keyframes[ki]
        if (!auto || !kf) return null
        const kind = laneKind(auto)
        const range = laneRange(auto, laneStatus[auto.id])
        const opts = range.options ?? []
        const curCurve: CurveName = kind === 'range' ? curveOf(kf.ease) : 'hold'
        const close = () => setContextMenu(null)
        // Inside a multi-selection the menu edits all of it: curves on every range key,
        // values only on the keys of this lane
        const hit = { trackIdx: ti, autoIdx: ai, kfIdx: ki }
        const targets = (sel.length > 1 && selHas(sel, hit) ? sel : [hit])
          .filter(h => !!autoAt(h.trackIdx, h.autoIdx)?.keyframes[h.kfIdx] && canEditLane(h.trackIdx, h.autoIdx))
        const laneTargets = targets.filter(h => laneKey(h) === laneKey(hit))
        const curveTargets = kind === 'range' ? targets.filter(h => laneKind(autoAt(h.trackIdx, h.autoIdx)!) === 'range') : [hit]
        const setAll = (list: KfHit[], updates: Partial<Keyframe>) =>
          onUpdateKeyframes(list.map(h => ({ ...kfRef(h), updates })))
        const commitReal = () => {
          const v = realToNorm(ctxInputVal, range)
          if (v != null) setAll(laneTargets, { value: v })
          close()
        }
        const curOpt = opts.length ? optionAt(kfValue('choice', kf, opts), opts) : kf.option
        const n = targets.length
        return (
          <div
            className="ctx-menu kf-menu"
            style={clampPos(contextMenu.x, contextMenu.y, 260, kind === 'range' ? 400 : 210)}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="ctx-title" title={laneTitle(auto)}>{laneTitle(auto)}</div>
            <div className="ctx-hint">{kf.time}{kind === 'range' && range.min !== undefined && range.max !== undefined
              ? ` · ${formatValue('range', 0, range)} … ${formatValue('range', 1, range, undefined, range.suffix)}` : ''}
              {n > 1 ? ` · ${n} selected` : ''}</div>
            <div className="ctx-row">
              <label>Value</label>
              {kind === 'range' && <>
                <input
                  type="text" inputMode="decimal"
                  value={ctxInputVal}
                  onChange={e => setCtxInputVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitReal()
                    if (e.key === 'Escape') close()
                  }}
                  autoFocus
                />
                {range.suffix && <span className="ctx-unit">{range.suffix}</span>}
              </>}
              {kind === 'choice' && (opts.length ? (
                <select
                  value={curOpt ?? ''}
                  onChange={e => {
                    const i = opts.indexOf(e.target.value)
                    if (i < 0) return
                    setAll(laneTargets, { value: opts.length > 1 ? i / (opts.length - 1) : 0, option: opts[i] })
                    close()
                  }}
                  onKeyDown={e => { if (e.key === 'Escape') close() }}
                  autoFocus
                >
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : <span className="ctx-unit">{kf.option ?? '—'} (options unknown)</span>)}
              {kind === 'boolean' && (
                <div className="ctx-seg">
                  {[0, 1].map(v => (
                    <button key={v} className={`ctx-seg-btn${kfValue('boolean', kf, opts) === v ? ' on' : ''}`}
                      onClick={() => { setAll(laneTargets, { value: v }); close() }}
                    >{v ? 'On' : 'Off'}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="ctx-row wrap">
              <label>Curve</label>
              <div className="ctx-seg">
                {(kind === 'range' ? BASIC_CURVES : (['hold'] as const)).map(c => (
                  <button key={c} className={`ctx-seg-btn${c === curCurve ? ' on' : ''}`}
                    title={kind === 'range' ? 'Press E to cycle through curves' : 'Discrete parameters always jump'}
                    onClick={() => setAll(curveTargets, { ease: c })}
                  ><span className="ctx-glyph">{BASIC_GLYPH[c]}</span>{curveLabel(c)}</button>
                ))}
              </div>
            </div>
            {kind === 'range' && (
              <div className="ctx-row wrap">
                <label>Resolume</label>
                <div className="kf-fam">
                  {FAMILY_ROWS.flatMap(row => {
                    const fam = curveLabel(row[0]).replace(/ In$/, '')
                    return [
                      <span key={fam} className="kf-fam-name">{fam}</span>,
                      ...row.map(c => (
                        <button key={c} className={`kf-fam-btn${c === curCurve ? ' on' : ''}`} title={curveLabel(c)}
                          onClick={() => setAll(curveTargets, { ease: c })}
                        >{curveLabel(c).slice(fam.length + 1)}</button>
                      )),
                    ]
                  })}
                </div>
              </div>
            )}
            {kind === 'range' && <button className="ctx-btn" onClick={commitReal}>Apply</button>}
            <div className="ctx-divider" />
            <button className="ctx-btn danger" onClick={() => {
              const del = targets.length ? targets : [hit]
              if (del.length === 1) onDeleteKeyframe(del[0].trackIdx, del[0].autoIdx, del[0].kfIdx)
              else onDeleteKeyframes(del)
              updateSel(selAfterDelete(selRef.current, del))
              close()
            }}>{n > 1 ? `Delete selected (${n})` : 'Delete keyframe'}</button>
            <button className="ctx-btn dim" onClick={close}>Cancel</button>
          </div>
        )
      })()}

      {rulerMenu && tempo && (() => {
        const beatF = (fps * 60) / tempo.bpm
        const set = (f: number) => { onSetDownbeat(Math.max(0, Math.round(f))); setRulerMenu(null) }
        const nudge = (df: number) => onSetDownbeat(Math.max(0, Math.round(tempo.downbeatF + df)))
        return (
          <div className="ctx-menu" style={clampPos(rulerMenu.x, rulerMenu.y, 230, 190)} onMouseDown={e => e.nativeEvent.stopImmediatePropagation()}>
            <div className="ctx-title">Bar 1</div>
            <div className="ctx-hint">now at {framesToSmpte(tempo.downbeatF, fps)} · {tempo.bpm} BPM {tempo.beatsPerBar}/4</div>
            <button className="ctx-btn" onClick={() => set(rulerMenu.frame)}>Set bar 1 here ({framesToSmpte(rulerMenu.frame, fps)})</button>
            <button className="ctx-btn" onClick={() => set(frameRef.current)}>Set bar 1 at playhead</button>
            <div className="ctx-row">
              <label>Nudge</label>
              <div className="ctx-seg">
                <button className="ctx-seg-btn" title="Bar 1 one beat earlier" onClick={() => nudge(-beatF)}>−beat</button>
                <button className="ctx-seg-btn" title="Bar 1 one frame earlier" onClick={() => nudge(-1)}>−1 f</button>
                <button className="ctx-seg-btn" title="Bar 1 one frame later" onClick={() => nudge(1)}>+1 f</button>
                <button className="ctx-seg-btn" title="Bar 1 one beat later" onClick={() => nudge(beatF)}>+beat</button>
              </div>
            </div>
            <div className="ctx-divider" />
            <button className="ctx-btn dim" onClick={() => setRulerMenu(null)}>Close</button>
          </div>
        )
      })()}

      {clipColorPicker && (
        <div
          className="clip-color-picker"
          style={clampPos(clipColorPicker.x, clipColorPicker.y, 220, 380)}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">Clip colour</div>
          <div className="ccp-grid">{TAG_COLORS.map(swatch)}</div>
          <div className="ccp-label">Saturated</div>
          <div className="ccp-grid">{SATURATED_COLORS.map(swatch)}</div>
          <div className="ctx-divider" />
          <button
            className="ctx-btn"
            onClick={() => {
              onUpdateCue(clipColorPicker.trackIdx, clipColorPicker.cueIdx, { color: undefined })
              setClipColorPicker(null)
            }}
          >Reset (layer colour)</button>
          {(() => {
            // Automation templates for this cue: opacity fade, copy / paste of its lanes
            const { trackIdx: ti, cueIdx: ci } = clipColorPicker
            const lt = tracks[ti] as LayerTrack | undefined
            const cue = lt?.clips[ci]
            if (!lt || !cue) return null
            const editable = canEdit(ti)
            const fadeWhy = clipFadeUnavailable(ti, ci)
            const noEnd = smpteToFrames(cue.duration, fps) <= 0
            const bound = lt.automations.filter(a => a.clipId === cue.id && !a.layerBound).length
            const close = () => setClipColorPicker(null)
            const fadeBtn = (mode: 'in' | 'out' | 'inout', label: string) => {
              const off = !editable || !!fadeWhy || (mode !== 'in' && noEnd)
              return (
                <button key={mode} className="ctx-seg-btn" disabled={off}
                  title={fadeWhy ?? (mode !== 'in' && noEnd ? 'Trigger-only cue has no end to fade out to'
                    : `${label} over ${fadeSeconds} s on the clip's opacity`)}
                  onClick={() => { onClipFade(ti, ci, mode, fadeSeconds); close() }}
                >{label}</button>
              )
            }
            return <>
              <div className="ctx-divider" />
              <div className="ccp-label">Fade in / out (opacity)</div>
              <div className="ctx-row">
                <label>Fade</label>
                <div className="ctx-seg">
                  {fadeBtn('in', 'In')}{fadeBtn('out', 'Out')}{fadeBtn('inout', 'In + Out')}
                </div>
              </div>
              <div className="ctx-row">
                <label>Length</label>
                <div className="ctx-seg">
                  {[0.5, 1, 2].map(sec => (
                    <button key={sec} className={`ctx-seg-btn${fadeSeconds === sec ? ' on' : ''}`}
                      disabled={!editable || !!fadeWhy}
                      onClick={() => setFadeSeconds(sec)}
                    >{sec} s</button>
                  ))}
                </div>
              </div>
              {fadeWhy && <div className="ctx-note">{fadeWhy}</div>}
              <div className="ctx-divider" />
              <button className="ctx-btn" disabled={!editable || !bound}
                title={bound ? 'Copy every lane that follows this clip, keyframes relative to its start' : 'No automation lanes follow this clip'}
                onClick={() => { onCopyClipAutomation(ti, ci); close() }}
              >Copy clip automation{bound ? ` (${bound})` : ''}</button>
              <button className="ctx-btn" disabled={!editable || !canPasteClipAutomation}
                title={canPasteClipAutomation ? 'Paste the copied lanes onto this clip, from its start' : 'Copy a clip\'s automation first'}
                onClick={() => { onPasteClipAutomation(ti, ci); close() }}
              >Paste clip automation</button>
            </>
          })()}
          <div className="ctx-divider" />
          <button className="ctx-btn dim" onClick={() => setClipColorPicker(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

// Start/length of each clip on a layer, plus how much of it is actually shown: a layer
// plays one clip at a time, so a clip stops showing where the next one starts.
interface ClipSpan { sf: number; durF: number; shownF: number }
function clipSpans(
  lt: LayerTrack, fps: number,
  ghostMove: Map<number, number> | null,   // cue index → start frame while dragged
  ghostDur: { cueIdx: number; durF: number } | null,
): ClipSpan[] {
  const spans = lt.clips.map((c, i) => {
    const sf = ghostMove?.get(i) ?? smpteToFrames(c.time, fps)
    const durF = ghostDur?.cueIdx === i ? ghostDur.durF : smpteToFrames(c.duration, fps)
    return { sf, durF, shownF: durF }
  })
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].sf - spans[b].sf || a - b)
  for (let k = 0; k < order.length - 1; k++) {
    const cur = spans[order[k]], next = spans[order[k + 1]]
    if (cur.durF > 0 && next.sf < cur.sf + cur.durF) cur.shownF = Math.max(0, next.sf - cur.sf)
  }
  return spans
}

// Clip automation lanes (clip-scope parameter, or legacy lanes bound to a cue)
const isClipLane = (auto: AutomationSubTrack) =>
  auto.ref ? auto.ref.scope === 'clip' : !auto.layerBound && !!auto.clipId

/** Indices of the cues a clip lane belongs to: its own cue, else every cue of the same Resolume clip. */
function laneCues(lt: LayerTrack, auto: AutomationSubTrack): number[] {
  const idx = (pred: (c: ClipCue) => boolean) => lt.clips.flatMap((c, i) => (pred(c) ? [i] : []))
  const own = auto.clipId ? idx(c => c.id === auto.clipId) : []
  if (own.length) return own
  const rid = auto.ref?.clipId
  return rid !== undefined ? idx(c => c.clipId === rid) : []
}

// Trigger-only (and fully covered) clips still get a small clickable block
const spanWidth = (frames: number, pxPerFrame: number) =>
  frames > 0 ? Math.max(8, frames * pxPerFrame) : Math.max(10, pxPerFrame * 2)

// Width of the grab zone at a clip's right edge for changing its duration. Narrow and
// trigger-only clips get none, otherwise the whole block would resize instead of move.
function resizeZoneW(durF: number, blockW: number): number {
  if (durF <= 0 || blockW < 24) return 0
  return Math.min(RESIZE_HANDLE_W + 4, blockW / 4)
}

// ── Colour ────────────────────────────────────────────────────────────────────

const rgbCache = new Map<string, [number, number, number] | null>()
function toRgb(c: string): [number, number, number] | null {
  let v = rgbCache.get(c)
  if (v !== undefined) return v
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim())
  v = null
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(ch => ch + ch).join('') : m[1].slice(0, 6)
    const n = parseInt(h, 16)
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  rgbCache.set(c, v)
  return v
}

function rgba(c: string, a: number): string {
  const v = toRgb(c)
  return v ? `rgba(${v[0]},${v[1]},${v[2]},${a})` : c
}

const toLinear = (u: number) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4 }

// Scale toward black until relative luminance ≤ maxL (0.18 keeps white text ≥ 4.5:1).
// Muted tag colours pass through unchanged.
function capLum(c: string, maxL: number, a = 1): string {
  const v = toRgb(c)
  if (!v) return c
  const L = 0.2126 * toLinear(v[0]) + 0.7152 * toLinear(v[1]) + 0.0722 * toLinear(v[2])
  const k = L > maxL ? (maxL / L) ** (1 / 2.4) : 1
  return `rgba(${Math.round(v[0] * k)},${Math.round(v[1] * k)},${Math.round(v[2] * k)},${a})`
}

// ── Shapes / text ─────────────────────────────────────────────────────────────

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y)
  ctx.closePath()
}

// Keyframe glyph by curve: ◆ linear, ■ hold, ● eased (r = half the glyph size)
function kfGlyph(ctx: CanvasRenderingContext2D, c: CurveName, x: number, y: number, r: number) {
  if (c === 'linear') { diamond(ctx, x, y, r); return }
  ctx.beginPath()
  if (c === 'hold') { const s = r * 0.8; ctx.rect(x - s, y - s, 2 * s, 2 * s) }
  else ctx.arc(x, y, r * 0.85, 0, Math.PI * 2)
}

// Small label box next to a point, kept inside the canvas and below the ruler
function drawTip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, W: number, top: number) {
  ctx.font = `11px ${T.fontUi}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  const bw = Math.ceil(ctx.measureText(text).width) + 12, bh = 18
  let bx = x + 10
  if (bx + bw > W - 2) bx = x - 10 - bw
  bx = Math.round(Math.max(2, bx))
  let by = y - bh - 6
  if (by < top + 2) by = y + 8
  by = Math.round(by)
  ctx.fillStyle = T.header; ctx.fillRect(bx, by, bw, bh)
  ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
  ctx.fillStyle = T.textHi; ctx.fillText(text, bx + 6, by + bh / 2 + 0.5)
}

// Collapsed group: one thin slice per member layer with its clips in their own colours
// (Logic/Ableton folded-group overview), so the timing stays readable while folded
function drawGroupSummary(
  ctx: CanvasRenderingContext2D, tracks: Track[], group: GroupTrack, y: number, h: number, W: number,
  fps: number, frameToX: (f: number) => number,
) {
  const members = tracks.filter(t => t.type === 'layer' && (t as LayerTrack).groupId === group.resolumeGroupId) as LayerTrack[]
  if (!members.length || h < 4) return
  const sliceH = Math.max(2, Math.floor(h / members.length) - 1)
  members.forEach((lt, mi) => {
    const sy = y + mi * (sliceH + 1)
    for (const c of lt.clips) {
      const sf = smpteToFrames(c.time, fps), df = Math.max(2, smpteToFrames(c.duration, fps))
      const x0 = frameToX(sf), x1 = frameToX(sf + df)
      if (x1 < 0 || x0 > W) continue
      ctx.fillStyle = capLum(c.color ?? c.resolumeColor ?? lt.color ?? TAG_COLORS[0], 0.3)
      ctx.fillRect(Math.round(x0), sy, Math.max(2, Math.round(x1 - x0)), sliceH)
    }
  })
}

function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, step = 8) {
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.strokeStyle = color; ctx.lineWidth = 1
  ctx.beginPath()
  for (let s = -h; s < w; s += step) { ctx.moveTo(x + s, y + h); ctx.lineTo(x + s + h, y) }
  ctx.stroke()
  ctx.restore()
}

function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1
  }
  return lo > 0 ? s.slice(0, lo) + '…' : ''
}

// Musical lines fall between frames, but clips and keys sit on whole frames: when a frame is
// wide enough to see the difference, draw the line on the frame things snap to
const gridX = (f: number, sf: number, ppf: number) => Math.round(((ppf >= 3 ? Math.round(f) : f) - sf) * ppf)

// ── Ruler / grid ──────────────────────────────────────────────────────────────

function forEachStep(step: number, sf: number, W: number, ppf: number, fn: (x: number, f: number) => void) {
  if (step <= 0 || ppf <= 0) return
  const endF = sf + W / ppf
  for (let i = Math.floor(sf / step); i * step <= endF + step; i++) {
    const f = i * step
    const x = (f - sf) * ppf
    if (x >= -1 && x <= W + 1) fn(x, f)
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D, W: number, fps: number, ppf: number, sf: number,
  markers: { time: string; name: string; color: string }[],
  bars: Tempo | null,
) {
  ctx.fillStyle = T.header; ctx.fillRect(0, 0, W, RULER_H)
  ctx.fillStyle = T.track; ctx.fillRect(0, TC_BAND_H, W, RULER_H - 1 - TC_BAND_H)
  ctx.fillStyle = T.gutter; ctx.fillRect(0, RULER_H - 1, W, 1)
  if (fps <= 0 || ppf <= 0) return

  if (bars) drawBarsBand(ctx, W, ppf, sf, bars)
  else drawTcBand(ctx, W, fps, ppf, sf)
  drawMarkerStrip(ctx, W, fps, ppf, sf, markers)
}

function drawTcBand(ctx: CanvasRenderingContext2D, W: number, fps: number, ppf: number, sf: number) {
  const { major, minor, showFrames } = rulerSteps(fps, ppf)
  ctx.fillStyle = T.field
  if (minor < major) forEachStep(minor, sf, W, ppf, x => ctx.fillRect(Math.round(x), TC_BAND_H - 4, 1, 4))

  ctx.font = `11px ${T.fontTc}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  forEachStep(major, sf, W, ppf, (x, f) => {
    const rx = Math.round(x)
    ctx.fillStyle = T.textFaint; ctx.fillRect(rx, 2, 1, TC_BAND_H - 2)
    const tc = framesToSmpte(Math.round(f), fps)
    ctx.fillStyle = T.textDim; ctx.fillText(showFrames ? tc : tc.slice(0, 8), rx + 4, 9)
  })
}

// Bars mode timecode band: bar numbers ("17"), beats when zoomed in ("17.3"), sixteenths at the
// deepest zoom ("17.3.2"); ticks for the finer grid steps. Pre-roll bars (before bar 1) are dimmer.
function drawBarsBand(ctx: CanvasRenderingContext2D, W: number, ppf: number, sf: number, t: Tempo) {
  const { major, minor } = musicalSteps(ppf, t)
  const f0 = sf - 1 / ppf, f1 = sf + (W + 1) / ppf
  if (minor < major) {
    ctx.fillStyle = T.field
    forEachGridLine(t, minor, f0, f1, (f, beats) => {
      if (isOnStep(beats, major)) return
      const h = isBarLine(beats, t) ? 8 : isBeatLine(beats) ? 5 : 3
      ctx.fillRect(gridX(f, sf, ppf), TC_BAND_H - h, 1, h)
    })
  }
  ctx.font = `11px ${T.fontTc}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  forEachGridLine(t, major, f0, f1, (f, beats) => {
    const rx = gridX(f, sf, ppf)
    const bar = isBarLine(beats, t)
    const pre = beats < 0
    ctx.fillStyle = bar ? T.textFaint : T.field; ctx.fillRect(rx, 2, 1, TC_BAND_H - 2)
    if (!isOnStep(beats, 0.25)) return   // 32nds: tick only
    if (pre && !bar) return              // pre-roll: whole bars only ("−1.2" reads like a decimal)
    const bb = frameToBarBeat(f, t)
    const label = formatBarBeat(bb, bar ? 1 : isBeatLine(beats) ? 2 : 3)
    ctx.fillStyle = pre ? T.textFaint : bar ? T.text : T.textDim
    ctx.fillText(label, rx + 4, 9)
  })
}

function drawMarkerStrip(
  ctx: CanvasRenderingContext2D, W: number, fps: number, ppf: number, sf: number,
  markers: { time: string; name: string; color: string }[],
) {
  // Marker strip: diamond + name, name clipped at the next marker
  const my = TC_BAND_H + (RULER_H - 1 - TC_BAND_H) / 2
  const mks = markers
    .map(m => ({ ...m, x: Math.round((smpteToFrames(m.time, fps) - sf) * ppf) }))
    .sort((a, b) => a.x - b.x)
  ctx.font = `11px ${T.fontUi}`
  mks.forEach((mk, i) => {
    if (mk.x < -200 || mk.x > W + 6) return
    const c = mk.color || T.loop
    diamond(ctx, mk.x + 0.5, my, 4)
    ctx.fillStyle = c; ctx.fill()
    ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
    const maxW = (i + 1 < mks.length ? mks[i + 1].x - 6 : W) - (mk.x + 7)
    if (mk.name && maxW > 10) {
      ctx.fillStyle = T.text
      ctx.fillText(fitText(ctx, mk.name, maxW), mk.x + 7, my + 0.5)
    }
  })
}

// Bars mode grid from the downbeat, per musicalSteps: bar lines (bar groups stronger when
// zoomed out), faint beats, very faint subdivisions; pre-roll before bar 1 at half strength.
// Kept well below markers (35 %) and the mint playhead so clips and automation stay in front.
function drawBarGrid(
  ctx: CanvasRenderingContext2D, W: number, top: number, h: number, ppf: number, sf: number, t: Tempo, barsOnly: boolean,
) {
  if (ppf <= 0 || h <= 0) return
  const { major, minor } = musicalSteps(ppf, t)
  const step = barsOnly ? Math.max(minor, t.beatsPerBar) : minor
  const groups = step >= t.beatsPerBar && major > step   // zoomed out: every line is a bar
  forEachGridLine(t, step, sf - 1 / ppf, sf + (W + 1) / ppf, (f, beats) => {
    let a: number
    if (isBarLine(beats, t)) a = groups && !isOnStep(beats, major) ? 0.055 : 0.1
    else if (isBeatLine(beats)) a = 0.045
    else a = 0.022
    if (barsOnly) a *= 0.7
    if (beats < 0) a *= 0.5
    ctx.fillStyle = `rgba(255,255,255,${a})`
    ctx.fillRect(gridX(f, sf, ppf), top, 1, h)
  })
}

// ── Audio lane ────────────────────────────────────────────────────────────────

function drawAudioLane(
  ctx: CanvasRenderingContext2D, W: number,
  audioTrack: Show['audioTrack'] | undefined,
  fps: number, pxPerFrame: number, scrollFrame: number,
  audioDuration: number,
  waveformInfo: WaveformInfo | null,
) {
  const laneY = RULER_H
  const laneH = AUDIO_LANE_H - 1  // last px is the gutter

  ctx.fillStyle = T.lane
  ctx.fillRect(0, laneY, W, laneH)
  ctx.fillStyle = T.gutter
  ctx.fillRect(0, laneY + laneH, W, 1)

  if (!audioTrack || audioDuration === 0) {
    ctx.fillStyle = T.textFaint
    ctx.font = `11px ${T.fontUi}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText('♪  Load audio — click the button in the left panel', 12, laneY + laneH / 2)
    return
  }

  const startF = smpteToFrames(audioTrack.startOffset || '00:00:00:00', fps)
  const durF = Math.round(audioDuration * fps)
  const ax = (startF - scrollFrame) * pxPerFrame
  const aw = Math.max(2, durF * pxPerFrame)
  const x0 = Math.max(0, ax)
  const x1 = Math.min(ax + aw, W)

  if (x1 > x0) {
    ctx.fillStyle = rgba(T.liveDeep, 0.35)
    ctx.fillRect(x0, laneY, x1 - x0, laneH)
  }

  if (waveformInfo && waveformInfo.data.length > 0 && x1 > x0) {
    const { data, samplesPerPeak, sampleRate } = waveformInfo
    const centerY = laneY + laneH / 2
    const amplitude = laneH / 2 - 5

    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, laneY, x1 - x0, laneH)
    ctx.clip()

    const tops: number[] = []
    const bots: number[] = []
    const xs: number[] = []

    for (let px = Math.ceil(x0); px <= Math.floor(x1); px++) {
      const frame = px / pxPerFrame + scrollFrame
      const t = (frame - startF) / fps
      if (t < 0 || t > audioDuration + 0.01) continue
      const si = t * sampleRate
      const piStart = Math.max(0, Math.floor(si / samplesPerPeak))
      const piEnd = Math.min(
        Math.ceil(((px + 1) / pxPerFrame + scrollFrame - startF) / fps * sampleRate / samplesPerPeak),
        data.length / 2 - 1
      )
      let mn = data[piStart * 2] ?? 0, mx = data[piStart * 2 + 1] ?? 0
      // Zoomed far out one pixel spans thousands of peaks: sample at most ~64 of them, so a
      // 3 h song costs the same per redraw as a short one (the outline is indistinguishable)
      const stride = Math.max(1, Math.floor((piEnd - piStart) / 64))
      for (let pi = piStart + 1; pi <= piEnd; pi += stride) {
        if (data[pi * 2] < mn) mn = data[pi * 2]
        if (data[pi * 2 + 1] > mx) mx = data[pi * 2 + 1]
      }
      xs.push(px + 0.5)
      tops.push(centerY - mx * amplitude)
      bots.push(centerY - mn * amplitude)
    }

    if (xs.length > 0) {
      ctx.fillStyle = T.liveFill
      ctx.beginPath()
      ctx.moveTo(xs[0], tops[0])
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], tops[i])
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], bots[i])
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(xs[0], Math.round(centerY), xs[xs.length - 1] - xs[0], 1)
    }

    ctx.restore()
  }

  // Start edge
  if (ax >= -1 && ax <= W) {
    ctx.fillStyle = T.liveFill
    ctx.fillRect(Math.max(0, Math.round(ax)), laneY, 2, laneH)
  }

  // File name
  const labelX = Math.max(ax + 6, 6)
  const labelW = Math.min(x1, W) - labelX - 4
  if (labelW > 12) {
    ctx.font = `bold 12px ${T.fontCond}`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    const name = fitText(ctx, audioTrack.name, labelW)
    const tw = ctx.measureText(name).width
    // Dark backing keeps the name readable over the waveform peaks
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(labelX - 3, laneY + 3, tw + 6, 16)
    ctx.fillStyle = T.text
    ctx.fillText(name, labelX, laneY + 5)
  }
}
