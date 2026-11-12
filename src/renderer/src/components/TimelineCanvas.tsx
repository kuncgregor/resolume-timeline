import { useRef, useEffect, useCallback, useState } from 'react'
import type { Track, LayerTrack, ClipCue, Keyframe, Show } from '../../../shared/show'
import type { WaveformInfo } from '../audio-engine'
import type { DragClipData } from '../App'
import { framesToSmpte, smpteToFrames } from './timeUtils'

const AUDIO_LANE_H = 72
const CLIP_COLORS = ['#E74C3C','#E2934A','#F1C40F','#2ECC71','#1ABC9C','#3498DB','#9B59B6','#E91E63','#ffffff','#888888','#ff6600','#00ddff']

const DEFAULT_CLIP_LANE_H = 52
const RULER_H = 28
const CLIP_BLOCK_H = 36
const RESIZE_HANDLE_W = 10
const DEFAULT_AUTO_H = 72
const AUTO_RESIZE_ZONE = 6  // px at bottom of auto lane to start resize

// ── Layout ────────────────────────────────────────────────────────────────────

interface AutoLaneLayout { y: number; h: number; id: string }
interface TrackLayout { y: number; totalH: number; autoLanes: AutoLaneLayout[] }

function buildLayout(
  tracks: Track[], clipH: (id: string) => number,
  autoH: (id: string) => number, scrollY = 0
): TrackLayout[] {
  // Start below ruler + pinned audio lane, offset by vertical scroll
  let y = RULER_H + AUDIO_LANE_H - scrollY
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
  lane.y + 4 + (lane.h - 8) * (1 - Math.max(0, Math.min(1, v)))
const kfFromY = (lane: AutoLaneLayout, y: number) =>
  Math.max(0, Math.min(1, 1 - (y - lane.y - 4) / (lane.h - 8)))

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
  scrollY, onScrollY, onScrollFrame, onSeek, onZoom, onSelectCue,
  onDropClip, onUpdateCue, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
  onResizeAutoLane, selectedTrackIdx, selectedCueIdx,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [ctxInputVal, setCtxInputVal] = useState('')
  const [clipColorPicker, setClipColorPicker] = useState<ClipColorPicker | null>(null)

  const autoH = (id: string) => autoLaneHeights[id] ?? DEFAULT_AUTO_H
  const clipH = (id: string) => layerRowHeights[id] ?? DEFAULT_CLIP_LANE_H
  const getScrollY = () => scrollY

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

  // ── Draw ──────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    if (W === 0 || H === 0) return

    const layout = buildLayout(tracks, clipH, autoH, scrollY)

    ctx.fillStyle = '#080808'
    ctx.fillRect(0, 0, W, H)

    drawRuler(ctx, W, fps, bpm, pxPerFrame, scrollFrame)

    // ── Pinned audio lane (fixed below ruler) ──────────────────────
    drawAudioLane(ctx, W, audioTrack, fps, pxPerFrame, scrollFrame, audioDuration, waveformInfo ?? null)

    // Clip drawing to track area (below ruler + audio lane)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, RULER_H + AUDIO_LANE_H, W, H - RULER_H - AUDIO_LANE_H)
    ctx.clip()

    // Lane backgrounds
    tracks.forEach((track, i) => {
      const { y, autoLanes } = layout[i]
      const curClipH = clipH(track.id)
      ctx.fillStyle = i === selectedTrackIdx ? '#1c1c1c' : (i % 2 === 0 ? '#0f0f0f' : '#141414')
      ctx.fillRect(0, y, W, curClipH)
      // Thick separator between layers
      ctx.fillStyle = '#252525'; ctx.fillRect(0, y + curClipH - 2, W, 2)

      if (track.type === 'layer' && (track as LayerTrack).expanded) {
        const lt = track as LayerTrack
        autoLanes.forEach((lane, ai) => {
          const auto = lt.automations[ai]
          const c = auto?.color ?? '#2ECC71'
          const isLayerBound = !!auto?.layerBound
          // Layer-bound: warm amber-dark; clip-bound (default): cool dark
          ctx.fillStyle = isLayerBound ? '#100e08' : '#0a0a0a'
          ctx.fillRect(0, lane.y, W, lane.h)
          // Left accent strip (colored)
          ctx.fillStyle = c + '66'
          ctx.fillRect(0, lane.y, isLayerBound ? 4 : 2, lane.h)
          // Bottom resize handle
          ctx.fillStyle = '#2a2a2a'
          ctx.fillRect(0, lane.y + lane.h - 2, W, 2)
          // Grid lines at 0.25/0.5/0.75
          ctx.strokeStyle = isLayerBound ? '#1e1b14' : '#1e1e1e'; ctx.lineWidth = 1; ctx.setLineDash([2, 6])
          ;[0.25, 0.5, 0.75].forEach(v => {
            const gy = kfToY(lane)(v)
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke()
          })
          ctx.setLineDash([])
        })
      }
    })

    // BPM beat grid
    if (bpm && bpm > 0) {
      drawBpmGrid(ctx, W, H, fps, bpm, pxPerFrame, scrollFrame)
    }

    // Drag drop highlight
    if (draggingClip) {
      tracks.forEach((track, i) => {
        if (track.type !== 'layer') return
        if ((track as LayerTrack).resolumeLayerId === draggingClip.layerId) {
          const { y } = layout[i]
          const ch = clipH(track.id)
          ctx.fillStyle = 'rgba(0,85,221,0.12)'
          ctx.strokeStyle = 'rgba(34,119,255,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
          ctx.strokeRect(1, y + 1, W - 2, ch - 2)
          ctx.fillRect(1, y + 1, W - 2, ch - 2)
          ctx.setLineDash([])
        }
      })
    }

    // Markers
    markers.forEach(mk => {
      const x = frameToX(smpteToFrames(mk.time, fps))
      if (x < -2 || x > W + 2) return
      ctx.strokeStyle = mk.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = mk.color; ctx.font = '10px monospace'
      ctx.fillText(mk.name, x + 3, RULER_H + 11)
    })

    // Clips
    tracks.forEach((track, trackIdx) => {
      if (track.type !== 'layer') return
      const lt = track as LayerTrack
      const { y, autoLanes } = layout[trackIdx]
      const color = lt.color ?? '#5599ff'

      lt.clips.forEach((clip, cueIdx) => {
        const isGhost = ghostClipRef.current?.trackIdx === trackIdx && ghostClipRef.current?.cueIdx === cueIdx
        const isDurGhost = ghostDurRef.current?.trackIdx === trackIdx && ghostDurRef.current?.cueIdx === cueIdx
        const sf = isGhost ? (ghostClipRef.current?.frame ?? 0) : smpteToFrames(clip.time, fps)
        const durF = isDurGhost ? ghostDurRef.current!.durF : smpteToFrames(clip.duration, fps)
        const x = frameToX(sf)
        const blockW = durF > 0 ? Math.max(8, durF * pxPerFrame) : Math.max(10, pxPerFrame * 2)
        const curClipH = clipH(lt.id)
        const blockY = y + (curClipH - CLIP_BLOCK_H) / 2
        if (x + blockW < -2 || x > W + 2) return
        const isSel = trackIdx === selectedTrackIdx && cueIdx === selectedCueIdx
        const clipColor = clip.color ?? color

        ctx.globalAlpha = isGhost ? 0.65 : 0.9
        ctx.fillStyle = isSel ? lighten(clipColor, 0.2) : clipColor
        roundRect(ctx, x, blockY, blockW, CLIP_BLOCK_H, 4); ctx.fill()
        ctx.globalAlpha = 1

        if (isSel || isGhost) {
          ctx.strokeStyle = isSel ? '#ffffffbb' : '#fff'
          ctx.lineWidth = 1.5
          roundRect(ctx, x, blockY, blockW, CLIP_BLOCK_H, 4); ctx.stroke()
        }
        ctx.fillStyle = lighten(clipColor, 0.4)
        ctx.fillRect(Math.max(0, x), blockY, Math.min(blockW, W - Math.max(0, x)), 3)

        if (blockW > 14) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(Math.max(0, x) + 3, blockY + 4, Math.min(blockW - 6, W - Math.max(0, x) - 3), CLIP_BLOCK_H - 6)
          ctx.clip()
          ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.92; ctx.font = 'bold 10px monospace'
          ctx.fillText(clip.clipName || `Clip ${clip.clipIndex}`, Math.max(0, x) + 4, blockY + 18)
          if (durF > 0 && blockW > 60) {
            ctx.font = '9px monospace'; ctx.globalAlpha = 0.5
            ctx.fillText(framesToSmpte(durF, fps), Math.max(0, x) + 4, blockY + 29)
          }
          ctx.restore(); ctx.globalAlpha = 1
        }
        // Resize handle (only where hitTestClip offers one)
        if (resizeZoneW(durF, blockW) > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.22)'
          ctx.fillRect(x + blockW - RESIZE_HANDLE_W, blockY + 5, 3, CLIP_BLOCK_H - 10)
        }
      })

      // Automation lines
      autoLanes.forEach((lane, ai) => {
        const auto = lt.automations[ai]
        if (!auto || !auto.keyframes.length) return
        const c = auto.color ?? '#2ECC71'
        const toY = kfToY(lane)

        const kfs = auto.keyframes
          .map(k => ({ frame: smpteToFrames(k.time, fps), v: k.value }))
          .sort((a, b) => a.frame - b.frame)

        // Draw the automation line
        ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = 0.9; ctx.setLineDash([])
        ctx.beginPath()
        kfs.forEach((k, i) => {
          const kx = frameToX(k.frame)
          if (kx < -200 || kx > W + 200) return
          if (i === 0) ctx.moveTo(kx, toY(k.v)); else ctx.lineTo(kx, toY(k.v))
        })
        ctx.stroke(); ctx.globalAlpha = 1

        // Extend line to edges
        if (kfs.length > 0) {
          const first = kfs[0], last = kfs[kfs.length - 1]
          ctx.strokeStyle = c + '44'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4])
          ctx.beginPath()
          ctx.moveTo(0, toY(first.v)); ctx.lineTo(frameToX(first.frame), toY(first.v))
          ctx.moveTo(frameToX(last.frame), toY(last.v)); ctx.lineTo(W, toY(last.v))
          ctx.stroke(); ctx.setLineDash([])
        }

        // Playhead live value dot
        const currV = interpolate(auto.keyframes, frame, fps)
        if (currV !== null) {
          const lx = frameToX(frame), ly = toY(currV)
          ctx.fillStyle = '#fff'
          ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill()
          ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke()
        }

        // Keyframe dots (larger for interaction)
        auto.keyframes.forEach((kf, ki) => {
          const kfDragging = kfDragRef.current?.trackIdx === trackIdx &&
            kfDragRef.current?.autoIdx === ai && kfDragRef.current?.kfIdx === ki
          let kx = frameToX(smpteToFrames(kf.time, fps))
          let ky = toY(kf.value)
          if (kfDragging && kfDragRef.current) {
            // Show ghost at drag position
            kx = frameToX(kfDragRef.current.anchorKfFrame)
            ky = toY(kfDragRef.current.anchorValue)
          }
          if (kx < -20 || kx > W + 20) return

          ctx.fillStyle = c
          ctx.beginPath(); ctx.arc(kx, ky, 5, 0, Math.PI * 2); ctx.fill()
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()

          // Value label on hover / drag
          if (kfDragging) {
            ctx.fillStyle = '#ffffffcc'; ctx.font = '9px monospace'
            ctx.fillText(kfDragRef.current!.anchorValue.toFixed(3), kx + 8, ky - 4)
          }
        })
      })
    })

    ctx.restore() // end track clip region

    // Playhead drawn OVER everything (not clipped)
    const px = frameToX(frame)
    if (px >= -1 && px <= W + 1) {
      ctx.setLineDash([])
      ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
      ctx.fillStyle = '#ff3333'
      ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 10); ctx.fill()
    }
  }, [tracks, markers, fps, bpm, frame, pxPerFrame, scrollFrame, selectedTrackIdx, selectedCueIdx, draggingClip, autoLaneHeights, layerRowHeights, scrollY, audioTrack, audioDuration, waveformInfo])

  // ── ResizeObserver ─────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current, canvas = canvasRef.current
    if (!container || !canvas) return
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
      draw()
    })
    ro.observe(container)
    canvas.width = container.clientWidth; canvas.height = container.clientHeight; draw()
    return () => ro.disconnect()
  }, [draw])

  // ── Non-passive wheel ──────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fn = (e: WheelEvent) => {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        // Zoom
        onZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Horizontal scroll
        const d = e.deltaX || e.deltaY
        onScrollFrame(Math.max(0, scrollFrame + d / pxPerFrame))
      } else {
        // Vertical scroll (tracks)
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
    const SLOP = 3
    // Later clips are drawn on top, so test them first
    for (let ci = lt.clips.length - 1; ci >= 0; ci--) {
      const clip = lt.clips[ci]
      const durF = smpteToFrames(clip.duration, fps)
      const blockW = durF > 0 ? Math.max(8, durF * pxPerFrame) : Math.max(10, pxPerFrame * 2)
      const cx = frameToX(smpteToFrames(clip.time, fps))
      if (x >= cx - SLOP && x <= cx + blockW + SLOP) {
        const zone = resizeZoneW(durF, blockW)
        return { trackIdx: ti, cueIdx: ci, isResize: zone > 0 && x >= cx + blockW - zone }
      }
    }
    return null
  }, [tracks, fps, pxPerFrame, scrollFrame])

  // ── Mouse down ─────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setContextMenu(null)
    setClipColorPicker(null)
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const layout = getLayout()

    if (y < RULER_H + AUDIO_LANE_H) { isDraggingPlayhead.current = true; onSeek(xToFrame(x)); return }

    // Auto lane resize?
    const resizeTarget = hitTestAutoResize(layout, y)
    if (resizeTarget) {
      autoResizeRef.current = { autoId: resizeTarget.autoId, startY: y, startH: autoH(resizeTarget.autoId) }
      return
    }

    // Keyframe drag?
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX)
    if (kfHit) {
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

    // Clip drag/resize?
    const clipHit = hitTestClip(x, y)
    if (clipHit) {
      onSelectCue(clipHit.trackIdx, clipHit.cueIdx)
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
  }, [tracks, fps, pxPerFrame, scrollFrame, getLayout, hitTestClip, onSelectCue, onSeek])

  // ── Mouse move ─────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top

    if (isDraggingPlayhead.current) { onSeek(xToFrame(x)); return }

    if (autoResizeRef.current) {
      const rs = autoResizeRef.current
      const newH = Math.max(40, rs.startH + (y - rs.startY))
      onResizeAutoLane(rs.autoId, newH)
      if (canvasRef.current) canvasRef.current.style.cursor = 'ns-resize'
      return
    }

    if (kfDragRef.current) {
      const kd = kfDragRef.current
      const deltaFrame = xToFrame(x) - kd.anchorFrame
      kd.anchorKfFrame = Math.max(0, kd.anchorKfFrame + deltaFrame)
      kd.anchorFrame = xToFrame(x)
      kd.anchorValue = kfFromY(kd.lane, y)
      draw()
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair'
      return
    }

    if (moveClipRef.current) {
      const mc = moveClipRef.current
      const newFrame = Math.max(0, mc.anchorCueFrame + (xToFrame(x) - mc.anchorMouseFrame))
      ghostClipRef.current = { trackIdx: mc.trackIdx, cueIdx: mc.cueIdx, frame: newFrame }
      draw()
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
      return
    }

    if (resizeClipRef.current) {
      const rs = resizeClipRef.current
      const newDur = Math.max(1, rs.startDurF + Math.round((x - rs.startX) / pxPerFrame))
      ghostDurRef.current = { trackIdx: rs.trackIdx, cueIdx: rs.cueIdx, durF: newDur }
      draw()
      if (canvasRef.current) canvasRef.current.style.cursor = 'ew-resize'
      return
    }

    // Cursor feedback
    const layout = getLayout()
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX)
    const resizeTarget = hitTestAutoResize(layout, y)
    const clipHit = hitTestClip(x, y)
    if (canvasRef.current) {
      canvasRef.current.style.cursor =
        y < RULER_H + AUDIO_LANE_H ? 'pointer' :
        kfHit ? 'move' :
        resizeTarget ? 'ns-resize' :
        clipHit?.isResize ? 'ew-resize' :
        clipHit ? 'grab' : 'crosshair'
    }
  }, [draw, onSeek, onUpdateCue, onResizeAutoLane, hitTestClip, getLayout, tracks, fps, pxPerFrame, scrollFrame])

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
    if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair'
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
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const layout = getLayout()
    const info = getAutoLaneAt(layout, y)
    if (!info) return
    const frame = xToFrame(x)
    const value = parseFloat(kfFromY(info.lane, y).toFixed(3))
    onAddKeyframe(info.trackIdx, info.autoIdx, frame, value)
  }, [getLayout, onAddKeyframe, fps, pxPerFrame, scrollFrame])

  // ── Right click → context menu ─────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const layout = getLayout()
    const kfHit = hitTestKeyframe(x, y, layout, tracks, fps, frameToX)
    if (kfHit) {
      const lt = tracks[kfHit.trackIdx] as LayerTrack
      const kf = lt.automations[kfHit.autoIdx].keyframes[kfHit.kfIdx]
      setCtxInputVal(kf.value.toFixed(4))
      setContextMenu({ x, y, ...kfHit, value: kf.value })
      setClipColorPicker(null)
      return
    }
    const clipHit = hitTestClip(x, y)
    if (clipHit) {
      setClipColorPicker({ x, y, trackIdx: clipHit.trackIdx, cueIdx: clipHit.cueIdx })
      setContextMenu(null)
    }
  }, [tracks, fps, getLayout, hitTestClip])

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/timeline-clip')) return
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/timeline-clip')
    if (!raw) return
    try {
      const data: DragClipData = JSON.parse(raw)
      const rect = canvasRef.current!.getBoundingClientRect()
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const layout = getLayout()
      const ti = getTrackAtY(layout, y)
      if (ti != null) onDropClip(ti, Math.max(0, xToFrame(x)), data)
    } catch {}
  }, [getLayout, onDropClip, scrollFrame, pxPerFrame])

  return (
    <div ref={containerRef} className="timeline-canvas-container"
      onDragOver={handleDragOver} onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={e => { if (!isDragging()) handleMouseMove(e) }}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        style={{ display: 'block' }}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="ctx-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">Keyframe</div>
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
          }}>✓ Potrdi</button>
          <div className="ctx-divider" />
          <button className="ctx-btn danger" onClick={() => {
            onDeleteKeyframe(contextMenu.trackIdx, contextMenu.autoIdx, contextMenu.kfIdx)
            setContextMenu(null)
          }}>✕ Izbriši keyframe</button>
          <button className="ctx-btn dim" onClick={() => setContextMenu(null)}>Prekliči</button>
        </div>
      )}

      {/* Clip color picker */}
      {clipColorPicker && (
        <div
          className="clip-color-picker"
          style={{ left: clipColorPicker.x, top: clipColorPicker.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="ctx-title">Barva clipa</div>
          <div className="ccp-grid">
            {CLIP_COLORS.map(c => (
              <button
                key={c}
                className="ccp-swatch"
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onUpdateCue(clipColorPicker.trackIdx, clipColorPicker.cueIdx, { color: c })
                  setClipColorPicker(null)
                }}
              />
            ))}
          </div>
          <div className="ctx-divider" />
          <button
            className="ctx-btn dim"
            onClick={() => {
              onUpdateCue(clipColorPicker.trackIdx, clipColorPicker.cueIdx, { color: undefined })
              setClipColorPicker(null)
            }}
          >↺ Ponastavi (barva layerja)</button>
          <button className="ctx-btn dim" onClick={() => setClipColorPicker(null)}>Prekliči</button>
        </div>
      )}
    </div>
  )
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

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

function drawRuler(ctx: CanvasRenderingContext2D, W: number, fps: number, bpm: number | undefined, ppf: number, sf: number) {
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, RULER_H)
  ctx.fillStyle = '#252525'; ctx.fillRect(0, RULER_H - 1, W, 1)
  if (fps <= 0 || ppf <= 0) return

  // BPM beat ticks on ruler
  if (bpm && bpm > 0) {
    const beatF = (fps * 60) / bpm
    const barF = beatF * 4
    const minPxPerBeat = 8
    const beatStep = beatF * ppf >= minPxPerBeat ? beatF : barF
    const startBeat = Math.floor(sf / beatStep) * beatStep
    for (let f = startBeat; f <= sf + W / ppf + beatStep; f += beatStep) {
      const x = (f - sf) * ppf
      if (x < -1 || x > W + 1) continue
      const isBar = Math.abs(f % barF) < 0.5
      ctx.fillStyle = isBar ? '#3a3a3a' : '#222222'
      ctx.fillRect(x, RULER_H - (isBar ? 8 : 4), 1, isBar ? 8 : 4)
    }
  }

  const iv = [1, 2, 5, 10, 30, 60, 120, 300, 600].map(s => s * fps).find(iv => iv * ppf >= 90) ?? 600 * fps
  const start = Math.floor(sf / iv) * iv
  ctx.font = '9px monospace'; ctx.textBaseline = 'middle'
  for (let f = start; f <= sf + W / ppf + iv; f += iv) {
    const x = (f - sf) * ppf
    if (x < -1 || x > W + 1) continue
    ctx.fillStyle = '#2e2e2e'; ctx.fillRect(x, 0, 1, RULER_H)
    ctx.fillStyle = '#666666'; ctx.fillText(framesToSmpte(f, fps), x + 3, RULER_H / 2)
  }
}

function drawBpmGrid(ctx: CanvasRenderingContext2D, W: number, H: number, fps: number, bpm: number, ppf: number, sf: number) {
  if (fps <= 0 || ppf <= 0 || bpm <= 0) return
  const beatF = (fps * 60) / bpm
  const barF = beatF * 4
  // Skip rendering if beats are too dense (< 3px apart)
  if (beatF * ppf < 3) return

  const gridTop = RULER_H + AUDIO_LANE_H
  const gridH = H - gridTop
  if (gridH <= 0) return

  const start = Math.floor(sf / beatF) * beatF
  ctx.save()
  ctx.beginPath(); ctx.rect(0, gridTop, W, gridH); ctx.clip()

  for (let f = start; f <= sf + W / ppf + beatF; f += beatF) {
    const x = (f - sf) * ppf
    if (x < -1 || x > W + 1) continue
    const isBar = Math.abs(f % barF) < 0.5
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)'
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.setLineDash(isBar ? [] : [2, 4])
    ctx.beginPath()
    ctx.moveTo(x + 0.5, gridTop)
    ctx.lineTo(x + 0.5, gridTop + gridH)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2); ctx.beginPath()
  ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y); ctx.closePath()
}

function lighten(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${Math.min(255, ((n >> 16) & 255) + Math.round(a * 255))},${Math.min(255, ((n >> 8) & 255) + Math.round(a * 255))},${Math.min(255, (n & 255) + Math.round(a * 255))})`
}

function drawAudioLane(
  ctx: CanvasRenderingContext2D, W: number,
  audioTrack: Show['audioTrack'] | undefined,
  fps: number, pxPerFrame: number, scrollFrame: number,
  audioDuration: number,
  waveformInfo: WaveformInfo | null,
) {
  const laneY = RULER_H
  const laneH = AUDIO_LANE_H
  const color = audioTrack?.color ?? '#1ABC9C'

  ctx.fillStyle = '#080c0b'
  ctx.fillRect(0, laneY, W, laneH)

  if (!audioTrack || audioDuration === 0) {
    ctx.fillStyle = '#1a2420'
    ctx.fillRect(0, laneY, W, laneH)
    ctx.fillStyle = '#2a3830'
    ctx.font = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText('♪  Naloži avdio — klikni gumb v levem panelu', 14, laneY + laneH / 2)
    ctx.fillStyle = '#1e2e28'
    ctx.fillRect(0, laneY + laneH - 1, W, 1)
    return
  }

  const startF = smpteToFrames(audioTrack.startOffset || '00:00:00:00', fps)
  const durF = Math.round(audioDuration * fps)
  const ax = (startF - scrollFrame) * pxPerFrame
  const aw = Math.max(2, durF * pxPerFrame)
  const x0 = Math.max(0, ax)
  const x1 = Math.min(ax + aw, W)

  // Subtle tinted bg for entire audio block
  if (x1 > x0) {
    ctx.fillStyle = color + '0e'
    ctx.fillRect(x0, laneY, x1 - x0, laneH)
  }

  if (waveformInfo && waveformInfo.data.length > 0 && x1 > x0) {
    const { data, samplesPerPeak, sampleRate } = waveformInfo
    const centerY = laneY + laneH / 2
    const amplitude = laneH / 2 - 6

    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, laneY + 1, x1 - x0, laneH - 2)
    ctx.clip()

    // Build top and bottom paths pixel by pixel
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
      // Filled body — gradient top→center→bottom
      const grad = ctx.createLinearGradient(0, laneY, 0, laneY + laneH)
      grad.addColorStop(0,    color + '18')
      grad.addColorStop(0.3,  color + '66')
      grad.addColorStop(0.5,  color + '99')
      grad.addColorStop(0.7,  color + '66')
      grad.addColorStop(1,    color + '18')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(xs[0], tops[0])
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], tops[i])
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], bots[i])
      ctx.closePath()
      ctx.fill()

      // Top outline with glow
      ctx.strokeStyle = color + 'cc'
      ctx.lineWidth = 1.2
      ctx.shadowColor = color
      ctx.shadowBlur = 5
      ctx.beginPath()
      ctx.moveTo(xs[0], tops[0])
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], tops[i])
      ctx.stroke()

      // Bottom outline with glow
      ctx.beginPath()
      ctx.moveTo(xs[0], bots[0])
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], bots[i])
      ctx.stroke()
      ctx.shadowBlur = 0

      // Center line
      ctx.strokeStyle = color + '28'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 5])
      ctx.beginPath()
      ctx.moveTo(xs[0], centerY); ctx.lineTo(xs[xs.length - 1], centerY)
      ctx.stroke()
      ctx.setLineDash([])
    }

    ctx.restore()
  }

  // Left accent bar at audio start
  if (ax >= -1 && ax <= W) {
    ctx.fillStyle = color
    ctx.fillRect(Math.max(0, ax), laneY, 2, laneH)
  }

  // Filename label
  if (aw > 40) {
    const labelX = Math.max(ax + 6, 6)
    const labelW = Math.min(x1 - labelX - 4, W - labelX - 4)
    if (labelW > 10) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(labelX, laneY + 3, labelW, 14)
      ctx.clip()
      ctx.fillStyle = '#ffffff'
      ctx.globalAlpha = 0.75
      ctx.font = 'bold 10px monospace'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText(audioTrack.name, labelX, laneY + 4)
      ctx.restore()
      ctx.globalAlpha = 1
    }
  }

  // Bottom separator
  ctx.fillStyle = '#1e2e28'
  ctx.fillRect(0, laneY + laneH - 1, W, 1)
}
