// Overview strip above the timeline ruler: the whole show at a glance (one thin row per
// layer, markers, playhead) with the main view's visible window as a draggable lens.
// Click = centre the view there, drag the lens = scroll, drag its edges = zoom,
// double-click = seek (not in SHOW mode while playing).
//
// Drawing is split in two: the show content goes to an offscreen bitmap that is rebuilt only
// when the show, width or overall range change; every tick just blits it and draws the lens
// and the playhead on top, so 3 h shows with hundreds of cues stay cheap.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TOUCH } from '../touch'
import { useFrame } from '../frameStore'
import type { Track, LayerTrack, GroupTrack, Marker } from '../../../shared/show'
import { T, TAG_COLORS } from '../theme'
import { deckOfCue, type DeckInfo } from '../decks'
import { smpteToFrames, framesToSmpte } from './timeUtils'

const BAR_H = 28          // keep in sync with .overview-bar in canvas.css
const PAD_Y = 3
const MAX_ROWS = 8        // more layers than this: several layers share a row
const MAX_ROW_H = 8
const EDGE_HIT = TOUCH ? 14 : 5        // px around a lens edge that grab the edge (zoom)
const MIN_LENS_W = 8      // the lens never draws thinner than this, so it stays grabbable
import { PPF_MIN, PPF_MAX } from '../layout'   // same clamp as the main view's Cmd+wheel zoom
// Grid step candidates in seconds; the first one at least GRID_MIN_PX apart is used
const GRID_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600]
const GRID_MIN_PX = 40

interface Bar { row: number; sf: number; ef: number; color: string; deck: string | null; muted: boolean }
interface Model { rows: number; bars: Bar[]; markers: { f: number; color: string }[]; contentEnd: number }

function buildModel(tracks: Track[], markers: Marker[], fps: number, decks: DeckInfo[]): Model {
  const groups = new Map<number, GroupTrack>()
  for (const t of tracks) if (t.type === 'group') groups.set((t as GroupTrack).resolumeGroupId, t as GroupTrack)
  const groupSlot = new Map<number, number>()
  const bars: Bar[] = []
  const multiDeck = decks.length > 1
  let slots = 0, contentEnd = 0
  const kfEnd = (autos: { keyframes: { time: string }[] }[]) => {
    for (const a of autos) for (const k of a.keyframes) contentEnd = Math.max(contentEnd, smpteToFrames(k.time, fps))
  }

  for (const t of tracks) {
    if (t.type === 'group') {
      const g = t as GroupTrack
      kfEnd(g.automations)
      // A collapsed group is one row with all its members' cues (like its row in the main view)
      if (g.collapsed) groupSlot.set(g.resolumeGroupId, slots++)
      continue
    }
    if (t.type !== 'layer') continue
    const lt = t as LayerTrack
    kfEnd(lt.automations)
    const g = lt.groupId !== undefined ? groups.get(lt.groupId) : undefined
    const slot = (g?.collapsed ? groupSlot.get(g.resolumeGroupId) : undefined) ?? slots++
    const muted = !!(lt.muted || g?.muted)
    const trackColor = lt.color ?? TAG_COLORS[0]
    for (const c of lt.clips) {
      const sf = smpteToFrames(c.time, fps)
      const ef = sf + Math.max(0, smpteToFrames(c.duration, fps))
      contentEnd = Math.max(contentEnd, ef)
      const deck = multiDeck && (c.deckId !== undefined || c.deckIndex !== undefined)
        ? (deckOfCue(decks, c)?.color ?? T.danger) : null
      bars.push({ row: slot, sf, ef, color: c.color ?? c.resolumeColor ?? trackColor, deck, muted })
    }
  }

  const rows = Math.min(slots, MAX_ROWS)
  if (slots > MAX_ROWS) for (const b of bars) b.row = Math.floor(b.row * MAX_ROWS / slots)
  const mks = markers.map(m => ({ f: smpteToFrames(m.time, fps), color: m.color || T.loop }))
  for (const m of mks) contentEnd = Math.max(contentEnd, m.f)
  return { rows, bars, markers: mks, contentEnd }
}

/** Show content over [0, total) frames into a device-pixel bitmap. */
function drawStatic(model: Model, w: number, dpr: number, total: number, fps: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.round(BAR_H * dpr)
  const ctx = cv.getContext('2d')
  if (!ctx) return cv
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const k = w / total

  ctx.fillStyle = T.lane; ctx.fillRect(0, 0, w, BAR_H)

  // Faint time grid (hours a little brighter)
  if (fps > 0) {
    const step = GRID_STEPS.find(s => s * fps * k >= GRID_MIN_PX) ?? GRID_STEPS[GRID_STEPS.length - 1]
    for (let s = step; s * fps < total; s += step) {
      ctx.fillStyle = s % 3600 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'
      ctx.fillRect(Math.round(s * fps * k), 0, 1, BAR_H)
    }
  }

  // Cue rows
  if (model.rows > 0) {
    const avail = BAR_H - PAD_Y * 2
    const rowH = Math.max(1, Math.min(MAX_ROW_H, Math.floor(avail / model.rows)))
    const y0 = PAD_Y + Math.floor((avail - rowH * model.rows) / 2)
    const bh = rowH >= 3 ? rowH - 1 : rowH
    for (const b of model.bars) {
      const x0 = Math.round(b.sf * k)
      const bw = Math.max(1, Math.round(b.ef * k) - x0)
      if (x0 > w) continue
      const y = y0 + b.row * rowH
      ctx.globalAlpha = b.muted ? 0.35 : 0.9
      ctx.fillStyle = b.color; ctx.fillRect(x0, y, bw, bh)
      if (b.deck) { ctx.globalAlpha = 1; ctx.fillStyle = b.deck; ctx.fillRect(x0, y, Math.min(2, bw), bh) }
    }
    ctx.globalAlpha = 1
  }

  // Markers: thin ticks in their colour, small diamond-ish cap on top
  for (const m of model.markers) {
    const x = Math.round(m.f * k)
    if (x > w) continue
    ctx.fillStyle = m.color
    ctx.globalAlpha = 0.75; ctx.fillRect(x, 0, 1, BAR_H)
    ctx.globalAlpha = 1; ctx.fillRect(x - 1, 0, 3, 3)
  }
  ctx.globalAlpha = 1
  return cv
}

interface Props {
  tracks: Track[]
  markers: Marker[]
  fps: number
  decks: DeckInfo[]
  endFrame: number          // App's last frame with content (cues, audio)
  playing: boolean
  readOnly: boolean         // SHOW mode: navigation works, double-click seek is off while playing
  scrollFrame: number
  pxPerFrame: number
  onScrollFrame: (f: number) => void
  onPxPerFrame: (ppf: number) => void
  onSeek: (f: number) => void
}

type Drag = { mode: 'move' | 'left' | 'right'; grab: number; total: number; w: number; start: number; end: number }

export function OverviewBar({
  tracks, markers, fps, decks, endFrame, playing, readOnly,
  scrollFrame, pxPerFrame, onScrollFrame, onPxPerFrame, onSeek,
}: Props) {
  const frame = useFrame()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, dpr: window.devicePixelRatio || 1 })
  const dragRef = useRef<Drag | null>(null)
  const [frozenTotal, setFrozenTotal] = useState<number | null>(null)

  // App rebuilds `decks` on every render; key it by content so the model isn't rebuilt per tick
  const deckKey = decks.map(d => `${d.id}:${d.index}:${d.name}:${d.color}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableDecks = useMemo(() => decks, [deckKey])
  const model = useMemo(() => buildModel(tracks, markers, fps, stableDecks), [tracks, markers, fps, stableDecks])

  const { w, dpr } = size
  const visF = w > 0 && pxPerFrame > 0 ? w / pxPerFrame : 0
  const contentEnd = Math.max(model.contentEnd, endFrame)
  // Whole range: content (+2% air), at least a minute, and wide enough to hold the view.
  // Frozen while dragging so the lens doesn't slide under the pointer.
  const total = frozenTotal ?? Math.max(Math.ceil(contentEnd * 1.02), fps * 60, Math.ceil(scrollFrame + visF), 1)

  const staticBmp = useMemo(
    () => (w > 0 ? drawStatic(model, w, dpr, total, fps) : null),
    [model, w, dpr, total, fps])

  // Lens in CSS px, widened around its centre to MIN_LENS_W
  const lensOf = useCallback((sf: number, vf: number, tot: number, width: number) => {
    let x0 = sf / tot * width, x1 = (sf + vf) / tot * width
    if (x1 - x0 < MIN_LENS_W) { const c = (x0 + x1) / 2; x0 = c - MIN_LENS_W / 2; x1 = c + MIN_LENS_W / 2 }
    return { x0, x1 }
  }, [])

  // ── Size / DPR ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setSize(s => {
      const nw = el.clientWidth, nd = window.devicePixelRatio || 1
      return s.w === nw && s.dpr === nd ? s : { w: nw, dpr: nd }
    })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    let mq: MediaQueryList | null = null
    const onDpr = () => { measure(); watch() }
    const watch = () => {
      mq?.removeEventListener('change', onDpr)
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', onDpr)
    }
    watch(); measure()
    return () => { ro.disconnect(); mq?.removeEventListener('change', onDpr) }
  }, [])

  // ── Draw: blit content, dim outside the lens, lens frame, playhead ──────
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !staticBmp || w === 0) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const bw = staticBmp.width, bh = staticBmp.height
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh
      cv.style.width = `${w}px`; cv.style.height = `${BAR_H}px`
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(staticBmp, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const { x0, x1 } = lensOf(scrollFrame, visF, total, w)
    const lx0 = Math.round(x0), lx1 = Math.round(x1)
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    if (lx0 > 0) ctx.fillRect(0, 0, lx0, BAR_H)
    if (lx1 < w) ctx.fillRect(lx1, 0, w - lx1, BAR_H)
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(lx0, 0, lx1 - lx0, BAR_H)
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1
    ctx.strokeRect(lx0 + 0.5, 0.5, lx1 - lx0 - 1, BAR_H - 1)
    // Edge grips
    if (lx1 - lx0 >= 12) {
      ctx.fillStyle = T.text
      const gy = Math.round(BAR_H / 2) - 5
      ctx.fillRect(lx0 + 1, gy, 2, 10); ctx.fillRect(lx1 - 3, gy, 2, 10)
    }

    // Playhead (same mint and cap as the main view)
    const px = Math.round(frame / total * w)
    if (px >= -4 && px <= w + 4) {
      ctx.fillStyle = T.live
      ctx.fillRect(px - 1, 0, 2, BAR_H)
      ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 5); ctx.closePath(); ctx.fill()
    }
  }, [staticBmp, w, dpr, total, scrollFrame, visF, frame, lensOf])

  // ── Interaction ─────────────────────────────────────────────────────────
  const live = useRef({ scrollFrame, pxPerFrame, total, w, visF })
  live.current = { scrollFrame, pxPerFrame, total, w, visF }

  const localX = (e: { clientX: number }) => {
    const r = canvasRef.current?.getBoundingClientRect()
    return r ? e.clientX - r.left : 0
  }
  const clampPpf = (p: number) => Math.max(PPF_MIN, Math.min(PPF_MAX, p))

  const hitLens = (x: number): Drag['mode'] | null => {
    const { scrollFrame: sf, total: tot, w: width, visF: vf } = live.current
    const { x0, x1 } = lensOf(sf, vf, tot, width)
    // A narrow lens is all body (edges grab just outside it), a wide one keeps 3px edge bands inside
    const m = x1 - x0 >= 16 ? 3 : 0
    if (x >= x0 + m && x <= x1 - m) return 'move'
    if (Math.abs(x - x0) <= EDGE_HIT) return 'left'
    if (Math.abs(x - x1) <= EDGE_HIT) return 'right'
    return null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || w === 0) return
    const { scrollFrame: sf, total: tot, w: width, visF: vf } = live.current
    const x = localX(e), f = x / width * tot
    let mode = hitLens(x)
    let start = sf
    if (!mode) {
      // Jump: centre the view on the click, then keep dragging the lens
      start = Math.max(0, Math.min(f - vf / 2, Math.max(0, tot - vf)))
      onScrollFrame(start)
      mode = 'move'
    }
    dragRef.current = { mode, grab: f - start, total: tot, w: width, start, end: start + vf }
    setFrozenTotal(tot)
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize'
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = localX(e)
    const d = dragRef.current
    if (!d) {
      const m = hitLens(x)
      e.currentTarget.style.cursor = m === 'move' ? 'grab' : m ? 'ew-resize' : 'pointer'
      return
    }
    const f = Math.max(0, Math.min(d.total, x / d.w * d.total))
    const vf = d.end - d.start
    if (d.mode === 'move') {
      onScrollFrame(Math.max(0, Math.min(f - d.grab, Math.max(0, d.total - vf))))
    } else if (d.mode === 'right') {
      // Left end stays, right end follows the pointer
      onPxPerFrame(clampPpf(d.w / Math.max(1e-3, f - d.start)))
    } else {
      // Right end stays, left end follows the pointer
      const ppf = clampPpf(d.w / Math.max(1e-3, d.end - f))
      onPxPerFrame(ppf)
      onScrollFrame(Math.max(0, d.end - d.w / ppf))
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setFrozenTotal(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const m = hitLens(localX(e))
    e.currentTarget.style.cursor = m === 'move' ? 'grab' : m ? 'ew-resize' : 'pointer'
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (readOnly && playing) return
    const { total: tot, w: width } = live.current
    if (width === 0) return
    onSeek(Math.max(0, Math.round(localX(e) / width * tot)))
  }

  const lengthTc = contentEnd > 0 && fps > 0 ? framesToSmpte(contentEnd, fps).slice(0, 8) : ''

  return (
    <div className="overview-bar">
      <div className="overview-label">
        <span>Overview</span>
        {lengthTc && <span className="overview-length mono" title="Show length">{lengthTc}</span>}
      </div>
      <div ref={wrapRef} className="overview-canvas">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
          title={readOnly && playing
            ? 'Click: centre view · drag: scroll · drag edges: zoom'
            : 'Click: centre view · drag: scroll · drag edges: zoom · double-click: seek'}
        />
      </div>
    </div>
  )
}
