import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useFrame } from '../frameStore'
import type { Track, LayerTrack, GroupTrack, ClipCue, Keyframe, Show, AutomationSubTrack, LaneKind } from '../../../shared/show'
import { BASIC_CURVES, FAMILY_CURVES, curveLabel, curveOf, sampleLane } from '../../../shared/automation'
import { movesOf, moveAtOrAfter, stepRuns, runOf, type Move } from '../../../shared/moves'
import {
  type Material, type Row, type TimeSel, type EditCtx, type KeyMove,
  extractTime, deleteTime, extractCues, deleteCues, pasteMaterial, splitAt, moveKeys, keysIn, isEmptyMaterial, pruneAddedKeys,
  snapValue, optionAt, crossfadePartners, trimStart,
} from '../material'
import type { CurveName, FrameKeyframe } from '../../../shared/automation'
import type { WaveformInfo } from '../audio-engine'
import type { DragClipData } from '../App'
import type { LaneStatus, LaneStatusMap } from '../laneStatus'
import { formatValue } from '../../../shared/paramTree'
import { TOUCH, LONG_PRESS_MS, DOUBLE_TAP_MS, DOUBLE_TAP_PX } from '../touch'
import { continuesFrom, mediaStartOf, trimModeFields } from '../../../shared/cues'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { T, TAG_COLORS } from '../theme'
import { laneColor } from '../laneColor'
import { deckOfCue, type DeckInfo } from '../decks'
import { RULER_H, AUDIO_LANE_H, DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_AUTO_H, PPF_MIN, PPF_MAX } from '../layout'
import { type Tempo, type SnapSettings, musicalSteps, forEachGridLine, frameToBarBeat, formatBarBeat, isBarLine, isBeatLine, isOnStep, snapFrame, rulerSteps, gridSnapOf, snapToGrid } from '../grid'

// Picker offers the muted tags first; saturated ones stay for shows that already use them
const SATURATED_COLORS = ['#E74C3C', '#E2934A', '#F1C40F', '#2ECC71', '#1ABC9C', '#3498DB', '#9B59B6', '#E91E63']

const TC_BAND_H = 19            // ruler: timecode band on top, marker strip below
const CLIP_PAD = 2              // gap between block and lane edge (room for the state halo)
const CLIP_TITLE_H = 16
const RESIZE_HANDLE_W = TOUCH ? 18 : 10   // touch: finger-sized hit zones (here and below)
const AUTO_RESIZE_ZONE = TOUCH ? 12 : 6   // px at bottom of auto lane to start resize
const TRACKS_TOP = RULER_H + AUDIO_LANE_H
const KF_R = 4                  // keyframe glyph: 8px, 10px on hover
const KF_HIT = TOUCH ? 14 : 6    // half of the 12px (touch 28px) keyframe hit area
const MAX_CHOICE_BANDS = 12     // more options than this: no band separators
const SNAP_PX = 8               // drags snap to markers / playhead / clip edges this close
const TOUCH_TOOL_KEY = 'resolume-timeline:touch-tool'
const DRAG_START_PX = TOUCH ? 10 : 3   // a clip moves only after this much travel (a click / tap must not nudge it)
const AXIS_LOCK_PX = 4          // Shift-drag picks its axis after this much movement
const FINE = 0.1                // Shift drag up / down: finer values (Live)
const SEG_HIT = TOUCH ? 10 : 4   // px from a lane's line that grabs the segment
const BODY_MIN_H = 10           // a clip lower than its title bar + this is all title bar

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

// ── Layout ────────────────────────────────────────────────────────────────────

// One entry per automation index (indices stay aligned with track.automations); a hidden
// lane (auto.visible === false) has h = 0 and is skipped by every draw and hit test.
// A lane's keyframes as drawn (frame, normalized value, curve), sorted by time then index.
// Cached per keyframes array (never changed in place): parsing every time on every frame is
// what made long, dense lanes slow.
interface LaneKey { ki: number; kf: Keyframe; f: number; v: number; c: CurveName; dragging: boolean; primary: boolean }
interface LaneKeys { keys: LaneKey[]; fks: FrameKeyframe[] }
const laneKeyCache = new WeakMap<Keyframe[], { fps: number; kind: LaneKind; optsKey: string; lk: LaneKeys }>()
function sortLaneKeys(keys: LaneKey[]): LaneKeys {
  keys.sort((a, b) => a.f - b.f || a.ki - b.ki)
  return { keys, fks: keys.map(k => ({ frame: k.f, value: k.v, curve: k.c, ...(k.kf.bend && k.c !== 'hold' ? { bend: k.kf.bend } : {}) })) }
}
/** First index with f >= frame (keys.length if none). */
function firstKeyAt(keys: LaneKey[], frame: number): number {
  let lo = 0, hi = keys.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid].f < frame) lo = mid + 1; else hi = mid }
  return lo
}

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

// ── Drags (Ableton Live Arrangement View) ─────────────────────────────────────

// f/v: where the key is drawn during the drag; valued = the drag also changes its value
interface DragItem extends KfHit { kind: LaneKind; opts: string[]; f0: number; v0: number; f: number; v: number; valued: boolean }
interface KfDrag {
  primary: DragItem; items: DragItem[]
  at: { trackIdx: number; autoIdx: number }; lane: AutoLaneLayout   // the lane clicked
  startX: number; startY: number; lastY: number
  accY: number                         // vertical movement in px (Shift: finer)
  axis: 'x' | 'y' | null; moved: boolean
  // A line segment: its breakpoints move up / down; a click without movement adds a
  // breakpoint there. Otherwise a click without movement deletes the breakpoint (Live).
  segment: { f: number; value: number; option?: string } | null
  withSel: boolean                     // the keys of the time selection: it moves with them
  snapTargets: number[]; snapF: number | null
}
// Option-drag on a segment between two breakpoints: its curvature (Keyframe.bend)
interface BendDrag { trackIdx: number; autoIdx: number; kfIdx: number; startY: number; bend0: number; dir: number; bend: number; moved: boolean }
// Mouse down on the background: a drag selects time, a click sets the insert marker
interface SelDrag { f0: number; row0: number; startX: number; startY: number; moved: boolean }
// Moving (Option: copying) the selected clips, or the time selection by a clip's title bar
interface MatDrag {
  mode: 'cues' | 'time'; ids: string[]; f0: number   // f0: where the material starts
  anchorMouseF: number; startX: number; moved: boolean
  df: number; copy: boolean
  collapse: string | null   // a click without movement on a clip of a multi-selection selects just it
}
interface ViewRow { row: Row; trackIdx: number; autoIdx: number | null; y: number; h: number }

// ⌘C / ⌘X: module level, survives the canvas remounting on view switches
let clipboard: Material | null = null

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  tracks: Track[]
  markers: { id: string; time: string; name: string; color: string }[]
  fps: number
  tempo: Tempo | null                 // musical grid (null = no BPM)
  onSetDownbeat: (frame: number) => void   // ruler right-click: where bar 1 beat 1 is
  rulerMode: 'timecode' | 'bars'      // in effect; 'bars' only with a tempo
  snap: SnapSettings                  // snap to grid in effect (⌘ during a drag = free; Option = copy)
  lockEnvelopes: boolean              // Live's Lock Envelopes: automation stays put when clips move
  playing: boolean                    // stopped: a click in the timeline also moves the playhead (Live)
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
  onScrollYTo: (y: number) => void      // touch pan / scrollbar: an exact position (1:1 with the finger)
  onScrollFrame: (f: number) => void
  onSeek: (frame: number) => void
  onZoom: (factor: number) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onDropClip: (trackIdx: number, frame: number, clips: DragClipData[]) => void   // several: one after another
  placing: DragClipData[] | null        // touch: clips picked in the browser, dropped by a tap on their layer
  onPlaced: () => void                  // placed or cancelled
  onUndo: (redo: boolean) => void       // touch toolbar
  onScaleRows: (factor: number) => void // touch toolbar: every layer row / lane taller or shorter
  onUpdateCue: (trackIdx: number, cueIdx: number, updates: Partial<ClipCue>) => void
  // An edit of the tracks (selection edits: move, copy, paste, delete, split…), applied by App
  // as one undoable change. Must be a pure function of the tracks it gets.
  onEditTracks: (edit: (tracks: Track[]) => Track[]) => void
  historyTick: number   // changes on undo / redo: the selection may point at what is gone
  // option: choice lanes, the option name of the snapped value
  onAddKeyframe: (trackIdx: number, autoIdx: number, frame: number, value: number, option?: string) => void
  // updates may carry time, value, ease (Curve) and option (choice lanes)
  onUpdateKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number, updates: Partial<Keyframe>) => void
  onDeleteKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number) => void
  // Batch edits, applied atomically. Indices refer to the lanes BEFORE the call; updates
  // are applied by index, then each touched lane is re-sorted once (stable) by time.
  onUpdateKeyframes: (items: KeyframeUpdate[]) => void
  onDeleteKeyframes: (items: KeyframeRef[]) => void
  // Clip right-click automation templates: opacity fade on the cue's clip, copy / paste of
  // every lane bound to the cue. clipFadeUnavailable → reason the fade can't be made, or null.
  onClipFade: (trackIdx: number, cueIdx: number, mode: 'in' | 'out' | 'inout', seconds: number) => void
  onCrossfade: (cueIdA: string, cueIdB: string) => void
  transitionSecs: Record<string, number>   // Resolume layer transition per layer track id (s)
  clipFadeUnavailable: (trackIdx: number, cueIdx: number) => string | null
  onCopyClipAutomation: (trackIdx: number, cueIdx: number) => void
  onPasteClipAutomation: (trackIdx: number, cueIdx: number) => void
  canPasteClipAutomation: boolean
  laneClipboard: string | null       // label of the lane copied (lane header right-click), if any
  onPasteLaneOnCue: (trackIdx: number, cueIdx: number) => void
  onResizeAutoLane: (autoId: string, height: number) => void
  selectedTrackIdx: number | null
  selectedCueIdx: number | null
}

interface ClipColorPicker { x: number; y: number; trackIdx: number; cueIdx: number; frame: number }   // frame: where it was right-clicked

export function TimelineCanvas({
  tracks: tracksProp, markers, fps, tempo, rulerMode: rulerModeProp, snap, lockEnvelopes, playing, pxPerFrame, scrollFrame, draggingClip,
  autoLaneHeights, layerRowHeights, audioTrack, audioDuration, waveformInfo,
  scrollY, readOnly, laneStatus, overrides, decks, onScrollY, onScrollYTo, onScrollFrame, onSeek, onZoom, onSelectCue,
  onDropClip, placing, onPlaced, onUndo, onScaleRows, onUpdateCue, onEditTracks, historyTick, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
  onUpdateKeyframes, onDeleteKeyframes,
  onClipFade, onCrossfade, transitionSecs, clipFadeUnavailable, onCopyClipAutomation, onPasteClipAutomation, canPasteClipAutomation, laneClipboard, onPasteLaneOnCue, onSetDownbeat,
  onResizeAutoLane, selectedTrackIdx, selectedCueIdx,
}: Props) {
  const tracks = useMemo(() => toViewTracks(tracksProp), [tracksProp])
  // Only the overlay follows the playhead (see drawOverlay)
  const frame = useFrame()
  const bars = rulerModeProp === 'bars' && tempo ? tempo : null   // musical ruler + grid in effect
  // Snap to grid: null when off. 'auto' follows the zoom, so it is recomputed every render.
  const gridSnap = gridSnapOf(snap, tempo, rulerModeProp, pxPerFrame, fps)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)   // playhead layer, see drawOverlay
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
  const [hoverKf, setHoverKf] = useState<KfHit | null>(null)
  const frameRef = useRef(frame)
  frameRef.current = frame

  // ── Selection, as in Live's Arrangement View ──
  // A time selection (a span of time over rows), or selected clips (clicked), and the insert
  // marker (where ⌘V pastes). Handlers read them through refs: a change is visible at once.
  const [timeSel, setTimeSelState] = useState<TimeSel | null>(null)
  const timeSelRef = useRef(timeSel)
  const setTimeSel = (next: TimeSel | null) => { timeSelRef.current = next; setTimeSelState(next) }
  const [clipSel, setClipSel] = useState<string[]>([])
  const clipSelRef = useRef(clipSel)
  const updateClipSel = (next: string[]) => { clipSelRef.current = next; setClipSel(next) }
  const [insertMk, setInsertMkState] = useState<{ f: number; row: Row } | null>(null)
  const insertRef = useRef(insertMk)
  const setInsertMk = (next: { f: number; row: Row } | null) => { insertRef.current = next; setInsertMkState(next) }
  const anchorCueRef = useRef<string | null>(null)   // Shift-click on a clip selects from here
  const clearSelection = () => { setTimeSel(null); updateClipSel([]) }
  // Last clicked automation lane (by id): paste target for one lane of material
  const focusLaneRef = useRef<string | null>(null)

  // Selected breakpoints (Live): the keys inside the time selection on its lane rows
  const sel = useMemo<KfHit[]>(() => {
    if (!timeSel) return []
    const out: KfHit[] = []
    for (const r of timeSel.rows) {
      if (!r.laneId) continue
      const at = findLane(tracks, r.laneId)
      if (at) keysIn(at.auto, timeSel.a, timeSel.b, fps).forEach(kfIdx => out.push({ trackIdx: at.trackIdx, autoIdx: at.autoIdx, kfIdx }))
    }
    return out
  }, [timeSel, tracks, fps])
  const selRef = useRef(sel)
  selRef.current = sel

  // The App's selected cue (inspector) joins the clip selection
  const primaryCueId = selectedTrackIdx != null && selectedCueIdx != null
    ? (tracksProp[selectedTrackIdx] as LayerTrack | undefined)?.clips?.[selectedCueIdx]?.id ?? null : null
  useEffect(() => {
    if (primaryCueId && !clipSelRef.current.includes(primaryCueId)) { updateClipSel([primaryCueId]); setTimeSel(null) }
  }, [primaryCueId])
  // Undo / redo: the selection belonged to the state that is gone
  useEffect(() => { if (historyTick) { setTimeSel(null); updateClipSel([]) } }, [historyTick])
  // Clips removed elsewhere (undo, inspector) leave the selection
  useEffect(() => {
    const ids = new Set(tracksProp.flatMap(t => t.type === 'layer' ? (t as LayerTrack).clips.map(c => c.id) : []))
    if (clipSelRef.current.some(id => !ids.has(id))) updateClipSel(clipSelRef.current.filter(id => ids.has(id)))
  }, [tracksProp])
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

  /** An edit through App (one undo step). The id generator restarts on every run, so the
   *  edit is the same function each time React runs it and the ids are known here. */
  const edit = <R extends Track[] | { tracks: Track[]; ids: string[] }>(op: (t: Track[], ctx: EditCtx) => R): R => {
    const base = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const run = (t: Track[]): R => {
      let n = 0
      const r = op(t, { fps, lockEnvelopes, newId: prefix => `${prefix}${base}-${++n}` })
      // Edge breakpoints that change nothing don't stay (repeated nudges would pile them up)
      if (Array.isArray(r)) return pruneAddedKeys(r, fps) as R
      return { ...r, tracks: pruneAddedKeys(r.tracks, fps) } as R
    }
    onEditTracks(t => { const r = run(t); return Array.isArray(r) ? r : r.tracks })
    return run(tracksProp)
  }

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
  const resizeClipRef = useRef<{ trackIdx: number; cueIdx: number; edge: 'left' | 'right'; startX: number; moved: boolean; startF: number; startDurF: number } | null>(null)
  // Snap guide of a clip move / resize / clip-browser drop (keyframe drags keep theirs in KfDrag)
  const snapGuideRef = useRef<number | null>(null)
  const kfDragRef = useRef<KfDrag | null>(null)
  const bendDragRef = useRef<BendDrag | null>(null)
  const selDragRef = useRef<SelDrag | null>(null)
  const matDragRef = useRef<MatDrag | null>(null)
  const autoResizeRef = useRef<{ autoId: string; startY: number; startH: number } | null>(null)
  // Clips being dragged at their new start; copy: Option held, the originals stay where they are
  const ghostClipRef = useRef<{ copy: boolean; items: { trackIdx: number; cueIdx: number; frame: number }[] } | null>(null)
  // Clip edge being dragged: its new start (left edge) and length
  const ghostDurRef = useRef<{ trackIdx: number; cueIdx: number; durF: number; sf?: number } | null>(null)

  const frameToX = (f: number) => (f - scrollFrame) * pxPerFrame

  /** A layer's clip spans as a drag in progress shows them (moved starts, a dragged edge: the
   *  left edge changes start and length, its end stays). The timeline and the overlay (playing
   *  clip outline) both draw from this, so they agree while dragging. */
  const dragSpans = (lt: LayerTrack, trackIdx: number) => {
    const gc = ghostClipRef.current
    const ghostMove = gc && !gc.copy
      ? new Map(gc.items.filter(g => g.trackIdx === trackIdx).map(g => [g.cueIdx, g.frame])) : null
    const ghostDur = ghostDurRef.current?.trackIdx === trackIdx ? ghostDurRef.current : null
    const starts = ghostDur?.sf != null ? new Map([...(ghostMove ?? []), [ghostDur.cueIdx, ghostDur.sf]]) : ghostMove
    return { spans: clipSpans(lt, fps, starts, ghostDur), ghostMove }
  }
  const xToFrame = (x: number) => Math.max(0, Math.round(x / pxPerFrame + scrollFrame))

  /** Where a dragged clip edge / dropped clip / new key lands. Snap on: the nearest grid line, or a
   *  marker / the playhead within SNAP_PX when that is nearer. Clip drags (`clips`) also stick to
   *  the start and end of every other clip within SNAP_PX, with snap on or off, so clips go one
   *  after another without a gap; a dragged block `len` frames long sticks with its end too.
   *  Free (⌘): the whole frame under the cursor. guide = the frame to draw the snap line at. */
  const snapDrag = (rawF: number, free: boolean, clips?: { skip?: Set<string>; len?: number }): { f: number; guide: number | null } => {
    if (free) return { f: Math.max(0, Math.round(rawF)), guide: null }
    const near = SNAP_PX / pxPerFrame
    let best: number | null = null, bestD = Infinity, guide: number | null = null
    const consider = (f: number, line: number) => {
      const d = Math.abs(f - rawF)
      if (d <= near && d < bestD) { best = f; bestD = d; guide = line }
    }
    if (gridSnap) {
      best = snapToGrid(rawF, gridSnap.stepF, gridSnap.tempo); bestD = Math.abs(best - rawF); guide = best
      for (const c of [...markers.map(m => smpteToFrames(m.time, fps)), Math.round(frameRef.current)]) consider(c, c)
    }
    if (clips) for (const e of clipEdges(clips.skip)) {
      consider(e, e)
      if (clips.len) consider(e - clips.len, e)
    }
    if (best === null) return { f: Math.max(0, Math.round(rawF)), guide: null }
    return { f: Math.max(0, best), guide }
  }

  /** Start and end frames of the clips on every layer (the ones in `skip` are being dragged). */
  const clipEdges = (skip?: Set<string>): number[] => {
    const out: number[] = []
    for (const t of tracks) if (t.type === 'layer') for (const c of (t as LayerTrack).clips) {
      if (skip?.has(c.id)) continue
      const sf = smpteToFrames(c.time, fps), dur = smpteToFrames(c.duration, fps)
      out.push(sf)
      if (dur > 0) out.push(sf + dur)
    }
    return out
  }

  useEffect(() => {
    if (readOnly) { setContextMenu(null); setClipColorPicker(null); setInsertMk(null) }
  }, [readOnly])

  /** Rows on screen, top to bottom: each track's clip row, then its shown lanes. */
  const viewRows = (layout: TrackLayout[]): ViewRow[] => {
    const out: ViewRow[] = []
    tracks.forEach((t, ti) => {
      const l = layout[ti]
      if (!l || l.hidden) return
      out.push({ row: { trackId: t.id }, trackIdx: ti, autoIdx: null, y: l.y, h: clipH(t.id) })
      l.autoLanes.forEach((lane, ai) => {
        const auto = (t as LayerTrack).automations[ai]
        if (auto && lane.h > 0) out.push({ row: { trackId: t.id, laneId: auto.id }, trackIdx: ti, autoIdx: ai, y: lane.y, h: lane.h })
      })
    })
    return out
  }
  const sameRow = (a: Row, b: Row) => a.trackId === b.trackId && (a.laneId ?? '') === (b.laneId ?? '')
  /** Index of the row at y (nearest row above / below when outside them). */
  const rowIndexAt = (rows: ViewRow[], y: number, clampToRows = false): number | null => {
    const i = rows.findIndex(r => y >= r.y && y < r.y + r.h)
    if (i >= 0 || !clampToRows || !rows.length) return i >= 0 ? i : null
    return y < rows[0].y ? 0 : rows.length - 1
  }

  /** A lane's keyframes as drawn: dragged ones at their drag position. */
  const drawnKeys = (trackIdx: number, ai: number, auto: AutomationSubTrack, kind: LaneKind, opts: string[]): LaneKeys => {
    const kd = kfDragRef.current
    const drags = kd?.moved ? kd.items.filter(i => i.trackIdx === trackIdx && i.autoIdx === ai) : []
    const curve = (kf: Keyframe): CurveName => kind === 'range' ? curveOf(kf.ease) : 'hold'
    const bd = bendDragRef.current
    if (bd?.moved && bd.trackIdx === trackIdx && bd.autoIdx === ai) {
      // Option-drag preview: the segment with its new curvature
      return sortLaneKeys(auto.keyframes.map((kf, ki) => {
        const k = ki === bd.kfIdx ? { ...kf, ease: 'linear', bend: bd.bend } : kf
        return { ki, kf: k, f: smpteToFrames(kf.time, fps), v: kfValue(kind, kf, opts), c: curve(k), dragging: false, primary: false }
      }))
    }
    if (!drags.length) {
      const optsKey = opts.join('\n'), hit = laneKeyCache.get(auto.keyframes)
      if (hit && hit.fps === fps && hit.kind === kind && hit.optsKey === optsKey) return hit.lk
      const lk = sortLaneKeys(auto.keyframes.map((kf, ki) => ({
        ki, kf, f: smpteToFrames(kf.time, fps), v: kfValue(kind, kf, opts), c: curve(kf), dragging: false, primary: false,
      })))
      laneKeyCache.set(auto.keyframes, { fps, kind, optsKey, lk })
      return lk
    }
    const byKi = new Map(drags.map(d => [d.kfIdx, d]))
    return sortLaneKeys(auto.keyframes.map((kf, ki) => {
      const d = byKi.get(ki)
      return {
        ki, kf, f: d ? d.f : smpteToFrames(kf.time, fps), v: d ? d.v : kfValue(kind, kf, opts), c: curve(kf),
        dragging: !!d, primary: !!d && d === kd!.primary,
      }
    }))
  }

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
        // The clip's name at the box's top right: the lane's range labels sit at the left edge
        const right = Math.min(b.x + b.w, W) - 4, tw = right - Math.max(b.x, 0) - 8
        if (tw > 6 && lh >= 14) {
          ctx.save()
          ctx.beginPath(); ctx.rect(b.x, ly, b.w, lh); ctx.clip()
          ctx.font = `10px ${T.fontCond}`; ctx.fillStyle = 'rgba(255,255,255,0.7)'
          ctx.textAlign = 'right'; ctx.textBaseline = 'top'
          ctx.fillText(fitText(ctx, clip.clipName || `Clip ${clip.clipIndex}`, tw), right, ly + 3)
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

      // Keyframes as drawn (dragged ones at their drag position). Only the ones on screen are
      // drawn, plus one beyond each edge so the curve reaches the edges.
      const { keys: all, fks: allFks } = drawnKeys(trackIdx, ai, auto, kind, opts)
      const lo = Math.max(0, firstKeyAt(all, pxToFrame(0)) - 1)
      const hi = Math.min(all.length, firstKeyAt(all, pxToFrame(W)) + 1)
      const sorted = all.slice(lo, hi).map(k => ({ ...k, x: frameToX(k.f), y: toY(k.v) }))
      const keys = sorted
      // Same interpolation as the engine; kfToY clamps elastic/back overshoot to the lane
      const fks: FrameKeyframe[] = allFks.slice(lo, hi)

      if (sorted.length) {
        // Curve outline: holds as steps, eased segments sampled every 2px
        const pts: [number, number][] = [[sorted[0].x, sorted[0].y]]
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i + 1]
          if (a.c === 'hold') { pts.push([b.x, a.y], [b.x, b.y]); continue }
          if (a.c !== 'linear' || fks[i].bend) {
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
        const glyph: CurveName = k.c === 'linear' && k.kf.bend ? 'easeInOut' : k.c   // bent: a curve
        if (active) { kfGlyph(ctx, glyph, k.x, k.y, r + 1.5); ctx.fillStyle = T.gutter; ctx.fill() }
        kfGlyph(ctx, glyph, k.x, k.y, r)
        ctx.fillStyle = active && !broken ? T.select : kfC; ctx.fill()
        if (!active) { ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke() }
        ctx.globalAlpha = 1
        if (k.primary && kd) {
          const n = kd.items.length
          tips.push({ text: `${formatValue(kind, k.v, range, undefined, range.suffix)} · ${framesToSmpte(k.f, fps)}${n > 1 ? `  (${n})` : ''}`, x: k.x, y: k.y })
        } else if (hover)
          tips.push({ text: `${paramName}: ${formatValue(kind, k.v, range, k.kf.option, range.suffix)} · ${k.kf.time}`, x: k.x, y: k.y })
      })

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
      const { spans, ghostMove } = dragSpans(lt, trackIdx)
      const cutOutlines: { x: number; w: number }[] = []

      lt.clips.forEach((clip, cueIdx) => {
        const isGhost = !!ghostMove?.has(cueIdx)
        const { sf, durF, shownF } = spans[cueIdx]
        const x = Math.round(frameToX(sf))
        const blockW = Math.round(spanWidth(shownF, pxPerFrame))
        const fullW = Math.round(spanWidth(durF, pxPerFrame))
        if (x + blockW < -4 || x > W + 4) return
        const isSel = clipSel.includes(clip.id)
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
          // ⟳: runs free in Resolume (doesn't pause / scrub with the playhead)
          const title = `${clip.follow === false ? '⟳ ' : ''}${clip.clipName || `Clip ${clip.clipIndex}`}`
          ctx.fillText(fitText(ctx, title, textW), tx, by + titleH / 2 + 0.5)
          if (bh - titleH >= 13) {
            // The body line starts at the clip's edge (the title line makes room for the deck badge)
            const bx = Math.max(0, x) + 6, bw = Math.min(x + blockW, W) - bx - 4
            ctx.font = `10px ${T.fontTc}`; ctx.fillStyle = 'rgba(255,255,255,0.7)'
            ctx.textBaseline = 'top'
            const slot = `#${clip.clipIndex}`
            const slotW = ctx.measureText(slot).width
            if (slotW <= bw) ctx.fillText(slot, bx, by + titleH + 3)
            if (durF > 0) {
              const dur = framesToSmpte(durF, fps)
              const durW = ctx.measureText(dur).width
              if (slotW + 8 + durW <= bw) ctx.fillText(dur, bx + slotW + 8, by + titleH + 3)
              // Edit trim mode, and where in its media the clip starts
              const ms = mediaStartOf(clip)
              const inTxt = [clip.trim === 'edit' ? 'edit' : '', ms > 0 ? `▸${framesToSmpte(ms, fps)}` : ''].filter(Boolean).join(' ')
              if (inTxt && slotW + 16 + durW + ctx.measureText(inTxt).width <= bw) ctx.fillText(inTxt, bx + slotW + durW + 16, by + titleH + 3)
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
        if (!isGhost && !readOnly && resizeZoneW(isCut ? 0 : durF, blockW) > 0 && bh - titleH >= 10) {
          ctx.fillStyle = 'rgba(255,255,255,0.3)'
          const gy = by + titleH + 3, gh = bh - titleH - 6
          ctx.fillRect(x + blockW - 7, gy, 1, gh)
          ctx.fillRect(x + blockW - 5, gy, 1, gh)
        }

        // Resolume's layer transition: the clip blends in over this long from its start
        const trF = (transitionSecs[lt.id] ?? 0) * fps
        const carriesOn = cueIdx > 0 && continuesFrom(lt.clips[cueIdx - 1], clip, t => smpteToFrames(t, fps))
        if (trF > 0 && !isGhost && !carriesOn) drawTransitionRamp(ctx, x, by + titleH, Math.min(blockW, trF * pxPerFrame), bh - titleH)

        // State outlines: 2px inside the block, 1px black halo outside (the playing clip's
        // outline is drawn by the overlay, it changes with the playhead)
        if (isGhost) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = T.textHi; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
          ctx.strokeRect(x + 0.5, by + 0.5, blockW - 1, bh - 1)
          ctx.setLineDash([])
        } else if (isSel) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1
          ctx.strokeRect(x - 0.5, by - 0.5, blockW + 1, bh + 1)
          ctx.strokeStyle = T.select; ctx.lineWidth = 2
          ctx.strokeRect(x + 1, by + 1, blockW - 2, bh - 2)
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
      : (matDragRef.current?.moved || resizeClipRef.current?.moved || draggingClip) ? snapGuideRef.current : null
    if (guideF != null) {
      const gx = Math.round(frameToX(guideF))
      ctx.fillStyle = T.select; ctx.fillRect(gx, TRACKS_TOP, 1, H - TRACKS_TOP)
    }

    // Time selection (Live): highlighted on its rows; a clip row's selection also takes the
    // layer automation under it unless envelopes are locked (lighter there)
    const ts = timeSelRef.current
    const md = matDragRef.current
    if (ts) {
      const rows = viewRows(layout)
      const drawSpan = (a: number, b: number, alpha: number, edge: boolean, dashed = false) => {
        const x0 = Math.round(frameToX(a)), x1 = Math.max(x0 + 1, Math.round(frameToX(b)))
        for (const vr of rows) {
          const picked = ts.rows.some(r => sameRow(r, vr.row))
          const implied = !picked && !lockEnvelopes && vr.row.laneId != null && ts.rows.some(r => !r.laneId && r.trackId === vr.row.trackId) &&
            (() => { const a = autoAt(vr.trackIdx, vr.autoIdx!); return !!a && (a.layerBound || !a.clipId) })()
          if (!picked && !implied) continue
          ctx.fillStyle = rgba(T.select, picked ? alpha : alpha / 2)
          ctx.fillRect(x0, vr.y, x1 - x0, vr.h - 1)
          if (edge) {
            ctx.fillStyle = rgba(T.select, picked ? 0.8 : 0.4)
            ctx.fillRect(x0, vr.y, 1, vr.h - 1); ctx.fillRect(x1 - 1, vr.y, 1, vr.h - 1)
          }
          if (dashed) {
            ctx.strokeStyle = T.select; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
            ctx.strokeRect(x0 + 0.5, vr.y + 0.5, x1 - x0 - 1, vr.h - 2); ctx.setLineDash([])
          }
        }
      }
      // Breakpoints of the selection being dragged: the selection goes along
      const kdf = kd?.moved && kd.withSel ? kd.primary.f - kd.primary.f0 : 0
      drawSpan(ts.a + kdf, ts.b + kdf, 0.16, true)
      // Dragged by a clip's title bar: where it lands (Option: a copy)
      if (md?.mode === 'time' && md.moved && md.df !== 0) drawSpan(ts.a + md.df, ts.b + md.df, 0.1, false, true)
    }

    // Tooltips / drag labels over every lane
    tips.forEach(t => drawTip(ctx, t.text, t.x, t.y, W, TRACKS_TOP))

    ctx.restore() // end track clip region
    drawOverlayRef.current()
  }, [tracks, markers, fps, bars, pxPerFrame, scrollFrame, selectedTrackIdx, selectedCueIdx, draggingClip, autoLaneHeights, layerRowHeights, scrollY, audioTrack, audioDuration, waveformInfo, readOnly, contextMenu, laneStatus, overrides, decks, sel, hoverKf, clipSel, timeSel, lockEnvelopes, transitionSecs])


  // ── Overlay: what moves with the playhead ─────────────────────────────────
  // Redrawn on every frame while the timeline runs; the timeline under it only on changes.

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current, container = containerRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !container || !ctx) return
    const W = container.clientWidth, H = container.clientHeight
    if (W === 0 || H === 0) return
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const layout = buildLayout(tracks, clipH, autoH, scrollY)
    const lx = frameToX(frame)
    // Playhead line first: what sits on it (a key just added at the playhead, the lanes' value
    // dots) is drawn over it, not hidden under it
    const px = Math.round(lx)
    if (px >= -6 && px <= W + 6) { ctx.fillStyle = T.live; ctx.fillRect(px - 1, 0, 2, H) }
    ctx.save()
    ctx.beginPath(); ctx.rect(0, TRACKS_TOP, W, H - TRACKS_TOP); ctx.clip()
    tracks.forEach((track, trackIdx) => {
      if (track.type !== 'layer') return
      const lt = track as LayerTrack
      const { y, totalH, autoLanes, hidden } = layout[trackIdx]
      if (hidden || y > H || y + totalH < TRACKS_TOP) return

      // The clip playing on this layer: progress bar and live outline
      if (!lt.muted) {
        const { spans, ghostMove } = dragSpans(lt, trackIdx)
        const by = y + CLIP_PAD, bh = clipH(lt.id) - 1 - CLIP_PAD * 2
        lt.clips.forEach((clip, ci) => {
          const { sf, shownF } = spans[ci]
          if (ghostMove?.has(ci) || shownF <= 0 || frame < sf || frame >= sf + shownF) return
          const x = Math.round(frameToX(sf)), blockW = Math.round(spanWidth(shownF, pxPerFrame))
          if (x + blockW < -4 || x > W + 4) return
          const p = Math.max(0, Math.min(1, (frame - sf) / shownF))
          ctx.fillStyle = T.liveFill
          ctx.fillRect(x + 2, by + bh - 4, Math.max(1, (blockW - 4) * p), 2)
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1
          ctx.strokeRect(x - 0.5, by - 0.5, blockW + 1, bh + 1)
          ctx.strokeStyle = T.live; ctx.lineWidth = 2
          ctx.strokeRect(x + 1, by + 1, blockW - 2, bh - 2)
          if (clipSel.includes(clip.id)) {
            ctx.strokeStyle = T.select; ctx.lineWidth = 1
            ctx.strokeRect(x + 2.5, by + 2.5, blockW - 5, bh - 5)
          }
        })
      }

      // Each lane's value at the playhead
      if (lx < -4 || lx > W + 4) return
      autoLanes.forEach((lane, ai) => {
        const auto = lt.automations[ai]
        if (!auto || lane.h <= 0 || lane.y > H || lane.y + lane.h < TRACKS_TOP) return
        const kind = laneKind(auto), status = laneStatus[auto.id]
        const { fks } = drawnKeys(trackIdx, ai, auto, kind, laneRange(auto, status).options ?? [])
        const cur = sampleLane(fks, frame, kind)?.value
        if (cur == null) return
        const ovr = overrides[auto.id]
        const faded = status?.state === 'broken' || auto.enabled === false || (typeof ovr === 'number' && Number.isFinite(ovr))
        ctx.save()
        ctx.beginPath(); ctx.rect(0, lane.y, W, lane.h - 1); ctx.clip()
        // A key on the playhead's frame: its glyph again, over the playhead line
        const onKey = fks.find(k => Math.abs(k.frame - frame) < 0.5)
        if (onKey) {
          ctx.beginPath(); ctx.arc(lx, kfToY(lane)(onKey.value), KF_R + 1, 0, Math.PI * 2)
          ctx.fillStyle = laneColor(auto, lt, T.text); ctx.fill()
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1.5; ctx.stroke()
        }
        if (readOnly && !faded) {
          // SHOW mode: the move running now lit mint, the next one blue (the show view's radar
          // language on the timeline itself)
          const moves = movesOf(fks, kind), toY = kfToY(lane)
          const lit = (m: Move, color: string) => {
            ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath()
            if (m.to === m.from) {
              const x = frameToX(m.from)
              ctx.moveTo(x, toY(m.values[0])); ctx.lineTo(x, toY(m.values[1]))
            } else {
              const x0 = Math.max(-2, frameToX(m.from)), x1 = Math.min(W + 2, frameToX(m.to))
              for (let x = x0; ; x += 3) {
                const p = Math.min(x, x1), v = sampleLane(fks, p / pxPerFrame + scrollFrame, kind)?.value ?? 0
                if (x === x0) ctx.moveTo(p, toY(v)); else ctx.lineTo(p, toY(v))
                if (p >= x1) break
              }
            }
            ctx.stroke()
          }
          // A strobe (run of quick steps) is lit as a whole, as the show view counts it as one
          const runs = stepRuns(moves, fps)
          const litFrom = (k: number, color: string) => {
            const run = runOf(runs, k)
            if (!run) { lit(moves[k], color); return k }
            for (let q = run.first; q <= run.last; q++) lit(moves[q], color)
            return run.last
          }
          const i = moveAtOrAfter(moves, frame), m = moves[i]
          const run = m ? runOf(runs, i) : null
          if (run && run.from <= frame) { const k = litFrom(i, T.live); if (moves[k + 1]) litFrom(k + 1, T.next) }
          else if (m && !run && m.from <= frame && frame < m.to) { lit(m, T.live); if (moves[i + 1]) litFrom(i + 1, T.next) }
          else if (m) litFrom(i, T.next)
        }
        ctx.beginPath(); ctx.arc(lx, kfToY(lane)(cur), 2.5, 0, Math.PI * 2)
        ctx.fillStyle = faded ? T.textFaint : T.live; ctx.fill()
        ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
        ctx.restore()
      })
    })
    ctx.restore()

    // Playhead cap in the ruler
    if (px >= -6 && px <= W + 6) {
      ctx.fillStyle = T.live
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill()
    }

    // Insert marker (Live): where ⌘V pastes, blinking on its row, over the playhead (stopped,
    // they are at the same place)
    const im = insertRef.current
    if (im && !timeSelRef.current && blinkRef.current) {
      const vr = viewRows(layout).find(r => sameRow(r.row, im.row))
      const ix = Math.round(frameToX(im.f))
      if (vr && ix >= -2 && ix <= W + 2 && vr.y + vr.h > TRACKS_TOP) {
        const top = Math.max(TRACKS_TOP, vr.y)
        ctx.fillStyle = T.textHi; ctx.fillRect(ix - 1, top, 3, vr.y + vr.h - 1 - top)
      }
    }
  }, [tracks, fps, frame, pxPerFrame, scrollFrame, autoLaneHeights, layerRowHeights, scrollY, laneStatus, overrides, clipSel, insertMk, timeSel, readOnly])
  const drawOverlayRef = useRef(drawOverlay)
  drawOverlayRef.current = drawOverlay
  useEffect(() => { drawOverlay() }, [drawOverlay])
  // The insert marker blinks like a text cursor
  const blinkRef = useRef(true)
  useEffect(() => {
    blinkRef.current = true
    if (!insertMk || timeSel) return
    const id = setInterval(() => { blinkRef.current = !blinkRef.current; drawOverlayRef.current() }, 530)
    return () => clearInterval(id)
  }, [insertMk, timeSel])

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

  /** The clip under the cursor and which part: the title bar selects and moves it (Live: only
   *  the clip bar is draggable), the body selects time like the background, the edges change
   *  its start / length. */
  const hitTestClip = useCallback((x: number, y: number): { trackIdx: number; cueIdx: number; part: 'title' | 'body' | 'left' | 'right' } | null => {
    const layout = getLayout()
    const ti = getTrackAtY(layout, y)
    if (ti == null || tracks[ti].type !== 'layer') return null
    const lt = tracks[ti] as LayerTrack
    // Only the clip row: the automation lanes below belong to keyframes
    if (y >= layout[ti].y + clipH(lt.id)) return null
    const SLOP = 3
    const spans = clipSpans(lt, fps, null, null)
    const by = layout[ti].y + CLIP_PAD, bh = clipH(lt.id) - 1 - CLIP_PAD * 2
    const titleH = Math.min(CLIP_TITLE_H, bh)
    // Later clips are drawn on top, so test them first. A clip the cursor is really on wins over
    // a neighbour's edge reached only through the slop (two clips touching: the edge under the
    // cursor is the one grabbed, not the next clip's start)
    const inside = (ci: number, slop: number) => {
      const cx = frameToX(spans[ci].sf), w = spanWidth(spans[ci].shownF, pxPerFrame)
      return x >= cx - slop && x <= cx + w + slop
    }
    let hitIdx = -1
    for (let ci = lt.clips.length - 1; ci >= 0 && hitIdx < 0; ci--) if (inside(ci, 0)) hitIdx = ci
    for (let ci = lt.clips.length - 1; ci >= 0 && hitIdx < 0; ci--) if (inside(ci, SLOP)) hitIdx = ci
    if (hitIdx < 0) return null
    const { sf, durF, shownF } = spans[hitIdx]
    const blockW = spanWidth(shownF, pxPerFrame)
    const cx = frameToX(sf)
    const right = resizeZoneW(shownF < durF ? 0 : durF, blockW)
    const left = resizeZoneW(durF, blockW)
    const part = right > 0 && x >= cx + blockW - right ? 'right'
      : left > 0 && x <= cx + left ? 'left'
      : TOUCH || y < by + titleH || bh - titleH < BODY_MIN_H ? 'title' : 'body'
    return { trackIdx: ti, cueIdx: hitIdx, part }
  }, [tracks, fps, pxPerFrame, scrollFrame, getLayout])

  /** The line of a lane under the cursor: the breakpoints around it and its value at f. */
  const hitSegment = (x: number, y: number, ti: number, ai: number, lane: AutoLaneLayout, f: number) => {
    const auto = autoAt(ti, ai)
    if (!auto) return null
    const kind = laneKind(auto), opts = laneRange(auto, laneStatus[auto.id]).options ?? []
    const { keys, fks } = drawnKeys(ti, ai, auto, kind, opts)
    if (!keys.length) return null
    const under = sampleLane(fks, x / pxPerFrame + scrollFrame, kind)
    if (!under || Math.abs(kfToY(lane)(under.value) - y) > SEG_HIT) return null
    const j = firstKeyAt(keys, x / pxPerFrame + scrollFrame)
    const at = sampleLane(fks, f, kind) ?? under
    const option = kind === 'choice' ? (keys[Math.max(0, j - 1)]?.kf.option ?? optionAt(at.value, opts)) : undefined
    return { k0: j > 0 ? keys[j - 1].ki : null, k1: j < keys.length ? keys[j].ki : null, value: at.value, option, kind }
  }

  const localXY = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Drag of breakpoints: the clicked one, the selected ones, or a segment's two. */
  const startKfDrag = (hits: KfHit[], primaryHit: KfHit | null, at: { trackIdx: number; autoIdx: number },
    layout: TrackLayout[], x: number, y: number, segment: KfDrag['segment'], withSel: boolean) => {
    const items: DragItem[] = []
    for (const h of hits) {
      const a = autoAt(h.trackIdx, h.autoIdx), k = a?.keyframes[h.kfIdx]
      if (!a || !k || !layout[h.trackIdx]?.autoLanes[h.autoIdx]?.h || !canEditLane(h.trackIdx, h.autoIdx)) continue
      const kind = laneKind(a), opts = laneRange(a, laneStatus[a.id]).options ?? []
      const f0 = smpteToFrames(k.time, fps), v0 = kfValue(kind, k, opts)
      items.push({ ...kfRef(h), kind, opts, f0, v0, f: f0, v: v0, valued: false })
    }
    const primary = (primaryHit && items.find(i => sameKf(i, primaryHit))) ?? items[0]
    if (!primary && !segment) return
    // Values move only for a lone key, or for range keys in the dragged key's lane
    items.forEach(i => {
      i.valued = items.length === 1 || (primary.kind === 'range' && i.kind === 'range' && laneKey(i) === laneKey(primary))
        || (!!segment && laneKey(i) === laneKey(at))
    })
    const lt = tracks[at.trackIdx] as LayerTrack
    const snapTargets = markers.map(m => smpteToFrames(m.time, fps))
    clipSpans(lt, fps, null, null).forEach(s => { snapTargets.push(s.sf); if (s.durF > 0) snapTargets.push(s.sf + s.durF) })
    lt.automations[at.autoIdx]?.keyframes.forEach((k, ki) => {
      if (!items.some(i => i.trackIdx === at.trackIdx && i.autoIdx === at.autoIdx && i.kfIdx === ki)) snapTargets.push(smpteToFrames(k.time, fps))
    })
    kfDragRef.current = {
      primary: primary ?? ({ ...at, kfIdx: -1, kind: 'range', opts: [], f0: 0, v0: 0, f: 0, v: 0, valued: false }),
      items, at, lane: layout[at.trackIdx].autoLanes[at.autoIdx],
      startX: x, startY: y, lastY: y, accY: 0, axis: segment ? 'y' : null, moved: false,
      segment, withSel, snapTargets, snapF: null,
    }
  }

  // ── Mouse down ─────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setContextMenu(null)
    setClipColorPicker(null)
    setRulerMenu(null)
    const { x, y } = localXY(e)
    const layout = getLayout()
    const free = e.metaKey || e.ctrlKey   // ⌘: no snapping (Live)
    const rawF = x / pxPerFrame + scrollFrame

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

    // Breakpoint: a drag moves it (all selected ones when it is selected), a click deletes it
    if (kfHit && kfEditable) {
      setHoverKf(null)
      const inSel = selHas(selRef.current, kfHit)
      if (!inSel) setTimeSel(null)
      updateClipSel([]); setInsertMk(null)
      startKfDrag(inSel ? selRef.current : [kfHit], kfHit, kfHit, layout, x, y, null, inSel)
      return
    }
    if (kfHit) return

    // Line segment: a drag moves it up / down, Option-drag bends it, a click adds a breakpoint
    if (autoLane && canEditLane(autoLane.trackIdx, autoLane.autoIdx)) {
      const { trackIdx: ti, autoIdx: ai } = autoLane
      const f = snapDrag(rawF, free).f
      const seg = hitSegment(x, y, ti, ai, autoLane.lane, f)
      if (seg) {
        updateClipSel([]); setInsertMk(null)
        const auto = autoAt(ti, ai)!
        if (e.altKey) {
          if (seg.kind !== 'range' || seg.k0 == null || seg.k1 == null) return
          const k0 = auto.keyframes[seg.k0], k1 = auto.keyframes[seg.k1]
          const bend0 = curveOf(k0.ease) === 'linear' ? (k0.bend ?? 0) : 0
          bendDragRef.current = { trackIdx: ti, autoIdx: ai, kfIdx: seg.k0, startY: y, bend0, dir: k1.value >= k0.value ? -1 : 1, bend: bend0, moved: false }
          return
        }
        const ends = [seg.k0, seg.k1].filter((k): k is number => k != null).map(kfIdx => ({ trackIdx: ti, autoIdx: ai, kfIdx }))
        // Inside the time selection the segment moves the selected breakpoints of its lane
        const selHere = selRef.current.filter(h => h.trackIdx === ti && h.autoIdx === ai)
        const withSel = selHere.length > 0 && ends.every(h => selHas(selHere, h))
        if (!withSel) setTimeSel(null)
        startKfDrag(withSel ? selHere : ends, null, autoLane, layout, x, y, { f, value: seg.value, option: seg.option }, withSel)
        return
      }
    }

    const clipHit = hitTestClip(x, y)
    if (clipHit && clipHit.part !== 'body') { clipMouseDown(e, clipHit, x, rawF); return }

    // Background, clip body, lane background: a drag selects time across rows, a click sets
    // the insert marker (stopped: the playhead goes there too)
    const rows = viewRows(layout)
    const ri = rowIndexAt(rows, y)
    if (ri == null) { clearSelection(); setInsertMk(null); return }
    const f = snapDrag(rawF, free).f
    const ts = timeSelRef.current, im = insertRef.current
    if (e.shiftKey && (ts || im)) {
      // Shift-click extends the selection to here, in time and across rows (Live)
      const idx = (r: Row) => rows.findIndex(v => sameRow(v.row, r))
      const baseRows = ts ? ts.rows.map(idx).filter(i => i >= 0) : [idx(im!.row)]
      const r0 = Math.min(ri, ...baseRows), r1 = Math.max(ri, ...baseRows)
      const a = Math.min(f, ts ? ts.a : im!.f), b = Math.max(f, ts ? ts.b : im!.f)
      updateClipSel([])
      if (b > a) setTimeSel({ a, b, rows: rows.slice(r0, r1 + 1).map(v => v.row) })
      return
    }
    selDragRef.current = { f0: f, row0: ri, startX: x, startY: y, moved: false }
  }, [tracks, markers, fps, pxPerFrame, scrollFrame, readOnly, laneStatus, getLayout, hitTestClip, onSelectCue, onSeek, lockEnvelopes])

  /** Mouse down on a clip's title bar or edge. */
  const clipMouseDown = (e: React.MouseEvent, hit: { trackIdx: number; cueIdx: number; part: string }, x: number, rawF: number) => {
    const lt = tracks[hit.trackIdx] as LayerTrack
    const clip = lt.clips[hit.cueIdx]
    const sf = smpteToFrames(clip.time, fps), durF = smpteToFrames(clip.duration, fps)
    setInsertMk(null)
    if (hit.part === 'left' || hit.part === 'right') {
      setTimeSel(null); updateClipSel([clip.id]); anchorCueRef.current = clip.id
      onSelectCue(hit.trackIdx, hit.cueIdx)
      if (canEdit(hit.trackIdx))
        resizeClipRef.current = { trackIdx: hit.trackIdx, cueIdx: hit.cueIdx, edge: hit.part, startX: x, moved: false, startF: sf, startDurF: durF }
      return
    }
    if (e.metaKey || e.ctrlKey) {
      // ⌘-click adds or removes a clip (Live: non-adjacent clips)
      const cur = clipSelRef.current
      const next = cur.includes(clip.id) ? cur.filter(id => id !== clip.id) : [...cur, clip.id]
      setTimeSel(null); updateClipSel(next); anchorCueRef.current = clip.id
      if (next.includes(clip.id)) onSelectCue(hit.trackIdx, hit.cueIdx)
      return
    }
    const anchor = anchorCueRef.current ? cueById(anchorCueRef.current) : null
    if (e.shiftKey && anchor) {
      // Shift-click: the clips from the last clicked one to this one, across the layers between
      const fa = smpteToFrames(anchor.cue.time, fps)
      const lo = Math.min(fa, sf)
      const hi = Math.max(fa + Math.max(1, smpteToFrames(anchor.cue.duration, fps)), sf + Math.max(1, durF))
      const layout = getLayout()
      const ids: string[] = []
      for (let ti = Math.min(anchor.trackIdx, hit.trackIdx); ti <= Math.max(anchor.trackIdx, hit.trackIdx); ti++) {
        const t = tracks[ti] as LayerTrack
        if (t.type !== 'layer' || layout[ti]?.hidden) continue
        for (const c of t.clips) {
          const cs = smpteToFrames(c.time, fps)
          if (cs < hi && cs + Math.max(1, smpteToFrames(c.duration, fps)) > lo) ids.push(c.id)
        }
      }
      setTimeSel(null); updateClipSel(ids)
      onSelectCue(hit.trackIdx, hit.cueIdx)
      return
    }
    anchorCueRef.current = clip.id
    // The title bar of a clip in the time selection drags the selection (Live)
    const ts = timeSelRef.current
    if (ts && ts.rows.some(r => !r.laneId && r.trackId === lt.id) && sf < ts.b && sf + Math.max(1, durF) > ts.a) {
      matDragRef.current = { mode: 'time', ids: [], f0: ts.a, anchorMouseF: rawF, startX: x, moved: false, df: 0, copy: false, collapse: null }
      return
    }
    const cur = clipSelRef.current
    const next = cur.includes(clip.id) ? cur : [clip.id]
    if (next !== cur) updateClipSel(next)
    setTimeSel(null)
    onSelectCue(hit.trackIdx, hit.cueIdx)
    // Touch: the whole clip is its handle, so a tap on it also marks where Split cuts
    if (TOUCH && canEdit(hit.trackIdx)) setInsertMk({ f: snapDrag(rawF, false).f, row: { trackId: lt.id } })
    const ids = next.filter(id => { const at = cueById(id); return !!at && canEdit(at.trackIdx) })
    if (!ids.length) return
    const f0 = Math.min(...ids.map(id => smpteToFrames(cueById(id)!.cue.time, fps)))
    matDragRef.current = { mode: 'cues', ids, f0, anchorMouseF: rawF, startX: x, moved: false, df: 0, copy: false, collapse: next.length > 1 ? clip.id : null }
  }

  // ── Mouse move ─────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: { clientX: number; clientY: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => {
    const { x, y } = localXY(e)
    const setCursor = (c: string) => { if (canvasRef.current) canvasRef.current.style.cursor = c }
    const free = e.metaKey || e.ctrlKey
    const rawF = x / pxPerFrame + scrollFrame

    if (isDraggingPlayhead.current) { onSeek(xToFrame(x)); return }

    if (autoResizeRef.current) {
      const rs = autoResizeRef.current
      onResizeAutoLane(rs.autoId, Math.max(MIN_AUTO_H, rs.startH + (y - rs.startY)))
      setCursor('ns-resize')
      return
    }

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      // A plain click (delete / add) must not nudge anything
      if (!kd.moved && Math.abs(x - kd.startX) < DRAG_START_PX && Math.abs(y - kd.startY) < DRAG_START_PX) return
      kd.moved = true
      // Shift: one axis, and finer values (Live); ⌘: no snapping
      kd.accY += (y - kd.lastY) * (e.shiftKey ? FINE : 1)
      kd.lastY = y
      const mx = Math.abs(x - kd.startX), my = Math.abs(y - kd.startY)
      if (!kd.axis && Math.max(mx, my) >= AXIS_LOCK_PX) kd.axis = mx >= my ? 'x' : 'y'
      const lock = kd.segment ? 'y' : e.shiftKey ? kd.axis : null
      const p = kd.primary
      if (!kd.items.length) { draw(); return }

      // Time: whole frames. Snap on: the nearest grid line, or a nearby target (marker, clip
      // edge, other key, playhead) when that is nearer. Snap off: nearby targets only.
      const rawKf = p.f0 + (lock === 'y' ? 0 : (x - kd.startX) / pxPerFrame)
      let tf = Math.round(rawKf)
      let snapF: number | null = null
      if (!free && lock !== 'y') {
        const cands = [...kd.snapTargets, Math.round(frameRef.current)]
        let best = SNAP_PX / pxPerFrame
        if (gridSnap) {
          snapF = snapToGrid(rawKf, gridSnap.stepF, gridSnap.tempo)
          best = Math.min(best, Math.abs(snapF - rawKf))
          for (const c of cands) { const d = Math.abs(c - rawKf); if (d < best) { best = d; snapF = c } }
        } else {
          // Beats of the visible bar grid (from the downbeat); none in TC mode, where no beat grid is drawn
          if (bars) cands.push(snapFrame(rawKf, bars))
          for (const c of cands) { const d = Math.abs(c - rawKf); if (d <= best) { best = d; snapF = c } }
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
      setCursor(kd.segment ? 'ns-resize' : 'crosshair')
      return
    }

    if (bendDragRef.current) {
      const bd = bendDragRef.current
      if (!bd.moved && Math.abs(y - bd.startY) < 2) return
      bd.moved = true
      bd.bend = Math.max(-1, Math.min(1, bd.bend0 + (-(y - bd.startY) / 80) * bd.dir))
      draw()
      setCursor('ns-resize')
      return
    }

    if (selDragRef.current) {
      const sd = selDragRef.current
      if (!sd.moved && Math.abs(x - sd.startX) < 3 && Math.abs(y - sd.startY) < 3) return
      sd.moved = true
      const rows = viewRows(getLayout())
      const ri = rowIndexAt(rows, y, true) ?? sd.row0
      const f = snapDrag(rawF, free).f
      const a = Math.min(sd.f0, f), b = Math.max(sd.f0, f)
      updateClipSel([]); setInsertMk(null)
      setTimeSel(b > a ? { a, b, rows: rows.slice(Math.min(sd.row0, ri), Math.max(sd.row0, ri) + 1).map(v => v.row) } : null)
      setCursor('text')
      return
    }

    if (matDragRef.current) {
      const md = matDragRef.current
      if (!md.moved && Math.abs(x - md.startX) < DRAG_START_PX) return
      md.moved = true
      // The material's start keeps its offset to the cursor; its start (and the end of dragged
      // clips, against other clips) is what snaps
      const cues = md.mode === 'cues' ? md.ids.map(cueById).filter(at => !!at) : []
      const end = Math.max(md.f0, ...cues.map(at => smpteToFrames(at!.cue.time, fps) + smpteToFrames(at!.cue.duration, fps)))
      const { f, guide } = snapDrag(md.f0 + (rawF - md.anchorMouseF), free,
        md.mode === 'cues' ? { skip: new Set(md.ids), len: end - md.f0 } : undefined)
      md.df = Math.max(-md.f0, f - md.f0)
      md.copy = e.altKey
      snapGuideRef.current = guide != null && md.f0 + md.df === f ? guide : null
      if (md.mode === 'cues') {
        ghostClipRef.current = {
          copy: md.copy,
          items: md.ids.flatMap(id => { const at = cueById(id); return at ? [{ trackIdx: at.trackIdx, cueIdx: at.cueIdx, frame: smpteToFrames(at.cue.time, fps) + md.df }] : [] }),
        }
      }
      draw()
      setCursor(md.copy ? 'copy' : 'grabbing')
      return
    }

    if (resizeClipRef.current) {
      const rs = resizeClipRef.current
      if (!rs.moved && Math.abs(x - rs.startX) < DRAG_START_PX) return
      rs.moved = true
      const end = rs.startF + rs.startDurF
      if (rs.edge === 'right') {
        // The clip end is what snaps; never shorter than one frame
        const own = (tracks[rs.trackIdx] as LayerTrack).clips[rs.cueIdx]
        const { f, guide } = snapDrag(end + (x - rs.startX) / pxPerFrame, free, { skip: new Set(own ? [own.id] : []) })
        const newDur = Math.max(1, f - rs.startF)
        snapGuideRef.current = guide != null && rs.startF + newDur === guide ? guide : null
        ghostDurRef.current = { trackIdx: rs.trackIdx, cueIdx: rs.cueIdx, durF: newDur }
      } else {
        // Left edge: the clip starts later (or earlier), its end stays; an 'edit' clip can't
        // start before its media does
        const cue = (tracks[rs.trackIdx] as LayerTrack).clips[rs.cueIdx]
        const { f, guide } = snapDrag(rs.startF + (x - rs.startX) / pxPerFrame, free, { skip: new Set(cue ? [cue.id] : []) })
        const sf = Math.max(0, Math.min(end - 1, cue ? trimStart(cue, f, fps).sf : f))
        snapGuideRef.current = guide != null && sf === guide ? guide : null
        ghostDurRef.current = { trackIdx: rs.trackIdx, cueIdx: rs.cueIdx, durF: end - sf, sf }
      }
      draw()
      setCursor('ew-resize')
      return
    }

    // Cursor feedback
    if (y < TRACKS_TOP) { setCursor('pointer'); return }
    const layout = getLayout()
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX, laneStatus)
    setHoverKf(prev => (sameKf(prev, kfHit) || (!prev && !kfHit) ? prev : kfHit))
    const ti = getTrackAtY(layout, y)
    const autoLane = getAutoLaneAt(layout, y)
    if (kfHit) { setCursor(canEditLane(kfHit.trackIdx, kfHit.autoIdx) ? 'pointer' : 'not-allowed'); return }
    if (hitTestAutoResize(layout, y)) { setCursor('ns-resize'); return }
    if (autoLane) {
      if (!canEditLane(autoLane.trackIdx, autoLane.autoIdx)) { setCursor('not-allowed'); return }
      const seg = hitSegment(x, y, autoLane.trackIdx, autoLane.autoIdx, autoLane.lane, rawF)
      setCursor(seg ? (e.altKey ? 'ns-resize' : 'pointer') : 'text')
      return
    }
    const clipHit = hitTestClip(x, y)
    setCursor(
      clipHit && clipHit.part !== 'body' ? (!canEdit(clipHit.trackIdx) ? 'not-allowed'
        : clipHit.part === 'title' ? (e.altKey ? 'copy' : 'grab') : 'ew-resize') :
      ti == null ? 'default' : 'text'
    )
  }, [draw, onSeek, onResizeAutoLane, hitTestClip, getLayout, tracks, markers, fps, bars, gridSnap?.stepF, gridSnap?.tempo, pxPerFrame, scrollFrame, readOnly, laneStatus])

  // ── Mouse up ───────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    isDraggingPlayhead.current = false
    autoResizeRef.current = null

    const kd = kfDragRef.current
    if (kd) {
      kfDragRef.current = null
      if (kd.moved && kd.items.length) {
        const moves: KeyMove[] = []
        for (const i of kd.items) {
          const auto = autoAt(i.trackIdx, i.autoIdx)
          if (!auto?.keyframes[i.kfIdx]) continue
          const m: KeyMove = { trackId: tracks[i.trackIdx].id, laneId: auto.id, kfIdx: i.kfIdx, f: i.f }
          if (i.valued && i.v !== i.v0) {
            m.value = parseFloat(i.v.toFixed(i.kind === 'range' ? 4 : 6))
            if (i.kind === 'choice' && i.opts.length) m.option = optionAt(i.v, i.opts)
          }
          moves.push(m)
        }
        if (moves.some((m, n) => m.f !== kd.items[n].f0 || m.value !== undefined)) {
          edit(t => moveKeys(t, moves, fps))
          // The time selection moves with its breakpoints
          const df = kd.primary.f - kd.primary.f0, ts = timeSelRef.current
          if (kd.withSel && ts && df) setTimeSel({ ...ts, a: ts.a + df, b: ts.b + df })
        }
      } else if (!kd.moved && kd.segment) {
        // A click on the line adds a breakpoint on it (Live)
        onAddKeyframe(kd.at.trackIdx, kd.at.autoIdx, kd.segment.f, parseFloat(kd.segment.value.toFixed(4)), kd.segment.option)
      } else if (!kd.moved && kd.primary.kfIdx >= 0) {
        // A click on a breakpoint deletes it (Live); a tap only marks it (the toolbar's Del deletes it)
        if (TOUCH) { tappedKfRef.current = kd.primary; setHoverKf(kd.primary) }
        else onDeleteKeyframe(kd.primary.trackIdx, kd.primary.autoIdx, kd.primary.kfIdx)
      }
      draw()
    }

    const bd = bendDragRef.current
    if (bd) {
      bendDragRef.current = null
      if (bd.moved) {
        // Option-drag: the segment's curvature; nearly straight = straight
        const bend = Math.abs(bd.bend) < 0.03 ? undefined : parseFloat(bd.bend.toFixed(3))
        onUpdateKeyframe(bd.trackIdx, bd.autoIdx, bd.kfIdx, { ease: 'linear', bend })
      }
      draw()
    }

    const sd = selDragRef.current
    if (sd) {
      selDragRef.current = null
      if (!sd.moved) {
        // A click: no selection, the insert marker here; stopped, the playhead too (Live)
        const row = viewRows(getLayout())[sd.row0]?.row
        clearSelection()
        // SHOW mode: nothing gets pasted, so no insert marker (it looked like a second playhead)
        setInsertMk(row && !readOnly ? { f: sd.f0, row } : null)
        if (!playing) onSeek(sd.f0)
      }
    }

    const md = matDragRef.current
    if (md) {
      matDragRef.current = null
      ghostClipRef.current = null
      snapGuideRef.current = null
      if (md.moved && (md.df !== 0 || md.copy) && !readOnly) {
        if (md.mode === 'cues') {
          // Selected clips (with their lanes and, unlocked, the automation under them)
          const at = md.f0 + md.df
          const r = edit((t, c) => {
            const mat = extractCues(t, md.ids, c)
            return md.copy ? pasteMaterial(t, mat, at, c)
              : pasteMaterial(deleteCues(t, md.ids, c), mat, at, c, { keepIds: true, moveFrom: md.f0 })
          })
          if (md.copy && r.ids.length) updateClipSel(r.ids)
        } else {
          const ts = timeSelRef.current
          const rows = ts ? editableRows(ts.rows) : []
          if (ts && rows.length) {
            const sel2 = { ...ts, rows }
            edit((t, c) => {
              const mat = extractTime(t, sel2, c)
              return md.copy ? pasteMaterial(t, mat, ts.a + md.df, c)
                : pasteMaterial(deleteTime(t, sel2, c), mat, ts.a + md.df, c, { moveFrom: ts.a })
            })
            setTimeSel({ ...sel2, a: ts.a + md.df, b: ts.b + md.df })
          }
        }
      } else if (!md.moved && md.collapse) {
        updateClipSel([md.collapse])
      }
      draw()
    }

    const rs = resizeClipRef.current, gd = ghostDurRef.current
    resizeClipRef.current = null
    ghostDurRef.current = null
    if (rs && gd) {
      snapGuideRef.current = null
      const trackId = tracks[rs.trackIdx]?.id
      const cueId = (tracks[rs.trackIdx] as LayerTrack | undefined)?.clips[rs.cueIdx]?.id
      if (rs.edge === 'right' && gd.durF !== rs.startDurF) {
        onUpdateCue(rs.trackIdx, rs.cueIdx, { duration: framesToSmpte(gd.durF, fps) })
      } else if (rs.edge === 'left' && gd.sf != null && gd.sf !== rs.startF && trackId && cueId) {
        // Start trimmed: the clip and its lanes stay where they are on the timeline
        const sf = gd.sf, dur = gd.durF
        edit(t => t.map(tr => tr.id !== trackId || tr.type !== 'layer' ? tr : {
          ...tr,
          clips: (tr as LayerTrack).clips
            .map(c => c.id === cueId ? { ...trimStart(c, sf, fps).cue, time: framesToSmpte(sf, fps), duration: framesToSmpte(dur, fps) } : c)
            .sort((p, q) => smpteToFrames(p.time, fps) - smpteToFrames(q.time, fps)),
        }))
      }
      draw()
    }
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }, [onUpdateCue, onAddKeyframe, onDeleteKeyframe, onUpdateKeyframe, onEditTracks, onSeek, fps, tracks, tracksProp, draw, playing, readOnly, lockEnvelopes, getLayout])

  // While a drag is active, follow the mouse on the window so leaving the canvas
  // neither drops nor freezes the drag.
  const dragHandlersRef = useRef({ move: handleMouseMove, up: handleMouseUp })
  dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp }
  const isDragging = () => !!(isDraggingPlayhead.current || autoResizeRef.current || kfDragRef.current ||
    bendDragRef.current || selDragRef.current || matDragRef.current || resizeClipRef.current)

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') { touchRef.current.down(e); return }
    handleMouseDown(e)
    if (!isDragging()) return
    const move = (ev: PointerEvent) => dragHandlersRef.current.move(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragHandlersRef.current.up()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [handleMouseDown])

  // ── Touch ──────────────────────────────────────────────────────────────────
  // One finger does what the mouse does (wider tap slop); two fingers pan (both ways) and pinch
  // to zoom; a long press opens the right-click menu; a double tap is a double-click. While clips
  // picked in the browser are being placed, a tap on their layer drops them there.
  // The toolbar's row above the timeline (App renders it, touch only)
  const [toolSlot, setToolSlot] = useState<HTMLElement | null>(null)
  useEffect(() => { if (TOUCH) setToolSlot(document.getElementById('touch-edit-slot')) }, [])
  const fingersRef = useRef(new Map<number, { x: number; y: number }>())
  // Zoom and scroll as the gesture has set them: a touch screen sends both fingers' moves within
  // one frame, before React re-renders with the new props
  const pressRef = useRef<{ id: number; x: number; y: number; moved: boolean; long: boolean; timer: number | null; pan?: { x: number; y: number }; scrollOnly?: boolean } | null>(null)
  const viewRef = useRef({ ppf: pxPerFrame, scroll: scrollFrame, y: scrollY })
  if (fingersRef.current.size < 2 && !pressRef.current?.pan) viewRef.current = { ppf: pxPerFrame, scroll: scrollFrame, y: scrollY }
  // Touch: the key tapped last (the toolbar's Del deletes it)
  const tappedKfRef = useRef<KfHit | null>(null)
  const pinchRef = useRef<{ cx: number; cy: number; dist: number } | null>(null)

  // How far the lanes can scroll: their full height against the space under the ruler
  const contentH = (() => {
    const lay = buildLayout(tracks, clipH, autoH, 0).filter(l => !l.hidden)
    const last = lay[lay.length - 1]
    return last ? last.y + last.totalH - TRACKS_TOP : 0
  })()
  const viewH = Math.max(0, (containerRef.current?.clientHeight ?? 0) - TRACKS_TOP)
  const maxScrollY = Math.max(0, contentH - viewH)
  const clampScrollY = (y: number) => Math.round(Math.max(0, Math.min(maxScrollY, y)))
  // Touch tool: Scroll (default; one finger pans everywhere, a tap selects / seeks, nothing is
  // moved by accident) or Edit (one finger edits as the mouse does). SHOW mode always scrolls.
  const [touchTool, setTouchToolState] = useState<'scroll' | 'edit'>(() => {
    try { return localStorage.getItem(TOUCH_TOOL_KEY) === 'edit' ? 'edit' : 'scroll' } catch { return 'scroll' }
  })
  const setTouchTool = (t: 'scroll' | 'edit') => { setTouchToolState(t); try { localStorage.setItem(TOUCH_TOOL_KEY, t) } catch { /* ignore */ } }
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)

  /** Drops whatever one finger started (a second finger turned it into a pan / pinch). */
  const abortDrag = () => {
    isDraggingPlayhead.current = false
    autoResizeRef.current = null; kfDragRef.current = null; bendDragRef.current = null
    selDragRef.current = null; matDragRef.current = null; resizeClipRef.current = null
    ghostClipRef.current = null; ghostDurRef.current = null; snapGuideRef.current = null
    draw()
  }

  const fingers = () => {
    const [a, b] = [...fingersRef.current.values()]
    const { x, y } = localXY({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 })
    return { cx: x, cy: y, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
  }

  const fakeMouse = (x: number, y: number) =>
    ({ clientX: x, clientY: y, button: 0, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false,
      preventDefault() {}, stopPropagation() {} }) as unknown as React.MouseEvent

  const touchDown = (e: React.PointerEvent) => {
    e.preventDefault()   // no emulated mouse events after it (they would repeat the gesture)
    const first = fingersRef.current.size === 0
    fingersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (first) { tappedKfRef.current = null; setHoverKf(null) }
    if (first) {
      window.addEventListener('pointermove', touchMoveWin)
      window.addEventListener('pointerup', touchUpWin)
      window.addEventListener('pointercancel', touchUpWin)
    }
    if (fingersRef.current.size === 2) {
      // Second finger: pan / pinch from here on, whatever the first one had started is dropped
      const p = pressRef.current
      if (p?.timer) clearTimeout(p.timer)
      pressRef.current = null
      abortDrag()
      pinchRef.current = fingers()
      viewRef.current = { ppf: pxPerFrame, scroll: scrollFrame, y: scrollY }
      return
    }
    if (fingersRef.current.size > 2) return
    // Scroll tool: one finger below the ruler only pans; the ruler / audio lane still scrub
    const scrollOnly = (readOnly || touchTool === 'scroll') && localXY(e).y >= TRACKS_TOP
    const press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, long: false, timer: null as number | null, scrollOnly }
    pressRef.current = press
    if (placing) return   // the tap drops the clips (on lift)
    press.timer = window.setTimeout(() => {
      press.timer = null
      if (press.moved || pressRef.current !== press) return
      press.long = true
      abortDrag()
      handleContextMenu(fakeMouse(press.x, press.y))
    }, LONG_PRESS_MS)
    if (!scrollOnly) handleMouseDown(e)
  }

  const touchMove = (ev: PointerEvent) => {
    if (!fingersRef.current.has(ev.pointerId)) return
    fingersRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    if (pinchRef.current && fingersRef.current.size >= 2) {
      // Both fingers' moves arrive one by one; once per frame, with both of them moved, so
      // half a move never reads as a pinch
      if (!pinchRafRef.current) pinchRafRef.current = requestAnimationFrame(() => { pinchRafRef.current = 0; touchRef.current.pinch() })
      return
    }
    const p = pressRef.current
    if (!p || p.id !== ev.pointerId || p.long) return
    if (!p.moved && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) >= DRAG_START_PX) {
      p.moved = true
      if (p.timer) { clearTimeout(p.timer); p.timer = null }
      // One finger on the empty background drags the view (a tablet has no wheel); the time
      // selection it would start with a mouse is dropped
      if (p.scrollOnly || selDragRef.current || !isDragging()) { selDragRef.current = null; p.pan = { x: ev.clientX, y: ev.clientY }; draw() }
    }
    if (p.pan) {
      const view = viewRef.current
      const scroll = Math.max(0, view.scroll - (ev.clientX - p.pan.x) / view.ppf)
      if (scroll !== view.scroll) onScrollFrame(scroll)
      const y = clampScrollY(view.y + p.pan.y - ev.clientY)
      if (y !== view.y) onScrollYTo(y)
      viewRef.current = { ...view, scroll, y }
      p.pan = { x: ev.clientX, y: ev.clientY }
      return
    }
    if (!placing) dragHandlersRef.current.move(ev)
  }

  const pinchMove = () => {
    const pinch = pinchRef.current
    if (pinch && fingersRef.current.size >= 2) {
      // Pan and zoom in one: the frame under the fingers' midpoint stays under it
      const now = fingers(), view = viewRef.current
      const zoom = now.dist / pinch.dist
      const ppf = Math.abs(zoom - 1) > 0.01 ? Math.max(PPF_MIN, Math.min(PPF_MAX, view.ppf * zoom)) : view.ppf
      if (ppf !== view.ppf) onZoom(ppf / view.ppf)
      const scroll = Math.max(0, pinch.cx / view.ppf + view.scroll - now.cx / ppf)
      if (scroll !== view.scroll) onScrollFrame(scroll)
      const y = clampScrollY(view.y + pinch.cy - now.cy)
      if (y !== view.y) onScrollYTo(y)
      viewRef.current = { ppf, scroll, y }
      pinchRef.current = ppf !== view.ppf ? now : { ...now, dist: pinch.dist }
    }
  }

  const touchUp = (ev: PointerEvent) => {
    if (!fingersRef.current.delete(ev.pointerId)) return
    if (fingersRef.current.size === 0) {
      window.removeEventListener('pointermove', touchMoveWin)
      window.removeEventListener('pointerup', touchUpWin)
      window.removeEventListener('pointercancel', touchUpWin)
    }
    if (pinchRef.current) { if (fingersRef.current.size < 2) pinchRef.current = null; return }
    const p = pressRef.current
    if (!p || p.id !== ev.pointerId) return
    pressRef.current = null
    if (p.timer) clearTimeout(p.timer)
    if (ev.type === 'pointercancel' || p.long) { abortDrag(); return }
    if (placing) { if (!p.moved) placeAt(ev); return }
    if (p.pan) { lastTapRef.current = null; return }
    // Scroll tool: a tap does what a click does (select a clip, set the insert marker / playhead)
    if (p.scrollOnly) handleMouseDown(fakeMouse(ev.clientX, ev.clientY))
    dragHandlersRef.current.up()
    if (p.moved) { lastTapRef.current = null; return }
    const last = lastTapRef.current, t = performance.now()
    if (last && t - last.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < DOUBLE_TAP_PX) {
      lastTapRef.current = null
      handleDblClick(fakeMouse(ev.clientX, ev.clientY))
    } else lastTapRef.current = { t, x: ev.clientX, y: ev.clientY }
  }

  // Clips picked in the browser go where the layer was tapped (their own layer only)
  const placeAt = (ev: { clientX: number; clientY: number }) => {
    if (!placing?.length) return
    const { x, y } = localXY(ev)
    const ti = getTrackAtY(getLayout(), y)
    const lt = ti != null ? tracks[ti] as LayerTrack : null
    if (ti == null || lt?.type !== 'layer' || lt.resolumeLayerId !== placing[0].layerId || !canEdit(ti)) return
    onDropClip(ti, snapDrag(x / pxPerFrame + scrollFrame, false, {}).f, placing)
    onPlaced()
  }

  // Window listeners call the newest handlers (they close over props that change while dragging)
  const pinchRafRef = useRef(0)
  const touchRef = useRef({ down: touchDown, move: touchMove, up: touchUp, pinch: pinchMove })
  touchRef.current = { down: touchDown, move: touchMove, up: touchUp, pinch: pinchMove }
  const touchMoveWin = useRef((ev: PointerEvent) => touchRef.current.move(ev)).current
  const touchUpWin = useRef((ev: PointerEvent) => touchRef.current.up(ev)).current

  // ── Double click ───────────────────────────────────────────────────────────
  // Lane background: a breakpoint (Live). Option + double-click on a segment: straight again.

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    const { x, y } = localXY(e)
    const layout = getLayout()
    const info = getAutoLaneAt(layout, y)
    if (!info || !canEditLane(info.trackIdx, info.autoIdx)) return
    if (hitTestKeyframe(x, y, layout, tracks, fps, frameToX, laneStatus)) return
    const rawF = x / pxPerFrame + scrollFrame
    const seg = hitSegment(x, y, info.trackIdx, info.autoIdx, info.lane, rawF)
    if (seg) {
      if (e.altKey && seg.k0 != null) onUpdateKeyframe(info.trackIdx, info.autoIdx, seg.k0, { ease: 'linear', bend: undefined })
      return   // a click on the line already added a breakpoint
    }
    const auto = autoAt(info.trackIdx, info.autoIdx)!
    const kind = laneKind(auto)
    const opts = laneRange(auto, laneStatus[auto.id]).options ?? []
    const raw = kfFromY(info.lane, y)
    // Time snaps to the grid (⌘ = exactly under the cursor)
    const at = snapDrag(rawF, e.metaKey || e.ctrlKey).f
    clearSelection()
    if (kind === 'range') {
      onAddKeyframe(info.trackIdx, info.autoIdx, at, parseFloat(raw.toFixed(3)))
    } else {
      // Choice: nearest option step (and its name); boolean: upper half = On
      const value = snapValue(kind, raw, opts.length)
      onAddKeyframe(info.trackIdx, info.autoIdx, at, parseFloat(value.toFixed(6)),
        kind === 'choice' ? optionAt(value, opts) : undefined)
    }
  }, [getLayout, onAddKeyframe, onUpdateKeyframe, fps, markers, gridSnap?.stepF, gridSnap?.tempo, pxPerFrame, scrollFrame, readOnly, tracks, laneStatus])

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
      // Right-click inside the selection edits all of it; outside, just this key
      if (!selHas(selRef.current, kfHit)) setTimeSel(null)
      setHoverKf(null)
      setClipColorPicker(null)
      return
    }
    if (kfHit) return
    const clipHit = hitTestClip(x, y)
    if (clipHit && canEdit(clipHit.trackIdx)) {
      setClipColorPicker({ x, y, trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx, frame: xToFrame(x) })
      setContextMenu(null)
    }
  }, [tracks, fps, readOnly, laneStatus, getLayout, hitTestClip, tempo, scrollFrame, pxPerFrame])

  // ── Keyboard: edits on the selection (Live's Edit menu) ────────────────────
  // Capture phase on window, so Delete/Backspace never also reaches the App.

  /** Rows of a selection that can be edited (not locked, lanes not broken). */
  const editableRows = (rows: Row[]) => rows.filter(r => {
    const ti = tracks.findIndex(t => t.id === r.trackId)
    if (ti < 0 || !canEdit(ti)) return false
    if (!r.laneId) return true
    const ai = (tracks[ti] as LayerTrack).automations.findIndex(a => a.id === r.laneId)
    return ai >= 0 && canEditLane(ti, ai)
  })
  const editableCues = () => clipSelRef.current.filter(id => { const at = cueById(id); return !!at && canEdit(at.trackIdx) })
  const noIds: EditCtx['newId'] = p => p
  /** Where the selected clips start. */
  const cuesStart = (ids: string[]) => Math.min(...ids.map(id => smpteToFrames(cueById(id)!.cue.time, fps)))

  const copySel = (): boolean => {
    const ts = timeSelRef.current
    const ctx = { fps, lockEnvelopes, newId: noIds }
    if (ts) { clipboard = extractTime(tracksProp, ts, ctx); return true }
    if (clipSelRef.current.length) { clipboard = extractCues(tracksProp, clipSelRef.current, ctx); return true }
    return false
  }
  const deleteSel = (): boolean => {
    const ts = timeSelRef.current
    if (ts) {
      const rows = editableRows(ts.rows)
      if (rows.length) edit((t, c) => deleteTime(t, { ...ts, rows }, c))
      return true
    }
    const ids = editableCues()
    if (!ids.length) return false
    edit((t, c) => deleteCues(t, ids, c))
    updateClipSel([])
    return true
  }
  const pasteSel = (): boolean => {
    const mat = clipboard
    if (!mat || readOnly || isEmptyMaterial(mat)) return false
    const ts = timeSelRef.current, im = insertRef.current
    const at = ts ? ts.a : im ? im.f : Math.max(0, Math.round(frameRef.current))
    // One lane of material goes onto the lane picked, whatever parameter it drives: the
    // same curve there (values converted to that lane's kind)
    const pick = ts?.rows.find(r => r.laneId)?.laneId ?? im?.row.laneId ?? focusLaneRef.current
    const target = !mat.clips.length && mat.lanes.length === 1 && pick ? findLane(tracks, pick) : null
    // The lane picked can't take it (locked, no target in Resolume): nothing, not somewhere else
    if (target && !canEditLane(target.trackIdx, target.autoIdx)) return true
    const laneTarget = target ? {
      trackId: tracks[target.trackIdx].id, laneId: target.auto.id, kind: laneKind(target.auto),
      options: laneRange(target.auto, laneStatus[target.auto.id]).options ?? [],
    } : undefined
    if (!laneTarget && !editableRows([...mat.clips.map(c => ({ trackId: c.trackId })), ...mat.lanes.map(l => ({ trackId: l.trackId, laneId: l.laneId }))]).length) return true
    const r = edit((t, c) => pasteMaterial(t, mat, at, c, { laneTarget }))
    // What was pasted becomes the selection
    if (mat.kind === 'time') {
      setTimeSel({ a: at, b: at + mat.len, rows: laneTarget ? [{ trackId: laneTarget.trackId, laneId: laneTarget.laneId }] : mat.rows })
      updateClipSel([])
    } else { setTimeSel(null); updateClipSel(r.ids) }
    setInsertMk(null)
    return true
  }
  // ⌘D: a copy right after the selection, which becomes the selection (Live)
  const duplicateSel = (): boolean => {
    if (readOnly) return false
    const ts = timeSelRef.current
    if (ts) {
      const rows = editableRows(ts.rows)
      if (!rows.length) return true
      const sel2 = { ...ts, rows }
      edit((t, c) => pasteMaterial(t, extractTime(t, sel2, c), ts.b, c))
      setTimeSel({ a: ts.b, b: ts.b + (ts.b - ts.a), rows })
      return true
    }
    const ids = editableCues()
    if (!ids.length) return false
    const f0 = cuesStart(ids)
    const r = edit((t, c) => { const m = extractCues(t, ids, c); return pasteMaterial(t, m, f0 + m.len, c) })
    updateClipSel(r.ids)
    return true
  }
  // ⌘E: split the clips at the insert marker, or at the edges of the time selection
  const splitSel = (): boolean => {
    if (readOnly) return false
    const ts = timeSelRef.current, im = insertRef.current
    const ids = ts ? editableRows(ts.rows).filter(r => !r.laneId).map(r => r.trackId)
      : im && !im.row.laneId ? editableRows([im.row]).map(r => r.trackId) : []
    if (!ids.length) return false
    edit((t, c) => {
      if (!ts) return splitAt(t, ids, im!.f, c)
      const r1 = splitAt(t, ids, ts.a, c), r2 = splitAt(r1.tracks, ids, ts.b, c)
      return { tracks: r2.tracks, ids: [...r1.ids, ...r2.ids] }
    })
    return true
  }
  // ⌘A: everything, as a time selection over every row
  const selectAll = (): boolean => {
    let end = 0
    for (const t of tracksProp) {
      if (t.type !== 'layer' && t.type !== 'group') continue
      for (const c of (t as LayerTrack).clips ?? []) end = Math.max(end, smpteToFrames(c.time, fps) + Math.max(1, smpteToFrames(c.duration, fps)))
      for (const a of (t as LayerTrack).automations) for (const k of a.keyframes) end = Math.max(end, smpteToFrames(k.time, fps) + 1)
    }
    if (!end) return false
    updateClipSel([]); setInsertMk(null)
    setTimeSel({ a: 0, b: end, rows: viewRows(getLayout()).map(v => v.row) })
    return true
  }
  // Arrows (Live): ← → nudge the selection by the grid (Shift: lengthen / shorten it), or
  // move the insert marker; ↑ ↓ move the selection / insert marker to the next row
  const arrowKey = (key: string, shift: boolean): boolean => {
    const ts = timeSelRef.current, im = insertRef.current
    const step = Math.max(1, Math.round(gridSnap?.stepF ?? 1))
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const d = key === 'ArrowRight' ? step : -step
      if (ts) {
        if (shift) { const b = Math.max(ts.a + 1, ts.b + d); setTimeSel({ ...ts, b }); return true }
        if (readOnly) return true
        const df = Math.max(-ts.a, d)
        const rows = editableRows(ts.rows)
        if (!df || !rows.length) return true
        const sel2 = { ...ts, rows }
        if (rows.every(r => r.laneId)) {
          // Only lanes: the selected breakpoints move, as when dragged (no edge breakpoints)
          const moves: KeyMove[] = []
          for (const r of rows) {
            const at = findLane(tracks, r.laneId!)
            if (at) keysIn(at.auto, ts.a, ts.b, fps).forEach(kfIdx => moves.push({
              trackId: r.trackId, laneId: r.laneId!, kfIdx, f: smpteToFrames(at.auto.keyframes[kfIdx].time, fps) + df,
            }))
          }
          if (moves.length) edit(t => moveKeys(t, moves, fps))
        } else {
          edit((t, c) => pasteMaterial(deleteTime(t, sel2, c), extractTime(t, sel2, c), ts.a + df, c, { moveFrom: ts.a }))
        }
        setTimeSel({ ...sel2, a: ts.a + df, b: ts.b + df })
        return true
      }
      const ids = editableCues()
      if (ids.length) {
        if (readOnly) return true
        const f0 = cuesStart(ids), df = Math.max(-f0, d)
        if (df) edit((t, c) => pasteMaterial(deleteCues(t, ids, c), extractCues(t, ids, c), f0 + df, c, { keepIds: true, moveFrom: f0 }))
        return true
      }
      if (im) {
        const f = Math.max(0, im.f + d)
        setInsertMk({ ...im, f })
        if (!playing) onSeek(f)
        return true
      }
      return false
    }
    // Up / down: the next row
    const rows = viewRows(getLayout())
    const d = key === 'ArrowDown' ? 1 : -1
    if (ts) {
      const idx = ts.rows.map(r => rows.findIndex(v => sameRow(v.row, r))).filter(i => i >= 0)
      if (!idx.length) return false
      const lo = Math.min(...idx), hi = Math.max(...idx)
      const [nlo, nhi] = shift ? (d > 0 ? [lo, Math.min(rows.length - 1, hi + 1)] : [Math.max(0, lo - 1), hi])
        : [Math.max(0, Math.min(rows.length - 1 - (hi - lo), lo + d)), 0]
      const end = shift ? nhi : nlo + (hi - lo)
      setTimeSel({ ...ts, rows: rows.slice(nlo, end + 1).map(v => v.row) })
      return true
    }
    if (im) {
      const i = rows.findIndex(v => sameRow(v.row, im.row))
      const n = Math.max(0, Math.min(rows.length - 1, i + d))
      if (rows[n]) setInsertMk({ ...im, row: rows[n].row })
      return true
    }
    return false
  }

  const keyStateRef = useRef({ copySel, deleteSel, pasteSel, duplicateSel, splitSel, selectAll, arrowKey, canEditLane, onUpdateKeyframes })
  keyStateRef.current = { copySel, deleteSel, pasteSel, duplicateSel, splitSel, selectAll, arrowKey, canEditLane, onUpdateKeyframes }

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const s = keyStateRef.current
      const mod = e.metaKey || e.ctrlKey
      const swallow = () => { e.preventDefault(); e.stopPropagation() }

      if (mod && !e.altKey && !e.shiftKey) {
        if (e.code === 'KeyC') { if (s.copySel()) swallow(); return }
        if (e.code === 'KeyX') { if (s.copySel()) { swallow(); s.deleteSel() } return }
        if (e.code === 'KeyV') { if (s.pasteSel()) swallow(); return }
        if (e.code === 'KeyD') { swallow(); s.duplicateSel(); return }   // (never the browser's bookmark)
        if (e.code === 'KeyA') { if (s.selectAll()) swallow(); return }
        if (e.code === 'KeyE') { if (s.splitSel()) swallow(); return }
      }
      if (e.key === 'Escape') {
        if (timeSelRef.current || clipSelRef.current.length || insertRef.current) {
          swallow(); setTimeSel(null); updateClipSel([]); setInsertMk(null); setContextMenu(null)
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (!mod && s.deleteSel()) swallow(); return }
      if (e.key.startsWith('Arrow') && !mod && !e.altKey) { if (s.arrowKey(e.key, e.shiftKey)) swallow(); return }
      if ((e.key === 'e' || e.key === 'E') && !mod && !e.altKey) {
        // E cycles the curve of the selected breakpoints; a Resolume family curve moves on to Linear
        const targets = selRef.current.filter(h => {
          const a = autoAt(h.trackIdx, h.autoIdx)
          return a && laneKind(a) === 'range' && a.keyframes[h.kfIdx] && s.canEditLane(h.trackIdx, h.autoIdx)
        })
        if (!targets.length) return
        swallow()
        const first = autoAt(targets[0].trackIdx, targets[0].autoIdx)!.keyframes[targets[0].kfIdx]
        const cur = (BASIC_CURVES as readonly string[]).indexOf(curveOf(first.ease))
        const next = BASIC_CURVES[(cur + 1) % BASIC_CURVES.length]
        s.onUpdateKeyframes(targets.map(h => ({ ...kfRef(h), updates: { ease: next, bend: undefined } })))
      }
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [])

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const dropTrackAt = (e: React.DragEvent) => getTrackAtY(getLayout(), localXY(e).y)

  // Drop position: the clip starts at the cursor, snapped like a clip move (⌘ = free)
  const dropFrameAt = (e: React.DragEvent) => snapDrag(localXY(e).x / pxPerFrame + scrollFrame, e.metaKey || e.ctrlKey, {})
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
      const parsed: DragClipData | DragClipData[] = JSON.parse(raw)
      const clips = Array.isArray(parsed) ? parsed : [parsed]
      const ti = dropTrackAt(e)
      if (ti != null && canEdit(ti) && clips.length) onDropClip(ti, dropFrameAt(e).f, clips)
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
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={e => { if (e.pointerType !== 'touch' && !isDragging()) handleMouseMove(e) }}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => { if (!isDragging()) setHoverKf(null) }}
      />
      <canvas ref={overlayRef} className="timeline-overlay" />

      {TOUCH && maxScrollY > 0 && (
        // Touch: the lanes' position, and a thumb to drag them by (there is no wheel)
        <VScroll top={TRACKS_TOP} viewH={viewH} contentH={contentH} scrollY={Math.min(scrollY, maxScrollY)}
          onScrollYTo={y => onScrollYTo(clampScrollY(y))} />
      )}
      {TOUCH && placing && (
        <div className="touch-banner">
          <span>Tap layer {placing[0].layerIndex} where {placing.length === 1 ? `"${placing[0].clipName}" goes` : `the ${placing.length} clips go (one after another)`}</span>
          <button className="btn" onClick={onPlaced}>Cancel</button>
        </div>
      )}
      {TOUCH && toolSlot && createPortal(
        // Touch: the edit commands that are keyboard shortcuts with a mouse, in a fixed row above
        // the timeline (not over it)
        <div className="touch-tools" onPointerDown={e => e.stopPropagation()}>
          {!readOnly && <>
            <div className="seg touch-tool" role="group" aria-label="One finger">
              <button className={`seg-btn${touchTool === 'scroll' ? ' on' : ''}`} onClick={() => setTouchTool('scroll')}
                title="One finger scrolls the timeline; a tap selects a clip or moves the playhead. Nothing moves by accident.">Scroll</button>
              <button className={`seg-btn${touchTool === 'edit' ? ' on' : ''}`} onClick={() => setTouchTool('edit')}
                title="One finger edits: move and trim clips, drag keys, select time">Edit</button>
            </div>
            <span className="touch-sep" />
            <button className="btn" title="Undo (⌘Z)" onClick={() => onUndo(false)}>Undo</button>
            <button className="btn" title="Redo (⌘⇧Z)" onClick={() => onUndo(true)}>Redo</button>
            <span className="touch-sep" />
            <button className="btn" title="Split at the insert marker (tap a clip first; ⌘E)" onClick={() => keyStateRef.current.splitSel()}>Split</button>
            <button className="btn" title="Duplicate the selection (⌘D)" onClick={() => keyStateRef.current.duplicateSel()}>Dup</button>
            <button className="btn" title="Copy (⌘C)" onClick={() => keyStateRef.current.copySel()}>Copy</button>
            <button className="btn" title="Paste at the insert marker (⌘V)" onClick={() => keyStateRef.current.pasteSel()}>Paste</button>
            <button className="btn danger-text" title="Delete the tapped key, or the selection (⌫)" onClick={() => {
              const k = tappedKfRef.current
              if (k) { tappedKfRef.current = null; setHoverKf(null); onDeleteKeyframe(k.trackIdx, k.autoIdx, k.kfIdx) }
              else keyStateRef.current.deleteSel()
            }}>Del</button>
          </>}
          <span className="touch-spacer" />
          <span className="touch-label">Zoom</span>
          <button className="btn" title="Zoom out" onClick={() => onZoom(1 / 1.5)}>−</button>
          <button className="btn" title="Zoom in" onClick={() => onZoom(1.5)}>+</button>
          <span className="touch-sep" />
          <span className="touch-label">Rows</span>
          <button className="btn" title="Every layer and lane shorter" onClick={() => onScaleRows(1 / 1.3)}>−</button>
          <button className="btn" title="Every layer and lane taller (see the curves)" onClick={() => onScaleRows(1.3)}>+</button>
        </div>,
        toolSlot,
      )}

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
            style={{ ...clampPos(contextMenu.x, contextMenu.y, 260, kind === 'range' ? 400 : 210), maxHeight: (containerRef.current?.clientHeight ?? 600) - 8, overflowY: 'auto' }}
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
                  autoFocus={!TOUCH}
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
                  autoFocus={!TOUCH}
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
          style={{ ...clampPos(clipColorPicker.x, clipColorPicker.y, 240, 500), maxHeight: (containerRef.current?.clientHeight ?? 600) - 8, overflowY: 'auto' }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">{pickerClip ? pickerClip.clipName || `Clip ${pickerClip.clipIndex}` : 'Clip'}</div>
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
              <div className="ctx-row">
                <label>Fade</label>
                <div className="ctx-seg">
                  {fadeBtn('in', 'In')}{fadeBtn('out', 'Out')}{fadeBtn('inout', 'In + Out')}
                </div>
              </div>
              {fadeWhy && <div className="ctx-note">{fadeWhy}</div>}
              {(() => {
                // Crossfade with an overlapping clip on another layer (the top clip fades)
                const partners = crossfadePartners(tracks, cue.id, fps)
                if (!partners.length) return null
                return partners.slice(0, 3).map(p => (
                  <button key={p.cue.id} className="ctx-btn" disabled={!editable}
                    title={`Blend over the overlap: the clip on the higher layer gets an opacity fade (keyframes you can edit), the lower one stays at full opacity`}
                    onClick={() => { onCrossfade(cue.id, p.cue.id); close() }}
                  >Crossfade with {p.cue.clipName || `Clip ${p.cue.clipIndex}`} · {p.layerName}</button>
                ))
              })()}
              <div className="ctx-divider" />
              <button className="ctx-btn" disabled={!editable}
                title={cue.follow === false
                  ? 'Runs free in Resolume: Stop doesn\'t pause it, scrubbing doesn\'t move it (backgrounds, loops). Click to follow the playhead again.'
                  : 'Follows the playhead: Stop pauses it on the playhead\'s frame, Play and scrubbing move it. Click to let it run free (backgrounds, loops).'}
                onClick={() => { onUpdateCue(ti, ci, { follow: cue.follow === false ? undefined : false }); close() }}
              >{cue.follow === false ? '○' : '✓'} Follow playhead</button>
              <div className="ctx-row" title="Loop: the clip always starts at the media's start, trimming the start doesn't move the picture (VJ loops). Edit: like an editor, trimming the start or splitting cuts into the media, the picture stays where it is on the timeline.">
                <label>Trim</label>
                <div className="ctx-seg">
                  {(['loop', 'edit'] as const).map(m => (
                    <button key={m} className={`ctx-seg-btn${(cue.trim ?? 'loop') === m ? ' on' : ''}`} disabled={!editable}
                      onClick={() => onUpdateCue(ti, ci, trimModeFields(m))}
                    >{m === 'loop' ? 'Loop' : 'Edit'}</button>
                  ))}
                </div>
              </div>
              {(() => {
                // Split where the clip was right-clicked (⌘E splits at the insert marker)
                const f = clipColorPicker.frame, sf = smpteToFrames(cue.time, fps), dur = smpteToFrames(cue.duration, fps)
                const inside = dur > 0 && f > sf && f < sf + dur
                return (
                  <button className="ctx-btn" disabled={!editable || !inside}
                    title={cue.trim === 'edit'
                      ? 'Split the clip here: the right part carries on the picture from this point (move it anywhere, it keeps playing from the cut)'
                      : 'Split the clip here: both parts start at the media\'s start (Loop)'}
                    onClick={() => { edit((t, c) => splitAt(t, [lt.id], f, c)); close() }}
                  >Split here · {framesToSmpte(f, fps)}</button>
                )
              })()}
              <div className="ctx-divider" />
              <button className="ctx-btn" disabled={!editable || !bound}
                title={bound ? 'Copy every lane that follows this clip, keyframes relative to its start' : 'No automation lanes follow this clip'}
                onClick={() => { onCopyClipAutomation(ti, ci); close() }}
              >Copy clip automation{bound ? ` (${bound})` : ''}</button>
              <button className="ctx-btn" disabled={!editable || !canPasteClipAutomation}
                title={canPasteClipAutomation ? 'Paste the copied lanes onto this clip, from its start' : 'Copy a clip\'s automation first'}
                onClick={() => { onPasteClipAutomation(ti, ci); close() }}
              >Paste clip automation</button>
              <button className="ctx-btn" disabled={!editable || !laneClipboard}
                title={laneClipboard ? `Paste the copied lane onto this clip, from its start` : 'Copy a lane first: right-click its header › Copy lane'}
                onClick={() => { onPasteLaneOnCue(ti, ci); close() }}
              >{laneClipboard ? `Paste lane: ${laneClipboard}` : 'Paste lane'}</button>
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
// Without a drag in progress the spans only change with the clips (never changed in place)
const spanCache = new WeakMap<ClipCue[], { fps: number; spans: ClipSpan[] }>()
function clipSpans(
  lt: LayerTrack, fps: number,
  ghostMove: Map<number, number> | null,   // cue index → start frame while dragged
  ghostDur: { cueIdx: number; durF: number } | null,
): ClipSpan[] {
  const cacheable = !ghostMove?.size && !ghostDur
  const hit = cacheable ? spanCache.get(lt.clips) : undefined
  if (hit && hit.fps === fps) return hit.spans
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
  if (cacheable) spanCache.set(lt.clips, { fps, spans })
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
/** Resolume's layer transition at a clip start: a low wedge along the bottom of the body (the
 *  clip blending in), kept small so it doesn't read as an opacity curve or cover the text. */
function drawTransitionRamp(ctx: CanvasRenderingContext2D, x: number, top: number, w: number, h: number) {
  const wh = Math.min(7, Math.floor(h * 0.3))
  if (w < 3 || wh < 3) return
  const bottom = top + h
  ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x + w, bottom); ctx.lineTo(x + w, bottom - wh); ctx.closePath()
  ctx.fillStyle = rgba(T.next, 0.45); ctx.fill()
}

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

/** Touch: a vertical scrollbar over the timeline's right edge. Drag the thumb, or tap the track
 *  to page. Pointer-captured, so the finger can leave the bar. */
function VScroll({ top, viewH, contentH, scrollY, onScrollYTo }: {
  top: number; viewH: number; contentH: number; scrollY: number; onScrollYTo: (y: number) => void
}) {
  const max = Math.max(1, contentH - viewH)
  const thumbH = Math.max(44, Math.round(viewH * viewH / contentH))
  const travel = Math.max(1, viewH - thumbH)
  const thumbTop = Math.round(scrollY / max * travel)
  const drag = useRef<{ y: number; scroll: number } | null>(null)
  return (
    <div className="vscroll" style={{ top, height: viewH }}
      onPointerDown={e => {
        e.stopPropagation(); e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect(), y = e.clientY - r.top
        if (y < thumbTop || y > thumbTop + thumbH) { onScrollYTo(scrollY + (y < thumbTop ? -viewH : viewH) * 0.9); return }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
        drag.current = { y: e.clientY, scroll: scrollY }
      }}
      onPointerMove={e => { const d = drag.current; if (d) onScrollYTo(d.scroll + (e.clientY - d.y) * max / travel) }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <div className="vscroll-thumb" style={{ top: thumbTop, height: thumbH }} />
    </div>
  )
}
