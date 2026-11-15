import { useEffect, useRef } from 'react'
import { frameStore } from '../../frameStore'
import { T } from '../../theme'
import { barFrames, beatsToFrame, frameToBeats, type Tempo } from '../../grid'
import { clipAtFrame, sampleAt, type ShowModel } from '../../showModel'

// The next bars (or seconds) of the timeline, per layer, sliding towards the playhead: clips as
// blocks, the lanes as curves with their moves lit (blue = coming, mint = running now), the song
// sections as lines. One row per layer of the model, the same rows as the LAYER · NOW column
// beside it. Drawn from a requestAnimationFrame loop that reads frameStore, so the playhead never
// re-renders React; it repaints only when the frame, the size or the data change.

const BEHIND = 0.06   // of the window: a little of what just happened, left of the playhead

interface Props {
  model: ShowModel
  tempo: Tempo | null
  fps: number
  bars: number          // window with a tempo
  secs: number          // window without one
  labels: boolean       // layer names inside the rows (no LAYER · NOW column beside it)
  fixedFrame?: number   // a preview at a fixed position (the next timeline during a break)
  title?: string        // over the preview
}

export function Radar({ model, tempo, fps, bars, secs, labels, fixedFrame, title }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const span = tempo ? bars * barFrames(tempo.bpm, fps, tempo.beatsPerBar) : secs * fps
  // Ticks above the rows, from the playhead: "+2 BARS +4 +6 +8" / "+5 s +10 s +15 s"
  const steps = tempo ? 4 : 3
  const ticks = Array.from({ length: steps }, (_, i) => {
    const k = i + 1
    const label = tempo ? `+${(bars / steps) * k}${k === 1 ? ' BARS' : ''}` : `+${(secs / steps) * k} s`
    return { label, pct: (BEHIND + (k / steps) * (1 - BEHIND)) * 100 }
  })
  const view = useRef({ model, tempo, fps, span, labels, fixedFrame, title, dirty: true })
  view.current = { model, tempo, fps, span: span / (1 - BEHIND), labels, fixedFrame, title, dirty: true }

  useEffect(() => {
    const canvas = canvasRef.current!
    let raf = 0, lastF = NaN, w = 0, h = 0
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      w = canvas.clientWidth; h = canvas.clientHeight
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      view.current.dirty = true
    })
    ro.observe(canvas)
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const v = view.current
      const f = v.fixedFrame ?? frameStore.get()
      if (!v.dirty && f === lastF) return
      v.dirty = false; lastF = f
      const ctx = canvas.getContext('2d')
      if (!ctx || !w || !h) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw(ctx, w, h, f, v)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return (
    <section className="sv-radar" aria-label="What comes next, per layer">
      <div className="sv-colhead sv-radar-head">
        <span className="sv-tick now" style={{ left: `${BEHIND * 100}%` }}>NOW</span>
        {ticks.map(t => <span key={t.label} className="sv-tick" style={{ left: `${t.pct}%` }}>{t.label}</span>)}
      </div>
      <canvas ref={canvasRef} />
    </section>
  )
}

type View = { model: ShowModel; tempo: Tempo | null; fps: number; span: number; labels: boolean; title?: string }

function draw(ctx: CanvasRenderingContext2D, W: number, H: number, frame: number, v: View) {
  const { model, tempo, fps, span } = v
  const start = frame - span * BEHIND
  const x = (f: number) => (f - start) / span * W
  const xNow = x(frame)
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = T.gutter; ctx.fillRect(0, 0, W, H)
  const n = model.layers.length
  if (!n) {
    ctx.fillStyle = T.monitor; ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = T.textFaint; ctx.font = `14px ${T.fontUi}`; ctx.textAlign = 'center'
    ctx.fillText('No clips or automation on this timeline', W / 2, H / 2)
    ctx.textAlign = 'left'
    return
  }
  const rowH = (H - (n - 1)) / n
  const rowY = (i: number) => i * (rowH + 1)

  for (let i = 0; i < n; i++) { ctx.fillStyle = T.lane; ctx.fillRect(0, rowY(i), W, rowH) }

  // Grid: bar lines (stronger every 4 bars), or every 5 seconds
  ctx.lineWidth = 1
  if (tempo) {
    const bar = barFrames(tempo.bpm, fps, tempo.beatsPerBar)
    let b = Math.ceil(frameToBeats(start, tempo) / tempo.beatsPerBar)
    for (let f = beatsToFrame(b * tempo.beatsPerBar, tempo); f < start + span; f += bar, b++) {
      ctx.strokeStyle = b % 4 === 0 ? T.splitter : T.track
      line(ctx, Math.round(x(f)) + 0.5, 0, H)
    }
  } else {
    const step = 5 * fps
    for (let f = Math.ceil(start / step) * step; f < start + span; f += step) { ctx.strokeStyle = T.track; line(ctx, Math.round(x(f)) + 0.5, 0, H) }
  }

  ctx.textBaseline = 'middle'
  // Lane names are drawn after the section lines, on their own background, so a line never crosses one
  const laneLabels: { text: string; x: number; y: number; color: string }[] = []
  model.layers.forEach((layer, i) => {
    const y0 = rowY(i)
    ctx.save()
    ctx.beginPath(); ctx.rect(0, y0, W, rowH); ctx.clip()
    // Clips: a strip along the bottom of the row
    const ch = Math.max(14, Math.min(28, rowH * 0.34))
    const cy = y0 + rowH - ch - 3
    for (const c of layer.clips) {
      if (c.end <= start || c.start >= start + span) continue
      const x0 = Math.max(4, x(c.start)), x1 = Math.min(W, c.end === Infinity ? W : x(c.end))
      if (x1 - x0 < 1) continue
      ctx.fillStyle = c.color ?? layer.color ?? T.control
      ctx.fillRect(x0, cy, x1 - x0 - 1, ch)
      if (frame >= c.start && frame < c.end) { ctx.strokeStyle = T.live; ctx.lineWidth = 2; ctx.strokeRect(x0 + 1, cy + 1, x1 - x0 - 3, ch - 2) }
      // The clip on air names itself right of the playhead: not split by it, not under the dimmed past
      const tx = frame >= c.start && frame < c.end ? Math.max(x0, xNow + 2) : x0
      if (x1 - tx > 30) {
        ctx.save(); ctx.beginPath(); ctx.rect(tx, cy, x1 - tx - 4, ch); ctx.clip()
        ctx.fillStyle = T.textHi; ctx.font = `600 ${ch >= 22 ? 13 : 11}px ${T.fontUi}`
        ctx.fillText(c.name, tx + 6, cy + ch / 2 + 1)
        ctx.restore()
      }
    }
    // Lanes: curves over the rest of the row (top = 1, bottom = 0)
    // Room at the top for the names (and the section names over the first row)
    const top = y0 + (v.labels ? 54 : 36), bottom = cy - 6
    if (bottom - top >= 10) {
      const labelXs: number[] = []
      for (const lane of layer.lanes) {
        const yv = (val: number) => bottom - Math.max(0, Math.min(1, val)) * (bottom - top)
        const path = (f0: number, f1: number) => {
          ctx.beginPath()
          const xa = Math.max(0, x(f0)), xb = Math.min(W, x(f1))
          for (let px = xa; ; px += 3) {
            const p = Math.min(px, xb), s = sampleAt(lane, start + p / W * span)
            if (px === xa) ctx.moveTo(p, yv(s?.value ?? 0)); else ctx.lineTo(p, yv(s?.value ?? 0))
            if (p >= xb) break
          }
          ctx.stroke()
        }
        ctx.strokeStyle = 'rgba(154, 154, 154, 0.35)'; ctx.lineWidth = 1
        path(start, start + span)
        for (const m of lane.moves) {
          if (m.to < start || m.from > start + span) continue
          const running = m.from <= frame && frame < m.to
          const color = running ? T.live : m.from > frame ? T.next : T.textFaint
          ctx.strokeStyle = color; ctx.lineWidth = 2
          if (m.to === m.from) {
            const xs = x(m.from)
            ctx.beginPath(); ctx.moveTo(xs, yv(m.values[0])); ctx.lineTo(xs, yv(m.values[1])); ctx.stroke()
          } else path(m.from, m.to)
          // Its name where it starts (or at the playhead while it runs), unless one is drawn close by
          const lx = running ? xNow + 6 : x(m.from) + 4
          if ((running || m.from > frame) && lx < W - 60 && labelXs.every(x0 => Math.abs(lx - x0) >= 70)) {
            laneLabels.push({ text: lane.name, x: lx, y: top - 11, color })
            labelXs.push(lx)
          }
        }
      }
    }
    // Layer colour rail
    ctx.fillStyle = layer.color ?? T.splitter; ctx.fillRect(0, y0, 3, rowH)
    ctx.restore()
  })

  // What already happened: dimmed
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'; ctx.fillRect(0, 0, xNow, H)

  // Song sections: a line through every row, the name at the top
  for (const s of model.sections) {
    if (s.start < start || s.start > start + span) continue
    const xs = Math.round(x(s.start))
    ctx.strokeStyle = s.marker.color; ctx.lineWidth = 2; line(ctx, xs, 0, H)
    ctx.font = `800 11px ${T.fontUi}`
    const label = `◆ ${s.marker.name || 'marker'}`, lw = ctx.measureText(label).width
    const lx = xs + lw + 10 > W ? xs - lw - 11 : xs + 1   // near the right edge: left of the line
    ctx.fillStyle = T.gutter; ctx.fillRect(lx, 0, lw + 10, 16)
    ctx.fillStyle = s.marker.color; ctx.fillText(label, lx + 4, 9)
  }

  ctx.font = `700 11px ${T.fontUi}`
  for (const l of laneLabels) {
    ctx.fillStyle = T.lane; ctx.fillRect(l.x - 3, l.y - 8, ctx.measureText(l.text).width + 6, 16)
    ctx.fillStyle = l.color; ctx.fillText(l.text, l.x, l.y)
  }

  // Playhead
  ctx.fillStyle = T.live; ctx.fillRect(Math.round(xNow) - 1, 0, 2, H)

  // Portrait: each layer's name and its clip on air, over everything (the playhead runs under it)
  if (v.labels) model.layers.forEach((layer, i) => {
    const y0 = rowY(i)
    const clip = clipAtFrame(layer, frame)
    ctx.font = `800 12px ${T.fontUi}`
    const name = `${layer.tag} ${layer.name}`
    const w1 = ctx.measureText(name).width
    ctx.font = `600 12px ${T.fontUi}`
    const w2 = clip ? ctx.measureText(`▶ ${clip.name}`).width + 10 : 0
    // Under the section names (they run across the top of the canvas)
    const ly = y0 + 18
    ctx.fillStyle = T.lane; ctx.fillRect(4, ly, w1 + w2 + 14, 20)
    ctx.fillStyle = T.textHi; ctx.font = `800 12px ${T.fontUi}`; ctx.fillText(name, 10, ly + 10)
    if (clip) { ctx.fillStyle = T.live; ctx.font = `600 12px ${T.fontUi}`; ctx.fillText(`▶ ${clip.name}`, 10 + w1 + 10, ly + 10) }
  })

  if (v.title) {
    ctx.font = `800 13px ${T.fontUi}`
    const tw = ctx.measureText(v.title).width
    ctx.fillStyle = T.next; ctx.fillRect(W / 2 - tw / 2 - 12, H / 2 - 16, tw + 24, 32)
    ctx.fillStyle = T.textOnLive; ctx.textAlign = 'center'; ctx.fillText(v.title, W / 2, H / 2 + 1); ctx.textAlign = 'left'
  }
}

function line(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number) {
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
}
