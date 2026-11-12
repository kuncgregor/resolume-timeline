import { useEffect, useRef, useState } from 'react'
import type { LayerTrack, ClipCue, AutomationSubTrack } from '../../../shared/show'
import { framesToSmpte, smpteToFrames } from './timeUtils'

const api = (window as any).timeline

interface Param { name: string; oscAddress: string; value: number; min?: number; max?: number; valuetype: string; paramId?: number }

// Resolume OSC addresses use lower-case names without spaces: "Position X" → "positionx"
const oscSeg = (name: string) => name.toLowerCase().replace(/[\s()\-]/g, '')

function extractParams(obj: any, base: string, depth = 0): Param[] {
  if (!obj || typeof obj !== 'object' || depth > 8) return []
  const result: Param[] = []

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (!item) continue
      const nameVal = item.name?.value ?? item.name
      const seg = typeof nameVal === 'string' ? oscSeg(nameVal) : null

      // Handle {name, value: {valuetype, value}} pattern — Resolume params array items
      const valObj = item.value
      if (seg && valObj && 'valuetype' in valObj && 'value' in valObj && typeof valObj.value === 'number') {
        result.push({
          name: String(nameVal),
          oscAddress: `${base}/${seg}`,
          value: valObj.value, min: valObj.min, max: valObj.max, valuetype: valObj.valuetype,
          paramId: valObj.id,
        })
      } else {
        result.push(...extractParams(item, seg ? `${base}/${seg}` : base, depth + 1))
      }
    }
    return result
  }

  for (const [key, val] of Object.entries(obj)) {
    if (['id', 'name', 'thumbnail', 'clips', 'connected', 'bypassed'].includes(key)) continue
    if (!val || typeof val !== 'object') continue
    const v = val as any
    if ('valuetype' in v && 'value' in v && typeof v.value === 'number') {
      result.push({ name: key, oscAddress: `${base}/${oscSeg(key)}`, value: v.value, min: v.min, max: v.max, valuetype: v.valuetype, paramId: v.id })
    } else {
      // 'params' in Resolume REST is a transparent wrapper — skip it in the OSC path
      const nextBase = (key === 'params') ? base : `${base}/${oscSeg(key)}`
      result.push(...extractParams(val, nextBase, depth + 1))
    }
  }
  return result
}

let uid = 1
// Ids are saved in show files, so they must not repeat across app launches
const newId = () => `auto-${Date.now()}-${uid++}`
const ACOLS = ['#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E91E63']
let ci = 0

// Section name for a param: the path segment right before its name ("…/video/opacity" → "video")
function groupOf(addr: string) {
  const segs = addr.split('/')
  const g = segs[segs.length - 2]
  return !g || /^\d+$/.test(g) ? 'general' : g
}

// Slider fill: CSS reads the percentage from --pct
const pct = (v: number, min: number, max: number) =>
  ({ '--pct': `${max > min ? ((v - min) / (max - min)) * 100 : 0}%` }) as React.CSSProperties

interface Props {
  track: LayerTrack | null; cue: ClipCue | null
  cueIdx: number | null; trackIdx: number | null; fps: number
  height: number
  readOnly: boolean
  onResize: (h: number) => void
  onUpdateCue: (ti: number, ci: number, u: Partial<ClipCue>) => void
  onDeleteCue: (ti: number, ci: number) => void
  onAddAutomation: (ti: number, sub: AutomationSubTrack) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onClose: () => void
}

export function BottomPanel({
  track, cue, cueIdx, trackIdx, fps, height, readOnly, onResize,
  onUpdateCue, onDeleteCue, onAddAutomation, onSelectCue, onClose,
}: Props) {
  const [tab, setTab] = useState<'cue' | 'layer' | 'clip'>('cue')
  const [layerParams, setLayerParams] = useState<Param[]>([])
  const [clipParams, setClipParams] = useState<Param[]>([])
  const [loadingParams, setLoadingParams] = useState(false)
  const [delArmed, setDelArmed] = useState(false)

  // Resize logic
  const resizingRef = useRef(false)
  const startRef = useRef({ y: 0, h: 0 })

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = startRef.current.y - e.clientY
      onResize(Math.max(80, Math.min(500, startRef.current.h + delta)))
    }
    const onUp = () => { resizingRef.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [onResize])

  useEffect(() => {
    if (!track || !cue) { setLayerParams([]); setClipParams([]); return }
    setLoadingParams(true)
    // A slower response for a previously selected clip must not overwrite this one
    let cancelled = false
    Promise.all([
      api.getLayerRaw(track.resolumeLayerIndex),
      api.getClipRaw(track.resolumeLayerIndex, cue.clipIndex),
    ]).then(([lr, cr]) => {
      if (cancelled) return
      const base = `/composition/layers/${track.resolumeLayerIndex}`
      setLayerParams(extractParams(lr, base).filter(p => p.name !== 'name').slice(0, 60))
      setClipParams(extractParams(cr, `${base}/clips/${cue.clipIndex}`).filter(p => p.name !== 'name').slice(0, 60))
      setLoadingParams(false)
    }).catch(() => { if (!cancelled) setLoadingParams(false) })
    return () => { cancelled = true }
  }, [track?.resolumeLayerIndex, cue?.clipIndex])

  useEffect(() => { setDelArmed(false) }, [cue?.id])

  const handle = (
    <div
      className="bp-resize-handle"
      onMouseDown={e => { resizingRef.current = true; startRef.current = { y: e.clientY, h: height } }}
    />
  )
  const roChip = readOnly && <span className="chip">SHOW · samo branje</span>
  const closeBtn = <button className="btn ghost bp-icon" onClick={onClose} title="Zapri">✕</button>
  const title = (t: LayerTrack, sub: string) => (
    <div className="bp-title">
      <span className="bp-stripe" style={{ background: t.color ?? 'var(--text-faint)' }} />
      <span className="bp-layer">{t.name}</span>
      <span className="bp-sep">›</span>
      <span className="bp-clip" title={sub}>{sub}</span>
    </div>
  )
  const fire = (t: LayerTrack, c: ClipCue) => api.triggerClip(t.resolumeLayerIndex, c.clipIndex)

  // CUE LIST view — track is selected (LayerTrack) but no specific clip
  if (track && trackIdx != null && cueIdx == null) {
    return (
      <div className="bottom-panel" style={{ height }}>
        {handle}
        <div className="bp-header">
          {title(track, `${track.clips.length} clipov`)}
          <div className="bp-actions">{roChip}{closeBtn}</div>
        </div>
        <div className="bp-body">
          {track.clips.length === 0 ? (
            <div className="bp-empty">Ni clipov v tem layerju. Povleci clip iz brskalnika.</div>
          ) : (
            <div className="bp-cue-list">
              {track.clips.map((c, ci) => {
                const durF = smpteToFrames(c.duration, fps)
                return (
                  <div key={c.id} className="bp-cue-row" tabIndex={0}
                    onClick={() => onSelectCue(trackIdx, ci)}
                    onKeyDown={e => { if (e.key === 'Enter') onSelectCue(trackIdx, ci) }}>
                    <span className="bp-cue-swatch" style={{ background: c.color ?? track.color ?? 'var(--text-faint)' }} />
                    <span className="bp-cue-slot">#{c.clipIndex}</span>
                    <span className="bp-cue-name" title={c.clipName}>{c.clipName || `Clip ${c.clipIndex}`}</span>
                    <span className="bp-cue-time mono">{c.time}</span>
                    <span className="bp-cue-dur mono">{durF === 0 ? 'TRIGGER' : c.duration}</span>
                    <button className="btn bp-fire bp-icon" title="Sproži clip v Resolume"
                      onClick={e => { e.stopPropagation(); fire(track, c) }}>▶</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!track || !cue || trackIdx == null || cueIdx == null) {
    return (
      <div className="bottom-panel empty">
        <span>Klikni na layer ali clip v timelineu</span>
        {roChip}
      </div>
    )
  }

  const durFrame = smpteToFrames(cue.duration, fps)
  const durMax = Math.max(fps * 60, durFrame * 2)
  const setDur = (f: number) => onUpdateCue(trackIdx, cueIdx, { duration: framesToSmpte(Math.max(0, f), fps) })
  const automated = new Set(track.automations.map(a => a.target))

  // Layer params stay at absolute times; clip params move with this clip
  const addAuto = (p: Param) => {
    onAddAutomation(trackIdx, {
      id: newId(), name: p.name, target: p.oscAddress,
      paramId: p.paramId, min: p.min, max: p.max,
      ...(tab === 'layer' ? { layerBound: true } : { clipId: cue.id }),
      color: ACOLS[ci++ % ACOLS.length], keyframes: [],
    })
  }

  return (
    <div className="bottom-panel" style={{ height }}>
      {handle}

      <div className="bp-header">
        {title(track, cue.clipName || `Clip ${cue.clipIndex}`)}

        <div className="bp-tabs">
          {(['cue', 'layer', 'clip'] as const).map(t => (
            <button key={t} className={`bp-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'cue' ? 'Cue' : t === 'layer' ? 'Layer' : 'Clip'}
            </button>
          ))}
        </div>

        <div className="bp-actions">
          {roChip}
          <button
            className={`btn ${delArmed ? 'on-danger' : 'ghost'}`}
            disabled={readOnly}
            onClick={() => { if (delArmed) onDeleteCue(trackIdx, cueIdx); else setDelArmed(true) }}
            onMouseLeave={() => setDelArmed(false)}
            title="Izbriši cue (dva klika)"
          >{delArmed ? 'Potrdi brisanje' : 'Izbriši'}</button>
          {closeBtn}
        </div>
      </div>

      <div className="bp-body">
        {tab === 'cue' && (
          <div className="bp-props">
            <div className="bp-row">
              <span className="bp-label">Layer</span>
              <span className="bp-val">L{track.resolumeLayerIndex} — {track.name}</span>
            </div>
            <div className="bp-row">
              <span className="bp-label">Clip slot</span>
              <span className="bp-val mono">{cue.clipIndex}</span>
            </div>
            <div className="bp-row">
              <span className="bp-label">Start</span>
              <span className="bp-val mono">{cue.time}</span>
            </div>
            <div className="bp-row">
              <span className="bp-label">Duration</span>
              <span className="bp-val mono bp-num">{cue.duration}</span>
              <button className="btn ghost bp-icon" disabled={readOnly || durFrame === 0}
                onClick={() => setDur(durFrame - 1)} title="−1 sličica">−</button>
              <input type="range" className="bp-slider bp-dur-slider" min={0} max={durMax} value={durFrame}
                style={pct(durFrame, 0, durMax)} disabled={readOnly}
                onChange={e => setDur(Number(e.target.value))} />
              <button className="btn ghost bp-icon" disabled={readOnly}
                onClick={() => setDur(durFrame + 1)} title="+1 sličica">+</button>
              {durFrame === 0 && <span className="chip next" title="Trajanje 0: samo sproži, brez samodejnega izklopa">Trigger</span>}
            </div>
            <div className="bp-row">
              <span className="bp-label">Release</span>
              <label className="bp-toggle">
                <input type="checkbox" checked={cue.release} disabled={readOnly}
                  onChange={e => onUpdateCue(trackIdx, cueIdx, { release: e.target.checked })} />
                <span>{cue.release ? 'Vklopljeno' : 'Izklopljeno'}</span>
              </label>
            </div>
            <div className="bp-row bp-row-action">
              <span className="bp-label" />
              <button className="btn bp-fire" onClick={() => fire(track, cue)}>▶ Fire</button>
            </div>
          </div>
        )}

        {(tab === 'layer' || tab === 'clip') && (
          <ParamList
            key={tab}
            params={tab === 'layer' ? layerParams : clipParams}
            loading={loadingParams}
            automated={automated}
            readOnly={readOnly}
            onAdd={addAuto}
            onSend={(addr, v) => api.sendOsc(addr, v)}
          />
        )}
      </div>
    </div>
  )
}

function ParamList({ params, loading, automated, readOnly, onAdd, onSend }: {
  params: Param[]; loading: boolean; automated: Set<string>; readOnly: boolean
  onAdd: (p: Param) => void; onSend: (addr: string, v: number) => void
}) {
  const [vals, setVals] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => {
    const m: Record<string, number> = {}
    params.forEach(p => { m[p.oscAddress] = p.value })
    setVals(m)
  }, [params])

  if (loading) return <div className="bp-empty">Nalagam…</div>
  if (!params.length) return <div className="bp-empty">Ni parametrov. Resolume mora biti odprt.</div>

  const groups = new Map<string, Param[]>()
  for (const p of params) {
    const g = groupOf(p.oscAddress)
    groups.set(g, [...(groups.get(g) ?? []), p])
  }
  const toggle = (g: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    return next
  })

  return (
    <div className="bp-params">
      {[...groups].map(([g, ps]) => {
        const open = !collapsed.has(g)
        return (
          <div key={g}>
            <button className="bp-section" onClick={() => toggle(g)}>
              <span className="bp-arrow">{open ? '▾' : '▸'}</span>
              <span>{g}</span>
              <span className="bp-section-count">{ps.length}</span>
            </button>
            {open && <div className="bp-param-grid">{ps.map(p => {
              const val = vals[p.oscAddress] ?? p.value
              const min = p.min ?? 0
              const max = p.max ?? 1
              const isAuto = automated.has(p.oscAddress)
              return (
                <div key={p.oscAddress} className="bp-row bp-param">
                  <span className="bp-label" title={`${p.name}\n${p.oscAddress}`}>{p.name}</span>
                  <span className="bp-val mono bp-num">{val.toFixed(max > 10 ? 0 : 3)}</span>
                  <input type="range" className="bp-slider" min={min} max={max} step={max > 10 ? 1 : 0.001}
                    value={val} style={pct(val, min, max)} disabled={readOnly}
                    onChange={e => {
                      const v = Number(e.target.value)
                      setVals(prev => ({ ...prev, [p.oscAddress]: v }))
                      // Resolume's OSC input takes ranged parameters normalized to 0..1
                      onSend(p.oscAddress, max > min ? (v - min) / (max - min) : v)
                    }}
                  />
                  <button className={`btn ghost bp-icon bp-auto ${isAuto ? 'on' : ''}`}
                    // A second lane on the same target would fight the first one
                    disabled={readOnly || isAuto} onClick={() => onAdd(p)}
                    title={isAuto ? 'Parameter je že avtomatiziran na tej stezi' : 'Dodaj avtomatizacijo'}
                  >{isAuto ? '◆' : '◇'}</button>
                </div>
              )
            })}</div>}
          </div>
        )
      })}
    </div>
  )
}
