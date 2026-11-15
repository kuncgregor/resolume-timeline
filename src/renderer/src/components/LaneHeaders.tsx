import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track, LayerTrack, GroupTrack, Show, AutomationSubTrack, Keyframe, LaneKind, ClipCue } from '../../../shared/show'
import type { ResolumeComposition, ResolumeLayer } from '../../../shared/resolume'
import { layerTransitionParam } from '../../../shared/resolume'
import { ConfirmDialog } from './ConfirmDialog'
import { LONG_PRESS_MS } from '../touch'
import { formatValue, type ParamInfo } from '../../../shared/paramTree'
import { laneColor } from '../laneColor'
import { frameKeyframes, sampleLane } from '../../../shared/automation'
import type { LaneStatusMap } from '../laneStatus'
import { DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_LANE_H, MIN_AUTO_H } from '../layout'
import { smpteToFrames } from './timeUtils'
import { useFrame } from '../frameStore'
import { ParamPicker, KIND_GLYPH, type PickBinding, type PickerClip } from './ParamPicker'

// Tablet view: the audio track and files belong to the app on the computer
const remote: boolean = !!(window as any).timeline?.__remote

interface Props {
  tracks: Track[]
  selectedIdx: number | null
  layerRowHeights: Record<string, number>
  autoLaneHeights: Record<string, number>
  scrollY: number
  audioTrack?: Show['audioTrack']
  readOnly: boolean
  composition: ResolumeComposition | null
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
  rulerMode: 'timecode' | 'bars'          // in effect (always 'timecode' without a tempo)
  hasTempo: boolean
  onSetRulerMode: (mode: 'timecode' | 'bars') => void
  // Right-click: copy a whole lane, paste it onto a layer / group (same parameter there) or its
  // curve onto another lane
  laneClipboard: string | null
  onCopyLane: (trackIdx: number, autoIdx: number) => void
  onPasteLane: (trackIdx: number) => void
  onPasteCurve: (trackIdx: number, autoIdx: number) => void
  onSetTransition: (paramId: number, seconds: number) => void   // Resolume layer transition time
}

interface HeaderMenu { x: number; y: number; ti: number; ai?: number }

interface ResizeState { id: string; kind: 'layer' | 'auto'; startY: number; startH: number }
interface EditState { ti: number; ai: number }
interface PickerState { ti: number; ai?: number; mode: 'add' | 'retarget'; anchor: DOMRect; key: string }

const LIVE_STRIP_MIN_H = 48
const MISMATCH_GRACE_MS = 3000   // composition poll (2 s) + slack before a clip change counts as a mismatch
const TRANSITION_PRESETS = [0, 0.25, 0.5, 1, 2, 4]

// Resolume wraps values as { value }; tolerate plain values too
const val = (p: unknown): unknown => (p && typeof p === 'object' && 'value' in (p as object) ? (p as { value: unknown }).value : p)

/** Normalized lane value at a frame (shared curves: canvas and engine use the same sampler).
 *  `inside` is false before the first / after the last keyframe. */
function valueAtFrame(keyframes: Keyframe[], frame: number, fps: number, kind: LaneKind):
  { value: number; option?: string; inside: boolean } | null {
  const kfs = frameKeyframes(keyframes, fps, t => smpteToFrames(t, fps))
  const v = sampleLane(kfs, frame, kind)
  if (!v || !kfs.length) return null
  return { ...v, inside: frame >= kfs[0].frame && frame <= kfs[kfs.length - 1].frame }
}

// A lane's value at the playhead. Its own components (value, OVR chip), so only they follow
// the playhead and not the whole header column.
interface LaneValueArgs {
  keyframes: Keyframe[]; fps: number; kind: LaneKind
  range: Parameters<typeof formatValue>[2]; suffix?: string
  hold: boolean   // the lane keeps sending outside its keyframes
}
function useLaneValue({ keyframes, fps, kind, range, suffix, hold }: LaneValueArgs) {
  const at = valueAtFrame(keyframes, useFrame(), fps, kind)
  return {
    text: at ? formatValue(kind, at.value, range, at.option, suffix) : '—',
    releasedOutside: at != null && !at.inside && !hold,
  }
}
function LaneValue(args: LaneValueArgs) {
  const { text, releasedOutside } = useLaneValue(args)
  return (
    <span className={`auto-value mono ${releasedOutside ? 'outside' : ''}`}
      title={releasedOutside ? 'Outside the keyframe range — lane is not sending' : 'Value at the playhead'}>{text}</span>
  )
}
// Taken over: the operator's value replaces the playhead value and the LAYER/CLIP switch
// until handed back (the header has no room for all three)
function OvrChip({ ovrText, onClick, ...args }: LaneValueArgs & { ovrText: string; onClick: () => void }) {
  const { text } = useLaneValue(args)
  return (
    <button className="ovr-chip"
      title={`Set by hand in Resolume: ${ovrText}. The lane is not sending (the timeline is at ${text}).\nClick to hand it back to the timeline.`}
      onClick={e => { e.stopPropagation(); onClick() }}>
      <span className="ovr-tag">OVR</span><span className="ovr-val mono">{ovrText}</span><span>↺</span>
    </button>
  )
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

const api = (window as any).timeline

// Clip thumbnails for clip-scope lane headers, shared across renders. Misses are retried
// after a while (a clip in a deck Resolume isn't showing has no thumbnail until it is shown).
// Capped (base64 images, a long session sees many clips): a Map keeps insertion order, so
// re-inserting on use and dropping the first entry is a simple LRU.
const THUMB_CACHE_MAX = 200
const thumbCache = new Map<string, string>()
const thumbMiss = new Map<string, number>()
const thumbGet = (key: string) => {
  const t = thumbCache.get(key)
  if (t !== undefined) { thumbCache.delete(key); thumbCache.set(key, t) }
  return t
}
const thumbPut = (key: string, t: string) => {
  thumbCache.delete(key); thumbCache.set(key, t)
  while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value!)
}
function useClipThumb(layerId: number | undefined, clipId: number | undefined): string | null {
  const key = layerId != null && clipId != null ? `${layerId}-${clipId}` : ''
  const [thumb, setThumb] = useState<string | null>(() => (key && thumbGet(key)) || null)
  useEffect(() => {
    if (!key) { setThumb(null); return }
    const hit = thumbGet(key)
    if (hit) { setThumb(hit); return }
    setThumb(null)
    if (Date.now() - (thumbMiss.get(key) ?? 0) < 15000 || !api?.getThumbnail) return
    let alive = true
    api.getThumbnail(layerId, clipId).then((t: string | null) => {
      if (t) { thumbPut(key, t); if (alive) setThumb(t) } else thumbMiss.set(key, Date.now())
    }).catch(() => thumbMiss.set(key, Date.now()))
    return () => { alive = false }
  }, [key, layerId, clipId])
  return thumb
}

// The cue a clip-scope lane belongs to: its bound cue, else any cue of the same Resolume clip
export function laneCue(lt: LayerTrack, auto: AutomationSubTrack): ClipCue | null {
  const isClip = auto.ref ? auto.ref.scope === 'clip' : (!!auto.clipId && !auto.layerBound)
  if (!isClip || !lt.clips) return null
  return lt.clips.find(c => c.id === auto.clipId)
    ?? (auto.ref?.clipId != null ? lt.clips.find(c => c.clipId === auto.ref!.clipId) : undefined)
    ?? null
}

// Full lane height, so the clip is recognisable (4:3 crop, at most 44 px wide: the header
// column is 232 px and the value and tools beside it must stay readable)
function ClipThumb({ layerId, cue, color, height }: { layerId: number; cue: ClipCue; color: string; height: number }) {
  const thumb = useClipThumb(layerId, cue.clipId)
  return (
    <span className="auto-thumb" title={`Clip: ${cue.clipName}`}
      style={{ ['--clip-color' as any]: color, width: Math.min(44, Math.round(height * 4 / 3)) }}>
      {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="auto-thumb-ph">▶</span>}
    </span>
  )
}

const EyeOff = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
    <path d="M2.5 13.5l11-11" />
  </svg>
)

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
  composition, fps, laneStatus, overrides, onReenable, onToggleGroupCollapsed,
  onSelect, onToggleExpand, onSetAllExpanded, onToggleMute, onToggleLock, onResizeLayer, onResizeAutoLane,
  onAddParam, onRetarget, onUpdateAutomation, onSnapshot,
  onDeleteAutomation, onToggleLayerBound, onEditAutomationTarget, onScrollY,
  onLoadAudio, onUpdateAudio, rulerMode, hasTempo, onSetRulerMode,
  laneClipboard, onCopyLane, onPasteLane, onPasteCurve, onSetTransition,
}: Props) {
  const [resizing, setResizing] = useState<ResizeState | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editValue, setEditValue] = useState('')
  // Removing a lane loses its keyframes: first click arms, second removes
  const [confirmRemove, setConfirmRemove] = useState<{ ti: number; ai: number } | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [menu, setMenu] = useState<HeaderMenu | null>(null)
  // Layer transition popover, and values just set (shown until a poll reports them)
  const [trPop, setTrPop] = useState<{ x: number; y: number; paramId: number; value: number } | null>(null)
  const [trPending, setTrPending] = useState<Record<number, { value: number; at: number }>>({})
  useEffect(() => {
    if (!trPop) return
    const close = () => setTrPop(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [trPop])
  useEffect(() => { setTrPop(null) }, [scrollY])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [menu])
  useEffect(() => { setMenu(null) }, [scrollY])
  const openMenu = (e: React.MouseEvent, ti: number, ai?: number) => {
    e.preventDefault(); e.stopPropagation()
    if (!readOnly) setMenu({ x: e.clientX, y: e.clientY, ti, ai })
  }
  const closePicker = useCallback(() => setPicker(null), [])

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => {
      const delta = e.clientY - resizing.startY
      if (resizing.kind === 'layer') onResizeLayer(resizing.id, Math.max(MIN_LANE_H, resizing.startH + delta))
      else onResizeAutoLane(resizing.id, Math.max(MIN_AUTO_H, resizing.startH + delta))
    }
    const onUp = () => setResizing(null)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }
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

  // Touch: one finger drags the header column up and down (a tap still hits its buttons), and a
  // long press on a header opens its menu, like a right-click
  const panRef = useRef<{ id: number; y: number; moved: boolean; timer: number | null } | null>(null)
  const onTouchDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || panRef.current) return
    const target = e.target as HTMLElement
    const timer = window.setTimeout(() => {
      const p = panRef.current
      if (!p || p.moved) return
      p.timer = null
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }))
    }, LONG_PRESS_MS)
    panRef.current = { id: e.pointerId, y: e.clientY, moved: false, timer }
  }
  const onTouchMove = (e: React.PointerEvent) => {
    const p = panRef.current
    if (!p || p.id !== e.pointerId) return
    const dy = e.clientY - p.y
    if (!p.moved && Math.abs(dy) < 10) return
    if (!p.moved) { p.moved = true; if (p.timer) { clearTimeout(p.timer); p.timer = null } }
    p.y = e.clientY
    onScrollY(-dy)
  }
  const onTouchUp = (e: React.PointerEvent) => {
    const p = panRef.current
    if (!p || p.id !== e.pointerId) return
    if (p.timer) clearTimeout(p.timer)
    panRef.current = null
  }

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
        title={picker.mode === 'retarget' && ai != null ? `Retarget: ${lt.automations[ai]?.ref?.label ?? lt.automations[ai]?.name ?? ''}` : undefined}
        onPick={(info, binding) => {
          if (picker.mode === 'add') onAddParam(picker.ti, info, binding)
          else if (ai != null) onRetarget(picker.ti, ai, info)
        }}
        onClose={closePicker}
      />
    )
  }

  // Automation lanes under a layer or a group track (same rows for both)
  const renderAutoLanes = (lt: LayerTrack, i: number, parentColor: string) => (
    lt.expanded && lt.automations.some(a => a.visible !== false) && (
    <div className="auto-block" style={{ ['--parent-color' as any]: parentColor }}>
    {lt.automations.map((auto, ai) => {
                  if (auto.visible === false) return null
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
                  const valueArgs: LaneValueArgs = { keyframes: auto.keyframes, fps, kind, range, suffix: status?.info?.suffix, hold: auto.outside === 'hold' }
                  // Taken over live: the value shown is the one the operator set in Resolume
                  const ovr = overrides[auto.id]
                  const ovrText = ovr != null ? formatValue(kind, ovr, range, undefined, status?.info?.suffix) : null
                  const { owner: refOwner, param } = splitLabel(auto)
                  const cue = (lt as Track).type === 'layer' ? laneCue(lt, auto) : null
                  const cueColor = cue ? (cue.color ?? cue.resolumeColor ?? lt.color ?? 'var(--scope-clip)') : ''
                  // A clip lane names its clip, not the generic "Clip · …" owner
                  const sub = refOwner.startsWith('Clip · ') ? refOwner.slice(7) : ''
                  // The same clip more than once on the layer (a split): its start tells the lanes apart
                  const twin = cue && lt.clips.filter(c => c.clipId === cue.clipId).length > 1
                  const clipLabel = cue ? (twin ? `${cue.time.slice(3)} ${cue.clipName}` : cue.clipName) : ''
                  const owner = cue ? (sub ? `${sub} · ${clipLabel}` : clipLabel) : refOwner
                  const retargetKey = `rt:${auto.id}`
                  const labelTip = [
                    auto.ref?.label ?? auto.name,
                    broken ? `✕ ${status?.reason ?? 'target no longer exists in Resolume'}` : null,
                    status?.state === 'offline' ? 'Resolume not connected' : null,
                    status?.state === 'elsewhere' ? status.reason : null,
                    !enabled ? 'Disabled: not sending' : null,
                    auto.target ? `OSC: ${auto.target}` : null,
                    readOnly ? null : 'Click: retarget to another parameter',
                  ].filter(Boolean).join('\n')
                  return (
                    <div key={auto.id}
                      className={`lane-row auto-row ${broken ? 'broken' : ''} ${enabled ? '' : 'disabled'} ${cue ? 'clip-lane' : ''}`}
                      style={{ height: autoH, ...(cue ? { ['--clip-color' as any]: cueColor } : {}) }}
                      onContextMenu={e => openMenu(e, i, ai)}>
                      <div className="lane-stripe auto" style={{ background: broken ? 'var(--danger)' : laneColor(auto, lt, 'var(--live-fill)') }} />
                      {cue && <ClipThumb layerId={lt.resolumeLayerId} cue={cue} color={cueColor} height={autoH - 1} />}
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
                            {!cue && <span className="auto-glyph">{KIND_GLYPH[kind]}</span>}
                            <button
                              className={`auto-label ${picker?.key === retargetKey ? 'open' : ''}`}
                              title={labelTip}
                              disabled={readOnly}
                              onClick={e => openPicker(e, { ti: i, ai, mode: 'retarget', key: retargetKey })}
                            >
                              {broken && <span className="auto-broken">✕ </span>}
                              {cue ? (
                                // Clip lanes: the parameter first, the (long) clip name after it
                                <><span className="auto-param">{param}</span><span className="auto-owner"> · {owner}</span></>
                              ) : (
                                <>{owner && <span className="auto-owner">{owner} › </span>}<span className="auto-param">{param}</span></>
                              )}
                            </button>
                            {legacy && (
                              <span
                                className={`auto-osc ${!auto.ref && !readOnly ? 'editable' : ''}`}
                                title={`legacy lane without a stable target\n${auto.target}${!auto.ref && !readOnly ? '\n\nClick: edit OSC path' : ''}`}
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
                          {ovrText == null && <LaneValue {...valueArgs} />}
                          {ovrText == null && <button
                            className={`bind-chip ${isLayerBound ? 'layer' : 'clip'}`}
                            title={isLayerBound
                              ? 'Fixed on the timeline — click to follow the clip'
                              : 'Follows the clip — click to fix it on the timeline'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleLayerBound(i, ai) }}
                          >{isLayerBound ? 'LAYER' : 'CLIP'}</button>}
                          {ovrText != null && (
                            // Taken over: the operator's value replaces the playhead value and the
                            // LAYER/CLIP switch until handed back (the header has no room for all three)
                            <OvrChip {...valueArgs} ovrText={ovrText} onClick={() => onReenable([auto.id])} />
                          )}
                          <span className="auto-spacer" />
                          <button
                            className="lane-tool auto-hide"
                            title="Hide this lane (it keeps playing). Show it again from the hidden-lanes button on the layer."
                            onClick={e => { e.stopPropagation(); onUpdateAutomation(i, ai, { visible: false }) }}
                          ><EyeOff /></button>
                          <input
                            type="checkbox" className="auto-enable"
                            checked={enabled} disabled={readOnly}
                            title={enabled ? 'Enabled: lane is sending (click to disable)' : 'Disabled: lane is not sending (click to enable)'}
                            onClick={e => e.stopPropagation()}
                            onChange={e => onUpdateAutomation(i, ai, { enabled: e.target.checked })}
                          />
                          <button
                            className="lane-tool auto-snap"
                            title="Write the current Resolume value as a keyframe at the playhead"
                            disabled={readOnly || status?.state !== 'ok'}
                            onClick={e => { e.stopPropagation(); onSnapshot(i, ai) }}
                          >◉</button>
                          {!readOnly && (
                            <button className="lane-tool danger" title="Remove automation…"
                              onClick={e => { e.stopPropagation(); setConfirmRemove({ ti: i, ai }) }}>✕</button>
                          )}
                        </div>
                      </div>
                      {!readOnly && <ResizeHandle onStart={y => setResizing({ id: auto.id, kind: 'auto', startY: y, startH: autoH })} />}
                    </div>
                  )
                })}
    </div>
  ))

  // Eye + n: lanes hidden from the view; click shows them all again
  // The layer's transition time in Resolume (clip changes on it blend over it); click to set.
  // A value just set shows at once, until the next composition poll reports it.
  const transitionChip = (lt: LayerTrack) => {
    const tr = layerTransitionParam(layerOf(lt))
    if (!tr) return null
    const pend = trPending[tr.paramId]
    const secs = pend && Date.now() - pend.at < 4000 ? pend.value : tr.seconds
    return (
      <button className={`transition-chip${secs > 0 ? ' on' : ''}`} disabled={readOnly}
        title={`Layer transition in Resolume: ${secs > 0 ? `clip changes on this layer blend over ${secs.toFixed(2)} s` : 'off, clip changes cut'}. The blend runs in Resolume's own time (it doesn't pause or scrub). Click to change.`}
        onClick={e => {
          e.stopPropagation()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setTrPop({ x: r.left, y: r.bottom + 2, paramId: tr.paramId, value: secs })
        }}
      >⇄ {secs > 0 ? `${secs.toFixed(secs < 1 && secs * 10 % 1 ? 2 : 1)}s` : '0s'}</button>
    )
  }
  const setTransition = (paramId: number, seconds: number) => {
    const v = Math.max(0, Math.min(10, seconds))
    setTrPending(p => ({ ...p, [paramId]: { value: v, at: Date.now() } }))
    onSetTransition(paramId, v)
    setTrPop(null)
  }

  const hiddenChip = (lt: LayerTrack, i: number) => {
    const n = lt.automations.filter(a => a.visible === false).length
    if (!n) return null
    return (
      <button className="lane-toggle hidden-chip"
        title={`${n} hidden automation ${n === 1 ? 'lane' : 'lanes'} (still playing) — click to show`}
        onClick={e => {
          e.stopPropagation()
          lt.automations.forEach((a, ai) => { if (a.visible === false) onUpdateAutomation(i, ai, { visible: true }) })
          if (!lt.expanded) onToggleExpand(i)
        }}><EyeOff />{n}</button>
    )
  }

  return (
    <div className="lane-headers" style={{ userSelect: resizing ? 'none' : undefined }}>
      <div className="ruler-corner">
        <span>Layers <span className="ruler-corner-count">{tracks.length}</span></span>
        <button
          className="corner-expand"
          title={anyExpanded ? 'Hide automation on all layers' : 'Show automation on all layers'}
          onClick={() => onSetAllExpanded(!anyExpanded)}
        >{anyExpanded ? '▸ all' : '▾ all'}</button>
        <div className="ruler-mode" role="group" aria-label="Ruler">
          {([['timecode', 'TC', 'Ruler in timecode'], ['bars', 'BARS', 'Ruler in bars and beats']] as const).map(([m, l, tip]) => (
            <button key={m} className={`ruler-mode-btn ${rulerMode === m ? 'on' : ''}`}
              disabled={m === 'bars' && !hasTempo}
              aria-pressed={rulerMode === m}
              title={m === 'bars' && !hasTempo ? 'Set a BPM first (transport or ✎ Edit timeline › Tempo)' : tip}
              onClick={() => { if (rulerMode !== m) onSetRulerMode(m) }}
            >{l}</button>
          ))}
        </div>
      </div>

      {/* Audio lane header — pinned under the ruler like the canvas audio lane */}
      <div className="audio-head" onClick={e => e.stopPropagation()}>
        <div className="lane-stripe" style={{ background: audioColor }} />
        {audioTrack ? (
          <div className="audio-head-body">
            <div className="audio-head-top">
              <span className="audio-head-icon">♪</span>
              <span className="audio-head-name" title={audioTrack.filePath}>{audioTrack.name}</span>
              {!readOnly && !remote && (
                <button className="lane-tool" title="Load a different audio file"
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
          <button className="audio-load" disabled={readOnly || remote}
            title={remote ? 'The audio track is loaded on the computer running the app' : undefined}
            onClick={e => { e.stopPropagation(); onLoadAudio() }}>
            ♪ Load audio
          </button>
        )}
      </div>

      <div className="lanes-viewport" ref={viewportRef}
        onPointerDown={onTouchDown} onPointerMove={onTouchMove} onPointerUp={onTouchUp} onPointerCancel={onTouchUp}>
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
                    style={{ height: h, ['--group-color' as any]: gt.color ?? 'var(--group-none)' }}
                    onClick={() => onSelect(i)}
                    onContextMenu={e => openMenu(e, i)}
                  >
                    <div className="lane-stripe group" />
                    <div className="layer-head">
                      <div className="layer-line">
                        <button className="group-collapse"
                          title={gt.collapsed ? 'Expand group (show layers)' : 'Collapse group (hide layers)'}
                          onClick={e => { e.stopPropagation(); onToggleGroupCollapsed(i) }}
                        >{gt.collapsed ? '▸' : '▾'}</button>
                        <span className="group-chip" title={offline ? 'Group no longer exists in Resolume' : `Resolume group ${gt.resolumeGroupIndex}`}>
                          {offline ? 'G —' : `G${gt.resolumeGroupIndex}`}
                        </span>
                        <span className="lane-name" title={gt.name}>{gt.name}</span>
                        <div className="lane-toggles">
                          {hiddenChip(gt as unknown as LayerTrack, i)}
                          {!readOnly && (
                            <button
                              className={`lane-toggle lane-add ${picker?.key === addKey ? 'open' : ''}`}
                              title="Add automation for a group parameter (master, opacity, group effects …)"
                              onClick={e => openPicker(e, { ti: i, mode: 'add', key: addKey })}
                            >+</button>
                          )}
                          <button
                            className={`lane-toggle ${gt.muted ? 'on-mute' : ''}`}
                            title={gt.muted ? 'Muted: the group and its layers are not sending (click to unmute)' : 'Mute the group and its layers'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleMute(i) }}
                          >M</button>
                          <button
                            className={`lane-toggle ${gt.locked ? 'on-lock' : ''}`}
                            title={gt.locked ? 'Locked for editing (click to unlock)' : 'Lock the group for editing'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleLock(i) }}
                          >L</button>
                        </div>
                      </div>
                      <div className="layer-line group-sub">
                        <button
                          className={`lane-expand ${nAuto ? '' : 'empty'}`}
                          title={`${gt.expanded ? 'Hide group automation' : 'Show group automation'} (${nAuto})`}
                          onClick={e => { e.stopPropagation(); onToggleExpand(i) }}
                        >{gt.expanded ? '▾' : '▸'}{nAuto > 0 && <span className="lane-auto-count">{nAuto}</span>}</button>
                        <span className="lane-meta">
                          Group · {members.length} {members.length === 1 ? 'layer' : 'layers'}
                          {gt.collapsed ? ' · collapsed' : ''}
                        </span>
                      </div>
                    </div>
                    {!readOnly && <ResizeHandle onStart={y => setResizing({ id: gt.id, kind: 'layer', startY: y, startH: h })} />}
                  </div>
                  {renderAutoLanes(gt as unknown as LayerTrack, i, gt.color ?? 'var(--group-none)')}
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
              <div key={lt.id}
                className={group ? 'member-block' : undefined}
                style={group ? { ['--group-color' as any]: group.color ?? 'var(--group-none)' } : undefined}>
                <div
                  className={`lane-row layer-row ${isSelected ? 'selected' : ''} ${i % 2 ? 'alt' : ''} ${lt.muted || group?.muted ? 'muted' : ''} ${group ? 'in-group' : ''}`}
                  style={{ height: h }}
                  onClick={() => onSelect(i)}
                  onContextMenu={e => openMenu(e, i)}
                >
                  <div className="lane-stripe" style={{ background: lt.color ?? 'var(--bg-splitter)' }} />
                  <div className="layer-head">
                    <div className="layer-line">
                      <button
                        className={`lane-expand ${nAuto ? '' : 'empty'}`}
                        title={`${lt.expanded ? 'Hide automation' : 'Show automation'} (${nAuto})`}
                        onClick={e => { e.stopPropagation(); onToggleExpand(i) }}
                      >{lt.expanded ? '▾' : '▸'}{nAuto > 0 && <span className="lane-auto-count">{nAuto}</span>}</button>
                      <span className={`lane-num ${offline ? 'offline' : ''}`}
                        title={offline ? 'Layer no longer exists in Resolume' : `Resolume layer ${lt.resolumeLayerIndex}`}>
                        {offline ? '—' : lt.resolumeLayerIndex}
                      </span>
                      <span className="lane-name" title={`${lt.name} · ${lt.clips.length} ${lt.clips.length === 1 ? 'clip' : 'clips'}`}>{lt.name}</span>
                      <div className="lane-toggles">
                        {transitionChip(lt)}
                        {hiddenChip(lt, i)}
                        {!readOnly && (
                          <button
                            className={`lane-toggle lane-add ${picker?.key === addKey ? 'open' : ''}`}
                            title="Add parameter automation"
                            onClick={e => openPicker(e, { ti: i, mode: 'add', key: addKey })}
                          >+</button>
                        )}
                        <button
                          className={`lane-toggle ${lt.muted ? 'on-mute' : ''}`}
                          title={lt.muted ? 'Muted: not sending to Resolume (click to unmute)' : 'Mute layer'}
                          disabled={readOnly}
                          onClick={e => { e.stopPropagation(); onToggleMute(i) }}
                        >M</button>
                        <button
                          className={`lane-toggle ${lt.locked ? 'on-lock' : ''}`}
                          title={lt.locked ? 'Locked for editing (click to unlock)' : 'Lock for editing'}
                          disabled={readOnly}
                          onClick={e => { e.stopPropagation(); onToggleLock(i) }}
                        >L</button>
                      </div>
                    </div>
                    {h >= LIVE_STRIP_MIN_H && (
                      <LiveStrip layer={layerOf(lt)} clips={lt.clips} fps={fps}
                        offline={offline} connected={!!composition} />
                    )}
                  </div>
                  {!readOnly && <ResizeHandle onStart={y => setResizing({ id: lt.id, kind: 'layer', startY: y, startH: h })} />}
                </div>

                {renderAutoLanes(lt, i, lt.color ?? 'var(--bg-splitter)')}
              </div>
            )
          })}
        </div>
      </div>
      {pickerEl}
      {confirmRemove && (() => {
        const t = tracks[confirmRemove.ti] as LayerTrack | undefined
        const lane = t?.automations?.[confirmRemove.ai]
        if (!t || !lane) return null
        const n = lane.keyframes.length
        return (
          <ConfirmDialog
            title="Remove automation"
            message={<>Remove <b>{lane.ref?.label ?? lane.name}</b> on {t.name} and its {n} {n === 1 ? 'keyframe' : 'keyframes'}?
              The parameter goes back to its Resolume default.</>}
            confirmLabel="Remove" danger
            onConfirm={() => { setConfirmRemove(null); onDeleteAutomation(confirmRemove.ti, confirmRemove.ai) }}
            onCancel={() => setConfirmRemove(null)}
          />
        )
      })()}
      {trPop && (
        <div className="dropdown header-menu transition-pop" style={{ left: trPop.x, top: trPop.y }} onMouseDown={e => e.stopPropagation()}>
          <div className="transition-pop-title">Layer transition (Resolume)</div>
          {TRANSITION_PRESETS.map(v => (
            <button key={v} className="dropdown-item" onClick={() => setTransition(trPop.paramId, v)}>
              {v === 0 ? 'Off (cut)' : `${v} s`}
              {Math.abs(trPop.value - v) < 0.005 && <span className="dropdown-key on">✓</span>}
            </button>
          ))}
          <div className="dropdown-sep" />
          <label className="transition-pop-custom">
            <span>Other</span>
            <input type="number" min={0} max={10} step={0.05} defaultValue={trPop.value}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Enter') { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v)) setTransition(trPop.paramId, v) }
              }} />
            <span>s</span>
          </label>
        </div>
      )}
      {menu && (() => {
        const t = tracks[menu.ti] as LayerTrack | undefined
        const lane = menu.ai != null ? t?.automations?.[menu.ai] : undefined
        const locked = !!t?.locked
        const label = lane ? (lane.ref?.label ?? lane.name) : ''
        const run = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); setMenu(null) }
        return (
          <div className="dropdown header-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={e => e.stopPropagation()}>
            {lane ? (
              <>
                <button className="dropdown-item" onClick={run(() => onCopyLane(menu.ti, menu.ai!))}
                  title="Copy this lane: paste it onto another layer (right-click its header), onto a clip (clip right-click) or its curve onto another lane">
                  Copy lane: {label}
                </button>
                <button className="dropdown-item" disabled={!laneClipboard || locked} onClick={run(() => onPasteCurve(menu.ti, menu.ai!))}
                  title="The copied curve on this lane's parameter, at the same times (keys there are replaced)">
                  {laneClipboard ? `Paste curve of ${laneClipboard}` : 'Paste curve'}
                </button>
              </>
            ) : (
              <button className="dropdown-item" disabled={!laneClipboard || locked} onClick={run(() => onPasteLane(menu.ti))}
                title={laneClipboard ? `The same parameter on ${t?.name ?? 'this layer'}, at the same times` : 'Copy a lane first: right-click its header › Copy lane'}>
                {laneClipboard ? `Paste lane: ${laneClipboard}` : 'Paste lane (copy a lane first)'}
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// Second line of a layer header: what Resolume is actually playing on this layer
function LiveStrip({ layer, clips, fps, offline, connected }: {
  layer: ResolumeLayer | null; clips: ClipCue[]; fps: number; offline: boolean; connected: boolean
}) {
  const expected = expectedCue(clips, useFrame(), fps)
  // Resolume's state arrives with the composition poll (every 2 s): right after the timeline's
  // clip changes, the old clip still showing isn't a mismatch yet
  const changed = useRef<{ id: string | null; at: number }>({ id: null, at: 0 })
  if ((expected?.id ?? null) !== changed.current.id) changed.current = { id: expected?.id ?? null, at: Date.now() }
  const settling = Date.now() - changed.current.at < MISMATCH_GRACE_MS
  if (!layer) {
    return (
      <div className="live-strip">
        <span className="live-chip none" title={!connected ? 'Resolume not connected' : offline ? 'Layer no longer exists in Resolume' : 'Layer not found in Resolume'}>—</span>
      </div>
    )
  }
  // During a layer transition Resolume shows two clips connected (the outgoing one and the
  // incoming one): the timeline's clip among them is a match, not a mismatch
  const live = (layer.clips ?? []).filter(c => String(val(c.connected) ?? '').startsWith('Connected'))
  const playing = live.find(c => c.id === expected?.clipId) ?? live[0] ?? null
  const playingName = playing ? String(val(playing.name) ?? '') || `Clip ${playing.id}` : ''
  const expName = expected ? expected.clipName || `Clip ${expected.clipIndex}` : '—'
  const opacity = Number(val((layer as any).video?.opacity) ?? 1)
  const bypassed = !!val((layer as any).bypassed)
  const solo = !!val((layer as any).solo)

  let chip: React.ReactNode
  if (!playing) {
    chip = <span className="live-chip none" title={`Resolume: — · timeline: ${expName}`}>—</span>
  } else if (expected && (playing.id === expected.clipId || settling)) {
    const name = playing.id === expected.clipId ? playingName : expName   // settling: the new clip
    chip = (
      <span className="live-chip match" title={`Resolume is playing ${name} — matches the timeline`}>
        <span className="live-chip-glyph">▶</span><span className="live-chip-name">{name}</span>
      </span>
    )
  } else {
    chip = (
      <span className="live-chip mismatch" title={`Resolume: ${playingName} · timeline: ${expName}`}>
        <span className="live-chip-glyph">≠</span><span className="live-chip-name">{playingName}</span>
      </span>
    )
  }
  const op = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0
  return (
    <div className="live-strip">
      {chip}
      <span className="live-opacity" title={`Layer opacity: ${Math.round(op * 100)}%`}>
        <span className="live-opacity-fill" style={{ width: `${op * 100}%` }} />
      </span>
      {bypassed && <span className="live-flag" title="Layer is bypassed in Resolume — automation is not visible">B</span>}
      {solo && <span className="live-flag" title="Layer is soloed in Resolume">S</span>}
    </div>
  )
}

function ResizeHandle({ onStart }: { onStart: (y: number) => void }) {
  return (
    <div
      className="lane-resize-handle"
      onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onStart(e.clientY) }}
    />
  )
}
