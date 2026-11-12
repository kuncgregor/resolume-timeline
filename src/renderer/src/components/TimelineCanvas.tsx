import { useRef, useEffect, useCallback, useState } from 'react'
import type { Track, LayerTrack, ClipCue, Keyframe, Show, AutomationSubTrack } from '../../../shared/show'
import type { WaveformInfo } from '../audio-engine'
import type { DragClipData } from '../App'
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
  frameToX: (f: number) => number
): KfHit | null {
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti]
    if (track.type !== 'layer') continue
    const lt = track as LayerTrack
    for (let ai = 0; ai < lt.automations.length; ai++) {
      const lane = layout[ti].autoLanes[ai]
      if (!lane) continue
      const toY = kfToY(lane)
      for (let ki = 0; ki < lt.automations[ai].keyframes.length; ki++) {
        const kf = lt.automations[ai].keyframes[ki]
        const kx = frameToX(smpteToFrames(kf.time, fps))
        const ky = toY(kf.value)
        if (Math.abs(cx - kx) < 9 && Math.abs(cy - ky) < 9) return { trackIdx: ti, autoIdx: ai, kfIdx: ki }
      }
    }
  }
  return null
}

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

interface CtxMenu { x: number; y: number; trackIdx: number; autoIdx: number; kfIdx: number; value: number }

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
  onScrollY: (delta: number) => void
  onScrollFrame: (f: number) => void
  onSeek: (frame: number) => void
  onZoom: (factor: number) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onDropClip: (trackIdx: number, frame: number, data: DragClipData) => void
  onUpdateCue: (trackIdx: number, cueIdx: number, updates: Partial<ClipCue>) => void
  onAddKeyframe: (trackIdx: number, autoIdx: number, frame: number, value: number) => void
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
  scrollY, readOnly, onScrollY, onScrollFrame, onSeek, onZoom, onSelectCue,
  onDropClip, onUpdateCue, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
  onResizeAutoLane, selectedTrackIdx, selectedCueIdx,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [ctxInputVal, setCtxInputVal] = useState('')
  const [clipColorPicker, setClipColorPicker] = useState<ClipColorPicker | null>(null)

  const autoH = (id: string) => autoLaneHeights[id] ?? DEFAULT_AUTO_H
  const clipH = (id: string) => layerRowHeights[id] ?? DEFAULT_LANE_H
  const canEdit = (ti: number) => !readOnly && !(tracks[ti] as LayerTrack | undefined)?.locked

  // Drag state refs
  const isDraggingPlayhead = useRef(false)
  const moveClipRef = useRef<{ trackIdx: number; cueIdx: number; anchorMouseFrame: number; anchorCueFrame: number } | null>(null)
  const resizeClipRef = useRef<{ trackIdx: number; cueIdx: number; startX: number; startDurF: number } | null>(null)
  const kfDragRef = useRef<{ trackIdx: number; autoIdx: number; kfIdx: number; lane: AutoLaneLayout; anchorFrame: number; anchorKfFrame: number; anchorValue: number } | null>(null)
  const autoResizeRef = useRef<{ autoId: string; startY: number; startH: number } | null>(null)
  const ghostClipRef = useRef<{ trackIdx: number; cueIdx: number; frame: number } | null>(null)
  const ghostDurRef = useRef<{ trackIdx: number; cueIdx: number; durF: number } | null>(null)

  const frameToX = (f: number) => (f - scrollFrame) * pxPerFrame
  const xToFrame = (x: number) => Math.max(0, Math.round(x / pxPerFrame + scrollFrame))

  useEffect(() => {
    if (readOnly) { setContextMenu(null); setClipColorPicker(null) }
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
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ;[0.25, 0.5, 0.75].forEach(v => ctx.fillRect(0, Math.round(kfToY(lane)(v)), W, 1))
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

      // Automation lines
      autoLanes.forEach((lane, ai) => {
        const auto = lt.automations[ai]
        if (!auto || !auto.keyframes.length) return
        const c = auto.color ?? T.text
        const toY = kfToY(lane)

        const kfs = auto.keyframes
          .map(k => ({ frame: smpteToFrames(k.time, fps), v: k.value }))
          .sort((a, b) => a.frame - b.frame)

        ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath()
        kfs.forEach((k, i) => {
          const kx = frameToX(k.frame)
          if (i === 0) ctx.moveTo(kx, toY(k.v)); else ctx.lineTo(kx, toY(k.v))
        })
        ctx.stroke()

        // Hold value before the first and after the last keyframe
        const first = kfs[0], lastKf = kfs[kfs.length - 1]
        ctx.strokeStyle = rgba(c, 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 4])
        ctx.beginPath()
        ctx.moveTo(0, toY(first.v)); ctx.lineTo(frameToX(first.frame), toY(first.v))
        ctx.moveTo(frameToX(lastKf.frame), toY(lastKf.v)); ctx.lineTo(W, toY(lastKf.v))
        ctx.stroke(); ctx.setLineDash([])

        auto.keyframes.forEach((kf, ki) => {
          const kd = kfDragRef.current
          const kfDragging = kd?.trackIdx === trackIdx && kd.autoIdx === ai && kd.kfIdx === ki
          const kfMenu = contextMenu?.trackIdx === trackIdx && contextMenu.autoIdx === ai && contextMenu.kfIdx === ki
          let kx = frameToX(smpteToFrames(kf.time, fps))
          let ky = toY(kf.value)
          if (kfDragging && kd) { kx = frameToX(kd.anchorKfFrame); ky = toY(kd.anchorValue) }
          if (kx < -20 || kx > W + 20) return

          diamond(ctx, kx, ky, 4.5)
          ctx.fillStyle = c; ctx.fill()
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
          if (kfDragging || kfMenu) {
            diamond(ctx, kx, ky, 6.5)
            ctx.strokeStyle = T.select; ctx.lineWidth = 1.5; ctx.stroke()
          }

          if (kfDragging && kd) {
            ctx.font = `11px ${T.fontTc}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            const label = formatAutoValue(auto, kd.anchorValue)
            const lw = ctx.measureText(label).width
            const ly = Math.max(lane.y + 8, ky - 10)
            ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(kx + 9, ly - 8, lw + 8, 16)
            ctx.fillStyle = T.textHi; ctx.fillText(label, kx + 13, ly)
          }
        })

        // Live value at the playhead
        const currV = interpolate(auto.keyframes, frame, fps)
        const lx = frameToX(frame)
        if (currV !== null && lx >= -4 && lx <= W + 4) {
          ctx.beginPath(); ctx.arc(lx, toY(currV), 3.5, 0, Math.PI * 2)
          ctx.fillStyle = T.live; ctx.fill()
          ctx.strokeStyle = T.gutter; ctx.lineWidth = 1; ctx.stroke()
        }
      })
    })

    ctx.restore() // end track clip region

    // Playhead over everything, cap in the ruler
    const px = Math.round(frameToX(frame))
    if (px >= -6 && px <= W + 6) {
      ctx.fillStyle = T.live
      ctx.fillRect(px - 1, 0, 2, H)
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill()
    }
  }, [tracks, markers, fps, bpm, frame, pxPerFrame, scrollFrame, selectedTrackIdx, selectedCueIdx, draggingClip, autoLaneHeights, layerRowHeights, scrollY, audioTrack, audioDuration, waveformInfo, readOnly, contextMenu])

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

    // Auto lane height is view state, not show data, so it stays adjustable in SHOW mode
    const resizeTarget = hitTestAutoResize(layout, y)
    if (resizeTarget) {
      autoResizeRef.current = { autoId: resizeTarget.autoId, startY: y, startH: autoH(resizeTarget.autoId) }
      return
    }

    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX)
    if (kfHit && canEdit(kfHit.trackIdx)) {
      const lt = tracks[kfHit.trackIdx] as LayerTrack
      const kf = lt.automations[kfHit.autoIdx].keyframes[kfHit.kfIdx]
      const lane = layout[kfHit.trackIdx].autoLanes[kfHit.autoIdx]
      kfDragRef.current = {
        ...kfHit, lane,
        anchorFrame: xToFrame(x),
        anchorKfFrame: smpteToFrames(kf.time, fps),
        anchorValue: kf.value,
      }
      return
    }

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
  }, [tracks, fps, pxPerFrame, scrollFrame, readOnly, getLayout, hitTestClip, onSelectCue, onSeek])

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
      const deltaFrame = xToFrame(x) - kd.anchorFrame
      kd.anchorKfFrame = Math.max(0, kd.anchorKfFrame + deltaFrame)
      kd.anchorFrame = xToFrame(x)
      kd.anchorValue = kfFromY(kd.lane, y)
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
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX)
    const clipHit = hitTestClip(x, y)
    const ti = getTrackAtY(layout, y)
    setCursor(
      kfHit ? (canEdit(kfHit.trackIdx) ? 'move' : 'not-allowed') :
      hitTestAutoResize(layout, y) ? 'ns-resize' :
      clipHit ? (!canEdit(clipHit.trackIdx) ? 'not-allowed' : clipHit.isResize ? 'ew-resize' : 'grab') :
      ti == null || readOnly ? 'default' :
      canEdit(ti) ? 'crosshair' : 'not-allowed'
    )
  }, [draw, onSeek, onResizeAutoLane, hitTestClip, getLayout, tracks, fps, pxPerFrame, scrollFrame, readOnly])

  // ── Mouse up ───────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    isDraggingPlayhead.current = false
    autoResizeRef.current = null

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      onUpdateKeyframe(kd.trackIdx, kd.autoIdx, kd.kfIdx, {
        time: framesToSmpte(kd.anchorKfFrame, fps),
        value: parseFloat(kd.anchorValue.toFixed(4)),
      })
      kfDragRef.current = null
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
  }, [onUpdateCue, onUpdateKeyframe, fps])

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
    const info = getAutoLaneAt(getLayout(), y)
    if (!info || !canEdit(info.trackIdx)) return
    const value = parseFloat(kfFromY(info.lane, y).toFixed(3))
    onAddKeyframe(info.trackIdx, info.autoIdx, xToFrame(x), value)
  }, [getLayout, onAddKeyframe, fps, pxPerFrame, scrollFrame, readOnly, tracks])

  // ── Right click → context menu ─────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (readOnly) return
    const { x, y } = localXY(e)
    const kfHit = hitTestKeyframe(x, y, getLayout(), tracks, fps, frameToX)
    if (kfHit && canEdit(kfHit.trackIdx)) {
      const lt = tracks[kfHit.trackIdx] as LayerTrack
      const kf = lt.automations[kfHit.autoIdx].keyframes[kfHit.kfIdx]
      setCtxInputVal(kf.value.toFixed(4))
      setContextMenu({ x, y, ...kfHit, value: kf.value })
      setClipColorPicker(null)
      return
    }
    const clipHit = hitTestClip(x, y)
    if (clipHit && canEdit(clipHit.trackIdx)) {
      setClipColorPicker({ x, y, trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx })
      setContextMenu(null)
    }
  }, [tracks, fps, readOnly, getLayout, hitTestClip])

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
      />

      {contextMenu && (
        <div
          className="ctx-menu"
          style={clampPos(contextMenu.x, contextMenu.y, 220, 150)}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">Keyframe</div>
          {(() => {
            const auto = (tracks[contextMenu.trackIdx] as LayerTrack)?.automations[contextMenu.autoIdx]
            const v = Math.max(0, Math.min(1, parseFloat(ctxInputVal) || 0))
            return auto?.max !== undefined && auto.min !== undefined
              ? <div className="ctx-hint">{auto.name} = {formatAutoValue(auto, v)} (0–1 = {auto.min}…{auto.max})</div>
              : null
          })()}
          <div className="ctx-row">
            <label>Vrednost</label>
            <input
              type="number" step="0.001" min="0" max="1"
              value={ctxInputVal}
              onChange={e => setCtxInputVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const v = Math.max(0, Math.min(1, parseFloat(ctxInputVal) || 0))
                  onUpdateKeyframe(contextMenu.trackIdx, contextMenu.autoIdx, contextMenu.kfIdx, { value: v })
                  setContextMenu(null)
                }
                if (e.key === 'Escape') setContextMenu(null)
              }}
              autoFocus
            />
          </div>
          <button className="ctx-btn" onClick={() => {
            const v = Math.max(0, Math.min(1, parseFloat(ctxInputVal) || 0))
            onUpdateKeyframe(contextMenu.trackIdx, contextMenu.autoIdx, contextMenu.kfIdx, { value: v })
            setContextMenu(null)
          }}>Potrdi</button>
          <div className="ctx-divider" />
          <button className="ctx-btn danger" onClick={() => {
            onDeleteKeyframe(contextMenu.trackIdx, contextMenu.autoIdx, contextMenu.kfIdx)
            setContextMenu(null)
          }}>Izbriši keyframe</button>
          <button className="ctx-btn dim" onClick={() => setContextMenu(null)}>Prekliči</button>
        </div>
      )}

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

// Keyframes are normalized 0..1; show the real Resolume value when the range is known
function formatAutoValue(auto: AutomationSubTrack | undefined, v: number): string {
  if (!auto || auto.min === undefined || auto.max === undefined || (auto.min === 0 && auto.max === 1))
    return v.toFixed(3)
  const real = auto.min + v * (auto.max - auto.min)
  return `${v.toFixed(3)} → ${Math.abs(auto.max - auto.min) > 10 ? real.toFixed(0) : real.toFixed(3)}`
}

// Width of the grab zone at a clip's right edge for changing its duration. Narrow and
// trigger-only clips get none, otherwise the whole block would resize instead of move.
function resizeZoneW(durF: number, blockW: number): number {
  if (durF <= 0 || blockW < 24) return 0
  return Math.min(RESIZE_HANDLE_W + 4, blockW / 4)
}

function interpolate(keyframes: Keyframe[], frame: number, fps: number): number | null {
  if (!keyframes.length) return null
  const kfs = [...keyframes].map(k => ({ ...k, f: smpteToFrames(k.time, fps) })).sort((a, b) => a.f - b.f)
  if (frame <= kfs[0].f) return kfs[0].value
  if (frame >= kfs[kfs.length - 1].f) return kfs[kfs.length - 1].value
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1]
    if (frame >= k0.f && frame <= k1.f) {
      const t = k1.f === k0.f ? 0 : (frame - k0.f) / (k1.f - k0.f)
      return k0.value + (k1.value - k0.value) * t
    }
  }
  return null
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
