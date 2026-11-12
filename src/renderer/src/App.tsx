import { useEffect, useRef, useState, useCallback } from 'react'
import type { Show, Track, LayerTrack, GroupTrack, AutomationSubTrack, ClipCue, EngineState, Keyframe } from '../../shared/show'
import type { ResolumeComposition } from '../../shared/resolume'
import type { RundownEntry, ShowEntry, BreakEntry, ConcertFile } from '../../shared/concert'
import { rv, layerDisplayName, resolumeColor } from '../../shared/resolume'
import { TransportBar } from './components/TransportBar'
import { LaneHeaders } from './components/LaneHeaders'
import { TimelineCanvas } from './components/TimelineCanvas'
import { BottomPanel } from './components/BottomPanel'
import { ClipBrowser } from './components/ClipBrowser'
import { RundownStrip } from './components/RundownStrip'
import { RundownEditModal } from './components/RundownEditModal'
import { ClockSettingsModal } from './components/ClockSettingsModal'
import { framesToSmpte, smpteToFrames } from './components/timeUtils'
import { LTCDecoder } from './ltc-decoder'
import { AudioEngine } from './audio-engine'
import type { WaveformInfo } from './audio-engine'
import { loadAutosave, writeAutosave, clearAutosave } from './autosave'
import { TAG_COLORS } from './theme'
import { resolveShow, laneFieldsFor } from './resolver'
import type { LaneStatusMap } from './laneStatus'
import { decksOf } from './decks'
import { sameRef, normalize, type ParamInfo } from '../../shared/paramTree'

const api = (window as any).timeline

export interface DragClipData {
  layerIndex: number; layerId: number
  clipIndex: number; clipId: number; clipName: string
  deckId?: number; deckIndex?: number; deckName?: string   // Resolume deck the clip comes from
}

// New layers and rundown entries get muted Resolume-style tag colours
const LAYER_COLORS = TAG_COLORS
const ENTRY_COLORS = TAG_COLORS
// Automation lane colours by scope: layer parameters green family, clip parameters orange
// family (same split as the inspector tabs and the LAYER/CLIP chips)
const SCOPE_COLORS = {
  layer: ['#6fd6a8', '#9be8c4', '#4fbf94', '#b5e86b'],
  group: ['#6fd6a8', '#9be8c4', '#4fbf94', '#b5e86b'],
  clip: ['#f2a33a', '#ffc46b', '#e8893a', '#ffd98a'],
}

const EMPTY_SHOW: Show = {
  version: 1, name: 'Timeline 1', frameRate: 25, duration: '02:00:00:00',
  resolume: { host: '127.0.0.1', oscPort: 7000, restPort: 8080, feedbackPort: 7001 },
  clock: { source: 'internal', offset: '00:00:00:00', freewheelFrames: 5 },
  markers: [], tracks: [],
}

// Mirrors the Resolume layer list into the show. Tracks whose layer is gone from the
// composition are kept (they hold cues/automation). Returns `show` unchanged when
// nothing differs, so a periodic sync does not mark the show dirty.
// Colour shown for a track: Resolume's colour tag wins while one is set; clearing the tag in
// Resolume restores the colour the app had assigned
function withTagColor<T extends { color?: string; appColor?: string }>(t: T, tag: string | undefined): T {
  if (tag) return t.color === tag ? t : { ...t, color: tag, appColor: t.appColor ?? t.color }
  if (t.appColor === undefined) return t
  const { appColor, ...rest } = t
  return { ...rest, color: appColor } as T
}

const shallowSame = (a: object, b: object) =>
  Object.keys({ ...a, ...b }).every(k => (a as any)[k] === (b as any)[k])

// Mirrors the Resolume layer list (and Arena layer groups) into the show, in Resolume's
// order with each group track placed directly before its member layers. Tracks whose layer is
// gone are kept (they hold cues/automation). Returns `show` unchanged when nothing differs, so
// the periodic sync does not mark the show dirty.
function syncLayers(show: Show, comp: ResolumeComposition): Show {
  const layers = (comp.layers ?? []).filter(Boolean)
  const groups = (comp.layergroups ?? []).filter(Boolean)
  const groupOf = new Map<number, number>()   // layer id → group index in comp.layergroups
  groups.forEach((g, gi) => (g.layers ?? []).forEach(l => l && groupOf.set(l.id, gi)))
  const matched = new Set<string>()
  const out: Track[] = []
  const emitted = new Set<number>()

  const syncGroup = (gi: number): Track => {
    const g = groups[gi]
    const name = rv(g.name, `Group ${gi + 1}`).replace(/#/g, String(gi + 1))
    const existing = show.tracks.find(t => t.type === 'group' && (t as GroupTrack).resolumeGroupId === g.id) as GroupTrack | undefined
    const base: GroupTrack = existing ?? {
      id: `group-${g.id}`, name, type: 'group', resolumeGroupId: g.id, resolumeGroupIndex: gi + 1,
      color: LAYER_COLORS[(gi + 5) % LAYER_COLORS.length], expanded: false, automations: [],
    }
    if (existing) matched.add(existing.id)
    const next = withTagColor({ ...base, name, resolumeGroupIndex: gi + 1 }, resolumeColor(g.colorid))
    return existing && shallowSame(existing, next) ? existing : next
  }

  layers.forEach((layer, li) => {
    const gi = groupOf.get(layer.id)
    if (gi !== undefined && !emitted.has(gi)) { emitted.add(gi); out.push(syncGroup(gi)) }
    const name = layerDisplayName(rv(layer.name, `Layer ${li + 1}`), li + 1)
    const groupId = gi !== undefined ? groups[gi].id : undefined
    const existing = show.tracks.find(
      t => t.type === 'layer' && (t as LayerTrack).resolumeLayerId === layer.id
    ) as LayerTrack | undefined
    const tag = resolumeColor(layer.colorid)
    if (!existing) {
      out.push(withTagColor({
        id: `layer-${layer.id}`, name,
        type: 'layer' as const, resolumeLayerId: layer.id, resolumeLayerIndex: li + 1, groupId,
        color: LAYER_COLORS[li % LAYER_COLORS.length], expanded: false, clips: [], automations: [],
      }, tag))
      return
    }
    matched.add(existing.id)
    // Clip slots can be moved in Resolume; follow the clip by its stable id (and its colour tag)
    const clipById = new Map((layer.clips ?? []).map((c, ci) => [c?.id, { slot: ci + 1, tag: resolumeColor(c?.colorid) }]))
    let clipsChanged = false
    const clips = existing.clips.map(c => {
      const rc = clipById.get(c.clipId)
      if (!rc || (rc.slot === c.clipIndex && rc.tag === c.resolumeColor)) return c
      clipsChanged = true
      return { ...c, clipIndex: rc.slot, resolumeColor: rc.tag }
    })
    const next = withTagColor({ ...existing, name, resolumeLayerIndex: li + 1, groupId, clips: clipsChanged ? clips : existing.clips }, tag)
    out.push(shallowSame(existing, next) ? existing : next)
  })
  // Gone from Resolume: index 0 = offline, so the scheduler stops firing into a wrong layer/group
  const unmatched = show.tracks
    .filter(t => !matched.has(t.id) && !out.some(s => s.id === t.id))
    .map(t => t.type === 'layer' && (t as LayerTrack).resolumeLayerIndex !== 0
      ? { ...(t as LayerTrack), resolumeLayerIndex: 0, groupId: undefined }
      : t.type === 'group' && (t as GroupTrack).resolumeGroupIndex !== 0
        ? { ...(t as GroupTrack), resolumeGroupIndex: 0 } : t)
  const tracks = [...out, ...unmatched]
  if (tracks.length === show.tracks.length && tracks.every((t, i) => t === show.tracks[i])) return show
  return { ...show, tracks }
}

// Resolume reports fileinfo.duration as a "HH:MM:SS.ss" string and duration_ms as a number
function resolveClipDuration(clipRaw: any): number {
  if (!clipRaw) return 0
  const fi = clipRaw?.video?.fileinfo ?? clipRaw?.audio?.fileinfo ?? clipRaw?.fileinfo
  if (typeof fi?.duration_ms === 'number' && fi.duration_ms > 0) return fi.duration_ms / 1000
  const d = fi?.duration?.value ?? fi?.duration ?? clipRaw?.transport?.controls?.duration?.value
  if (typeof d === 'number') return d > 0 ? d : 0
  if (typeof d === 'string') {
    const secs = d.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0)
    return Number.isFinite(secs) && secs > 0 ? secs : 0
  }
  return 0
}

let uid = 1
const newId = () => `c${Date.now()}-${uid++}`
let entryUid = 1
const newEntryId = () => `e${Date.now()}-${entryUid++}`

function makeShowEntry(show: Show, filePath: string | null = null, colorIdx = 0): ShowEntry {
  return {
    id: newEntryId(), type: 'show', show, filePath, dirty: false,
    color: ENTRY_COLORS[colorIdx % ENTRY_COLORS.length], notes: '',
  }
}

function makeBreakEntry(): BreakEntry {
  return { id: newEntryId(), type: 'break', label: 'Break', duration: '00:20:00:00', color: '#333333', notes: '' }
}

// Single module-level initial entry so IDs are stable across renders
const _initEntry = makeShowEntry({ ...EMPTY_SHOW }, null, 0)
// Read once at startup: the state left by the previous session (crash, reload, quit)
// Entries still carrying the old default names ("Nov projekt", "Projekt N") become "Timeline N"
const renameDefault = (r: ReturnType<typeof loadAutosave>) => r && {
  ...r,
  rundown: r.rundown.map((e, i) => e.type === 'show' && /^(Nov projekt|Projekt \d+)$/.test(e.show.name)
    ? { ...e, show: { ...e.show, name: `Timeline ${i + 1}` } } : e),
}
const _restored = renameDefault(loadAutosave())
const _initActiveId = _restored?.rundown.some(e => e.id === _restored.activeId)
  ? _restored.activeId : (_restored?.rundown[0].id ?? _initEntry.id)

export default function App() {
  const [rundown, setRundown] = useState<RundownEntry[]>(_restored?.rundown ?? [_initEntry])
  const [activeId, setActiveId] = useState<string>(_initActiveId)
  const [concertFilePath, setConcertFilePath] = useState<string | null>(_restored?.concertFilePath ?? null)
  const [concertDirty, setConcertDirty] = useState(_restored?.concertDirty ?? false)
  const [restoredAt, setRestoredAt] = useState<number | null>(_restored?.savedAt ?? null)
  const [autosaveFailed, setAutosaveFailed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // SHOW mode locks every editing gesture (QLab Show Mode / console "live" lock)
  const [showMode, setShowMode] = useState(false)
  const showModeRef = useRef(false)
  showModeRef.current = showMode
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const activeIdRef = useRef<string>(_initActiveId)
  const ltcActiveRef = useRef(false)

  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // LTC decoder — global singleton
  const ltcDecoderRef = useRef(new LTCDecoder())
  const [ltcActive, setLtcActive] = useState(false)
  const [ltcRawTC, setLtcRawTC] = useState('--:--:--:--')
  useEffect(() => { ltcActiveRef.current = ltcActive }, [ltcActive])

  // Audio engine
  const audioEngineRef = useRef(new AudioEngine())
  const [audioLoaded, setAudioLoaded] = useState(false)
  const [, setAudioDuration] = useState(0)
  const [waveformInfo, setWaveformInfo] = useState<WaveformInfo | null>(null)
  const audioLoadedRef = useRef(false)
  useEffect(() => { audioLoadedRef.current = audioLoaded }, [audioLoaded])

  useEffect(() => {
    audioEngineRef.current.onWaveformReady = (info) => setWaveformInfo(info)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────

  const activeEntry = rundown.find(e => e.id === activeId) ?? rundown[0] ?? _initEntry
  const activeShowEntry: ShowEntry | null = activeEntry?.type === 'show' ? activeEntry as ShowEntry : null
  const show: Show = activeShowEntry?.show ?? EMPTY_SHOW
  const activeIsBreak = activeEntry?.type === 'break'
  const fps = show.frameRate
  const offsetFrames = smpteToFrames(show.clock.offset || '00:00:00:00', fps)

  const [engineState, setEngineState] = useState<EngineState>({
    frame: 0, playing: false, fps: 25, showName: '', resolumeConnected: false,
  })
  const engineRef = useRef(engineState)
  useEffect(() => { engineRef.current = engineState }, [engineState])

  // ── setShow — updates active show entry ────────────────────────────────────

  const setShow = useCallback((updater: Show | ((prev: Show) => Show)) => {
    setRundown(prev => {
      let changed = false
      const next = prev.map(e => {
        if (e.id !== activeIdRef.current || e.type !== 'show') return e
        const se = e as ShowEntry
        const newShow = typeof updater === 'function' ? updater(se.show) : updater
        if (newShow === se.show) return e
        changed = true
        return { ...se, show: newShow, dirty: true }
      })
      // Show content lives in its own file; the concert file only references it,
      // so show edits mark the show dirty, not the concert.
      return changed ? next : prev
    })
  }, [])

  // ── Autosave ───────────────────────────────────────────────────────────────

  const autosaveRef = useRef({ rundown, activeId, concertFilePath, concertDirty })
  autosaveRef.current = { rundown, activeId, concertFilePath, concertDirty }
  const flushAutosave = useCallback(() => {
    setAutosaveFailed(!writeAutosave({ savedAt: Date.now(), ...autosaveRef.current }))
  }, [])
  // Debounced so dragging a keyframe does not serialize the show on every mouse move
  useEffect(() => {
    const t = setTimeout(flushAutosave, 800)
    return () => clearTimeout(t)
  }, [rundown, activeId, concertFilePath, concertDirty, flushAutosave])
  useEffect(() => {
    window.addEventListener('pagehide', flushAutosave)
    return () => window.removeEventListener('pagehide', flushAutosave)
  }, [flushAutosave])

  const handleDiscardRestored = useCallback(() => {
    api.stop(); audioEngineRef.current.stop()
    const entry = makeShowEntry({ ...EMPTY_SHOW }, null, 0)
    clearAutosave()
    setRundown([entry]); setActiveId(entry.id)
    setConcertFilePath(null); setConcertDirty(false); setRestoredAt(null)
    // Fill the new empty show with the current Resolume layers
    api.getComposition().then((comp: ResolumeComposition | null) => {
      if (comp) setShow(prev => syncLayers(prev, comp))
    })
  }, [setShow])

  const [pxPerFrame, setPxPerFrame] = useState(3)
  const [scrollFrame, setScrollFrame] = useState(0)
  const [showBrowser, setShowBrowser] = useState(true)
  const showBrowserRef = useRef(showBrowser)
  showBrowserRef.current = showBrowser
  // Selection is stored by id: clips get re-sorted when moved and tracks can be
  // re-ordered by the Resolume sync, so stored indices would point at the wrong item.
  const [selection, setSelection] = useState<{ trackId: string | null; cueId: string | null }>(
    { trackId: null, cueId: null })
  const showRef = useRef(show)
  showRef.current = show
  const selectedTrackIdx = (() => {
    const i = show.tracks.findIndex(t => t.id === selection.trackId)
    return i >= 0 ? i : null
  })()
  const selectedCueIdx = (() => {
    if (selectedTrackIdx == null || !selection.cueId) return null
    const t = show.tracks[selectedTrackIdx]
    const i = t.type === 'layer' ? (t as LayerTrack).clips.findIndex(c => c.id === selection.cueId) : -1
    return i >= 0 ? i : null
  })()
  const selectTrack = useCallback((ti: number | null) => {
    setSelection({ trackId: ti != null ? showRef.current.tracks[ti]?.id ?? null : null, cueId: null })
  }, [])
  const selectCue = useCallback((ti: number, ci: number) => {
    const t = showRef.current.tracks[ti]
    const cue = t?.type === 'layer' ? (t as LayerTrack).clips[ci] : undefined
    setSelection({ trackId: t?.id ?? null, cueId: cue?.id ?? null })
  }, [])
  const clearSelection = useCallback(() => setSelection({ trackId: null, cueId: null }), [])
  const [draggingClip, setDraggingClip] = useState<DragClipData | null>(null)
  const [autoLaneHeights, setAutoLaneHeights] = useState<Record<string, number>>({})
  const [layerRowHeights, setLayerRowHeights] = useState<Record<string, number>>({})
  const [bottomPanelHeight, setBottomPanelHeight] = useState(250)
  const [scrollY, setScrollY] = useState(0)
  const handleScrollY = useCallback((delta: number) => {
    setScrollY(prev => Math.max(0, prev + delta * 0.8))
  }, [])
  const autoScrollRef = useRef(true)

  // ── Engine tick ────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = api.onTick((state: EngineState) => {
      setEngineState(state)
      if (state.playing && autoScrollRef.current) {
        setScrollFrame(prev => {
          const cw = window.innerWidth - 200 - (showBrowserRef.current ? 260 : 0)
          const vf = cw / pxPerFrame
          const px = (state.frame - prev) * pxPerFrame
          if (px > cw * 0.75) return state.frame - Math.floor(vf * 0.25)
          if (px < 0) return Math.max(0, state.frame)
          return prev
        })
      }
    })
    return unsub
  }, [pxPerFrame])

  // Ticks only arrive while the frame changes, so the connection status needs its own
  // event, plus one query at startup in case that event fired before we subscribed
  useEffect(() => {
    api.getState().then((s: EngineState | null) => { if (s) setEngineState(s) })
    return api.onResolumeStatus(({ connected }: { connected: boolean }) =>
      setEngineState(s => ({ ...s, resolumeConnected: connected })))
  }, [])

  // ── Resolume composition updates ───────────────────────────────────────────

  // Latest composition JSON: drives layer sync, the parameter picker, the live strip in
  // the layer headers and the automation target resolver
  const [composition, setComposition] = useState<ResolumeComposition | null>(null)

  useEffect(() => {
    const unsub = api.onCompositionUpdate((comp: ResolumeComposition) => {
      setComposition(comp)
      setShow(prev => syncLayers(prev, comp))
    })
    return unsub
  }, [setShow])

  useEffect(() => {
    api.getComposition().then((comp: ResolumeComposition | null) => {
      if (!comp) return
      setComposition(comp)
      setShow(prev => syncLayers(prev, comp))
    })
  }, [setShow])

  // ── Automation targets: stable ref → live Resolume parameter id ─────────────

  // Lanes the operator took over in Resolume (lane id → their value, normalized) and the REC
  // switch: when armed, operator changes become keyframes at the playhead instead
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [recordArmed, setRecordArmed] = useState(false)
  useEffect(() => api.onOverrides((m: Record<string, number>) => setOverrides(m)), [])
  useEffect(() => { api.setRecordArmed(recordArmed) }, [recordArmed])
  useEffect(() => api.onRecord(({ laneId, value, option }: { laneId: string; value: number; option?: string }) => {
    showRef.current.tracks.forEach((t, ti) => {
      if (t.type !== 'layer' && t.type !== 'group') return
      const ai = (t as LayerTrack | GroupTrack).automations.findIndex(a => a.id === laneId)
      if (ai >= 0) handleAddKeyframe(ti, ai, engineRef.current.frame, value, option)
    })
  }), [])
  const handleReenable = useCallback((ids?: string[]) => { api.reenableAutomation(ids) }, [])

  const decks = decksOf(composition)
  const selectedDeck = decks.find(d => d.selected)

  const [laneStatus, setLaneStatus] = useState<LaneStatusMap>({})
  const laneStatusRef = useRef(laneStatus)
  laneStatusRef.current = laneStatus
  const sentTargetsRef = useRef('')
  useEffect(() => {
    const { status, targets, updates } = resolveShow(show, composition)
    if (updates.length) {
      // Migration of old lanes / refreshed ranges; the effect runs again with the new show
      setShow(prev => {
        const tracks = [...prev.tracks]
        for (const u of updates) {
          const lt = tracks[u.trackIdx] as LayerTrack
          if (!lt || (lt.type !== 'layer' && (lt as Track).type !== 'group') || !lt.automations[u.autoIdx]) continue
          const autos = [...lt.automations]
          autos[u.autoIdx] = { ...autos[u.autoIdx], ...u.updates }
          tracks[u.trackIdx] = { ...lt, automations: autos }
        }
        return { ...prev, tracks }
      })
    }
    setLaneStatus(prev => JSON.stringify(prev) === JSON.stringify(status) ? prev : status)
    const key = JSON.stringify(targets)
    if (key !== sentTargetsRef.current) {
      sentTargetsRef.current = key
      api.setTargets(targets)
    }
  }, [show, composition, setShow])

  useEffect(() => { api.loadShowDirect(show) }, [show])

  // ── LTC decoder lifecycle ──────────────────────────────────────────────────

  const isLtcSource = (src: string) => src === 'ltc' || src === 'ltc-a' || src === 'ltc-b'
  const deviceForSource = (s: Show): string | undefined => {
    const src = s.clock.source
    if (src === 'ltc-b') return s.clock.ltcDeviceB
    if (src === 'ltc-a' || src === 'ltc') return s.clock.ltcDeviceA ?? s.clock.ltcDevice
    return undefined
  }
  const channelForSource = (s: Show): number => {
    const src = s.clock.source
    if (src === 'ltc-b') return s.clock.ltcChannelB ?? 0
    if (src === 'ltc-a' || src === 'ltc') return s.clock.ltcChannelA ?? 0
    return 0
  }

  const ltcEnabledShows = rundown.filter(
    (e): e is ShowEntry => e.type === 'show' && isLtcSource(e.show.clock.source)
  )
  const ltcShouldRun = ltcEnabledShows.length > 0
  const ltcDeviceId = isLtcSource(show.clock.source)
    ? (deviceForSource(show) ?? '')
    : (ltcEnabledShows[0] ? (deviceForSource(ltcEnabledShows[0].show) ?? '') : '')
  const ltcChannelIdx = isLtcSource(show.clock.source)
    ? channelForSource(show)
    : (ltcEnabledShows[0] ? channelForSource(ltcEnabledShows[0].show) : 0)

  useEffect(() => {
    const decoder = ltcDecoderRef.current
    if (!ltcShouldRun) {
      decoder.stop().then(() => { setLtcActive(false); api.sendLtcStop() })
      return
    }
    // "LTC live" means frames are arriving. When they stop for longer than the freewheel
    // window, the indicator goes off and the transport stops at the last frame.
    let lostTimer: ReturnType<typeof setTimeout> | undefined
    const lostAfterMs = Math.max(400, ((show.clock.freewheelFrames ?? 5) + 3) / fps * 1000)
    decoder.onFrame = (absFrame, hh, mm, ss, ff) => {
      const pad = (n: number) => String(n).padStart(2, '0')
      setLtcRawTC(`${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`)
      setLtcActive(true)
      api.sendLtcFrame(absFrame)
      clearTimeout(lostTimer)
      lostTimer = setTimeout(() => { setLtcActive(false); api.sendLtcStop() }, lostAfterMs)
    }
    decoder.onError = (err) => console.error('[LTC]', err)
    decoder.start(ltcDeviceId || undefined, ltcChannelIdx, fps)
    return () => {
      clearTimeout(lostTimer)
      decoder.stop().then(() => { setLtcActive(false); api.sendLtcStop() })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ltcShouldRun, ltcDeviceId, ltcChannelIdx, fps, show.clock.freewheelFrames])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Text fields keep their keys; sliders and checkboxes don't (Home/Space on a focused
      // fader would move it to its minimum and auto-key that as a keyframe)
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.target instanceof HTMLInputElement && !['range', 'checkbox'].includes(e.target.type)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (engineRef.current.playing) {
          api.stop(); audioEngineRef.current.stop()
        } else {
          api.play()
          if (audioLoadedRef.current) audioEngineRef.current.play(engineRef.current.frame)
        }
      }
      if (e.code === 'Home') { e.preventDefault(); api.locate(0); setScrollFrame(0); autoScrollRef.current = true
        if (engineRef.current.playing && audioLoadedRef.current) audioEngineRef.current.play(0)
        else audioEngineRef.current.stop()
      }
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault(); goRef.current(1)
      }
      if ((e.code === 'Delete' || e.code === 'Backspace') && !showModeRef.current) {
        if (selectedTrackIdx != null && selectedCueIdx != null) {
          handleDeleteCue(selectedTrackIdx, selectedCueIdx)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedTrackIdx, selectedCueIdx])

  // ── Transport ──────────────────────────────────────────────────────────────

  const handlePlay = useCallback(() => {
    api.play()
    if (audioLoadedRef.current) audioEngineRef.current.play(engineRef.current.frame)
  }, [])

  const handleStop = useCallback(() => {
    api.stop(); autoScrollRef.current = true; audioEngineRef.current.stop()
  }, [])

  const handleLocate = useCallback((frame: number) => {
    api.locate(frame); setScrollFrame(Math.max(0, frame - 50))
    if (engineRef.current.playing && audioLoadedRef.current) audioEngineRef.current.play(frame)
    else audioEngineRef.current.stop()
  }, [])

  const handleSeek = useCallback((frame: number) => {
    autoScrollRef.current = false; api.locate(frame)
    if (engineRef.current.playing && audioLoadedRef.current) audioEngineRef.current.play(frame)
    else audioEngineRef.current.stop()
  }, [])

  // ── Rundown management ─────────────────────────────────────────────────────

  const handleAddShow = useCallback(() => {
    const idx = rundown.length
    const timelines = rundown.filter(e => e.type === 'show').length
    const entry = makeShowEntry({ ...EMPTY_SHOW, name: `Timeline ${timelines + 1}` }, null, idx)
    setRundown(prev => [...prev, entry])
    setActiveId(entry.id)
    setConcertDirty(true)
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
  }, [rundown.length])

  const handleOpenShowFile = useCallback(async () => {
    const result = await api.openShowFile()
    if (!result) return
    const idx = rundown.length
    const entry = makeShowEntry(result.show, result.filePath, idx)
    setRundown(prev => [...prev, entry])
    setActiveId(entry.id)
    setConcertDirty(true)
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
  }, [rundown.length])

  const handleAddBreak = useCallback(() => {
    const entry = makeBreakEntry()
    setRundown(prev => [...prev, entry])
    setConcertDirty(true)
  }, [])

  const handleSelectEntry = useCallback((id: string) => {
    if (id === activeId) return
    api.stop(); audioEngineRef.current.stop()
    setActiveId(id)
    clearSelection(); setScrollFrame(0)
    autoScrollRef.current = true
    // LTC auto-play: if LTC is live and new entry is a show, start immediately
    const entry = rundown.find(e => e.id === id)
    if (entry?.type === 'show' && ltcActiveRef.current) {
      api.play()
    }
  }, [activeId, rundown])

  // GO: step through the rundown. Ignores repeats within 300 ms so a double press
  // cannot skip an entry.
  const lastGoRef = useRef(0)
  const handleGo = useCallback((direction: 1 | -1) => {
    const now = performance.now()
    if (now - lastGoRef.current < 300) return
    lastGoRef.current = now
    const idx = rundown.findIndex(e => e.id === activeId)
    const target = rundown[idx + direction]
    if (target) handleSelectEntry(target.id)
  }, [rundown, activeId, handleSelectEntry])
  const goRef = useRef(handleGo)
  goRef.current = handleGo

  const handleReconnect = useCallback(() => {
    api.connectResolume(show.resolume.host, show.resolume.oscPort, show.resolume.restPort)
  }, [show.resolume.host, show.resolume.oscPort, show.resolume.restPort])

  const handleDeleteEntry = useCallback((id: string) => {
    if (rundown.length <= 1) return  // always keep at least one
    const next = rundown.filter(e => e.id !== id)
    if (id === activeIdRef.current) {
      // The running show is going away: stop before switching to another one
      api.stop(); audioEngineRef.current.stop()
      clearSelection(); setScrollFrame(0)
      setActiveId(next[0].id)
    }
    setRundown(next)
    setConcertDirty(true)
  }, [rundown, clearSelection])

  const handleReorder = useCallback((newOrder: RundownEntry[]) => {
    setRundown(newOrder); setConcertDirty(true)
  }, [])

  const handleEditEntry = useCallback((id: string, updates: Partial<Pick<BreakEntry, 'color' | 'notes' | 'label' | 'duration'>> & { name?: string }) => {
    setRundown(prev => prev.map(e => {
      if (e.id !== id) return e
      if (e.type === 'show') {
        const renamed = updates.name !== undefined && updates.name !== e.show.name
        return {
          ...e, color: updates.color ?? e.color, notes: updates.notes ?? e.notes,
          ...(renamed ? { show: { ...e.show, name: updates.name! }, dirty: true } : {}),
        }
      }
      return { ...e, ...updates }
    }))
    setConcertDirty(true)
  }, [])

  const handleSaveActiveShow = useCallback(async () => {
    if (!activeShowEntry) return
    const filePath = await api.saveShow(activeShowEntry.show)
    if (filePath) {
      setRundown(prev => prev.map(e =>
        e.id === activeId && e.type === 'show'
          ? { ...e, dirty: false, filePath } as ShowEntry
          : e
      ))
    }
  }, [activeShowEntry, activeId])

  const handleSaveConcert = useCallback(async () => {
    const data: ConcertFile = {
      version: 1,
      name: concertFilePath?.split('/').pop()?.replace(/\.concert\.json$|\.json$/, '') ?? 'Concert',
      entries: rundown.map(e => e.type === 'show'
        ? { id: e.id, type: 'show', filePath: (e as ShowEntry).filePath, color: e.color, notes: e.notes }
        : { id: e.id, type: 'break', label: (e as BreakEntry).label, duration: (e as BreakEntry).duration, color: e.color, notes: e.notes }
      ),
    }
    const newPath = await api.saveConcert(data)
    if (newPath) { setConcertFilePath(newPath); setConcertDirty(false) }
  }, [rundown, concertFilePath])

  const handleOpenConcert = useCallback(async () => {
    const result = await api.loadConcert()
    if (!result) return
    const entries: RundownEntry[] = (result.entries ?? []).map((fe: any, i: number) =>
      fe.type === 'show'
        ? {
            id: fe.id, type: 'show',
            show: result.shows[fe.id] ?? { ...EMPTY_SHOW, name: fe.filePath?.split('/').pop() ?? 'Show' },
            filePath: fe.filePath ?? null, dirty: false,
            color: fe.color ?? ENTRY_COLORS[i % ENTRY_COLORS.length], notes: fe.notes ?? '',
          } as ShowEntry
        : {
            id: fe.id, type: 'break',
            label: fe.label ?? 'Break', duration: fe.duration ?? '00:20:00:00',
            color: fe.color ?? '#333333', notes: fe.notes ?? '',
          } as BreakEntry
    )
    const validEntries = entries.length > 0 ? entries : [makeShowEntry({ ...EMPTY_SHOW }, null, 0)]
    setRundown(validEntries)
    setActiveId(validEntries[0].id)
    setConcertFilePath(result.filePath)
    setConcertDirty(false)
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
  }, [])

  const handleUpdateProjectSettings = useCallback((partial: Partial<Show>) => {
    setShow(prev => ({ ...prev, ...partial }))
  }, [setShow])

  // ── Audio track ────────────────────────────────────────────────────────────

  // The engine holds one decoded file; this is the path it holds for the current show
  const loadedAudioPathRef = useRef<string | null>(null)
  const audioLoadGenRef = useRef(0)

  const unloadAudio = useCallback(() => {
    audioLoadGenRef.current++  // abandons any load still in flight
    audioEngineRef.current.stop()
    loadedAudioPathRef.current = null
    setAudioLoaded(false); setWaveformInfo(null)
  }, [])

  const loadAudioIntoEngine = useCallback(async (filePath: string, data: Uint8Array, s: Show) => {
    unloadAudio()
    const gen = audioLoadGenRef.current
    const engine = audioEngineRef.current
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    let ok = false
    try {
      ok = await engine.load(buf, s.frameRate, smpteToFrames(s.audioTrack?.startOffset ?? '00:00:00:00', s.frameRate))
    } catch {}
    if (!ok || gen !== audioLoadGenRef.current) return false
    engine.setGain(s.audioTrack?.gain ?? 0.8)
    if (s.clock.audioOutputDevice) await engine.setOutputDevice(s.clock.audioOutputDevice)
    engine.setOutputChannels(s.clock.audioOutputChannelL ?? 0, s.clock.audioOutputChannelR ?? 1)
    if (gen !== audioLoadGenRef.current) return false
    loadedAudioPathRef.current = filePath
    setAudioLoaded(true)
    setAudioDuration(engine.duration)
    return true
  }, [unloadAudio])

  const handleLoadAudioTrack = useCallback(async () => {
    const result = await api.openAudioFile()
    if (!result) return
    if (!await loadAudioIntoEngine(result.filePath, result.data, showRef.current)) return
    const name = result.filePath.split('/').pop() ?? 'audio'
    setShow(prev => ({
      ...prev, audioTrack: {
        id: prev.audioTrack?.id ?? newId(), type: 'audio', name,
        filePath: result.filePath, gain: prev.audioTrack?.gain ?? 0.8,
        color: prev.audioTrack?.color ?? '#1ABC9C', startOffset: prev.audioTrack?.startOffset ?? '00:00:00:00',
      },
    }))
  }, [loadAudioIntoEngine, setShow])

  // Each show has its own audio track: load it when switching shows or after a restore
  const wantedAudioPath = show.audioTrack?.filePath ?? null
  useEffect(() => {
    if (wantedAudioPath === loadedAudioPathRef.current) return
    unloadAudio()
    if (!wantedAudioPath) return
    const gen = audioLoadGenRef.current
    api.readAudioFile(wantedAudioPath).then((res: { data: Uint8Array } | null) => {
      if (gen !== audioLoadGenRef.current) return
      if (!res) { console.warn('[audio] cannot read', wantedAudioPath); return }
      loadAudioIntoEngine(wantedAudioPath, res.data, showRef.current)
    })
  }, [activeId, wantedAudioPath, unloadAudio, loadAudioIntoEngine])

  // Gain and start offset are per show too
  useEffect(() => {
    audioEngineRef.current.setGain(show.audioTrack?.gain ?? 0.8)
    audioEngineRef.current.setStartOffsetFrames(
      smpteToFrames(show.audioTrack?.startOffset ?? '00:00:00:00', show.frameRate))
  }, [activeId, show.audioTrack?.gain, show.audioTrack?.startOffset, show.frameRate])

  const handleUpdateAudioTrack = useCallback((updates: Partial<NonNullable<Show['audioTrack']>>) => {
    setShow(prev => {
      if (!prev.audioTrack) return prev
      return { ...prev, audioTrack: { ...prev.audioTrack, ...updates } }
    })
    if (updates.gain !== undefined) audioEngineRef.current.setGain(updates.gain)
    if (updates.startOffset !== undefined)
      audioEngineRef.current.setStartOffsetFrames(smpteToFrames(updates.startOffset, show.frameRate))
  }, [setShow, show.frameRate])

  useEffect(() => { audioEngineRef.current.setFps(show.frameRate) }, [show.frameRate])

  // Audio that finishes loading while the transport runs joins in at the current frame
  useEffect(() => {
    if (audioLoaded && engineRef.current.playing)
      audioEngineRef.current.play(engineRef.current.frame)
  }, [audioLoaded])

  useEffect(() => {
    if (!audioLoaded) return
    const dev = show.clock.audioOutputDevice
    if (dev) audioEngineRef.current.setOutputDevice(dev)
  }, [show.clock.audioOutputDevice, audioLoaded])

  useEffect(() => {
    audioEngineRef.current.setOutputChannels(
      show.clock.audioOutputChannelL ?? 0, show.clock.audioOutputChannelR ?? 1,
    )
  }, [show.clock.audioOutputChannelL, show.clock.audioOutputChannelR])

  // ── Clip operations ────────────────────────────────────────────────────────

  const handleDropClip = useCallback(async (trackIdx: number, frame: number, data: DragClipData) => {
    let duration = '00:00:00:00'
    try {
      const clipRaw = await api.getClipRaw(data.layerIndex, data.clipIndex)
      const durSec = resolveClipDuration(clipRaw)
      if (durSec > 0) duration = framesToSmpte(Math.round(durSec * fps), fps)
    } catch {}
    setShow(prev => {
      const tracks = [...prev.tracks]
      const track = tracks[trackIdx]
      if (!track || track.type !== 'layer') return prev
      const lt = track as LayerTrack
      if (lt.resolumeLayerId !== data.layerId) return prev
      const cue: ClipCue = {
        id: newId(), time: framesToSmpte(frame, prev.frameRate),
        duration, clipIndex: data.clipIndex, clipId: data.clipId,
        clipName: data.clipName, release: true,
        ...(data.deckId !== undefined ? { deckId: data.deckId, deckIndex: data.deckIndex, deckName: data.deckName } : {}),
      }
      tracks[trackIdx] = {
        ...lt, clips: [...lt.clips, cue].sort(
          (a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate)
        ),
      }
      return { ...prev, tracks }
    })
  }, [fps, setShow])

  const handleUpdateCue = useCallback((trackIdx: number, cueIdx: number, updates: Partial<ClipCue>) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      if (!lt) return prev
      const clips = [...lt.clips]
      const oldClip = clips[cueIdx]
      clips[cueIdx] = { ...oldClip, ...updates }

      let autos = lt.automations
      if (updates.time && updates.time !== oldClip.time) {
        const delta = smpteToFrames(updates.time, prev.frameRate) - smpteToFrames(oldClip.time, prev.frameRate)
        if (delta !== 0) {
          autos = lt.automations.map(auto => {
            if (auto.layerBound) return auto
            if (auto.clipId && auto.clipId !== oldClip.id) return auto
            return {
              ...auto,
              keyframes: auto.keyframes.map(kf => ({
                ...kf,
                time: framesToSmpte(Math.max(0, smpteToFrames(kf.time, prev.frameRate) + delta), prev.frameRate),
              })),
            }
          })
        }
      }

      if (updates.time) clips.sort((a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate))
      tracks[trackIdx] = { ...lt, clips, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleDeleteCue = useCallback((trackIdx: number, cueIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      tracks[trackIdx] = { ...lt, clips: lt.clips.filter((_, i) => i !== cueIdx) }
      return { ...prev, tracks }
    })
    setSelection(sel => ({ ...sel, cueId: null }))
  }, [setShow])

  const updateAutomation = useCallback((trackIdx: number, autoIdx: number, updates: Partial<AutomationSubTrack>) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      if (!lt?.automations[autoIdx]) return prev
      const autos = [...lt.automations]
      autos[autoIdx] = { ...autos[autoIdx], ...updates }
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  // New lane for a Resolume parameter. Picking a parameter that already has a lane on this
  // layer just unfolds the layer instead of creating a second lane that would fight the first.
  const handleAddParam = useCallback((
    trackIdx: number, info: ParamInfo, binding: 'layer' | { cueId: string },
    firstKey?: { frame: number; value: number; option?: string },
  ) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      if (!lt || (lt.type !== 'layer' && (lt as Track).type !== 'group')) return prev
      if (lt.automations.some(a => sameRef(a.ref, info.ref))) {
        // A hidden lane comes back into view instead of being duplicated
        const automations = lt.automations.map(a => sameRef(a.ref, info.ref) && a.visible === false ? { ...a, visible: true } : a)
        tracks[trackIdx] = { ...lt, expanded: true, automations }
        return { ...prev, tracks }
      }
      const slot = info.ref.scope === 'clip' ? lt.clips?.find(c => c.clipId === info.ref.clipId)?.clipIndex : undefined
      const ownerIndex = (lt as Track).type === 'group' ? (lt as unknown as GroupTrack).resolumeGroupIndex : lt.resolumeLayerIndex
      const palette = SCOPE_COLORS[info.ref.scope]
      const sameScope = lt.automations.filter(a => (a.ref?.scope ?? 'layer') === info.ref.scope).length
      const keyframes: Keyframe[] = firstKey ? [{
        time: framesToSmpte(firstKey.frame, prev.frameRate), value: firstKey.value,
        ease: info.kind === 'range' ? 'linear' : 'hold',
        ...(firstKey.option !== undefined ? { option: firstKey.option } : {}),
      }] : []
      const lane: AutomationSubTrack = {
        id: `auto-${Date.now()}-${uid++}`, keyframes, enabled: true,
        color: palette[sameScope % palette.length],
        ...(binding === 'layer' ? { layerBound: true } : { clipId: binding.cueId }),
        ...laneFieldsFor(info, ownerIndex, slot),
      } as AutomationSubTrack
      tracks[trackIdx] = { ...lt, expanded: true, automations: [...lt.automations, lane] }
      return { ...prev, tracks }
    })
  }, [setShow])

  // ◇/◆ in the inspector (After Effects stopwatch + Resolve keyframe button): start
  // animating with a keyframe at the playhead, or toggle the keyframe at the playhead
  const handleToggleKey = useCallback((trackIdx: number, info: ParamInfo, real: number | string | boolean, binding: 'layer' | { cueId: string }) => {
    const lt = showRef.current.tracks[trackIdx] as LayerTrack
    const frame = engineRef.current.frame
    const value = normalize(info, real)
    const option = info.kind === 'choice' ? String(real) : undefined
    const autoIdx = lt?.automations.findIndex(a => sameRef(a.ref, info.ref)) ?? -1
    if (autoIdx < 0) { handleAddParam(trackIdx, info, binding, { frame, value, option }); return }
    const time = framesToSmpte(frame, showRef.current.frameRate)
    const kfIdx = lt.automations[autoIdx].keyframes.findIndex(k => k.time === time)
    if (kfIdx >= 0) handleDeleteKeyframe(trackIdx, autoIdx, kfIdx)
    else handleAddKeyframe(trackIdx, autoIdx, frame, value, option)
  }, [handleAddParam])

  // Moving the fader of an animated parameter writes a keyframe at the playhead
  const handleParamEdit = useCallback((trackIdx: number, info: ParamInfo, real: number | string | boolean) => {
    if (showModeRef.current) return
    const lt = showRef.current.tracks[trackIdx] as LayerTrack
    const autoIdx = lt?.automations.findIndex(a => sameRef(a.ref, info.ref)) ?? -1
    if (autoIdx < 0) return
    handleAddKeyframe(trackIdx, autoIdx, engineRef.current.frame, normalize(info, real),
      info.kind === 'choice' ? String(real) : undefined)
  }, [])

  const handleRetarget = useCallback((trackIdx: number, autoIdx: number, info: ParamInfo) => {
    const lt = showRef.current.tracks[trackIdx] as LayerTrack
    const cue = info.ref.scope === 'clip' ? lt?.clips.find(c => c.clipId === info.ref.clipId) : undefined
    // Binding follows the new target: a clip parameter moves with its cue, a layer one stays put
    const binding = info.ref.scope === 'clip'
      ? { clipId: cue?.id, layerBound: false }
      : { clipId: undefined, layerBound: true }
    updateAutomation(trackIdx, autoIdx, {
      ...laneFieldsFor(info, lt?.resolumeLayerIndex ?? 0, cue?.clipIndex), ...binding, paramId: undefined,
    })
  }, [updateAutomation])

  // Write the parameter's current Resolume value as a keyframe at the playhead (Pixera-style
  // "store", REAPER latch preview): the quickest way to program a look.
  const handleSnapshot = useCallback(async (trackIdx: number, autoIdx: number) => {
    const auto = (showRef.current.tracks[trackIdx] as LayerTrack)?.automations[autoIdx]
    const info = auto && laneStatusRef.current[auto.id]?.info
    if (!info) return
    const p = await api.getParamById(info.id)
    if (!p) return
    const v = normalize(info, p.value)
    handleAddKeyframe(trackIdx, autoIdx, engineRef.current.frame, v, info.kind === 'choice' ? String(p.value) : undefined)
  }, [])

  const handleSetAllExpanded = useCallback((expanded: boolean) => {
    setShow(prev => ({
      ...prev,
      tracks: prev.tracks.map(t => (t.type === 'layer' || t.type === 'group') && (t as LayerTrack).automations.length
        ? { ...t, expanded } : t),
    }))
  }, [setShow])

  const handleToggleGroupCollapsed = useCallback((trackIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const gt = tracks[trackIdx] as GroupTrack
      if (gt?.type !== 'group') return prev
      tracks[trackIdx] = { ...gt, collapsed: !gt.collapsed }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleToggleExpand = useCallback((trackIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      tracks[trackIdx] = { ...lt, expanded: !lt.expanded }
      return { ...prev, tracks }
    })
  }, [setShow])

  const toggleTrackFlag = useCallback((trackIdx: number, flag: 'muted' | 'locked') => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      tracks[trackIdx] = { ...lt, [flag]: !lt[flag] }
      return { ...prev, tracks }
    })
  }, [setShow])
  const handleToggleMute = useCallback((i: number) => toggleTrackFlag(i, 'muted'), [toggleTrackFlag])
  const handleToggleLock = useCallback((i: number) => toggleTrackFlag(i, 'locked'), [toggleTrackFlag])

  const handleResizeAutoLane = useCallback((autoId: string, height: number) => {
    setAutoLaneHeights(prev => ({ ...prev, [autoId]: height }))
  }, [])

  const handleResizeLayer = useCallback((id: string, height: number) => {
    setLayerRowHeights(prev => ({ ...prev, [id]: height }))
  }, [])

  function handleAddKeyframe(trackIdx: number, autoIdx: number, frame: number, value: number, option?: string) {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      const auto = { ...autos[autoIdx] }
      const time = framesToSmpte(frame, prev.frameRate)
      const kf: Keyframe = {
        time, value, ease: (auto.kind ?? 'range') === 'range' ? 'linear' : 'hold',
        ...(option !== undefined ? { option } : {}),
      }
      // A keyframe already at this frame is replaced, not duplicated
      auto.keyframes = [...auto.keyframes.filter(k => k.time !== time), kf].sort(
        (a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate)
      )
      autos[autoIdx] = auto
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }

  const handleUpdateKeyframe = useCallback((trackIdx: number, autoIdx: number, kfIdx: number, updates: Partial<Keyframe>) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      const auto = { ...autos[autoIdx] }
      const kfs = [...auto.keyframes]
      kfs[kfIdx] = { ...kfs[kfIdx], ...updates }
      if (updates.time) kfs.sort((a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate))
      auto.keyframes = kfs
      autos[autoIdx] = auto
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  // Batch keyframe edits from the canvas (multi-selection): applied in one show update so a
  // drag of several keyframes is one change, indices refer to the lanes before the update
  const editLanes = useCallback((
    fn: (lane: AutomationSubTrack, trackIdx: number, autoIdx: number, fps: number) => AutomationSubTrack | null,
    lanes: { trackIdx: number; autoIdx: number }[],
  ) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const seen = new Set<string>()
      for (const { trackIdx, autoIdx } of lanes) {
        const key = `${trackIdx}:${autoIdx}`
        if (seen.has(key)) continue
        seen.add(key)
        const lt = tracks[trackIdx] as LayerTrack
        const lane = lt?.automations?.[autoIdx]
        if (!lane) continue
        const next = fn(lane, trackIdx, autoIdx, prev.frameRate)
        if (!next) continue
        const autos = [...lt.automations]
        autos[autoIdx] = {
          ...next,
          keyframes: [...next.keyframes].sort((a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate)),
        }
        tracks[trackIdx] = { ...lt, automations: autos }
      }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleUpdateKeyframes = useCallback((items: { trackIdx: number; autoIdx: number; kfIdx: number; updates: Partial<Keyframe> }[]) => {
    editLanes((lane, ti, ai) => {
      const mine = items.filter(i => i.trackIdx === ti && i.autoIdx === ai)
      const kfs = lane.keyframes.map((k, ki) => {
        const u = mine.find(m => m.kfIdx === ki)
        return u ? { ...k, ...u.updates } : k
      })
      return { ...lane, keyframes: kfs }
    }, items)
  }, [editLanes])

  const handleDeleteKeyframes = useCallback((items: { trackIdx: number; autoIdx: number; kfIdx: number }[]) => {
    editLanes((lane, ti, ai) => {
      const drop = new Set(items.filter(i => i.trackIdx === ti && i.autoIdx === ai).map(i => i.kfIdx))
      return { ...lane, keyframes: lane.keyframes.filter((_, ki) => !drop.has(ki)) }
    }, items)
  }, [editLanes])

  // Paste keeps relative timing from the playhead; pasted keyframes replace ones at the same time
  const handlePasteKeyframes = useCallback((trackIdx: number, autoIdx: number, atFrame: number,
    items: { offsetFrames: number; value: number; ease: string; option?: string }[]) => {
    editLanes((lane, _ti, _ai, fr) => {
      const pasted: Keyframe[] = items.map(i => ({
        time: framesToSmpte(Math.max(0, atFrame + i.offsetFrames), fr), value: i.value, ease: i.ease,
        ...(i.option !== undefined ? { option: i.option } : {}),
      }))
      const times = new Set(pasted.map(k => k.time))
      return { ...lane, keyframes: [...lane.keyframes.filter(k => !times.has(k.time)), ...pasted] }
    }, [{ trackIdx, autoIdx }])
  }, [editLanes])

  const handleDeleteKeyframe = useCallback((trackIdx: number, autoIdx: number, kfIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      const auto = { ...autos[autoIdx] }
      auto.keyframes = auto.keyframes.filter((_, i) => i !== kfIdx)
      autos[autoIdx] = auto
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleToggleLayerBound = useCallback((trackIdx: number, autoIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      autos[autoIdx] = { ...autos[autoIdx], layerBound: !autos[autoIdx].layerBound }
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleDeleteAutomation = useCallback((trackIdx: number, autoIdx: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      tracks[trackIdx] = { ...lt, automations: lt.automations.filter((_, i) => i !== autoIdx) }
      return { ...prev, tracks }
    })
  }, [setShow])

  const handleEditAutomationTarget = useCallback((trackIdx: number, autoIdx: number, newTarget: string) => {
    if (!newTarget) return
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      autos[autoIdx] = { ...autos[autoIdx], target: newTarget }
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

  const selectedTrackRaw = selectedTrackIdx != null ? show.tracks[selectedTrackIdx] : null
  const selectedTrack: LayerTrack | null =
    selectedTrackRaw && selectedTrackRaw.type === 'layer' ? (selectedTrackRaw as LayerTrack) : null
  const selectedCue = selectedTrack && selectedCueIdx != null
    ? selectedTrack.clips[selectedCueIdx] ?? null : null

  // Last frame with content, for the transport's "time to end" countdown
  const endFrame = (() => {
    let end = 0
    for (const t of show.tracks) {
      if (t.type !== 'layer') continue
      for (const c of (t as LayerTrack).clips)
        end = Math.max(end, smpteToFrames(c.time, fps) + smpteToFrames(c.duration, fps))
    }
    if (audioLoaded && show.audioTrack)
      end = Math.max(end, smpteToFrames(show.audioTrack.startOffset, fps) + Math.round(audioEngineRef.current.duration * fps))
    return end
  })()

  const editingEntry = editingEntryId ? rundown.find(e => e.id === editingEntryId) ?? null : null

  return (
    <div className={`app${showMode ? ' show-mode' : ''}${recordArmed && !showMode ? ' rec-armed' : ''}`}>
      <RundownStrip
        rundown={rundown}
        activeId={activeId}
        playing={engineState.playing}
        nowRemaining={endFrame > 0 ? framesToSmpte(Math.max(0, endFrame - engineState.frame), fps) : null}
        showMode={showMode}
        concertDirty={concertDirty}
        activeShowDirty={activeShowEntry?.dirty ?? false}
        concertFilePath={concertFilePath}
        resolumeConnected={engineState.resolumeConnected}
        resolumeHost={show.resolume.host}
        currentDeck={selectedDeck ? { index: selectedDeck.index, name: selectedDeck.name, color: selectedDeck.color, count: decks.length } : null}
        onSelect={handleSelectEntry}
        onGo={handleGo}
        onReorder={handleReorder}
        onAddShow={handleAddShow}
        onAddBreak={handleAddBreak}
        onEdit={setEditingEntryId}
        onDelete={handleDeleteEntry}
        onOpenConcert={handleOpenConcert}
        onSaveConcert={handleSaveConcert}
        onOpenShowFile={handleOpenShowFile}
        onSaveActiveShow={handleSaveActiveShow}
        onSettings={() => setShowSettings(true)}
        onToggleShowMode={() => setShowMode(m => !m)}
        onReconnect={handleReconnect}
      />

      {(restoredAt || autosaveFailed) && (
        <div className={`notice-bar ${autosaveFailed ? 'warn' : ''}`}>
          {autosaveFailed
            ? <span>Autosave failed (not enough storage). Save the timeline manually.</span>
            : <span>Restored last session ({new Date(restoredAt!).toLocaleString('en-GB')}). Unsaved timelines are marked with a dot.</span>}
          {restoredAt && !autosaveFailed && (
            <button className="btn-sm" onClick={handleDiscardRestored}>Start fresh</button>
          )}
          <button className="btn-icon" onClick={() => { setRestoredAt(null); setAutosaveFailed(false) }}>✕</button>
        </div>
      )}

      <TransportBar
        engineState={engineState}
        show={show}
        offsetFrames={offsetFrames}
        endFrame={endFrame}
        ltcActive={ltcActive}
        recordArmed={recordArmed}
        onToggleRecord={() => setRecordArmed(r => !r)}
        overrideCount={Object.keys(overrides).length}
        onReenable={() => handleReenable()}
        readOnly={showMode}
        onPlay={handlePlay}
        onStop={handleStop}
        onLocate={handleLocate}
        onToggleBrowser={() => setShowBrowser(b => !b)}
        browserOpen={showBrowser}
      />

      <div className="main-area">
        {activeIsBreak ? (
          <div className="break-panel">
            <div className="break-panel-icon">⏸</div>
            <div className="break-panel-label">{(activeEntry as BreakEntry).label}</div>
            <div className="break-panel-duration">{(activeEntry as BreakEntry).duration}</div>
            {(activeEntry as BreakEntry).notes && (
              <div className="break-panel-notes">{(activeEntry as BreakEntry).notes}</div>
            )}
          </div>
        ) : (
          <div className="timeline-section">
            <LaneHeaders
              tracks={show.tracks} selectedIdx={selectedTrackIdx}
              layerRowHeights={layerRowHeights} autoLaneHeights={autoLaneHeights}
              scrollY={scrollY}
              audioTrack={show.audioTrack}
              readOnly={showMode}
              onSelect={selectTrack}
              onToggleMute={handleToggleMute}
              onToggleLock={handleToggleLock}
              onToggleExpand={handleToggleExpand}
              onResizeLayer={handleResizeLayer}
              onResizeAutoLane={handleResizeAutoLane}
              onDeleteAutomation={handleDeleteAutomation}
              onToggleLayerBound={handleToggleLayerBound}
              onEditAutomationTarget={handleEditAutomationTarget}
              composition={composition}
              frame={engineState.frame} fps={fps}
              laneStatus={laneStatus}
              overrides={overrides}
              onReenable={handleReenable}
              onToggleGroupCollapsed={handleToggleGroupCollapsed}
              onAddParam={handleAddParam}
              onRetarget={handleRetarget}
              onUpdateAutomation={updateAutomation}
              onSnapshot={handleSnapshot}
              onSetAllExpanded={handleSetAllExpanded}
              onScrollY={handleScrollY}
              onLoadAudio={handleLoadAudioTrack}
              onUpdateAudio={handleUpdateAudioTrack}
            />
            <TimelineCanvas
              tracks={show.tracks} markers={show.markers} fps={fps} bpm={show.bpm}
              readOnly={showMode} laneStatus={laneStatus} overrides={overrides} decks={decks}
              frame={engineState.frame} pxPerFrame={pxPerFrame} scrollFrame={scrollFrame}
              draggingClip={draggingClip} autoLaneHeights={autoLaneHeights}
              layerRowHeights={layerRowHeights}
              audioTrack={show.audioTrack}
              audioDuration={audioLoaded ? audioEngineRef.current.duration : 0}
              waveformInfo={waveformInfo}
              scrollY={scrollY} onScrollY={handleScrollY}
              onScrollFrame={setScrollFrame} onSeek={handleSeek}
              onZoom={f => setPxPerFrame(p => Math.max(0.5, Math.min(60, p * f)))}
              onSelectCue={selectCue}
              onDropClip={handleDropClip} onUpdateCue={handleUpdateCue}
              onAddKeyframe={handleAddKeyframe}
              onUpdateKeyframe={handleUpdateKeyframe}
              onDeleteKeyframe={handleDeleteKeyframe}
              onUpdateKeyframes={handleUpdateKeyframes}
              onDeleteKeyframes={handleDeleteKeyframes}
              onPasteKeyframes={handlePasteKeyframes}
              onResizeAutoLane={handleResizeAutoLane}
              selectedTrackIdx={selectedTrackIdx} selectedCueIdx={selectedCueIdx}
            />
          </div>
        )}

        {showBrowser && !activeIsBreak && (
          <ClipBrowser
            tracks={show.tracks}
            liveComposition={composition}
            onClose={() => setShowBrowser(false)}
            onDragStart={setDraggingClip}
            onDragEnd={() => setDraggingClip(null)}
          />
        )}
      </div>

      {!activeIsBreak && (
        <BottomPanel
          track={selectedTrack} cue={selectedCue} readOnly={showMode}
          group={selectedTrackRaw?.type === 'group' ? selectedTrackRaw as GroupTrack : null}
          decks={decks}
          frame={engineState.frame}
          onToggleKey={handleToggleKey} onParamEdit={handleParamEdit} onSeek={handleSeek}
          cueIdx={selectedCueIdx} trackIdx={selectedTrackIdx} fps={fps}
          height={bottomPanelHeight} onResize={setBottomPanelHeight}
          onUpdateCue={handleUpdateCue} onDeleteCue={handleDeleteCue}
          onSelectCue={selectCue}
          onClose={clearSelection}
        />
      )}

      {showSettings && (
        <ClockSettingsModal
          show={show}
          onUpdate={handleUpdateProjectSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {editingEntry && (
        <RundownEditModal
          entry={editingEntry}
          onSave={handleEditEntry}
          onClose={() => setEditingEntryId(null)}
        />
      )}
    </div>
  )
}
