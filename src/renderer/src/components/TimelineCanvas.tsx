import { useRef, useEffect, useCallback, useState } from 'react'
import type { Track, LayerTrack, ClipCue, Keyframe, Show, AutomationSubTrack, Curve, LaneKind } from '../../../shared/show'
import type { WaveformInfo } from '../audio-engine'
import type { DragClipData } from '../App'
import type { LaneStatus, LaneStatusMap } from '../laneStatus'
import { formatValue } from '../../../shared/paramTree'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { T, TAG_COLORS } from '../theme'
import { RULER_H, AUDIO_LANE_H, DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_AUTO_H } from '../layout'

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

// ── Automation values ─────────────────────────────────────────────────────────

const CURVES: Curve[] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']
const CURVE_LABEL: Record<Curve, string> = {
  linear: 'Linear', hold: 'Hold', easeIn: 'Ease In', easeOut: 'Ease Out', easeInOut: 'Ease In-Out',
}
const CURVE_GLYPH: Record<Curve, string> = { linear: '◆', hold: '■', easeIn: '●', easeOut: '●', easeInOut: '●' }
const LEGACY_CURVES: Record<string, Curve> = { easeInCubic: 'easeIn', easeOutCubic: 'easeOut', easeInOutCubic: 'easeInOut' }

/** Stored ease string → curve. Older shows wrote 'easeInCubic' etc.; unknown = linear. */
function curveOf(ease: string | undefined): Curve {
  if (ease && (CURVES as string[]).includes(ease)) return ease as Curve
  return (ease && LEGACY_CURVES[ease]) || 'linear'
}

function easeT(c: Curve, t: number): number {
  switch (c) {
    case 'hold': return 0
    case 'easeIn': return t * t * t
    case 'easeOut': return 1 - (1 - t) ** 3
    case 'easeInOut': return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
    default: return t
  }
}

// Keyframe reduced to what interpolation needs (sorted by frame; c = 'hold' on discrete lanes)
interface PKey { f: number; v: number; c: Curve }

/** valueAt: the lane value at a (possibly fractional) frame, used for the curve, the
 *  playhead dot and drag previews. Same rules as the engine: the curve of a segment is the
 *  ease of its START keyframe, choice/boolean lanes always hold (c = 'hold'), and before
 *  the first / after the last key the end value holds. */
function valueAtKeys(kfs: PKey[], frame: number): number | null {
  if (!kfs.length) return null
  if (frame <= kfs[0].f) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (frame >= last.f) return last.v
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1]
    if (frame >= k0.f && frame < k1.f) {
      if (k0.c === 'hold') return k0.v
      return k0.v + (k1.v - k0.v) * easeT(k0.c, (frame - k0.f) / (k1.f - k0.f))
    }
  }
  return last.v
}

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

/** Index a keyframe ends up at after its time changes (the App re-sorts, stably, by time). */
function indexAfterTimeChange(kfs: Keyframe[], kfIdx: number, time: string, fps: number): number {
  const moved = { ...kfs[kfIdx], time }
  const next = kfs.map((k, i) => (i === kfIdx ? moved : k))
  next.sort((a, b) => smpteToFrames(a.time, fps) - smpteToFrames(b.time, fps))
  return next.indexOf(moved)
}

// ── Layout ────────────────────────────────────────────────────────────────────

interface AutoLaneLayout { y: number; h: number; id: string }
interface TrackLayout { y: number; totalH: number; autoLanes: AutoLaneLayout[] }

function buildLayout(
  tracks: Track[], clipH: (id: string) => number,
  autoH: (id: string) => number, scrollY = 0
): TrackLayout[] {
  // Start below ruler + pinned audio lane, offset by vertical scroll
  let y = TRACKS_TOP - scrollY
  return tracks.map(track => {
    const curClipH = clipH(track.id)
    const autoLanes: AutoLaneLayout[] = []
    if (track.type === 'layer' && (track as LayerTrack).expanded) {
      let ay = y + curClipH
      for (const auto of (track as LayerTrack).automations) {
        const h = autoH(auto.id)
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
      if (y >= lane.y && y < lane.y + lane.h) return { trackIdx: ti, autoIdx: ai, lane }
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

interface KfHit { trackIdx: number; autoIdx: number; kfIdx: number }

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
      if (!lane || cy < lane.y || cy >= lane.y + lane.h) continue
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

function hitTestAutoResize(layout: TrackLayout[], y: number): { autoId: string } | null {
  for (const tl of layout) {
    for (const lane of tl.autoLanes) {
      const bottom = lane.y + lane.h
      if (Math.abs(y - bottom) <= AUTO_RESIZE_ZONE) return { autoId: lane.id }
    }
  }
  return null
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxMenu { x: number; y: number; trackIdx: number; autoIdx: number; kfIdx: number }

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  tracks: Track[]
  markers: { id: string; time: string; name: string; color: string }[]
  fps: number
  bpm?: number
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
  onScrollY: (delta: number) => void
  onScrollFrame: (f: number) => void
  onSeek: (frame: number) => void
  onZoom: (factor: number) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onDropClip: (trackIdx: number, frame: number, data: DragClipData) => void
  onUpdateCue: (trackIdx: number, cueIdx: number, updates: Partial<ClipCue>) => void
  // option: choice lanes, the option name of the snapped value
  onAddKeyframe: (trackIdx: number, autoIdx: number, frame: number, value: number, option?: string) => void
  // updates may carry time, value, ease (Curve) and option (choice lanes)
  onUpdateKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number, updates: Partial<Keyframe>) => void
  onDeleteKeyframe: (trackIdx: number, autoIdx: number, kfIdx: number) => void
  onResizeAutoLane: (autoId: string, height: number) => void
  selectedTrackIdx: number | null
  selectedCueIdx: number | null
}

interface ClipColorPicker { x: number; y: number; trackIdx: number; cueIdx: number }

export function TimelineCanvas({
  tracks, markers, fps, bpm, frame, pxPerFrame, scrollFrame, draggingClip,
  autoLaneHeights, layerRowHeights, audioTrack, audioDuration, waveformInfo,
  scrollY, readOnly, laneStatus, onScrollY, onScrollFrame, onSeek, onZoom, onSelectCue,
  onDropClip, onUpdateCue, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
  onResizeAutoLane, selectedTrackIdx, selectedCueIdx,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [ctxInputVal, setCtxInputVal] = useState('')
  const [clipColorPicker, setClipColorPicker] = useState<ClipColorPicker | null>(null)
  const [selKf, setSelKf] = useState<KfHit | null>(null)
  const [hoverKf, setHoverKf] = useState<KfHit | null>(null)

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
  const moveClipRef = useRef<{ trackIdx: number; cueIdx: number; anchorMouseFrame: number; anchorCueFrame: number } | null>(null)
  const resizeClipRef = useRef<{ trackIdx: number; cueIdx: number; startX: number; startDurF: number } | null>(null)
  const kfDragRef = useRef<{
    trackIdx: number; autoIdx: number; kfIdx: number; lane: AutoLaneLayout
    anchorFrame: number; anchorKfFrame: number; anchorValue: number
    kind: LaneKind; opts: string[]; startX: number; startY: number; moved: boolean
  } | null>(null)
  const autoResizeRef = useRef<{ autoId: string; startY: number; startH: number } | null>(null)
  const ghostClipRef = useRef<{ trackIdx: number; cueIdx: number; frame: number } | null>(null)
  const ghostDurRef = useRef<{ trackIdx: number; cueIdx: number; durF: number } | null>(null)

  const frameToX = (f: number) => (f - scrollFrame) * pxPerFrame
  const xToFrame = (x: number) => Math.max(0, Math.round(x / pxPerFrame + scrollFrame))

  useEffect(() => {
    if (readOnly) { setContextMenu(null); setClipColorPicker(null); setSelKf(null) }
  }, [readOnly])

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

    // One automation lane: curve by kind, keyframe glyphs, playhead dot
    const drawAutoLane = (trackIdx: number, ai: number, auto: AutomationSubTrack, lane: AutoLaneLayout) => {
      const kind = laneKind(auto)
      const status = laneStatus[auto.id]
      const range = laneRange(auto, status)
      const opts = range.options ?? []
      const broken = status?.state === 'broken'
      const disabled = auto.enabled === false
      const laneC = auto.color ?? T.text
      const lineC = broken || disabled ? T.textFaint : laneC
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

      // Keyframes as drawn: the one being dragged sits at its drag position
      const dragHere = kd && kd.moved && kd.trackIdx === trackIdx && kd.autoIdx === ai ? kd : null
      const keys = auto.keyframes.map((kf, ki) => {
        const dragging = !!dragHere && dragHere.kfIdx === ki
        const f = dragging && dragHere ? dragHere.anchorKfFrame : smpteToFrames(kf.time, fps)
        const v = dragging && dragHere ? dragHere.anchorValue : kfValue(kind, kf, opts)
        const c: Curve = kind === 'range' ? curveOf(kf.ease) : 'hold'
        return { ki, kf, f, v, c, x: frameToX(f), y: toY(v), dragging }
      })
      const sorted = [...keys].sort((a, b) => a.f - b.f || a.ki - b.ki)

      if (sorted.length) {
        // Curve outline: holds as steps, eased segments sampled every 2px with valueAtKeys
        const pts: [number, number][] = [[sorted[0].x, sorted[0].y]]
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i + 1]
          if (a.c === 'hold') { pts.push([b.x, a.y], [b.x, b.y]); continue }
          if (a.c !== 'linear') {
            const xe = Math.min(b.x, W)
            for (let px = Math.ceil(Math.max(a.x, 0)); px < xe; px += 2) {
              const v = valueAtKeys(sorted, pxToFrame(px))
              if (v != null) pts.push([px, toY(v)])
            }
          }
          pts.push([b.x, b.y])
        }
        const first = sorted[0], lastK = sorted[sorted.length - 1]

        if (kind === 'range') {
          ctx.beginPath(); ctx.moveTo(first.x, toY(0))
          pts.forEach(p => ctx.lineTo(p[0], p[1]))
          ctx.lineTo(lastK.x, toY(0)); ctx.closePath()
          ctx.fillStyle = rgba(lineC, disabled || broken ? 0.06 : 0.12); ctx.fill()
        } else if (kind === 'boolean') {
          ctx.fillStyle = rgba(lineC, disabled || broken ? 0.25 : 0.55)
          for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i], b = sorted[i + 1]
            if (a.v >= 0.5 && b.x > a.x) ctx.fillRect(a.x, toY(1), b.x - a.x, toY(0) - toY(1))
          }
        }

        ctx.strokeStyle = lineC; ctx.lineWidth = kind === 'boolean' ? 1 : 1.5
        ctx.setLineDash(disabled ? [4, 3] : [])
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

      // Keyframe glyphs: ◆ linear, ■ hold, ● eased
      const paramName = laneParamName(auto, status)
      keys.forEach(k => {
        if (k.x < -20 || k.x > W + 20) return
        const hit = { trackIdx, autoIdx: ai, kfIdx: k.ki }
        const active = k.dragging || sameKf(selKf, hit) || sameKf(contextMenu, hit)
        const hover = !kd && sameKf(hoverKf, hit)
        const r = hover || k.dragging ? KF_R + 1 : KF_R
        ctx.globalAlpha = disabled ? 0.45 : 1
        if (active) { kfGlyph(ctx, k.c, k.x, k.y, r + 1.5); ctx.fillStyle = T.gutter; ctx.fill() }
        kfGlyph(ctx, k.c, k.x, k.y, r)
        ctx.fillStyle = active && !broken ? T.select : kfC; ctx.fill()
        if (!active) { ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke() }
        ctx.globalAlpha = 1
        if (k.dragging)
          tips.push({ text: `${formatValue(kind, k.v, range, undefined, range.suffix)} · ${framesToSmpte(k.f, fps)}`, x: k.x, y: k.y })
        else if (hover)
          tips.push({ text: `${paramName}: ${formatValue(kind, k.v, range, k.kf.option, range.suffix)} · ${k.kf.time}`, x: k.x, y: k.y })
      })

      // Value at the playhead
      const cur = valueAtKeys(sorted, frame)
      const lx = frameToX(frame)
      if (cur != null && lx >= -4 && lx <= W + 4) {
        ctx.beginPath(); ctx.arc(lx, toY(cur), 2.5, 0, Math.PI * 2)
        ctx.fillStyle = broken || disabled ? T.textFaint : T.live; ctx.fill()
        ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
      }
      ctx.restore()
    }

    ctx.fillStyle = T.well
    ctx.fillRect(0, 0, W, H)

    drawRuler(ctx, W, fps, pxPerFrame, scrollFrame, markers)
    drawAudioLane(ctx, W, audioTrack, fps, pxPerFrame, scrollFrame, audioDuration, waveformInfo ?? null)

    // Track area (below ruler + audio lane)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, TRACKS_TOP, W, H - TRACKS_TOP)
    ctx.clip()

    // Lane backgrounds
    tracks.forEach((track, i) => {
      const { y, autoLanes } = layout[i]
      const curClipH = clipH(track.id)
      const base = i % 2 === 0 ? T.lane : T.laneAlt
      ctx.fillStyle = base
      ctx.fillRect(0, y, W, curClipH - 1)
      if (i === selectedTrackIdx) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(0, y, W, curClipH - 1) }
      ctx.fillStyle = T.gutter; ctx.fillRect(0, y + curClipH - 1, W, 1)

      if (track.type === 'layer' && (track as LayerTrack).expanded) {
        const lt = track as LayerTrack
        autoLanes.forEach((lane, ai) => {
          const auto = lt.automations[ai]
          ctx.fillStyle = base; ctx.fillRect(0, lane.y, W, lane.h - 1)
          ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, lane.y, W, lane.h - 1)
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
          // Layer-bound automation (never moves with clips) gets the wider accent
          ctx.fillStyle = rgba(auto?.color ?? T.text, 0.6)
          ctx.fillRect(0, lane.y, auto?.layerBound ? 4 : 2, lane.h - 1)
          ctx.fillStyle = T.gutter; ctx.fillRect(0, lane.y + lane.h - 1, W, 1)
        })
      }
    })

    // Time / beat grid over the tracks
    if (tracksBottom > TRACKS_TOP) {
      const gh = tracksBottom - TRACKS_TOP
      if (bpm && bpm > 0) drawBpmGrid(ctx, W, TRACKS_TOP, gh, fps, bpm, pxPerFrame, scrollFrame)
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
      const { y, totalH, autoLanes } = layout[trackIdx]
      if (y > H || y + totalH < TRACKS_TOP) return
      const trackColor = lt.color ?? TAG_COLORS[0]
      const muted = !!lt.muted
      const curClipH = clipH(lt.id)
      const by = y + CLIP_PAD, bh = curClipH - 1 - CLIP_PAD * 2
      const titleH = Math.min(CLIP_TITLE_H, bh)

      const ghostMove = ghostClipRef.current?.trackIdx === trackIdx ? ghostClipRef.current : null
      const ghostDur = ghostDurRef.current?.trackIdx === trackIdx ? ghostDurRef.current : null
      const spans = clipSpans(lt, fps, ghostMove, ghostDur)
      const cutOutlines: { x: number; w: number }[] = []

      lt.clips.forEach((clip, cueIdx) => {
        const isGhost = ghostMove?.cueIdx === cueIdx
        const { sf, durF, shownF } = spans[cueIdx]
        const x = Math.round(frameToX(sf))
        const blockW = Math.round(spanWidth(shownF, pxPerFrame))
        const fullW = Math.round(spanWidth(durF, pxPerFrame))
        if (x + blockW < -4 || x > W + 4) return
        const isSel = trackIdx === selectedTrackIdx && cueIdx === selectedCueIdx
        const isLive = !muted && !isGhost && shownF > 0 && frame >= sf && frame < sf + shownF
        const isCut = shownF < durF
        const color = clip.color ?? trackColor

        ctx.globalAlpha = (muted ? 0.4 : 1) * (isGhost ? 0.6 : 1)
        // Body at 55% over the lane, title strip opaque; both capped in luminance so
        // saturated legacy colours keep white text readable without touching stored data
        ctx.fillStyle = capLum(color, 0.12, 0.55)
        ctx.fillRect(x, by + titleH, blockW, bh - titleH)
        ctx.fillStyle = capLum(color, 0.18)
        ctx.fillRect(x, by, blockW, titleH)

        const tx = Math.max(0, x) + 4
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
        if (!auto || lane.y > H || lane.y + lane.h < TRACKS_TOP) return
        drawAutoLane(trackIdx, ai, auto, lane)
      })
    })

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
  }, [tracks, markers, fps, bpm, frame, pxPerFrame, scrollFrame, selectedTrackIdx, selectedCueIdx, draggingClip, autoLaneHeights, layerRowHeights, scrollY, audioTrack, audioDuration, waveformInfo, readOnly, contextMenu, laneStatus, selKf, hoverKf])

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

    if (kfHit && kfEditable) {
      const auto = autoAt(kfHit.trackIdx, kfHit.autoIdx)!
      const kf = auto.keyframes[kfHit.kfIdx]
      setHoverKf(null)
      if (e.altKey) {  // Alt-click deletes
        onDeleteKeyframe(kfHit.trackIdx, kfHit.autoIdx, kfHit.kfIdx)
        setSelKf(null)
        return
      }
      setSelKf(kfHit)
      const kind = laneKind(auto)
      const opts = laneRange(auto, laneStatus[auto.id]).options ?? []
      const lane = layout[kfHit.trackIdx].autoLanes[kfHit.autoIdx]
      kfDragRef.current = {
        ...kfHit, lane, kind, opts,
        anchorFrame: xToFrame(x),
        anchorKfFrame: smpteToFrames(kf.time, fps),
        anchorValue: kfValue(kind, kf, opts),
        startX: x, startY: y, moved: false,
      }
      return
    }
    // Any other click in the track area (clip, empty lane) drops the keyframe selection
    setSelKf(null)
    if (kfHit) return

    const clipHit = hitTestClip(x, y)
    if (clipHit) {
      onSelectCue(clipHit.trackIdx, clipHit.cueIdx)
      if (!canEdit(clipHit.trackIdx)) return
      const lt = tracks[clipHit.trackIdx] as LayerTrack
      const clip = lt.clips[clipHit.cueIdx]
      if (clipHit.isResize) {
        resizeClipRef.current = {
          trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx,
          startX: x, startDurF: smpteToFrames(clip.duration, fps),
        }
      } else {
        moveClipRef.current = {
          trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx,
          anchorMouseFrame: xToFrame(x),
          anchorCueFrame: smpteToFrames(clip.time, fps),
        }
      }
    }
  }, [tracks, fps, pxPerFrame, scrollFrame, readOnly, laneStatus, getLayout, hitTestClip, onSelectCue, onSeek, onDeleteKeyframe])

  // ── Mouse move ─────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: { clientX: number; clientY: number }) => {
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
      const deltaFrame = xToFrame(x) - kd.anchorFrame
      kd.anchorKfFrame = Math.max(0, kd.anchorKfFrame + deltaFrame)
      kd.anchorFrame = xToFrame(x)
      kd.anchorValue = snapValue(kd.kind, kfFromY(kd.lane, y), kd.opts.length)
      draw()
      setCursor('crosshair')
      return
    }

    if (moveClipRef.current) {
      const mc = moveClipRef.current
      const newFrame = Math.max(0, mc.anchorCueFrame + (xToFrame(x) - mc.anchorMouseFrame))
      ghostClipRef.current = { trackIdx: mc.trackIdx, cueIdx: mc.cueIdx, frame: newFrame }
      draw()
      setCursor('grabbing')
      return
    }

    if (resizeClipRef.current) {
      const rs = resizeClipRef.current
      const newDur = Math.max(1, rs.startDurF + Math.round((x - rs.startX) / pxPerFrame))
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
  }, [draw, onSeek, onResizeAutoLane, hitTestClip, getLayout, tracks, fps, pxPerFrame, scrollFrame, readOnly, laneStatus])

  // ── Mouse up ───────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    isDraggingPlayhead.current = false
    autoResizeRef.current = null

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      kfDragRef.current = null
      const auto = autoAt(kd.trackIdx, kd.autoIdx)
      if (kd.moved && auto?.keyframes[kd.kfIdx]) {
        const time = framesToSmpte(kd.anchorKfFrame, fps)
        const updates: Partial<Keyframe> = { time, value: parseFloat(kd.anchorValue.toFixed(4)) }
        if (kd.kind === 'choice' && kd.opts.length) updates.option = optionAt(kd.anchorValue, kd.opts)
        onUpdateKeyframe(kd.trackIdx, kd.autoIdx, kd.kfIdx, updates)
        // The App re-sorts keyframes by time: keep the moved one selected
        setSelKf({ trackIdx: kd.trackIdx, autoIdx: kd.autoIdx, kfIdx: indexAfterTimeChange(auto.keyframes, kd.kfIdx, time, fps) })
      } else draw()
    }

    if (moveClipRef.current && ghostClipRef.current) {
      onUpdateCue(moveClipRef.current.trackIdx, moveClipRef.current.cueIdx, {
        time: framesToSmpte(ghostClipRef.current.frame, fps),
      })
    }
    if (resizeClipRef.current && ghostDurRef.current) {
      onUpdateCue(resizeClipRef.current.trackIdx, resizeClipRef.current.cueIdx, {
        duration: framesToSmpte(ghostDurRef.current.durF, fps),
      })
    }
    moveClipRef.current = null
    ghostClipRef.current = null
    resizeClipRef.current = null
    ghostDurRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }, [onUpdateCue, onUpdateKeyframe, fps, tracks, draw])

  // While a drag is active, follow the mouse on the window so leaving the canvas
  // neither drops nor freezes the drag.
  const dragHandlersRef = useRef({ move: handleMouseMove, up: handleMouseUp })
  dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp }
  const isDragging = () => !!(isDraggingPlayhead.current || autoResizeRef.current ||
    kfDragRef.current || moveClipRef.current || resizeClipRef.current)

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
    if (kind === 'range') {
      onAddKeyframe(info.trackIdx, info.autoIdx, xToFrame(x), parseFloat(raw.toFixed(3)))
    } else {
      // Choice: nearest option step (and its name); boolean: upper half = On
      const value = snapValue(kind, raw, opts.length)
      onAddKeyframe(info.trackIdx, info.autoIdx, xToFrame(x), parseFloat(value.toFixed(6)),
        kind === 'choice' ? optionAt(value, opts) : undefined)
    }
  }, [getLayout, onAddKeyframe, fps, pxPerFrame, scrollFrame, readOnly, tracks, laneStatus])

  // ── Right click → context menu ─────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (readOnly) return
    const { x, y } = localXY(e)
    const kfHit = hitTestKeyframe(x, y, getLayout(), tracks, fps, frameToX, laneStatus)
    if (kfHit && canEditLane(kfHit.trackIdx, kfHit.autoIdx)) {
      const auto = autoAt(kfHit.trackIdx, kfHit.autoIdx)!
      const kf = auto.keyframes[kfHit.kfIdx]
      setCtxInputVal(realText(kf.value, laneRange(auto, laneStatus[auto.id])))
      setContextMenu({ x, y, ...kfHit })
      setSelKf(kfHit)
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
  }, [tracks, fps, readOnly, laneStatus, getLayout, hitTestClip])

  // ── Keyboard on the selected keyframe ──────────────────────────────────────
  // Capture phase on window, so Delete/Backspace never also reaches the App's clip delete.

  const keyStateRef = useRef({ selKf, tracks, canEditLane, onDeleteKeyframe, onUpdateKeyframe })
  keyStateRef.current = { selKf, tracks, canEditLane, onDeleteKeyframe, onUpdateKeyframe }

  useEffect(() => {
    if (!selKf) return
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const s = keyStateRef.current
      const sel = s.selKf
      if (!sel) return
      const lt = s.tracks[sel.trackIdx] as LayerTrack | undefined
      const auto = lt?.type === 'layer' && lt.expanded ? lt.automations[sel.autoIdx] : undefined
      if (!auto?.keyframes[sel.kfIdx]) return
      const isDelete = e.key === 'Delete' || e.key === 'Backspace'
      const isCurve = (e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey && laneKind(auto) === 'range'
      if (!isDelete && !isCurve) return
      e.preventDefault(); e.stopPropagation()
      if (!s.canEditLane(sel.trackIdx, sel.autoIdx)) return
      if (isDelete) {
        s.onDeleteKeyframe(sel.trackIdx, sel.autoIdx, sel.kfIdx)
        setSelKf(null); setContextMenu(null)
      } else {
        const cur = curveOf(auto.keyframes[sel.kfIdx].ease)
        const next = CURVES[(CURVES.indexOf(cur) + 1) % CURVES.length]
        s.onUpdateKeyframe(sel.trackIdx, sel.autoIdx, sel.kfIdx, { ease: next })
      }
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [selKf])

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const dropTrackAt = (e: React.DragEvent) => getTrackAtY(getLayout(), localXY(e).y)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly || !e.dataTransfer.types.includes('application/timeline-clip')) return
    const ti = dropTrackAt(e)
    if (ti != null && !canEdit(ti)) return  // not preventing default = "no drop" cursor
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
  }, [readOnly, tracks, getLayout])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (readOnly) return
    const raw = e.dataTransfer.getData('application/timeline-clip')
    if (!raw) return
    try {
      const data: DragClipData = JSON.parse(raw)
      const ti = dropTrackAt(e)
      if (ti != null && canEdit(ti)) onDropClip(ti, Math.max(0, xToFrame(localXY(e).x)), data)
    } catch {}
  }, [readOnly, tracks, getLayout, onDropClip, scrollFrame, pxPerFrame])

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
      onDragOver={handleDragOver} onDrop={handleDrop}
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
        const curCurve: Curve = kind === 'range' ? curveOf(kf.ease) : 'hold'
        const close = () => setContextMenu(null)
        const commitReal = () => {
          const v = realToNorm(ctxInputVal, range)
          if (v != null) onUpdateKeyframe(ti, ai, ki, { value: v })
          close()
        }
        const curOpt = opts.length ? optionAt(kfValue('choice', kf, opts), opts) : kf.option
        return (
          <div
            className="ctx-menu kf-menu"
            style={clampPos(contextMenu.x, contextMenu.y, 260, kind === 'range' ? 250 : 210)}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="ctx-title" title={laneTitle(auto)}>{laneTitle(auto)}</div>
            <div className="ctx-hint">{kf.time}{kind === 'range' && range.min !== undefined && range.max !== undefined
              ? ` · ${formatValue('range', 0, range)} … ${formatValue('range', 1, range, undefined, range.suffix)}` : ''}</div>
            <div className="ctx-row">
              <label>Vrednost</label>
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
                    onUpdateKeyframe(ti, ai, ki, { value: opts.length > 1 ? i / (opts.length - 1) : 0, option: opts[i] })
                    close()
                  }}
                  onKeyDown={e => { if (e.key === 'Escape') close() }}
                  autoFocus
                >
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : <span className="ctx-unit">{kf.option ?? '—'} (opcije neznane)</span>)}
              {kind === 'boolean' && (
                <div className="ctx-seg">
                  {[0, 1].map(v => (
                    <button key={v} className={`ctx-seg-btn${kfValue('boolean', kf, opts) === v ? ' on' : ''}`}
                      onClick={() => { onUpdateKeyframe(ti, ai, ki, { value: v }); close() }}
                    >{v ? 'On' : 'Off'}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="ctx-row wrap">
              <label>Oblika</label>
              <div className="ctx-seg">
                {(kind === 'range' ? CURVES : ['hold' as Curve]).map(c => (
                  <button key={c} className={`ctx-seg-btn${c === curCurve ? ' on' : ''}`}
                    title={kind === 'range' ? 'Tipka E kroži med oblikami' : 'Diskretni parametri vedno skočijo'}
                    onClick={() => onUpdateKeyframe(ti, ai, ki, { ease: c })}
                  ><span className="ctx-glyph">{CURVE_GLYPH[c]}</span>{CURVE_LABEL[c]}</button>
                ))}
              </div>
            </div>
            {kind === 'range' && <button className="ctx-btn" onClick={commitReal}>Potrdi</button>}
            <div className="ctx-divider" />
            <button className="ctx-btn danger" onClick={() => {
              onDeleteKeyframe(ti, ai, ki)
              setSelKf(null)
              close()
            }}>Izbriši keyframe</button>
            <button className="ctx-btn dim" onClick={close}>Prekliči</button>
          </div>
        )
      })()}

      {clipColorPicker && (
        <div
          className="clip-color-picker"
          style={clampPos(clipColorPicker.x, clipColorPicker.y, 220, 190)}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">Barva clipa</div>
          <div className="ccp-grid">{TAG_COLORS.map(swatch)}</div>
          <div className="ccp-label">Nasičene</div>
          <div className="ccp-grid">{SATURATED_COLORS.map(swatch)}</div>
          <div className="ctx-divider" />
          <button
            className="ctx-btn"
            onClick={() => {
              onUpdateCue(clipColorPicker.trackIdx, clipColorPicker.cueIdx, { color: undefined })
              setClipColorPicker(null)
            }}
          >Ponastavi (barva layerja)</button>
          <button className="ctx-btn dim" onClick={() => setClipColorPicker(null)}>Prekliči</button>
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
  ghostMove: { cueIdx: number; frame: number } | null,
  ghostDur: { cueIdx: number; durF: number } | null,
): ClipSpan[] {
  const spans = lt.clips.map((c, i) => {
    const sf = ghostMove?.cueIdx === i ? ghostMove.frame : smpteToFrames(c.time, fps)
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
function kfGlyph(ctx: CanvasRenderingContext2D, c: Curve, x: number, y: number, r: number) {
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

// ── Ruler / grid ──────────────────────────────────────────────────────────────

// Major interval = first rung ≥ 80px apart; minor = first listed subdivision ≥ 10px apart
// (sub-second minors must land on whole frames).
function rulerSteps(fps: number, ppf: number): { major: number; minor: number; showFrames: boolean } {
  const ladder: [number, number[]][] = [
    [1, []], [5, [5]],
    [fps, [10, 5, 4, 2]], [2 * fps, [10, 4, 2]], [5 * fps, [10, 5]], [10 * fps, [10, 5, 2]],
    [15 * fps, [15, 5, 3]], [30 * fps, [30, 6, 3]], [60 * fps, [12, 6, 4, 2]],
    [120 * fps, [8, 4, 2]], [300 * fps, [10, 5]], [600 * fps, [10, 5, 2]],
  ]
  const rungs = ladder.filter(([f], i) => i < 2 ? f < fps : true)
  const [major, divs] = rungs.find(([f]) => f * ppf >= 80) ?? rungs[rungs.length - 1]
  const n = divs.find(d => (major / d) * ppf >= 10 && (major / d >= fps || Number.isInteger(major / d)))
  return { major, minor: n ? major / n : major, showFrames: major < fps }
}

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
) {
  ctx.fillStyle = T.header; ctx.fillRect(0, 0, W, RULER_H)
  ctx.fillStyle = T.track; ctx.fillRect(0, TC_BAND_H, W, RULER_H - 1 - TC_BAND_H)
  ctx.fillStyle = T.gutter; ctx.fillRect(0, RULER_H - 1, W, 1)
  if (fps <= 0 || ppf <= 0) return

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

function drawBpmGrid(ctx: CanvasRenderingContext2D, W: number, top: number, h: number, fps: number, bpm: number, ppf: number, sf: number) {
  if (fps <= 0 || ppf <= 0 || bpm <= 0) return
  const beatF = (fps * 60) / bpm
  const barF = beatF * 4
  if (barF * ppf < 6) return
  const showBeats = beatF * ppf >= 6
  forEachStep(showBeats ? beatF : barF, sf, W, ppf, (x, f) => {
    const isBar = Math.abs(f / barF - Math.round(f / barF)) < 1e-6
    ctx.fillStyle = isBar ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'
    ctx.fillRect(Math.round(x), top, 1, h)
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
    ctx.fillText('♪  Naloži avdio — klikni gumb v levem panelu', 12, laneY + laneH / 2)
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
      for (let pi = piStart + 1; pi <= piEnd; pi++) {
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
