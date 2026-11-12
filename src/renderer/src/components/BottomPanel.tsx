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

interface Props {
  track: LayerTrack | null; cue: ClipCue | null
  cueIdx: number | null; trackIdx: number | null; fps: number
  height: number
  onResize: (h: number) => void
  onUpdateCue: (ti: number, ci: number, u: Partial<ClipCue>) => void
  onDeleteCue: (ti: number, ci: number) => void
  onAddAutomation: (ti: number, sub: AutomationSubTrack) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onClose: () => void
}

export function BottomPanel({
  track, cue, cueIdx, trackIdx, fps, height, onResize,
  onUpdateCue, onDeleteCue, onAddAutomation, onSelectCue, onClose,
}: Props) {
  const [tab, setTab] = useState<'cue' | 'layer' | 'clip'>('cue')
  const [layerParams, setLayerParams] = useState<Param[]>([])
  const [clipParams, setClipParams] = useState<Param[]>([])
  const [loadingParams, setLoadingParams] = useState(false)

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
    Promise.all([
      api.getLayerRaw(track.resolumeLayerIndex),
      api.getClipRaw(track.resolumeLayerIndex, cue.clipIndex),
    ]).then(([lr, cr]) => {
      const base = `/composition/layers/${track.resolumeLayerIndex}`
      setLayerParams(extractParams(lr, base).filter(p => p.name !== 'name').slice(0, 60))
      setClipParams(extractParams(cr, `${base}/clips/${cue.clipIndex}`).filter(p => p.name !== 'name').slice(0, 60))
      setLoadingParams(false)
    })
  }, [track?.resolumeLayerIndex, cue?.clipIndex])

  // CUE LIST view — track is selected (LayerTrack) but no specific clip
  if (track && trackIdx != null && cueIdx == null) {
    return (
      <div className="bottom-panel" style={{ height }}>
        <div
          className="bp-resize-handle"
          onMouseDown={e => { resizingRef.current = true; startRef.current = { y: e.clientY, h: height } }}
        />
        <div className="bp-header">
          <div className="bp-title">
            <span className="bp-layer" style={{ color: track.color }}>{track.name}</span>
            <span className="bp-sep">›</span>
            <span className="bp-clip">{track.clips.length} clipov</span>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="bp-body" style={{ padding: 0 }}>
          {track.clips.length === 0 ? (
            <div className="bp-empty" style={{ padding: 14 }}>Ni clipov v tem layerju. Povleci clip iz brskalnika.</div>
          ) : (
            <div className="cue-list">
              {track.clips.map((c, ci) => {
                const sw = c.color ?? track.color ?? '#666'
                const durF = smpteToFrames(c.duration, fps)
                return (
                  <div key={c.id} className="cue-row" onClick={() => onSelectCue(trackIdx, ci)}>
                    <span className="cue-row-swatch" style={{ background: sw }} />
                    <span className="cue-row-slot">#{c.clipIndex}</span>
                    <span className="cue-row-name" title={c.clipName}>{c.clipName || `Clip ${c.clipIndex}`}</span>
                    <span className="cue-row-time mono">{c.time}</span>
                    <span className="cue-row-dur mono">{durF === 0 ? 'trigger' : c.duration}</span>
                    <button
                      className="btn-fire cue-row-fire"
                      onClick={e => { e.stopPropagation(); api.triggerClip(track.resolumeLayerIndex, c.clipIndex) }}
                    >▶ Fire</button>
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
      <div className="bottom-panel empty" style={{ height: 36 }}>
        <span>Klikni na layer ali clip v timelineu</span>
      </div>
    )
  }

  const durFrame = smpteToFrames(cue.duration, fps)

  // Layer params stay at absolute times; clip params move with this clip
  const addAuto = (p: Param) => {
    onAddAutomation(trackIdx, {
      id: newId(), name: p.name, target: p.oscAddress,
      paramId: p.paramId,
      ...(tab === 'layer' ? { layerBound: true } : { clipId: cue.id }),
      color: ACOLS[ci++ % ACOLS.length], keyframes: [],
    })
  }

  return (
    <div className="bottom-panel" style={{ height }}>
      {/* Drag handle at top */}
      <div
        className="bp-resize-handle"
        onMouseDown={e => { resizingRef.current = true; startRef.current = { y: e.clientY, h: height } }}
      />

      <div className="bp-header">
        <div className="bp-title">
          <span className="bp-layer" style={{ color: track.color }}>
            {track.name}
          </span>
          <span className="bp-sep">›</span>
          <span className="bp-clip">{cue.clipName || `Clip ${cue.clipIndex}`}</span>
        </div>

        <div className="bp-tabs" style={{ marginLeft: 10 }}>
          {(['cue', 'layer', 'clip'] as const).map(t => (
            <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'cue' ? 'Cue' : t === 'layer' ? 'Layer' : 'Clip'}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          <button className="btn-sm dng" onClick={() => onDeleteCue(trackIdx, cueIdx)}>Del</button>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="bp-body">
        {tab === 'cue' && (
          <div className="bp-cue-grid">
            <div className="bp-field">
              <label>Layer</label>
              <span>L{track.resolumeLayerIndex} — {track.name}</span>
            </div>
            <div className="bp-field">
              <label>Clip slot</label>
              <span>{cue.clipIndex}</span>
            </div>
            <div className="bp-field">
              <label>Start</label>
              <span className="mono">{cue.time}</span>
            </div>
            <div className="bp-field">
              <label>Duration: <span className="mono" style={{ color: '#888' }}>{durFrame === 0 ? 'trigger' : cue.duration}</span></label>
              <input type="range" min={0} max={Math.max(fps * 60, durFrame * 2)} value={durFrame}
                onChange={e => onUpdateCue(trackIdx, cueIdx, { duration: framesToSmpte(Number(e.target.value), fps) })}
                style={{ width: 180 }}
              />
            </div>
            <div className="bp-field">
              <label>Release</label>
              <input type="checkbox" checked={cue.release}
                onChange={e => onUpdateCue(trackIdx, cueIdx, { release: e.target.checked })} />
            </div>
            <div className="bp-field">
              <button className="btn-fire" onClick={() => api.triggerClip(track.resolumeLayerIndex, cue.clipIndex)}>
                ▶ Fire
              </button>
            </div>
          </div>
        )}

        {(tab === 'layer' || tab === 'clip') && (
          <ParamList
            params={tab === 'layer' ? layerParams : clipParams}
            loading={loadingParams}
            onAdd={addAuto}
            onSend={(addr, v) => api.sendOsc(addr, v)}
          />
        )}
      </div>
    </div>
  )
}

function ParamList({ params, loading, onAdd, onSend }: {
  params: Param[]; loading: boolean
  onAdd: (p: Param) => void; onSend: (addr: string, v: number) => void
}) {
  const [vals, setVals] = useState<Record<string, number>>({})
  useEffect(() => {
    const m: Record<string, number> = {}
    params.forEach(p => { m[p.oscAddress] = p.value })
    setVals(m)
  }, [params])

  if (loading) return <div className="bp-empty">Nalagam…</div>
  if (!params.length) return <div className="bp-empty">Ni parametrov. Resolume mora biti odprt.</div>

  return (
    <div className="param-grid">
      {params.map(p => {
        const val = vals[p.oscAddress] ?? p.value
        const min = p.min ?? 0
        const max = p.max ?? 1
        return (
          <div key={p.oscAddress} className="param-card">
            <div className="param-card-header">
              <span className="param-card-name" title={p.name}>{p.name}</span>
              <button className="btn-sm" style={{ fontSize: 8, padding: '1px 4px' }}
                onClick={() => onAdd(p)} title="Add automation">+A</button>
            </div>
            <div className="param-card-path">{p.oscAddress.split('/').slice(-3).join('/')}</div>
            <div className="param-card-control">
              <input type="range" min={min} max={max} step={max > 10 ? 1 : 0.001}
                value={val}
                onChange={e => {
                  const v = Number(e.target.value)
                  setVals(prev => ({ ...prev, [p.oscAddress]: v }))
                  onSend(p.oscAddress, v)
                }}
              />
              <span className="param-card-val">{val.toFixed(max > 10 ? 0 : 3)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
