import { useEffect, useRef, useState } from 'react'
import { useFrame } from '../frameStore'
import type { LayerTrack, GroupTrack, ClipCue, AutomationSubTrack } from '../../../shared/show'
import { listParams, sameRef, formatValue, normalize, type ParamInfo } from '../../../shared/paramTree'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { KIND_GLYPH } from './ParamPicker'
import { trackTag, shade } from '../laneColor'
import { deckOfCue, type DeckInfo } from '../decks'
import { knownClip } from '../resolver'
import { mediaStartOf, trimModeFields } from '../../../shared/cues'
import { TOUCH } from '../touch'

const api = (window as any).timeline

type Binding = 'layer' | { cueId: string }

// Slider fill: CSS reads the percentage from --pct
const pct = (v: number, min: number, max: number) =>
  ({ '--pct': `${max > min ? ((v - min) / (max - min)) * 100 : 0}%` }) as React.CSSProperties

interface Props {
  track: LayerTrack | null; cue: ClipCue | null
  group: GroupTrack | null      // selected Resolume layer group (Arena)
  decks: DeckInfo[]
  cueIdx: number | null; trackIdx: number | null; fps: number
  height: number
  readOnly: boolean
  onResize: (h: number) => void
  onUpdateCue: (ti: number, ci: number, u: Partial<ClipCue>) => void
  onDeleteCue: (ti: number, ci: number) => void
  // Keyframing like After Effects / Resolve: ◇ starts animating the parameter (lane +
  // keyframe at the playhead), ◆ toggles a keyframe at the playhead, and moving the fader
  // of an animated parameter writes a keyframe at the playhead.
  onToggleKey: (trackIdx: number, info: ParamInfo, real: Real, binding: Binding) => void
  onParamEdit: (trackIdx: number, info: ParamInfo, real: Real) => void
  onSeek: (frame: number) => void
  onSelectCue: (trackIdx: number, cueIdx: number) => void
  onClose: () => void
}

export function BottomPanel({
  track, cue, group, decks, cueIdx, trackIdx, fps, height, readOnly, onResize,
  onUpdateCue, onDeleteCue, onToggleKey, onParamEdit, onSeek, onSelectCue, onClose,
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
    const onMove = (e: PointerEvent) => {
      if (!resizingRef.current) return
      const delta = startRef.current.y - e.clientY
      onResize(Math.max(80, Math.min(500, startRef.current.h + delta)))
    }
    const onUp = () => { resizingRef.current = false }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }
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

  // Live values: re-read the visible tab's parameters so faders follow automation and
  // whatever the operator does in Resolume (REST by index, ~0.3 ms locally)
  const [live, setLive] = useState<Record<number, Real>>({})
  useEffect(() => {
    if (!track || !cue || tab === 'cue') return
    let stopped = false
    const poll = async () => {
      const raw = tab === 'layer'
        ? await api.getLayerRaw(track.resolumeLayerIndex)
        : await api.getClipRaw(track.resolumeLayerIndex, cue.clipIndex)
      if (stopped || !raw) return
      const list = tab === 'layer' ? listParams(raw, 'layer') : listParams(raw, 'clip', cue.clipId)
      setLive(Object.fromEntries(list.map(p => [p.id, p.value as Real])))
      // Effects added/removed in Resolume: refresh the rows themselves
      const setList = tab === 'layer' ? setLayerParams : setClipParams
      setList(prev => prev.map(p => p.id).join() === list.map(p => p.id).join() ? prev : list)
    }
    const t = setInterval(poll, 300)
    return () => { stopped = true; clearInterval(t) }
  }, [tab, track?.resolumeLayerIndex, cue?.clipIndex, cue?.clipId])

  const handle = (
    <div
      className="bp-resize-handle"
      onPointerDown={e => { e.preventDefault(); resizingRef.current = true; startRef.current = { y: e.clientY, h: height } }}
    />
  )
  const roChip = readOnly && <span className="chip">SHOW · read-only</span>
  const closeBtn = <button className="btn ghost bp-icon" onClick={onClose} title="Close">✕</button>
  const title = (t: LayerTrack, sub: string) => (
    <div className="bp-title">
      <span className="bp-stripe" style={{ background: t.color ?? 'var(--text-faint)' }} />
      <span className="bp-layer">{t.name}</span>
      <span className="bp-sep">›</span>
      <span className="bp-clip" title={sub}>{sub}</span>
    </div>
  )
  const fire = (t: LayerTrack, c: ClipCue) => api.fireClip(c, t.resolumeLayerIndex)

  // GROUP view — the selected track is a layer group: its own parameters (master, opacity,
  // blend, bypass, group effects) polled live like the layer tab
  const [groupParams, setGroupParams] = useState<ParamInfo[]>([])
  const [groupLive, setGroupLive] = useState<Record<number, Real>>({})
  useEffect(() => {
    if (!group || group.resolumeGroupIndex < 1) { setGroupParams([]); return }
    let stopped = false
    const poll = async () => {
      const raw = await api.getGroupRaw(group.resolumeGroupIndex)
      if (stopped || !raw) return
      const list = listParams(raw, 'group')
      setGroupLive(Object.fromEntries(list.map(p => [p.id, p.value as Real])))
      setGroupParams(prev => prev.map(p => p.id).join() === list.map(p => p.id).join() ? prev : list)
    }
    poll()
    const t = setInterval(poll, 300)
    return () => { stopped = true; clearInterval(t) }
  }, [group?.resolumeGroupIndex])

  if (group && trackIdx != null) {
    return (
      <div className="bottom-panel" style={{ height }}>
        {handle}
        <div className="bp-header">
          <div className="bp-title">
            <span className="bp-stripe" style={{ background: group.color ?? 'var(--text-faint)' }} />
            <span className="bp-layer">{group.name}</span>
            <span className="bp-sep">›</span>
            <span className="bp-clip">Group parameters</span>
          </div>
          <div className="bp-actions">{roChip}{closeBtn}</div>
        </div>
        <div className="bp-body">
          <ParamList
            scope="layer" tag={trackTag(group)}
            params={groupParams}
            live={groupLive}
            loading={false}
            lanes={group.automations}
            fps={fps}
            readOnly={readOnly}
            onToggleKey={(info, real) => onToggleKey(trackIdx, info, real, 'layer')}
            onEdit={(info, real) => { api.setParamById(info.id, real); onParamEdit(trackIdx, info, real) }}
            onSeek={onSeek}
          />
        </div>
      </div>
    )
  }

  // CUE LIST view — track is selected (LayerTrack) but no specific clip
  if (track && trackIdx != null && cueIdx == null) {
    return (
      <div className="bottom-panel" style={{ height }}>
        {handle}
        <div className="bp-header">
          {title(track, `${track.clips.length} ${track.clips.length === 1 ? 'clip' : 'clips'}`)}
          <div className="bp-actions">{roChip}{closeBtn}</div>
        </div>
        <div className="bp-body">
          {track.clips.length === 0 ? (
            <div className="bp-empty">No clips on this layer. Drag a clip from the browser.</div>
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
                    <button className="btn bp-fire bp-icon" title="Fire the clip in Resolume"
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
        <span>{TOUCH ? 'Tap' : 'Click'} a layer or clip in the timeline</span>
        {roChip}
      </div>
    )
  }

  const durFrame = smpteToFrames(cue.duration, fps)
  const durMax = Math.max(fps * 60, durFrame * 2)
  const setDur = (f: number) => onUpdateCue(trackIdx, cueIdx, { duration: framesToSmpte(Math.max(0, f), fps) })
  // Layer params stay at absolute times; clip params move with this clip
  const binding: Binding = tab === 'layer' ? 'layer' : { cueId: cue.id }

  return (
    <div className="bottom-panel" style={{ height }}>
      {handle}

      <div className="bp-header">
        {title(track, cue.clipName || `Clip ${cue.clipIndex}`)}

        <div className="bp-tabs">
          {(['cue', 'layer', 'clip'] as const).map(t => (
            <button key={t} className={`bp-tab ${t === 'cue' ? '' : `scope-${t}`} ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
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
            title="Delete cue (two clicks)"
          >{delArmed ? 'Confirm delete' : 'Delete'}</button>
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
              <span className="bp-label">Deck</span>
              {(() => {
                const d = deckOfCue(decks, cue)
                if (cue.deckIndex === undefined && cue.deckId === undefined)
                  return <span className="bp-val" title="Older cue: fires on whichever deck Resolume shows">Current deck</span>
                return (
                  <span className={`bp-val deck-val ${d ? '' : 'missing'}`} style={{ ['--deck-color' as any]: d?.color ?? 'var(--danger)' }}
                    title={d ? `Fires from deck ${d.index} (${d.name}); the app switches to it when needed` : 'This deck no longer exists in Resolume'}>
                    <span className="deck-dot" />D{d?.index ?? cue.deckIndex} · {d?.name ?? cue.deckName ?? 'missing'}
                    {d?.selected && <span className="deck-now"> (shown in Resolume)</span>}
                  </span>
                )
              })()}
            </div>
            <div className="bp-row">
              <span className="bp-label">Start</span>
              <span className="bp-val mono">{cue.time}</span>
            </div>
            <div className="bp-row">
              <span className="bp-label">Duration</span>
              <span className="bp-val mono bp-num">{cue.duration}</span>
              <button className="btn ghost bp-icon" disabled={readOnly || durFrame === 0}
                onClick={() => setDur(durFrame - 1)} title="−1 frame">−</button>
              <input type="range" className="bp-slider bp-dur-slider" min={0} max={durMax} value={durFrame}
                style={pct(durFrame, 0, durMax)} disabled={readOnly}
                onChange={e => setDur(Number(e.target.value))} />
              <button className="btn ghost bp-icon" disabled={readOnly}
                onClick={() => setDur(durFrame + 1)} title="+1 frame">+</button>
              {durFrame === 0 && <span className="chip next" title="Duration 0: trigger only, no automatic release">Trigger</span>}
            </div>
            <div className="bp-row">
              <span className="bp-label">Release</span>
              <label className="bp-toggle">
                <input type="checkbox" checked={cue.release} disabled={readOnly}
                  onChange={e => onUpdateCue(trackIdx, cueIdx, { release: e.target.checked })} />
                <span>{cue.release ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="bp-row">
              <span className="bp-label">Follow playhead</span>
              <label className="bp-toggle" title="On: Stop pauses the clip on the playhead's frame, Play and scrubbing move it. Off: it runs free in Resolume (backgrounds, loops), marked ⟳ on the timeline.">
                <input type="checkbox" checked={cue.follow !== false} disabled={readOnly}
                  onChange={e => onUpdateCue(trackIdx, cueIdx, { follow: e.target.checked ? undefined : false })} />
                <span>{cue.follow !== false ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="bp-row" title="Loop: the clip always starts at the media's start, trimming the start doesn't move the picture (VJ loops). Edit: like an editor, trimming the start or splitting cuts into the media, the picture stays where it is on the timeline.">
              <span className="bp-label">Trim</span>
              <div className="seg">
                {(['loop', 'edit'] as const).map(m => (
                  <button key={m} className={`seg-btn${(cue.trim ?? 'loop') === m ? ' on' : ''}`} disabled={readOnly}
                    onClick={() => onUpdateCue(trackIdx, cueIdx, trimModeFields(m))}
                  >{m === 'loop' ? 'Loop' : 'Edit'}</button>
                ))}
              </div>
            </div>
            {cue.trim === 'edit' && (() => {
              // Where the clip starts in its media (slider up to the media's length when known)
              const ms = mediaStartOf(cue)
              const mediaMs = Number(knownClip(cue.clipId)?.video?.fileinfo?.duration_ms ?? 0)
              const max = Math.max(ms, mediaMs > 0 ? Math.floor(mediaMs / 1000 * fps) - 1 : Math.max(durFrame, fps * 10))
              const set = (f: number) => {
                const v = Math.max(0, Math.min(max, Math.round(f)))
                onUpdateCue(trackIdx, cueIdx, { mediaStart: v || undefined })
              }
              return (
                <div className="bp-row" title="Where the clip starts in its media: the picture at the clip's start on the timeline">
                  <span className="bp-label">Media start</span>
                  <span className="bp-val mono bp-num">{framesToSmpte(ms, fps)}</span>
                  <button className="btn ghost bp-icon" disabled={readOnly || ms === 0}
                    onClick={() => set(ms - 1)} title="−1 frame">−</button>
                  <input type="range" className="bp-slider bp-dur-slider" min={0} max={max} value={ms}
                    style={pct(ms, 0, max)} disabled={readOnly}
                    onChange={e => set(Number(e.target.value))} />
                  <button className="btn ghost bp-icon" disabled={readOnly || ms >= max}
                    onClick={() => set(ms + 1)} title="+1 frame">+</button>
                </div>
              )
            })()}
            <div className="bp-row bp-row-action">
              <span className="bp-label" />
              <button className="btn bp-fire" onClick={() => fire(track, cue)}>▶ Fire</button>
            </div>
          </div>
        )}

        {(tab === 'layer' || tab === 'clip') && (
          <ParamList
            key={tab}
            scope={tab} tag={tab === 'clip' ? cue?.resolumeColor : trackTag(track)}
            params={tab === 'layer' ? layerParams : clipParams}
            live={live}
            loading={loadingParams}
            lanes={track.automations}
            fps={fps}
            readOnly={readOnly}
            onToggleKey={(info, real) => onToggleKey(trackIdx, info, real, binding)}
            onEdit={(info, real) => { api.setParamById(info.id, real); onParamEdit(trackIdx, info, real) }}
            onSeek={onSeek}
          />
        )}
      </div>
    </div>
  )
}

type Real = number | string | boolean

function ParamList({ scope, tag, params, live, loading, lanes, fps, readOnly, onToggleKey, onEdit, onSeek }: {
  scope: 'layer' | 'clip'
  tag?: string   // Resolume colour tag of the layer / group / clip: faders take its colour
  params: ParamInfo[]; live: Record<number, Real>; loading: boolean
  lanes: AutomationSubTrack[]; fps: number; readOnly: boolean
  onToggleKey: (p: ParamInfo, real: Real) => void
  onEdit: (p: ParamInfo, real: Real) => void
  onSeek: (frame: number) => void
}) {
  const frame = useFrame()
  // While a fader is held, its value comes from the hand, not from polling
  const [held, setHeld] = useState<Record<number, Real>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  if (loading) return <div className="bp-empty">Loading…</div>
  if (!params.length) return <div className="bp-empty">No parameters. Resolume must be running.</div>

  const groups = new Map<string, ParamInfo[]>()
  for (const p of params) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
  const toggle = (g: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    return next
  })
  const hold = (p: ParamInfo, v: Real) => { setHeld(prev => ({ ...prev, [p.id]: v })); onEdit(p, v) }
  const release = (p: ParamInfo) => setHeld(prev => { const n = { ...prev }; delete n[p.id]; return n })

  return (
    <div className={`bp-params scope-${scope}`}
      style={tag ? { ['--scope' as any]: tag, ['--scope-fill' as any]: shade(tag, 0.75) } : undefined}>
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
              const val = p.id in held ? held[p.id] : p.id in live ? live[p.id] : p.value
              const lane = lanes.find(l => sameRef(l.ref, p.ref))
              const keyFrames = lane ? lane.keyframes.map(k => smpteToFrames(k.time, fps)).sort((a, b) => a - b) : []
              const onKey = keyFrames.includes(frame)
              const prevKey = [...keyFrames].reverse().find(f => f < frame)
              const nextKey = keyFrames.find(f => f > frame)
              const shown = formatValue(p.kind, normalize(p, val), p, p.kind === 'choice' ? String(val) : undefined, p.suffix)
              let control: React.ReactNode
              if (p.kind === 'range') {
                const min = p.min ?? 0, max = p.max ?? 1
                const num = typeof val === 'number' ? val : min
                control = (
                  <input type="range" className="bp-slider" min={min} max={max} step="any"
                    value={num} style={pct(num, min, max)} disabled={readOnly}
                    onChange={e => hold(p, Number(e.target.value))}
                    onPointerUp={e => { release(p); e.currentTarget.blur() }} onBlur={() => release(p)} />
                )
              } else if (p.kind === 'choice') {
                control = (
                  <select className="bp-select" value={String(val ?? '')} disabled={readOnly}
                    onChange={e => { onEdit(p, e.target.value) }}>
                    {!(p.options ?? []).includes(String(val)) && <option value={String(val ?? '')}>{String(val ?? '—')}</option>}
                    {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )
              } else {
                control = (
                  <label className="bp-toggle bp-param-toggle">
                    <input type="checkbox" checked={!!val} disabled={readOnly}
                      onChange={e => onEdit(p, e.target.checked)} />
                    <span>{val ? 'On' : 'Off'}</span>
                  </label>
                )
              }
              return (
                <div key={p.id} className={`bp-row bp-param ${lane ? 'animated' : ''}`}>
                  <span className="bp-label" title={`${p.ref.label}\n${p.valuetype} · id ${p.id}`}>
                    <span className="bp-kind">{KIND_GLYPH[p.kind]}</span>{p.name}
                  </span>
                  <span className="bp-val mono bp-num" title={shown}>{shown}</span>
                  {control}
                  <span className="bp-keynav">
                    {lane && (
                      <button className="btn ghost bp-icon" disabled={prevKey === undefined}
                        onClick={() => prevKey !== undefined && onSeek(prevKey)} title="Previous keyframe">◀</button>
                    )}
                    <button className={`btn ghost bp-icon bp-auto ${lane ? 'on' : ''} ${onKey ? 'key' : ''}`}
                      disabled={readOnly}
                      onClick={() => onToggleKey(p, val as Real)}
                      title={!lane ? 'Animate: create a lane and a keyframe at the playhead'
                        : onKey ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}
                    >{onKey ? '◆' : '◇'}</button>
                    {lane && (
                      <button className="btn ghost bp-icon" disabled={nextKey === undefined}
                        onClick={() => nextKey !== undefined && onSeek(nextKey)} title="Next keyframe">▶</button>
                    )}
                  </span>
                </div>
              )
            })}</div>}
          </div>
        )
      })}
    </div>
  )
}
