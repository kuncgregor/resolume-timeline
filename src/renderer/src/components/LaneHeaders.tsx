import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track, LayerTrack, GroupTrack, Show, AutomationSubTrack, Keyframe, LaneKind, ClipCue } from '../../../shared/show'
import type { ResolumeComposition, ResolumeLayer } from '../../../shared/resolume'
import { formatValue, type ParamInfo } from '../../../shared/paramTree'
import { toFrameKeyframes, sampleLane } from '../../../shared/automation'
import type { LaneStatusMap } from '../laneStatus'
import { DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_LANE_H, MIN_AUTO_H } from '../layout'
import { smpteToFrames } from './timeUtils'
import { ParamPicker, KIND_GLYPH, type PickBinding, type PickerClip } from './ParamPicker'

interface Props {
  tracks: Track[]
  selectedIdx: number | null
  layerRowHeights: Record<string, number>
  autoLaneHeights: Record<string, number>
  scrollY: number
  audioTrack?: Show['audioTrack']
  readOnly: boolean
  composition: ResolumeComposition | null
  frame: number
  fps: number
  laneStatus: LaneStatusMap
  overrides: Record<string, number>          // lanes the operator took over in Resolume
  onToggleGroupCollapsed: (idx: number) => void
  onReenable: (ids?: string[]) => void
  onSelect: (idx: number) => void
  onToggleExpand: (idx: number) => void
  onSetAllExpanded: (expanded: boolean) => void
  onToggleMute: (idx: number) => void
  onToggleLock: (idx: number) => void
  onResizeLayer: (id: string, h: number) => void
  onResizeAutoLane: (id: string, h: number) => void
  onAddParam: (trackIdx: number, info: ParamInfo, binding: PickBinding) => void
  onRetarget: (trackIdx: number, autoIdx: number, info: ParamInfo) => void
  onUpdateAutomation: (trackIdx: number, autoIdx: number, updates: Partial<AutomationSubTrack>) => void
  onSnapshot: (trackIdx: number, autoIdx: number) => void
  onDeleteAutomation: (trackIdx: number, autoIdx: number) => void
  onToggleLayerBound: (trackIdx: number, autoIdx: number) => void
  onEditAutomationTarget: (trackIdx: number, autoIdx: number, newTarget: string) => void
  onScrollY: (delta: number) => void
  onLoadAudio: () => void
  onUpdateAudio: (updates: Partial<NonNullable<Show['audioTrack']>>) => void
}

interface ResizeState { id: string; kind: 'layer' | 'auto'; startY: number; startH: number }
interface EditState { ti: number; ai: number }
interface PickerState { ti: number; ai?: number; mode: 'add' | 'retarget'; anchor: DOMRect; key: string }

const LIVE_STRIP_MIN_H = 48

// Resolume wraps values as { value }; tolerate plain values too
const val = (p: unknown): unknown => (p && typeof p === 'object' && 'value' in (p as object) ? (p as { value: unknown }).value : p)

/** Normalized lane value at a frame (shared curves: canvas and engine use the same sampler).
 *  `inside` is false before the first / after the last keyframe. */
function valueAtFrame(keyframes: Keyframe[], frame: number, fps: number, kind: LaneKind):
  { value: number; option?: string; inside: boolean } | null {
  const kfs = toFrameKeyframes(keyframes, t => smpteToFrames(t, fps))
  const v = sampleLane(kfs, frame, kind)
  if (!v || !kfs.length) return null
  return { ...v, inside: frame >= kfs[0].frame && frame <= kfs[kfs.length - 1].frame }
}

// The cue the scheduler keeps on this layer at `frame`: the last one started, while its
// duration lasts (duration 0 = trigger, active until the next cue)
function expectedCue(clips: ClipCue[], frame: number, fps: number): ClipCue | null {
  let best: ClipCue | null = null, bestF = -Infinity
  for (const c of clips) {
    const sf = smpteToFrames(c.time, fps)
    if (sf <= frame && sf >= bestF) { best = c; bestF = sf }
  }
  if (!best) return null
  const dur = smpteToFrames(best.duration, fps)
  return dur === 0 || frame < bestF + dur ? best : null
}

function splitLabel(auto: AutomationSubTrack): { owner: string; param: string } {
  const label = auto.ref?.label ?? auto.name
  const at = label.indexOf(' › ')
  const sub = at >= 0 ? label.slice(0, at) : ''
  const param = at >= 0 ? label.slice(at + 3) : label
  if (!auto.ref) return { owner: sub, param }
  if (auto.ref.scope === 'clip') return { owner: sub ? `Clip · ${sub}` : 'Clip', param }
  if (auto.ref.scope === 'group') return { owner: sub ? `Group · ${sub}` : 'Group', param }
  return { owner: sub || 'Layer', param }
}

export function LaneHeaders({
  tracks, selectedIdx, layerRowHeights, autoLaneHeights, scrollY, audioTrack, readOnly,
  composition, frame, fps, laneStatus, overrides, onReenable, onToggleGroupCollapsed,
  onSelect, onToggleExpand, onSetAllExpanded, onToggleMute, onToggleLock, onResizeLayer, onResizeAutoLane,
  onAddParam, onRetarget, onUpdateAutomation, onSnapshot,
  onDeleteAutomation, onToggleLayerBound, onEditAutomationTarget, onScrollY,
  onLoadAudio, onUpdateAudio,
}: Props) {
  const [resizing, setResizing] = useState<ResizeState | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editValue, setEditValue] = useState('')
  // Removing a lane loses its keyframes: first click arms, second removes
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const closePicker = useCallback(() => setPicker(null), [])

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const delta = e.clientY - resizing.startY
      if (resizing.kind === 'layer') onResizeLayer(resizing.id, Math.max(MIN_LANE_H, resizing.startH + delta))
      else onResizeAutoLane(resizing.id, Math.max(MIN_AUTO_H, resizing.startH + delta))
    }
    const onUp = () => setResizing(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [resizing, onResizeLayer, onResizeAutoLane])

  // The picker is anchored to a screen rect; scrolling the lanes would leave it floating
  useEffect(() => { setPicker(null) }, [scrollY])
  useEffect(() => { if (readOnly) setPicker(null) }, [readOnly])

  // Escape unmounts the input, which fires blur → commitEdit; this flag turns that commit off
  const cancelEditRef = useRef(false)
  const commitEdit = () => {
    if (cancelEditRef.current) { cancelEditRef.current = false; return }
    if (!editing) return
    onEditAutomationTarget(editing.ti, editing.ai, editValue.trim())
    setEditing(null)
  }

  // Native non-passive listener: React's wheel handler is passive and cannot preventDefault
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const fn = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); onScrollY(e.deltaY) }
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [onScrollY])

  const audioColor = audioTrack?.color ?? 'var(--live-fill)'
  const layerOf = (lt: LayerTrack): ResolumeLayer | null =>
    composition?.layers?.find(l => l.id === lt.resolumeLayerId) ?? null

  const openPicker = (e: React.MouseEvent, p: Omit<PickerState, 'anchor'>) => {
    e.stopPropagation()
    if (readOnly) return
    if (picker?.key === p.key) { setPicker(null); return }
    setPicker({ ...p, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })
  }

  // Only layers that have lanes count: App's expand-all leaves empty layers alone
  const anyExpanded = tracks.some(t => t.type === 'layer' && (t as LayerTrack).expanded && (t as LayerTrack).automations.length > 0)

  // ── Picker data for the open picker ──
  let pickerEl: React.ReactNode = null
  const pt = picker ? tracks[picker.ti] : null
  if (picker && pt && (pt.type === 'layer' || pt.type === 'group')) {
    const isGroup = pt.type === 'group'
    const lt = (isGroup ? { ...pt, clips: [] } : pt) as LayerTrack
    const layerJson: any = isGroup
      ? (composition?.layergroups?.find(g => g?.id === (pt as GroupTrack).resolumeGroupId) ?? null)
      : layerOf(lt)
    const seen = new Set<string>()
    const clips: PickerClip[] = []
    for (const cue of [...lt.clips].sort((a, b) => smpteToFrames(a.time, fps) - smpteToFrames(b.time, fps))) {
      if (seen.has(cue.id)) continue
      seen.add(cue.id)
      const json = layerJson?.clips?.find((c: any) => c.id === cue.clipId) ?? null
      clips.push({ cueId: cue.id, clipId: cue.clipId, name: cue.clipName, json })
    }
    const ai = picker.ai
    pickerEl = (
      <ParamPicker
        key={picker.key}
        anchor={picker.anchor} layerJson={layerJson} clips={clips} scope={isGroup ? 'group' : 'layer'}
        automated={lt.automations.flatMap(a => (a.ref ? [a.ref] : []))}
        mode={picker.mode}
        title={picker.mode === 'retarget' && ai != null ? `Preusmeri: ${lt.automations[ai]?.ref?.label ?? lt.automations[ai]?.name ?? ''}` : undefined}
        onPick={(info, binding) => {
          if (picker.mode === 'add') onAddParam(picker.ti, info, binding)
          else if (ai != null) onRetarget(picker.ti, ai, info)
        }}
        onClose={closePicker}
      />
    )
  }

  // Automation lanes under a layer or a group track (same rows for both)
  const renderAutoLanes = (lt: LayerTrack, i: number) => (
    lt.expanded && lt.automations.map((auto, ai) => {
                  const autoH = autoLaneHeights[auto.id] ?? DEFAULT_AUTO_H
                  const isEditingThis = editing?.ti === i && editing?.ai === ai
                  const isLayerBound = !!auto.layerBound
                  const status = laneStatus[auto.id]
                  const broken = status?.state === 'broken'
                  const legacy = status?.state === 'legacy' || !auto.ref
                  const enabled = auto.enabled !== false
                  const kind: LaneKind = auto.kind ?? status?.info?.kind ?? 'range'
                  const range = status?.info
                    ? { min: status.info.min, max: status.info.max, options: status.info.options, multiplier: status.info.multiplier }
                    : { min: auto.min, max: auto.max, options: auto.options }
                  const at = valueAtFrame(auto.keyframes, frame, fps, kind)
                  const releasedOutside = at != null && !at.inside && auto.outside !== 'hold'
                  const valueText = at ? formatValue(kind, at.value, range, at.option, status?.info?.suffix) : '—'
                  const { owner, param } = splitLabel(auto)
                  const retargetKey = `rt:${auto.id}`
                  const labelTip = [
                    auto.ref?.label ?? auto.name,
                    broken ? `✕ ${status?.reason ?? 'cilja ni več v Resolume'}` : null,
                    status?.state === 'offline' ? 'Resolume ni povezan' : null,
                    !enabled ? 'Izklopljeno: ne pošilja' : null,
                    auto.target ? `OSC: ${auto.target}` : null,
                    readOnly ? null : 'Klik: preusmeri na drug parameter',
                  ].filter(Boolean).join('\n')
                  return (
                    <div key={auto.id}
                      className={`lane-row auto-row ${broken ? 'broken' : ''} ${enabled ? '' : 'disabled'}`}
                      style={{ height: autoH }}>
                      <div className="lane-stripe auto" style={{ background: broken ? 'var(--danger)' : auto.color ?? 'var(--live-fill)' }} />
                      <div className="lane-body">
                        {isEditingThis ? (
                          <input
                            className="lane-path-edit mono"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEdit()
                              if (e.key === 'Escape') { cancelEditRef.current = true; setEditing(null) }
                              e.stopPropagation()
                            }}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <div className="auto-title">
                            <span className="auto-glyph">{KIND_GLYPH[kind]}</span>
                            <button
                              className={`auto-label ${picker?.key === retargetKey ? 'open' : ''}`}
                              title={labelTip}
                              disabled={readOnly}
                              onClick={e => openPicker(e, { ti: i, ai, mode: 'retarget', key: retargetKey })}
                            >
                              {broken && <span className="auto-broken">✕ </span>}
                              {owner && <span className="auto-owner">{owner} › </span>}
                              <span className="auto-param">{param}</span>
                            </button>
                            {legacy && (
                              <span
                                className={`auto-osc ${!auto.ref && !readOnly ? 'editable' : ''}`}
                                title={`stara steza brez stabilnega cilja\n${auto.target}${!auto.ref && !readOnly ? '\n\nKlik: uredi OSC pot' : ''}`}
                                onClick={e => {
                                  if (auto.ref || readOnly) return
                                  e.stopPropagation()
                                  cancelEditRef.current = false
                                  setEditing({ ti: i, ai })
                                  setEditValue(auto.target)
                                }}
                              >OSC</span>
                            )}
                          </div>
                        )}
                        <div className="auto-line">
                          <span
                            className={`auto-value mono ${releasedOutside ? 'outside' : ''}`}
                            title={releasedOutside ? 'Izven razpona keyframov — steza ne pošilja' : 'Vrednost na playheadu'}
                          >{valueText}</span>
                          <button
                            className={`bind-chip ${isLayerBound ? 'layer' : 'clip'}`}
                            title={isLayerBound
                              ? 'Fiksno na časovnici — klikni, da sledi clipu'
                              : 'Sledi clipu — klikni za fiksno na časovnici'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleLayerBound(i, ai) }}
                          >{isLayerBound ? 'LAYER' : 'CLIP'}</button>
                          {auto.id in overrides && (
                            <button className="ovr-chip"
                              title="Operater je ta parameter premaknil v Resolume; steza ne pošilja. Klikni, da jo vrneš časovnici."
                              onClick={e => { e.stopPropagation(); onReenable([auto.id]) }}>OVR ↺</button>
                          )}
                          <span className="auto-spacer" />
                          <input
                            type="checkbox" className="auto-enable"
                            checked={enabled} disabled={readOnly}
                            title={enabled ? 'Vklopljeno: steza pošilja (klikni za izklop)' : 'Izklopljeno: steza ne pošilja (klikni za vklop)'}
                            onClick={e => e.stopPropagation()}
                            onChange={e => onUpdateAutomation(i, ai, { enabled: e.target.checked })}
                          />
                          <button
                            className="lane-tool auto-snap"
                            title="Zapiši trenutno vrednost iz Resolume na playhead"
                            disabled={readOnly || status?.state !== 'ok'}
                            onClick={e => { e.stopPropagation(); onSnapshot(i, ai) }}
                          >◉</button>
                          {!readOnly && (armedDelete === auto.id ? (
                            <button className="lane-tool armed" title="Klikni še enkrat za odstranitev"
                              onMouseLeave={() => setArmedDelete(null)}
                              onClick={e => { e.stopPropagation(); setArmedDelete(null); onDeleteAutomation(i, ai) }}>Odstrani?</button>
                          ) : (
                            <button className="lane-tool danger" title="Odstrani avtomacijo"
                              onClick={e => { e.stopPropagation(); setArmedDelete(auto.id) }}>✕</button>
                          ))}
                        </div>
                      </div>
                      {!readOnly && <ResizeHandle onStart={y => setResizing({ id: auto.id, kind: 'auto', startY: y, startH: autoH })} />}
                    </div>
                  )
                })
  )

  return (
    <div className="lane-headers" style={{ userSelect: resizing ? 'none' : undefined }}>
      <div className="ruler-corner">
        <span>Sloji</span>
        <button
          className="corner-expand"
          title={anyExpanded ? 'Skrij avtomacijo vseh layerjev' : 'Pokaži avtomacijo vseh layerjev'}
          onClick={() => onSetAllExpanded(!anyExpanded)}
        >{anyExpanded ? '▸ vse' : '▾ vse'}</button>
        <span className="ruler-corner-count">{tracks.length}</span>
      </div>

      {/* Audio lane header — pinned under the ruler like the canvas audio lane */}
      <div className="audio-head" onClick={e => e.stopPropagation()}>
        <div className="lane-stripe" style={{ background: audioColor }} />
        {audioTrack ? (
          <div className="audio-head-body">
            <div className="audio-head-top">
              <span className="audio-head-icon">♪</span>
              <span className="audio-head-name" title={audioTrack.filePath}>{audioTrack.name}</span>
              {!readOnly && (
                <button className="lane-tool" title="Naloži drugo avdio datoteko"
                  onClick={e => { e.stopPropagation(); onLoadAudio() }}>⇄</button>
              )}
            </div>
            <div className="audio-head-gain">
              <span className="lane-meta">Gain</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={audioTrack.gain} disabled={readOnly}
                onChange={e => onUpdateAudio({ gain: Number(e.target.value) })}
                onClick={e => e.stopPropagation()}
              />
              <span className="audio-head-val mono">{Math.round(audioTrack.gain * 100)}%</span>
            </div>
          </div>
        ) : (
          <button className="audio-load" disabled={readOnly}
            onClick={e => { e.stopPropagation(); onLoadAudio() }}>
            ♪ Naloži avdio
          </button>
        )}
      </div>

      <div className="lanes-viewport" ref={viewportRef}>
        <div className="lanes-inner" style={{ transform: `translateY(-${scrollY}px)` }}>
          {tracks.map((track, i) => {
            const h = layerRowHeights[track.id] ?? DEFAULT_LANE_H
            const isSelected = i === selectedIdx
            if (track.type === 'group') {
              const gt = track as GroupTrack
              const members = tracks.filter(t => t.type === 'layer' && (t as LayerTrack).groupId === gt.resolumeGroupId)
              const nAuto = gt.automations.length
              const addKey = `add:${gt.id}`
              const offline = gt.resolumeGroupIndex < 1
              return (
                <div key={gt.id}>
                  <div
                    className={`lane-row group-row ${isSelected ? 'selected' : ''} ${gt.muted ? 'muted' : ''}`}
                    style={{ height: h, ['--group-color' as any]: gt.color ?? 'var(--bg-splitter)' }}
                    onClick={() => onSelect(i)}
                  >
                    <div className="lane-stripe group" />
                    <div className="layer-head">
                      <div className="layer-line">
                        <button className="group-collapse"
                          title={gt.collapsed ? 'Razpri skupino (pokaži layerje)' : 'Zloži skupino (skrij layerje)'}
                          onClick={e => { e.stopPropagation(); onToggleGroupCollapsed(i) }}
                        >{gt.collapsed ? '▸' : '▾'}</button>
                        <span className="group-chip" title={offline ? 'Skupine ni več v Resolume' : `Resolume skupina ${gt.resolumeGroupIndex}`}>
                          {offline ? 'G —' : `G${gt.resolumeGroupIndex}`}
                        </span>
                        <span className="lane-name" title={gt.name}>{gt.name}</span>
                        <div className="lane-toggles">
                          {!readOnly && (
                            <button
                              className={`lane-toggle lane-add ${picker?.key === addKey ? 'open' : ''}`}
                              title="Dodaj avtomacijo parametra skupine (master, opacity, efekti skupine …)"
                              onClick={e => openPicker(e, { ti: i, mode: 'add', key: addKey })}
                            >+</button>
                          )}
                          <button
                            className={`lane-toggle ${gt.muted ? 'on-mute' : ''}`}
                            title={gt.muted ? 'Utišano: skupina in njeni layerji ne pošiljajo (klikni za vklop)' : 'Utišaj skupino in njene layerje'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleMute(i) }}
                          >M</button>
                          <button
                            className={`lane-toggle ${gt.locked ? 'on-lock' : ''}`}
                            title={gt.locked ? 'Zaklenjeno za urejanje (klikni za odklep)' : 'Zakleni skupino za urejanje'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleLock(i) }}
                          >L</button>
                        </div>
                      </div>
                      <div className="layer-line group-sub">
                        <button
                          className={`lane-expand ${nAuto ? '' : 'empty'}`}
                          title={`${gt.expanded ? 'Skrij avtomacijo skupine' : 'Pokaži avtomacijo skupine'} (${nAuto})`}
                          onClick={e => { e.stopPropagation(); onToggleExpand(i) }}
                        >{gt.expanded ? '▾' : '▸'}{nAuto > 0 && <span className="lane-auto-count">{nAuto}</span>}</button>
                        <span className="lane-meta">
                          Skupina · {members.length} {members.length === 1 ? 'layer' : members.length === 2 ? 'layerja' : 'layerji'}
                          {gt.collapsed ? ' · zloženo' : ''}
                        </span>
                      </div>
                    </div>
                    {!readOnly && <ResizeHandle onStart={y => setResizing({ id: gt.id, kind: 'layer', startY: y, startH: h })} />}
                  </div>
                  {renderAutoLanes(gt as unknown as LayerTrack, i)}
                </div>
              )
            }
            if (track.type !== 'layer') {
              return (
                <div key={track.id} className={`lane-row ${isSelected ? 'selected' : ''} ${i % 2 ? 'alt' : ''}`}
                  style={{ height: h }} onClick={() => onSelect(i)}>
                  <div className="lane-stripe" style={{ background: track.color ?? 'var(--bg-splitter)' }} />
                  <div className="lane-body">
                    <div className="lane-name">{track.name}</div>
                    <div className="lane-meta">{track.type}</div>
                  </div>
                </div>
              )
            }

            const lt = track as LayerTrack
            const group = lt.groupId !== undefined
              ? tracks.find(t => t.type === 'group' && (t as GroupTrack).resolumeGroupId === lt.groupId) as GroupTrack | undefined
              : undefined
            if (group?.collapsed) return null
            const offline = lt.resolumeLayerIndex < 1
            const nAuto = lt.automations.length
            const addKey = `add:${lt.id}`
            return (
              <div key={lt.id}>
                <div
                  className={`lane-row layer-row ${isSelected ? 'selected' : ''} ${i % 2 ? 'alt' : ''} ${lt.muted || group?.muted ? 'muted' : ''} ${group ? 'in-group' : ''}`}
                  style={{ height: h, ...(group ? { ['--group-color' as any]: group.color ?? 'var(--bg-splitter)' } : {}) }}
                  onClick={() => onSelect(i)}
                >
                  <div className="lane-stripe" style={{ background: lt.color ?? 'var(--bg-splitter)' }} />
                  <div className="layer-head">
                    <div className="layer-line">
                      <button
                        className={`lane-expand ${nAuto ? '' : 'empty'}`}
                        title={`${lt.expanded ? 'Skrij avtomacijo' : 'Pokaži avtomacijo'} (${nAuto})`}
                        onClick={e => { e.stopPropagation(); onToggleExpand(i) }}
                      >{lt.expanded ? '▾' : '▸'}{nAuto > 0 && <span className="lane-auto-count">{nAuto}</span>}</button>
                      <span className={`lane-num ${offline ? 'offline' : ''}`}
                        title={offline ? 'Layerja ni več v Resolume' : `Resolume layer ${lt.resolumeLayerIndex}`}>
                        {offline ? '—' : lt.resolumeLayerIndex}
                      </span>
                      <span className="lane-name" title={`${lt.name} · ${lt.clips.length} ${lt.clips.length === 1 ? 'clip' : 'clipov'}`}>{lt.name}</span>
                      <div className="lane-toggles">
                        {!readOnly && (
                          <button
                            className={`lane-toggle lane-add ${picker?.key === addKey ? 'open' : ''}`}
                            title="Dodaj avtomacijo parametra"
                            onClick={e => openPicker(e, { ti: i, mode: 'add', key: addKey })}
                          >+</button>
                        )}
                        <button
                          className={`lane-toggle ${lt.muted ? 'on-mute' : ''}`}
                          title={lt.muted ? 'Utišano: ne pošilja v Resolume (klikni za vklop)' : 'Utišaj layer'}
                          disabled={readOnly}
                          onClick={e => { e.stopPropagation(); onToggleMute(i) }}
                        >M</button>
                        <button
                          className={`lane-toggle ${lt.locked ? 'on-lock' : ''}`}
                          title={lt.locked ? 'Zaklenjeno za urejanje (klikni za odklep)' : 'Zakleni za urejanje'}
                          disabled={readOnly}
                          onClick={e => { e.stopPropagation(); onToggleLock(i) }}
                        >L</button>
                      </div>
                    </div>
                    {h >= LIVE_STRIP_MIN_H && (
                      <LiveStrip layer={layerOf(lt)} expected={expectedCue(lt.clips, frame, fps)}
                        offline={offline} connected={!!composition} />
                    )}
                  </div>
                  {!readOnly && <ResizeHandle onStart={y => setResizing({ id: lt.id, kind: 'layer', startY: y, startH: h })} />}
                </div>

                {renderAutoLanes(lt, i)}
              </div>
            )
          })}
        </div>
      </div>
      {pickerEl}
    </div>
  )
}

// Second line of a layer header: what Resolume is actually playing on this layer
function LiveStrip({ layer, expected, offline, connected }: {
  layer: ResolumeLayer | null; expected: ClipCue | null; offline: boolean; connected: boolean
}) {
  if (!layer) {
    return (
      <div className="live-strip">
        <span className="live-chip none" title={!connected ? 'Resolume ni povezan' : offline ? 'Layerja ni več v Resolume' : 'Layer ni najden v Resolume'}>—</span>
      </div>
    )
  }
  const playing = layer.clips?.find(c => String(val(c.connected) ?? '').startsWith('Connected')) ?? null
  const playingName = playing ? String(val(playing.name) ?? '') || `Clip ${playing.id}` : ''
  const expName = expected ? expected.clipName || `Clip ${expected.clipIndex}` : '—'
  const opacity = Number(val((layer as any).video?.opacity) ?? 1)
  const bypassed = !!val((layer as any).bypassed)
  const solo = !!val((layer as any).solo)

  let chip: React.ReactNode
  if (!playing) {
    chip = <span className="live-chip none" title={`Resolume: — · časovnica: ${expName}`}>—</span>
  } else if (expected && playing.id === expected.clipId) {
    chip = (
      <span className="live-chip match" title={`Resolume predvaja ${playingName} — ujema se s časovnico`}>
        <span className="live-chip-glyph">▶</span><span className="live-chip-name">{playingName}</span>
      </span>
    )
  } else {
    chip = (
      <span className="live-chip mismatch" title={`Resolume: ${playingName} · časovnica: ${expName}`}>
        <span className="live-chip-glyph">≠</span><span className="live-chip-name">{playingName}</span>
      </span>
    )
  }
  const op = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0
  return (
    <div className="live-strip">
      {chip}
      <span className="live-opacity" title={`Opacity layerja: ${Math.round(op * 100)} %`}>
        <span className="live-opacity-fill" style={{ width: `${op * 100}%` }} />
      </span>
      {bypassed && <span className="live-flag" title="Layer je v Resolume bypassan — avtomacija ni vidna">B</span>}
      {solo && <span className="live-flag" title="Layer je v Resolume solo">S</span>}
    </div>
  )
}

function ResizeHandle({ onStart }: { onStart: (y: number) => void }) {
  return (
    <div
      className="lane-resize-handle"
      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onStart(e.clientY) }}
    />
  )
}
