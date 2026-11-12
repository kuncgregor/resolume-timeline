import { useEffect, useState } from 'react'
import type { LayerTrack, ClipCue, AutomationSubTrack } from '../../../shared/show'
import { framesToSmpte, smpteToFrames } from './timeUtils'

const api = (window as any).timeline

interface Param {
  name: string
  oscAddress: string
  value: number
  min?: number
  max?: number
  valuetype: string
}

// Recursively extract numeric parameters with their OSC paths
function extractParams(obj: any, oscBase: string, depth = 0): Param[] {
  if (!obj || typeof obj !== 'object' || depth > 8) return []
  const result: Param[] = []

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (!item) continue
      const nameVal = item.name?.value ?? item.name
      const effectName = typeof nameVal === 'string'
        ? nameVal.toLowerCase().replace(/\s+/g, '') : null
      const sub = effectName ? `${oscBase}/${effectName}` : oscBase
      result.push(...extractParams(item, sub, depth + 1))
    }
    return result
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key === 'id' || key === 'name' || key === 'thumbnail' || key === 'clips' || key === 'connected') continue
    if (!val || typeof val !== 'object') continue
    const v = val as any
    // Leaf parameter: has valuetype and numeric value
    if ('valuetype' in v && 'value' in v && typeof v.value === 'number') {
      result.push({
        name: key,
        oscAddress: `${oscBase}/${key}`,
        value: v.value,
        min: v.min,
        max: v.max,
        valuetype: v.valuetype,
      })
    } else if (!Array.isArray(v)) {
      result.push(...extractParams(v, `${oscBase}/${key}`, depth + 1))
    } else {
      result.push(...extractParams(v, `${oscBase}/${key}`, depth + 1))
    }
  }
  return result
}

let autoIdCounter = 1

interface Props {
  track: LayerTrack
  cue: ClipCue
  cueIdx: number
  trackIdx: number
  fps: number
  onUpdate: (updates: Partial<ClipCue>) => void
  onDelete: () => void
  onAddAutomation: (sub: AutomationSubTrack) => void
  onClose: () => void
}

export function Inspector({ track, cue, cueIdx, trackIdx, fps, onUpdate, onDelete, onAddAutomation, onClose }: Props) {
  const [layerParams, setLayerParams] = useState<Param[]>([])
  const [clipParams, setClipParams] = useState<Param[]>([])
  const [loadingParams, setLoadingParams] = useState(false)
  const [tab, setTab] = useState<'cue' | 'layer' | 'clip'>('cue')

  const startFrame = smpteToFrames(cue.time, fps)
  const durFrame = smpteToFrames(cue.duration, fps)

  useEffect(() => {
    setLoadingParams(true)
    Promise.all([
      api.getLayerRaw(track.resolumeLayerIndex),
      api.getClipRaw(track.resolumeLayerIndex, cue.clipIndex),
    ]).then(([layerRaw, clipRaw]) => {
      const base = `/composition/layers/${track.resolumeLayerIndex}`
      setLayerParams(extractParams(layerRaw, base).slice(0, 40))
      setClipParams(extractParams(clipRaw, `${base}/clips/${cue.clipIndex}`).slice(0, 40))
      setLoadingParams(false)
    })
  }, [track.resolumeLayerIndex, cue.clipIndex])

  const addAutomation = (p: Param, opts?: { clipId?: string; layerBound?: boolean }) => {
    const sub: AutomationSubTrack = {
      id: `auto-${Date.now()}-${autoIdCounter++}`,
      name: p.name,
      target: p.oscAddress,
      ...opts,
      color: randomColor(),
      keyframes: [],
    }
    onAddAutomation(sub)
  }

  const sendParam = (p: Param, value: number) => {
    api.sendOsc(p.oscAddress, value)
  }

  return (
    <div className="inspector">
      <div className="inspector-header">
        <span>{track.name} / {cue.clipName || `Clip ${cue.clipIndex}`}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn-sm" style={{ color: '#ff6666', borderColor: '#ff4444' }} onClick={onDelete}>Del</button>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="inspector-tabs">
        {(['cue', 'layer', 'clip'] as const).map(t => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'cue' ? 'Cue' : t === 'layer' ? 'Layer' : 'Clip'}
          </button>
        ))}
      </div>

      <div className="inspector-body">

        {tab === 'cue' && (
          <>
            <Row label="Layer" value={`L${track.resolumeLayerIndex} — ${track.name}`} />
            <Row label="Clip slot" value={String(cue.clipIndex)} />
            <Row label="Start" value={cue.time} />

            <label className="inspector-label-sm">Trajanje</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
              <input
                type="range" min={0} max={fps * 60} value={durFrame}
                onChange={e => onUpdate({ duration: framesToSmpte(Number(e.target.value), fps) })}
                style={{ flex: 1 }}
              />
              <span style={{ color: '#aaa', fontSize: 10, minWidth: 55 }}>
                {durFrame === 0 ? 'Trigger' : cue.duration}
              </span>
            </div>
            <button
              className="btn-sm"
              style={{ marginBottom: 8, fontSize: 9, opacity: 0.8 }}
              onClick={async () => {
                try {
                  const clipRaw = await api.getClipRaw(track.resolumeLayerIndex, cue.clipIndex)
                  const v = clipRaw?.video?.fileinfo?.duration?.value
                    ?? clipRaw?.video?.fileinfo?.duration
                    ?? clipRaw?.fileinfo?.duration?.value
                    ?? clipRaw?.transport?.controls?.duration?.value
                    ?? clipRaw?.duration?.value
                  const durSec = typeof v === 'number' && v > 0 ? v : 0
                  if (durSec > 0) onUpdate({ duration: framesToSmpte(Math.round(durSec * fps), fps) })
                } catch {}
              }}
            >
              Nastavi iz Resolume
            </button>

            <label className="inspector-label-sm">Release (40 ms)</label>
            <input type="checkbox" checked={cue.release}
              onChange={e => onUpdate({ release: e.target.checked })} style={{ marginBottom: 8 }} />

            <button className="btn-fire" onClick={() => api.triggerClip(track.resolumeLayerIndex, cue.clipIndex)}>
              ▶ Fire Now
            </button>
          </>
        )}

        {tab === 'layer' && (
          <ParamList params={layerParams} loading={loadingParams} onAdd={p => addAutomation(p, { layerBound: true })} onSend={sendParam} />
        )}

        {tab === 'clip' && (
          <ParamList params={clipParams} loading={loadingParams} onAdd={p => addAutomation(p, { clipId: cue.id })} onSend={sendParam} />
        )}
      </div>
    </div>
  )
}

function ParamList({ params, loading, onAdd, onSend }: {
  params: Param[], loading: boolean,
  onAdd: (p: Param) => void, onSend: (p: Param, v: number) => void
}) {
  if (loading) return <div className="browser-empty">Nalagam parametre…</div>
  if (!params.length) return <div className="browser-empty">Ni parametrov (Resolume ni povezan?)</div>
  return (
    <div className="param-list">
      {params.map(p => (
        <div key={p.oscAddress} className="param-row">
          <div className="param-info">
            <div className="param-name">{p.name}</div>
            <div className="param-osc">{p.oscAddress.split('/').slice(-3).join('/')}</div>
          </div>
          <div className="param-controls">
            <input
              type="range"
              min={p.min ?? 0} max={p.max ?? 1} step={0.01}
              defaultValue={p.value}
              onChange={e => onSend(p, Number(e.target.value))}
              style={{ width: 70 }}
            />
            <span className="param-value">{p.value.toFixed(2)}</span>
            <button className="btn-sm" style={{ fontSize: 9, padding: '1px 5px' }}
              onClick={() => onAdd(p)} title="Dodaj automation lane">
              +Auto
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-row">
      <span className="inspector-label">{label}</span>
      <span className="inspector-value">{value}</span>
    </div>
  )
}

const COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6', '#1ABC9C']
let colorIdx = 0
function randomColor() { return COLORS[colorIdx++ % COLORS.length] }
