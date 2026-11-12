import { useEffect, useRef, useState, useCallback } from 'react'
import type { Show, LayerTrack, AutomationSubTrack, ClipCue, EngineState, Keyframe } from '../../shared/show'
import type { ResolumeComposition } from '../../shared/resolume'
import type { RundownEntry, ShowEntry, BreakEntry, ConcertFile } from '../../shared/concert'
import { rv, layerDisplayName } from '../../shared/resolume'
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

const api = (window as any).timeline

export interface DragClipData {
  layerIndex: number; layerId: number
  clipIndex: number; clipId: number; clipName: string
}

const LAYER_COLORS = [
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C',
  '#1ABC9C', '#F39C12', '#3498DB', '#E91E63', '#00BCD4',
]

const ENTRY_COLORS = [
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C',
  '#1ABC9C', '#F39C12', '#3498DB', '#E91E63', '#00BCD4',
  '#FF6B6B', '#95A5A6',
]

const EMPTY_SHOW: Show = {
  version: 1, name: 'Nov projekt', frameRate: 25, duration: '02:00:00:00',
  resolume: { host: '127.0.0.1', oscPort: 7000, restPort: 8080, feedbackPort: 7001 },
  clock: { source: 'internal', offset: '00:00:00:00', freewheelFrames: 5 },
  markers: [], tracks: [],
}

// Mirrors the Resolume layer list into the show. Tracks whose layer is gone from the
// composition are kept (they hold cues/automation). Returns `show` unchanged when
// nothing differs, so a periodic sync does not mark the show dirty.
function syncLayers(show: Show, comp: ResolumeComposition): Show {
  const layers = (comp.layers ?? []).filter(Boolean)
  const matched = new Set<string>()
  const synced: LayerTrack[] = layers.map((layer, li) => {
    const name = layerDisplayName(rv(layer.name, `Layer ${li + 1}`), li + 1)
    const existing = show.tracks.find(
      t => t.type === 'layer' && (t as LayerTrack).resolumeLayerId === layer.id
    ) as LayerTrack | undefined
    if (!existing) {
      return {
        id: `layer-${layer.id}`, name,
        type: 'layer' as const, resolumeLayerId: layer.id, resolumeLayerIndex: li + 1,
        color: LAYER_COLORS[li % LAYER_COLORS.length], expanded: false, clips: [], automations: [],
      }
    }
    matched.add(existing.id)
    // Clip slots can be moved in Resolume; follow the clip by its stable id
    const slotById = new Map((layer.clips ?? []).map((c, ci) => [c?.id, ci + 1]))
    let clipsChanged = false
    const clips = existing.clips.map(c => {
      const slot = slotById.get(c.clipId)
      if (slot === undefined || slot === c.clipIndex) return c
      clipsChanged = true
      return { ...c, clipIndex: slot }
    })
    if (!clipsChanged && existing.name === name && existing.resolumeLayerIndex === li + 1) return existing
    return { ...existing, name, resolumeLayerIndex: li + 1, clips }
  })
  // Layer gone from Resolume: index 0 = offline, so the scheduler stops firing into a wrong layer
  const unmatched = show.tracks
    .filter(t => !matched.has(t.id) && !synced.some(s => s.id === t.id))
    .map(t => t.type === 'layer' && (t as LayerTrack).resolumeLayerIndex !== 0
      ? { ...(t as LayerTrack), resolumeLayerIndex: 0 } : t)
  const tracks = [...synced, ...unmatched]
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
  return { id: newEntryId(), type: 'break', label: 'Odmor', duration: '00:20:00:00', color: '#333333', notes: '' }
}

// Single module-level initial entry so IDs are stable across renders
const _initEntry = makeShowEntry({ ...EMPTY_SHOW }, null, 0)
// Read once at startup: the state left by the previous session (crash, reload, quit)
const _restored = loadAutosave()
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
          const cw = window.innerWidth - 380
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

  useEffect(() => {
    const unsub = api.onCompositionUpdate((comp: ResolumeComposition) => {
      setShow(prev => syncLayers(prev, comp))
    })
    return unsub
  }, [setShow])

  useEffect(() => {
    api.getComposition().then((comp: ResolumeComposition | null) => {
      if (comp) setShow(prev => syncLayers(prev, comp))
    })
  }, [setShow])

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
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
      if (e.code === 'Delete' || e.code === 'Backspace') {
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
    const entry = makeShowEntry({ ...EMPTY_SHOW, name: `Projekt ${idx + 1}` }, null, idx)
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

  const handleEditEntry = useCallback((id: string, updates: Partial<Pick<BreakEntry, 'color' | 'notes' | 'label' | 'duration'>>) => {
    setRundown(prev => prev.map(e => {
      if (e.id !== id) return e
      if (e.type === 'show') return { ...e, color: updates.color ?? e.color, notes: updates.notes ?? e.notes }
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

  const handleAddAutomation = useCallback((trackIdx: number, sub: AutomationSubTrack) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      tracks[trackIdx] = { ...lt, expanded: true, automations: [...lt.automations, sub] }
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

  const handleResizeAutoLane = useCallback((autoId: string, height: number) => {
    setAutoLaneHeights(prev => ({ ...prev, [autoId]: height }))
  }, [])

  const handleResizeLayer = useCallback((id: string, height: number) => {
    setLayerRowHeights(prev => ({ ...prev, [id]: height }))
  }, [])

  const handleAddKeyframe = useCallback((trackIdx: number, autoIdx: number, frame: number, value: number) => {
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const autos = [...lt.automations]
      const auto = { ...autos[autoIdx] }
      const kf: Keyframe = { time: framesToSmpte(frame, prev.frameRate), value, ease: 'linear' }
      auto.keyframes = [...auto.keyframes, kf].sort(
        (a, b) => smpteToFrames(a.time, prev.frameRate) - smpteToFrames(b.time, prev.frameRate)
      )
      autos[autoIdx] = auto
      tracks[trackIdx] = { ...lt, automations: autos }
      return { ...prev, tracks }
    })
  }, [setShow])

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

  const editingEntry = editingEntryId ? rundown.find(e => e.id === editingEntryId) ?? null : null

  return (
    <div className="app">
      <RundownStrip
        rundown={rundown}
        activeId={activeId}
        ltcActive={ltcActive}
        ltcDisplay={ltcRawTC}
        concertDirty={concertDirty}
        activeShowDirty={activeShowEntry?.dirty ?? false}
        concertFilePath={concertFilePath}
        onSelect={handleSelectEntry}
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
      />

      {(restoredAt || autosaveFailed) && (
        <div className={`notice-bar ${autosaveFailed ? 'warn' : ''}`}>
          {autosaveFailed
            ? <span>Samodejno shranjevanje ni uspelo (premalo prostora). Shrani show ročno.</span>
            : <span>Obnovljeno zadnje stanje ({new Date(restoredAt!).toLocaleString('sl-SI')}). Neshranjeni showi so označeni s piko.</span>}
          {restoredAt && !autosaveFailed && (
            <button className="btn-sm" onClick={handleDiscardRestored}>Začni na novo</button>
          )}
          <button className="btn-icon" onClick={() => { setRestoredAt(null); setAutosaveFailed(false) }}>✕</button>
        </div>
      )}

      <TransportBar
        engineState={engineState}
        show={show}
        offsetFrames={offsetFrames}
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
              onSelect={selectTrack}
              onToggleExpand={handleToggleExpand}
              onResizeLayer={handleResizeLayer}
              onResizeAutoLane={handleResizeAutoLane}
              onDeleteAutomation={handleDeleteAutomation}
              onToggleLayerBound={handleToggleLayerBound}
              onEditAutomationTarget={handleEditAutomationTarget}
              onScrollY={handleScrollY}
              onLoadAudio={handleLoadAudioTrack}
              onUpdateAudio={handleUpdateAudioTrack}
            />
            <TimelineCanvas
              tracks={show.tracks} markers={show.markers} fps={fps} bpm={show.bpm}
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
              onResizeAutoLane={handleResizeAutoLane}
              selectedTrackIdx={selectedTrackIdx} selectedCueIdx={selectedCueIdx}
            />
          </div>
        )}

        {showBrowser && !activeIsBreak && (
          <ClipBrowser
            tracks={show.tracks}
            onClose={() => setShowBrowser(false)}
            onDragStart={setDraggingClip}
            onDragEnd={() => setDraggingClip(null)}
          />
        )}
      </div>

      {!activeIsBreak && (
        <BottomPanel
          track={selectedTrack} cue={selectedCue}
          cueIdx={selectedCueIdx} trackIdx={selectedTrackIdx} fps={fps}
          height={bottomPanelHeight} onResize={setBottomPanelHeight}
          onUpdateCue={handleUpdateCue} onDeleteCue={handleDeleteCue}
          onAddAutomation={handleAddAutomation}
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
