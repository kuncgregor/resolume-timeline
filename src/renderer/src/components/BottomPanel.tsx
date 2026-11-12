import { useEffect, useRef, useState } from 'react'
import type { LayerTrack, ClipCue, ParamRef } from '../../../shared/show'
import { listParams, sameRef, formatValue, normalize, type ParamInfo } from '../../../shared/paramTree'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { KIND_GLYPH } from './ParamPicker'

const api = (window as any).timeline

type Binding = 'layer' | { cueId: string }

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
  onAddParam: (trackIdx: number, info: ParamInfo, binding: Binding) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onClose: () => void
}

export function BottomPanel({
  track, cue, cueIdx, trackIdx, fps, height, readOnly, onResize,
  onUpdateCue, onDeleteCue, onAddParam, onSelectCue, onClose,
}: Props) {
  const [tab, setTab] = useState<'cue' | 'layer' | 'clip'>('cue')
  const [layerParams, setLayerParams] = useState<ParamInfo[]>([])
  const [clipParams, setClipParams] = useState<ParamInfo[]>([])
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
      setLayerParams(lr ? listParams(lr, 'layer') : [])
      setClipParams(cr ? listParams(cr, 'clip', cue.clipId) : [])
      setLoadingParams(false)
    }).catch(() => { if (!cancelled) setLoadingParams(false) })
    return () => { cancelled = true }
  }, [track?.resolumeLayerIndex, cue?.clipIndex, cue?.clipId])

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
  const automated = track.automations.flatMap(a => (a.ref ? [a.ref] : []))

  // Layer params stay at absolute times; clip params move with this clip
  const addAuto = (info: ParamInfo) =>
    onAddParam(trackIdx, info, tab === 'layer' ? 'layer' : { cueId: cue.id })

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
            onSend={(id, v) => api.setParamById(id, v)}
          />
        )}
      </div>
    </div>
  )
}

type Real = number | string | boolean

function ParamList({ params, loading, automated, readOnly, onAdd, onSend }: {
  params: ParamInfo[]; loading: boolean; automated: ParamRef[]; readOnly: boolean
  onAdd: (p: ParamInfo) => void; onSend: (id: number, v: Real) => void
}) {
  // Local echo of what the operator set, keyed by parameter id (REST values are real units)
  const [vals, setVals] = useState<Record<number, Real>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => { setVals({}) }, [params])

  if (loading) return <div className="bp-empty">Nalagam…</div>
  if (!params.length) return <div className="bp-empty">Ni parametrov. Resolume mora biti odprt.</div>

  const groups = new Map<string, ParamInfo[]>()
  for (const p of params) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
  const toggle = (g: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    return next
  })
  const set = (p: ParamInfo, v: Real) => {
    setVals(prev => ({ ...prev, [p.id]: v }))
    onSend(p.id, v)
  }

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
              const val = p.id in vals ? vals[p.id] : p.value
              const isAuto = automated.some(r => sameRef(r, p.ref))
              const shown = formatValue(p.kind, normalize(p, val), p, p.kind === 'choice' ? String(val) : undefined, p.suffix)
              let control: React.ReactNode
              if (p.kind === 'range') {
                const min = p.min ?? 0, max = p.max ?? 1
                const num = typeof val === 'number' ? val : min
                control = (
                  <input type="range" className="bp-slider" min={min} max={max} step="any"
                    value={num} style={pct(num, min, max)} disabled={readOnly}
                    onChange={e => set(p, Number(e.target.value))} />
                )
              } else if (p.kind === 'choice') {
                control = (
                  <select className="bp-select" value={String(val ?? '')} disabled={readOnly}
                    onChange={e => set(p, e.target.value)}>
                    {!(p.options ?? []).includes(String(val)) && <option value={String(val ?? '')}>{String(val ?? '—')}</option>}
                    {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )
              } else {
                control = (
                  <label className="bp-toggle bp-param-toggle">
                    <input type="checkbox" checked={!!val} disabled={readOnly}
                      onChange={e => set(p, e.target.checked)} />
                    <span>{val ? 'On' : 'Off'}</span>
                  </label>
                )
              }
              return (
                <div key={p.id} className="bp-row bp-param">
                  <span className="bp-label" title={`${p.ref.label}\n${p.valuetype} · id ${p.id}`}>
                    <span className="bp-kind">{KIND_GLYPH[p.kind]}</span>{p.name}
                  </span>
                  <span className="bp-val mono bp-num" title={shown}>{shown}</span>
                  {control}
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
