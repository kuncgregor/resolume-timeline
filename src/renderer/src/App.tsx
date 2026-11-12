import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { Show, Track, LayerTrack, GroupTrack, AutomationSubTrack, ClipCue, EngineState, Keyframe, ParamRef } from '../../shared/show'
import type { ResolumeComposition } from '../../shared/resolume'
import { isValidRundown, type RundownEntry, type ShowEntry, type BreakEntry } from '../../shared/concert'
import { showfileData, showfileKey, isShowfile, type ShowfileMeta, type ShowfileData } from '../../shared/showfile'
import { rv, layerDisplayName, resolumeColor } from '../../shared/resolume'
import { TransportBar } from './components/TransportBar'
import { LaneHeaders } from './components/LaneHeaders'
import { TimelineCanvas } from './components/TimelineCanvas'
import { convertItems } from './material'
import { OverviewBar } from './components/OverviewBar'
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
import { resolveShow, laneFieldsFor, rememberClip, knownClip } from './resolver'
import type { LaneStatusMap } from './laneStatus'
import { decksOf } from './decks'
import { HealthBar } from './components/HealthBar'
import { frameStore } from './frameStore'
import { PPF_MIN, PPF_MAX } from './layout'
import { tempoOf, rulerModeOf, snapOf, gridSnapOf, formatSnapStep, type SnapGrid } from './grid'
import { sameRef, normalize, resolveRef, oscAddress, type ParamInfo } from '../../shared/paramTree'

const api = (window as any).timeline
// A browser on the app's tablet server: edits the same session, but LTC, the audio track,
// recording and the engine's show/targets stay with the app on the computer
const REMOTE: boolean = !!api.__remote

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
const FOLLOW_TC_KEY = 'resolume-timeline:followTc'
const ARENA_REC_LATENCY_MS = 40   // Arena starts writing ~38 ms after the record command (measured, 7.24)
const STOP_CONFIRM_MS = 1500   // SHOW mode: second Space / ■ within this stops

/** LTC input a clock source listens to ('ltc' = legacy A). */
const ltcInputOf = (src: string): 'a' | 'b' | null => src === 'ltc-b' ? 'b' : src === 'ltc-a' || src === 'ltc' ? 'a' : null

/** The timeline an incoming LTC time (seconds) belongs to, among timelines on that input:
 *  each owns the range from its start TC up to the next greater start TC (like timecode shows
 *  on a lighting desk). Timelines sharing a start TC: the selected one wins. */
function ltcOwner(rundown: RundownEntry[], tcSec: number, input: 'a' | 'b', activeId: string): string | null {
  let best: string | null = null, bestStart = -1
  for (const e of rundown) {
    if (e.type !== 'show' || ltcInputOf(e.show.clock.source) !== input) continue
    const fr = e.show.frameRate
    const start = smpteToFrames(e.show.clock.offset || '00:00:00:00', fr) / fr
    if (start > tcSec + 1e-6) continue
    if (start > bestStart + 1e-6 || (Math.abs(start - bestStart) <= 1e-6 && e.id === activeId)) { best = e.id; bestStart = start }
  }
  return best
}

/** Project frame of a decoded LTC frame. It is decoded when its sync word ends, i.e. as the
 *  next frame starts (+1); 50/60 fps projects get 25/30 fps LTC (one LTC frame = 2 frames). */
const ltcToFrames = (hh: number, mm: number, ss: number, ff: number, fps: number) => {
  const per = fps > 30 ? 2 : 1
  return (hh * 3600 + mm * 60 + ss) * fps + (ff + 1) * per
}

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

// ── Clip automation templates (clip right-click: fades, copy / paste) ─────────
const CLIP_OPACITY_PATH: ParamRef['path'] = ['video', 'opacity']
type CueKey = { frame: number; value: number; ease: string; option?: string }
// Lanes bound to a cue, keyframe times relative to the cue start (frames at `fps`)
interface ClipAutoClipboard {
  fps: number; layerId: number; cueName: string
  lanes: { lane: AutomationSubTrack; keys: (Omit<CueKey, 'frame'> & { offset: number })[] }[]
}

/** Puts `keys` onto the lane of `ref` bound to `cue` (a new lane from `fresh` when the cue
 *  has none): existing keyframes inside `ranges` are replaced, the others are kept. */
function mergeCueLane(
  lt: LayerTrack, cue: ClipCue, ref: ParamRef, fresh: () => AutomationSubTrack,
  keys: CueKey[], ranges: [number, number][], fps: number,
): LayerTrack {
  const inRange = (f: number) => ranges.some(([a, b]) => f >= a && f <= b)
  const idx = lt.automations.findIndex(a => sameRef(a.ref, ref) && a.clipId === cue.id && !a.layerBound)
  const base = idx >= 0 ? lt.automations[idx] : fresh()
  const byTime = new Map<string, Keyframe>()
  for (const k of base.keyframes) if (!inRange(smpteToFrames(k.time, fps))) byTime.set(k.time, k)
  for (const k of keys) {
    const time = framesToSmpte(k.frame, fps)
    byTime.set(time, { time, value: k.value, ease: k.ease, ...(k.option !== undefined ? { option: k.option } : {}) })
  }
  const keyframes = [...byTime.values()].sort((a, b) => smpteToFrames(a.time, fps) - smpteToFrames(b.time, fps))
  const lane: AutomationSubTrack = { ...base, keyframes, ...(base.visible === false ? { visible: true } : {}) }
  const automations = idx >= 0 ? lt.automations.map((a, i) => (i === idx ? lane : a)) : [...lt.automations, lane]
  return { ...lt, expanded: true, automations }
}
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

const NEW_SHOWFILE: ShowfileMeta = { name: '', path: null, autosave: true }

// Single module-level initial entry so IDs are stable across renders
const _initEntry = makeShowEntry({ ...EMPTY_SHOW }, null, 0)
// Read once at startup: the state left by the previous session (crash, reload, quit)
// Entries still carrying the old default names ("Nov projekt", "Projekt N") become "Timeline N"
const renameDefault = (r: ReturnType<typeof loadAutosave>) => r && {
  ...r,
  rundown: r.rundown.map((e, i) => e.type === 'show' && /^(Nov projekt|Projekt \d+)$/.test(e.show.name)
    ? { ...e, show: { ...e.show, name: `Timeline ${i + 1}` } } : e),
}
const _restored = REMOTE ? null : renameDefault(loadAutosave())
const _initActiveId = _restored?.rundown.some(e => e.id === _restored.activeId)
  ? _restored.activeId : (_restored?.rundown[0].id ?? _initEntry.id)

const UNDO_GROUP_MS = 300   // edits closer together than this are one undo step
const UNDO_STEPS = 100

/** Engine states that differ only in the frame (the frame store has that). */
const sameEngineState = (a: EngineState, b: EngineState) =>
  a.playing === b.playing && a.fps === b.fps && a.showName === b.showName && a.resolumeConnected === b.resolumeConnected

export default function App() {
  const [rundown, setRundown] = useState<RundownEntry[]>(_restored?.rundown ?? [_initEntry])
  const [activeId, setActiveId] = useState<string>(_initActiveId)
  // The showfile this session is (name, file, autosave) and whether it has unsaved changes
  const [showfile, setShowfile] = useState<ShowfileMeta>(_restored?.showfile ?? NEW_SHOWFILE)
  const [showfileDirty, setShowfileDirty] = useState(_restored?.showfileDirty ?? true)
  // Restored unsaved work is worth a notice only when autosave didn't keep the file up to date
  const [restoredAt, setRestoredAt] = useState<number | null>(
    _restored?.showfile && !_restored.showfile.autosave && _restored.showfileDirty ? _restored.savedAt : null)
  const [showfileSavedAt, setShowfileSavedAt] = useState<number | null>(null)
  const [showfileError, setShowfileError] = useState<string | null>(null)
  const [autosaveFailed, setAutosaveFailed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // SHOW mode locks every editing gesture (QLab Show Mode / console "live" lock)
  const [showMode, setShowMode] = useState(false)
  const showModeRef = useRef(false)
  showModeRef.current = showMode
  // Playhead locked: SHOW mode while playing (only GO / the clock move it)
  const showLockedRef = () => showModeRef.current && engineRef.current.playing
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const activeIdRef = useRef<string>(_initActiveId)

  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // LTC decoder — global singleton
  const ltcDecoderRef = useRef(new LTCDecoder())
  const [ltcActive, setLtcActive] = useState(false)
  const [ltcRawTC, setLtcRawTC] = useState('--:--:--:--')
  // LTC arrives but belongs to no / another timeline (before this one's start TC, or at or
  // after the next LTC timeline's start TC): the active timeline doesn't run
  const [ltcOutside, setLtcOutside] = useState(false)
  // Follow TC: switch to the timeline whose TC range the incoming LTC is in (per machine)
  const [followTc, setFollowTc] = useState(() => { try { return localStorage.getItem(FOLLOW_TC_KEY) === '1' } catch { return false } })
  const followTcRef = useRef(followTc)
  followTcRef.current = followTc
  useEffect(() => { try { localStorage.setItem(FOLLOW_TC_KEY, followTc ? '1' : '0') } catch { /* private mode */ } }, [followTc])

  // Audio engine
  const audioEngineRef = useRef(new AudioEngine())
  audioEngineRef.current.silent = REMOTE
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
  const tempo = useMemo(() => tempoOf(show), [show.bpm, show.beatsPerBar, show.downbeat, show.frameRate])
  const rulerMode = rulerModeOf(show)
  const snap = useMemo(() => snapOf(show), [show.snap, show.bpm, show.rulerMode])

  const [engineState, setEngineState] = useState<EngineState>({
    frame: 0, playing: false, fps: 25, showName: '', resolumeConnected: false,
  })
  const engineRef = useRef(engineState)
  useEffect(() => { engineRef.current = engineState }, [engineState])

  // ── setShow — updates active show entry ────────────────────────────────────
  // setShow is for the user's edits: each one can be undone (⌘Z) and redone (⌘⇧Z), per
  // timeline. syncShow is for what follows Resolume (layers, colours, resolved targets).

  const historyRef = useRef(new Map<string, { past: Show[]; future: Show[] }>())
  const [historyTick, setHistoryTick] = useState(0)
  const lastEditRef = useRef(0)
  const setShow = useCallback((updater: Show | ((prev: Show) => Show)) => {
    // Edits close together (one gesture, a fader writing keyframes) are one undo step
    const now = Date.now()
    if (now - lastEditRef.current > UNDO_GROUP_MS) {
      const id = activeIdRef.current
      const h = historyRef.current.get(id) ?? { past: [], future: [] }
      h.past.push(showRef.current)
      if (h.past.length > UNDO_STEPS) h.past.shift()
      h.future = []
      historyRef.current.set(id, h)
    }
    lastEditRef.current = now
    syncShow(updater)
  }, [])
  const syncShow = useCallback((updater: Show | ((prev: Show) => Show)) => {
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
      return changed ? next : prev
    })
  }, [])

  // ── Autosave ───────────────────────────────────────────────────────────────

  // SHOW mode is part of the session: the lock applies on the tablets too
  const autosaveRef = useRef({ rundown, activeId, showfile, showfileDirty, showMode })
  autosaveRef.current = { rundown, activeId, showfile, showfileDirty, showMode }
  const flushAutosave = useCallback(() => {
    if (REMOTE) return
    setAutosaveFailed(!writeAutosave({ savedAt: Date.now(), ...autosaveRef.current }))
  }, [])
  // Debounced so dragging a keyframe does not serialize the show on every mouse move
  useEffect(() => {
    const t = setTimeout(flushAutosave, 800)
    return () => clearTimeout(t)
  }, [rundown, activeId, showfile, showfileDirty, showMode, flushAutosave])
  useEffect(() => {
    window.addEventListener('pagehide', flushAutosave)
    return () => window.removeEventListener('pagehide', flushAutosave)
  }, [flushAutosave])

  // ── Session sync ───────────────────────────────────────────────────────────
  // The engine keeps the session (session.json in the app's data folder) and passes every
  // change on to the other UIs: the app window and tablets show and edit the same timelines.
  // Whole-session: each push names the revision it was based on, and a push based on an
  // older one is refused (that UI takes the current session instead), so a UI that missed
  // changes can't overwrite them. Also how the app finds the timelines made in the browser.
  const sessionJsonRef = useRef('')   // last session sent or received
  const sessionRevRef = useRef<number | null>(null)
  const pushingRef = useRef(false)
  const [sessionReady, setSessionReady] = useState(false)
  const adoptSession = useCallback((d: any, rev: number | null) => {
    if (rev != null && sessionRevRef.current != null && rev <= sessionRevRef.current) return   // older reply
    if (rev != null) sessionRevRef.current = rev
    if (!d || !isValidRundown(d.rundown)) return
    const state = {
      rundown: d.rundown as RundownEntry[],
      activeId: d.rundown.some((e: RundownEntry) => e.id === d.activeId) ? d.activeId as string : d.rundown[0].id as string,
      showfile: (d.showfile ?? NEW_SHOWFILE) as ShowfileMeta,
      showfileDirty: d.showfileDirty ?? true,
      showMode: !!d.showMode,
    }
    sessionJsonRef.current = JSON.stringify(state)
    activeIdRef.current = state.activeId
    setRundown(state.rundown); setActiveId(state.activeId)
    setShowfile(state.showfile); setShowfileDirty(state.showfileDirty)
    setShowMode(state.showMode)
  }, [])
  const pushSession = useCallback(async () => {
    // One push at a time: the next one must carry the revision the previous one created
    if (pushingRef.current) return
    const json = JSON.stringify(autosaveRef.current)
    if (json === sessionJsonRef.current) return
    sessionJsonRef.current = json
    pushingRef.current = true
    let ok = false
    try {
      const r = await api.sessionSet({ savedAt: Date.now(), ...autosaveRef.current }, sessionRevRef.current)
      ok = !!r?.ok
      if (ok) sessionRevRef.current = Math.max(r.rev, sessionRevRef.current ?? 0)
      else if (r?.data) { sessionRevRef.current = null; adoptSession(r.data, r.rev) }
    } catch { sessionJsonRef.current = '' /* retried with the next change */ }
    finally { pushingRef.current = false }
    // Changed while the push was on its way (not after a refusal: this UI now shows the
    // engine's session, its own state is the one that was refused)
    if (ok && JSON.stringify(autosaveRef.current) !== sessionJsonRef.current) pushSession()
  }, [adoptSession])
  const fetchSession = useCallback(async (startup: boolean) => {
    const s = await api.sessionGet()
    if (!s?.rundown) return
    // At startup the newer of the engine's session and this window's own autosave wins; a
    // tablet always shows the engine's
    if (!startup || REMOTE || !_restored || (s.savedAt ?? 0) > _restored.savedAt) {
      adoptSession(s, s.rev ?? null)
      // Notice only for unsaved work that autosave didn't write
      if (startup && !REMOTE) setRestoredAt(s.showfile && !s.showfile.autosave && s.showfileDirty ? s.savedAt ?? null : null)
    } else sessionRevRef.current = s.rev ?? null
  }, [adoptSession])
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    // A tablet must not push its empty start state over the real session: it only becomes
    // ready after reading it (retried until the app answers)
    const first = () => fetchSession(true).then(
      () => { if (live) setSessionReady(true) },
      () => { if (!live) return; if (REMOTE) timer = setTimeout(first, 2000); else setSessionReady(true) })
    first()
    const unsub = api.onSession(({ data, from, rev }: { data: any; from: string | null; rev: number }) => {
      if (from !== api.clientId) adoptSession(data, rev)
    })
    const unsubRe = api.onReconnect(() => { fetchSession(false).catch(() => {}) })
    return () => { live = false; clearTimeout(timer); unsub(); unsubRe() }
  }, [adoptSession, fetchSession])
  useEffect(() => {
    if (!sessionReady) return
    const t = setTimeout(pushSession, 250)
    return () => clearTimeout(t)
  }, [sessionReady, rundown, activeId, showfile, showfileDirty, showMode, pushSession])

  // Saved-state of the showfile: key of the content last written (null = not known yet)
  const savedKeyRef = useRef<string | null>(null)
  const handleNewShowfile = useCallback(() => {
    api.stop(); audioEngineRef.current.stop()
    const entry = makeShowEntry({ ...EMPTY_SHOW, name: 'Timeline 1' }, null, 0)
    clearAutosave()
    savedKeyRef.current = ''
    setRundown([entry]); setActiveId(entry.id)
    setShowfile(NEW_SHOWFILE); setShowfileDirty(true); setRestoredAt(null)
    // Fill the new empty show with the current Resolume layers
    api.getComposition().then((comp: ResolumeComposition | null) => {
      if (comp) syncShow(prev => syncLayers(prev, comp))
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

  /** ⌘Z / ⌘⇧Z: the timeline as it was before the last edit / after the last undo. */
  const undo = useCallback((redo: boolean) => {
    const h = historyRef.current.get(activeIdRef.current)
    if (!h) return
    const from = redo ? h.future : h.past, to = redo ? h.past : h.future
    let target = from.pop()
    while (target && target === showRef.current) target = from.pop()
    if (!target) return
    to.push(showRef.current)
    lastEditRef.current = 0
    setHistoryTick(n => n + 1)
    // View and edit settings stay as they are now (they are not undo steps), and so does
    // what Resolume says now (layer names, colours)
    const cur = showRef.current
    const restored = { ...target, snap: cur.snap, rulerMode: cur.rulerMode, lockEnvelopes: cur.lockEnvelopes }
    const comp = compositionRef.current
    syncShow(comp ? syncLayers(restored, comp) : restored)
  }, [syncShow])
  const undoRef = useRef(undo)
  undoRef.current = undo
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
      // The frame goes to the frame store (only what shows it re-renders); the app
      // re-renders when the rest changes (play / stop, connection)
      frameStore.set(state.frame)
      setEngineState(prev => sameEngineState(prev, state) ? prev : state)
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

  // Play / Stop / locate from a tablet: the audio track (played here) follows
  useEffect(() => REMOTE ? undefined : api.onTransportCmd(({ frame, playing, from }: { frame: number; playing: boolean; from: string | null }) => {
    if (from === api.clientId) return
    if (playing && audioLoadedRef.current) audioEngineRef.current.play(frame)
    else audioEngineRef.current.stop()
  }), [])

  // Ticks only arrive while the frame changes, so the connection status needs its own
  // event, plus one query at startup in case that event fired before we subscribed
  useEffect(() => {
    api.getState().then((s: EngineState | null) => { if (s) { frameStore.set(s.frame); setEngineState(s) } })
    return api.onResolumeStatus(({ connected }: { connected: boolean }) =>
      setEngineState(s => ({ ...s, resolumeConnected: connected })))
  }, [])

  // ── Resolume composition updates ───────────────────────────────────────────

  // Latest composition JSON: drives layer sync, the parameter picker, the live strip in
  // the layer headers and the automation target resolver
  const [composition, setComposition] = useState<ResolumeComposition | null>(null)
  const compositionRef = useRef(composition)
  compositionRef.current = composition

  useEffect(() => {
    const unsub = api.onCompositionUpdate((comp: ResolumeComposition) => {
      setComposition(comp)
      syncShow(prev => syncLayers(prev, comp))
    })
    return unsub
  }, [setShow])

  useEffect(() => {
    api.getComposition().then((comp: ResolumeComposition | null) => {
      if (!comp) return
      setComposition(comp)
      syncShow(prev => syncLayers(prev, comp))
    })
  }, [setShow])

  // ── Automation targets: stable ref → live Resolume parameter id ─────────────

  // Lanes the operator took over in Resolume (lane id → their value, normalized) and the REC
  // switch: when armed, operator changes become keyframes at the playhead instead
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [recordArmed, setRecordArmed] = useState(false)
  useEffect(() => api.onOverrides((m: Record<string, number>) => setOverrides(m)), [])
  useEffect(() => { if (!REMOTE) api.setRecordArmed(recordArmed) }, [recordArmed])
  useEffect(() => REMOTE ? undefined : api.onRecord(({ laneId, value, option }: { laneId: string; value: number; option?: string }) => {
    showRef.current.tracks.forEach((t, ti) => {
      if (t.type !== 'layer' && t.type !== 'group') return
      const ai = (t as LayerTrack | GroupTrack).automations.findIndex(a => a.id === laneId)
      if (ai >= 0) handleAddKeyframe(ti, ai, frameStore.get(), value, option)
    })
  }), [])
  const handleReenable = useCallback((ids?: string[]) => { api.reenableAutomation(ids) }, [])

  // Resolume's composition tempo (BPM link)
  const arenaTempo = useMemo(() => {
    const t = (composition as any)?.tempocontroller?.tempo
    return t?.id != null ? { id: t.id as number, value: Number(t.value) } : null
  }, [composition])

  // Taken-over lanes with a name an operator recognises: "Layer 2 › Rotation Y"
  const manualLanes = useMemo(() => {
    const out: { id: string; name: string }[] = []
    for (const t of show.tracks) {
      if (t.type !== 'layer' && t.type !== 'group') continue
      for (const a of (t as LayerTrack).automations) {
        if (!(a.id in overrides)) continue
        const label = a.ref?.label ?? a.name
        out.push({ id: a.id, name: `${t.name} › ${label.includes(' › ') ? label.split(' › ').pop() : label}` })
      }
    }
    return out
  }, [show.tracks, overrides])

  const decks = useMemo(() => decksOf(composition), [composition])
  const selectedDeck = decks.find(d => d.selected)

  // ── Showfile: name, save, autosave ─────────────────────────────────────────
  // One file holds every timeline. A new showfile is named after the Resolume composition
  // and, with autosave on, saved to Documents/Resolume Timeline as soon as it has a name.
  // Only the app window writes files (a tablet's changes reach it through the session).
  const compositionName = String(rv((composition as any)?.name, '') ?? '').trim()
  const compositionNameRef = useRef(compositionName)
  compositionNameRef.current = compositionName
  const showfileName = showfile.name || compositionName || 'Untitled showfile'
  const showfileRef = useRef(showfile)
  showfileRef.current = showfile

  useEffect(() => {
    if (!REMOTE && sessionReady && !showfile.name && compositionName) setShowfile(s => s.name ? s : { ...s, name: compositionName })
  }, [sessionReady, showfile.name, compositionName])
  useEffect(() => {
    if (REMOTE || !sessionReady || !showfile.autosave || showfile.path || !showfile.name) return
    let live = true
    api.showfileDefaultPath(showfile.name).then((p: string) => {
      if (live && p) setShowfile(s => s.path ? s : { ...s, path: p })
    }).catch(() => {})
    return () => { live = false }
  }, [sessionReady, showfile.autosave, showfile.path, showfile.name])

  // Unsaved changes: the content differs from what was last written
  useEffect(() => {
    if (REMOTE || !sessionReady) return
    const t = setTimeout(() => {
      const key = showfileKey(showfile.name, rundown)
      if (savedKeyRef.current === null) savedKeyRef.current = showfileDirty ? '' : key   // first check after start
      setShowfileDirty(key !== savedKeyRef.current)
    }, 300)
    return () => clearTimeout(t)
  }, [sessionReady, rundown, showfile.name])   // eslint-disable-line react-hooks/exhaustive-deps

  const writeShowfile = useCallback(async (path: string, name: string) => {
    const { rundown: rd, activeId: aid, showfile: sf } = autosaveRef.current
    const key = showfileKey(name, rd)
    let r: { ok: boolean; savedAt?: number; error?: string } | null = null
    try { r = await api.showfileWrite(path, showfileData(sf, name, rd, aid, compositionNameRef.current || undefined)) } catch (e) { r = { ok: false, error: String(e) } }
    if (!r?.ok) { setShowfileError(`The showfile could not be saved: ${r?.error ?? 'unknown error'}`); return false }
    savedKeyRef.current = key
    setShowfileError(null); setShowfileSavedAt(r.savedAt ?? Date.now())
    setShowfileDirty(showfileKey(name, autosaveRef.current.rundown) !== key)
    return true
  }, [])

  // Autosave: a second after the last change
  useEffect(() => {
    if (REMOTE || !sessionReady || !showfile.autosave || !showfile.path || !showfile.name || !showfileDirty) return
    const t = setTimeout(() => { writeShowfile(showfile.path!, showfile.name) }, 1000)
    return () => clearTimeout(t)
  }, [sessionReady, showfile.autosave, showfile.path, showfile.name, showfileDirty, rundown, writeShowfile])

  const handleSaveShowfile = useCallback(async () => {
    if (REMOTE) return   // files live on the computer running the app
    const sf = showfileRef.current
    const name = sf.name || compositionNameRef.current || 'Untitled showfile'
    const path: string = sf.path ?? await api.showfileDefaultPath(name)
    if (sf.path !== path || sf.name !== name) setShowfile(s => ({ ...s, name, path }))
    await writeShowfile(path, name)
  }, [writeShowfile])
  const saveRef = useRef(handleSaveShowfile)
  saveRef.current = handleSaveShowfile

  const handleSaveShowfileAs = useCallback(async () => {
    if (REMOTE) return
    const path: string | null = await api.showfileSaveAs(showfileRef.current.name || compositionNameRef.current || 'Untitled showfile')
    if (!path) return
    const name = path.split(/[\\/]/).pop()!.replace(/\.rtshow$/i, '')
    setShowfile(s => ({ ...s, name, path }))
    await writeShowfile(path, name)
  }, [writeShowfile])

  // Renaming the showfile renames its file too
  const handleRenameShowfile = useCallback(async (raw: string) => {
    const name = raw.trim()
    const sf = showfileRef.current
    if (REMOTE || !name || name === sf.name) return
    let path = sf.path
    if (path) {
      const r = await api.showfileRename(path, name).catch(() => null)
      if (r?.path) path = r.path
    }
    setShowfile(s => ({ ...s, name, path }))
  }, [])

  const handleToggleAutosave = useCallback(() => {
    setShowfile(s => ({ ...s, autosave: !s.autosave }))
  }, [])

  const [laneStatus, setLaneStatus] = useState<LaneStatusMap>({})
  const laneStatusRef = useRef(laneStatus)
  laneStatusRef.current = laneStatus
  const sentTargetsRef = useRef('')
  const [clipCacheTick, setClipCacheTick] = useState(0)
  const clipFetchAtRef = useRef(new Map<number, number>())
  useEffect(() => {
    const { status, targets, updates } = resolveShow(show, composition)
    if (updates.length) {
      // Migration of old lanes / refreshed ranges; the effect runs again with the new show
      syncShow(prev => {
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
    // Clips of decks Resolume isn't showing: fetch them by id (works while they play) so
    // their lanes resolve; this runs again with every composition poll until it succeeds
    const elsewhere = new Set<number>()
    for (const t of show.tracks) if (t.type === 'layer')
      for (const a of (t as LayerTrack).automations)
        if (status[a.id]?.state === 'elsewhere' && a.ref?.clipId != null) elsewhere.add(a.ref.clipId)
    // At most one attempt per clip every 2 s: this effect also runs on every edit / REC key
    const now = Date.now()
    for (const id of elsewhere) {
      if (now - (clipFetchAtRef.current.get(id) ?? 0) < 2000) continue
      clipFetchAtRef.current.set(id, now)
      api.getClipById(id).then((json: any) => {
        if (json?.id === id) { rememberClip(json); setClipCacheTick(n => n + 1) }
      }).catch(() => {})
    }
    const key = JSON.stringify(targets)
    if (key !== sentTargetsRef.current && !REMOTE) {
      sentTargetsRef.current = key
      api.setTargets(targets)
    }
  }, [show, composition, setShow, clipCacheTick])

  useEffect(() => { if (!REMOTE) api.loadShowDirect(show) }, [show])

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
  const ltcShouldRun = !REMOTE && ltcEnabledShows.length > 0
  const ltcDeviceId = isLtcSource(show.clock.source)
    ? (deviceForSource(show) ?? '')
    : (ltcEnabledShows[0] ? (deviceForSource(ltcEnabledShows[0].show) ?? '') : '')
  const ltcChannelIdx = isLtcSource(show.clock.source)
    ? channelForSource(show)
    : (ltcEnabledShows[0] ? channelForSource(ltcEnabledShows[0].show) : 0)

  // Values the running decoder reads without restarting it (a Follow TC switch to a
  // timeline with another frame rate must not drop the signal)
  const ltcInput: 'a' | 'b' = ltcInputOf(show.clock.source) ?? (ltcEnabledShows[0] ? ltcInputOf(ltcEnabledShows[0].show.clock.source) ?? 'a' : 'a')
  const ltcInputRef = useRef(ltcInput)
  ltcInputRef.current = ltcInput
  const fpsRef = useRef(fps)
  fpsRef.current = fps
  const freewheelRef = useRef(show.clock.freewheelFrames ?? 5)
  freewheelRef.current = show.clock.freewheelFrames ?? 5
  const ltcGenRef = useRef(0)

  useEffect(() => {
    const decoder = ltcDecoderRef.current
    const gen = ++ltcGenRef.current
    if (REMOTE) return   // the app on the computer decodes LTC
    if (!ltcShouldRun) {
      decoder.stop().then(() => { if (ltcGenRef.current === gen) { setLtcActive(false); setLtcOutside(false); api.sendLtcStop() } })
      return
    }
    // "LTC live" means frames are arriving. When they stop for longer than the freewheel
    // window, the indicator goes off and the transport stops at the last frame.
    let lostTimer: ReturnType<typeof setTimeout> | undefined
    let outsideFor: string | null = null     // active timeline we already stopped as "not here"
    let followedTo: string | null = null, followedAt = 0
    decoder.onFrame = (_abs, hh, mm, ss, ff) => {
      const pad = (n: number) => String(n).padStart(2, '0')
      setLtcRawTC(`${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`)
      setLtcActive(true)
      const f = fpsRef.current
      const ltcFps = f > 30 ? f / 2 : f
      const active = activeIdRef.current
      const tcSec = hh * 3600 + mm * 60 + ss + ff / ltcFps
      const owner = ltcOwner(rundownRef.current, tcSec, ltcInputRef.current, active)
      // Arena recording armed on an LTC timeline: start the recorder just ahead of its start TC
      // (Arena needs ~40 ms), so the take begins on the timeline's first frame
      const rec = arenaRecRef.current
      const sh = showRef.current
      if (rec.armed && rec.state === 'idle' && isLtcSource(sh.clock.source)) {
        const startSec = smpteToFrames(sh.clock.offset || '00:00:00:00', sh.frameRate) / sh.frameRate
        const dt = startSec - tcSec
        if (dt > 0 && dt <= 1) {
          setArenaRec({ state: 'starting' })
          setTimeout(() => { beginArenaRecordingRef.current() }, Math.max(0, dt * 1000 - ARENA_REC_LATENCY_MS))
        }
      }
      // One switch request per owner while the active id catches up (it updates a render
      // later); after that, request again (the operator may have picked another timeline)
      const now = performance.now()
      if (owner && owner !== active && followTcRef.current && (owner !== followedTo || now - followedAt > 1000)) {
        followedTo = owner; followedAt = now
        selectEntryRef.current(owner)
      }
      if (owner && owner === active) {
        outsideFor = null
        api.sendLtcFrame(ltcToFrames(hh, mm, ss, ff, f))
      } else if (outsideFor !== active) {
        // Not this timeline's timecode: it must not run (once per selected timeline)
        outsideFor = active
        api.sendLtcStop()
      }
      setLtcOutside(owner !== active)
      clearTimeout(lostTimer)
      const lostAfterMs = Math.max(400, (freewheelRef.current + 3) / f * 1000)
      lostTimer = setTimeout(() => { setLtcActive(false); setLtcOutside(false); api.sendLtcStop() }, lostAfterMs)
    }
    decoder.onError = (err) => console.error('[LTC]', err)
    decoder.start(ltcDeviceId || undefined, ltcChannelIdx, fpsRef.current)
    return () => {
      clearTimeout(lostTimer)
      // A newer run of this effect owns the state by the time the old decoder has stopped
      decoder.stop().then(() => { if (ltcGenRef.current === gen) { setLtcActive(false); setLtcOutside(false); api.sendLtcStop() } })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ltcShouldRun, ltcDeviceId, ltcChannelIdx])

  // ── Snap to grid (per show, like rulerMode) ────────────────────────────────

  // The stored grid is kept as is: a musical grid survives removing and re-setting the BPM
  const setSnap = useCallback((patch: { on?: boolean; grid?: SnapGrid }) => {
    syncShow(prev => ({ ...prev, snap: { on: snapOf(prev).on, grid: prev.snap?.grid ?? 'auto', ...patch } }))
  }, [setShow])
  const toggleSnapRef = useRef(() => {})
  toggleSnapRef.current = () => {
    if (activeShowEntry) syncShow(prev => ({ ...prev, snap: { on: !snapOf(prev).on, grid: prev.snap?.grid ?? 'auto' } }))
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘S / Ctrl+S: save the showfile, from anywhere
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        saveRef.current()
        return
      }
      // Text fields keep their keys; sliders and checkboxes don't (Home/Space on a focused
      // fader would move it to its minimum and auto-key that as a keyframe)
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.target instanceof HTMLInputElement && !['range', 'checkbox'].includes(e.target.type)) return
      // ⌘Z / ⌘⇧Z: undo / redo the timeline edits (text fields keep their own undo)
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !e.altKey) {
        e.preventDefault()
        if (!showModeRef.current) undoRef.current(e.shiftKey)
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        // Auto-repeat of a held key is not a second press (it would confirm the SHOW stop)
        if (e.repeat) return
        if (engineRef.current.playing) {
          stopRef.current()
        } else {
          playRef.current()
        }
      }
      if (e.code === 'Home' && showLockedRef()) { e.preventDefault(); return }
      if (e.code === 'Home') { e.preventDefault(); api.locate(0); setScrollFrame(0); autoScrollRef.current = true
        if (engineRef.current.playing && audioLoadedRef.current) audioEngineRef.current.play(0)
        else audioEngineRef.current.stop()
      }
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        if (!e.repeat) goRef.current(1)
      }
      // N: snap to grid on / off (as in DaVinci Resolve); an edit setting, so not in SHOW mode
      if (e.code === 'KeyN' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && !showModeRef.current) {
        e.preventDefault()
        toggleSnapRef.current()
      }
      // Delete / Backspace on clips: the timeline canvas deletes its clip selection
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Transport ──────────────────────────────────────────────────────────────

  const handlePlay = useCallback(() => {
    if (arenaRecRef.current.armed && arenaRecRef.current.state === 'idle' && !isLtcSource(showRef.current.clock.source)) {
      startAlignedRecording()
      return
    }
    api.play()
    if (audioLoadedRef.current) audioEngineRef.current.play(frameStore.get())
  }, [])
  const playRef = useRef(handlePlay)
  playRef.current = handlePlay

  // ── Arena recording (Arena's Record button, over OSC) ───────────────────────
  // Armed + Play: the timeline goes to its start, Arena starts recording, and the timeline
  // starts the moment Arena has created the file (~40 ms) — so the recording's first frame is
  // the timeline start. With LTC the command is sent just before the start TC instead.
  // Recording stops at the timeline end or on Stop, then the arm is released (one take).
  type ArenaRec = { armed: boolean; state: 'idle' | 'starting' | 'recording'; file: string | null; error: string | null }
  const [arenaRec, setArenaRecState] = useState<ArenaRec>({ armed: false, state: 'idle', file: null, error: null })
  const arenaRecRef = useRef(arenaRec)
  const setArenaRec = useCallback((patch: Partial<ArenaRec>) => {
    arenaRecRef.current = { ...arenaRecRef.current, ...patch }
    setArenaRecState(arenaRecRef.current)
  }, [])
  const recSeenPlayingRef = useRef(false)
  const beginArenaRecordingRef = useRef<() => Promise<boolean>>(async () => false)

  const beginArenaRecording = useCallback(async (): Promise<boolean> => {
    setArenaRec({ state: 'starting', error: null })
    recSeenPlayingRef.current = false
    const r = await api.recordStart()
    if (!r?.ok) {
      // No file within 1.5 s: don't run a take that may not be recording (or is misaligned)
      api.recordStop()
      setArenaRec({ state: 'idle', error: `Arena did not start recording (watched ${r?.dir ?? 'the recordings folder'}). Check Arena's Record panel.` })
      return false
    }
    setArenaRec({ state: 'recording', file: r.file })
    return true
  }, [setArenaRec])

  beginArenaRecordingRef.current = beginArenaRecording

  const startAlignedRecording = useCallback(async () => {
    api.stop(); audioEngineRef.current.stop()
    api.locate(0); setScrollFrame(0); autoScrollRef.current = true
    if (!(await beginArenaRecording())) return
    api.play()
    if (audioLoadedRef.current) audioEngineRef.current.play(0)
  }, [beginArenaRecording])

  const stopArenaRecording = useCallback(() => {
    if (arenaRecRef.current.state === 'idle') return
    api.recordStop()
    setArenaRec({ state: 'idle', armed: false })
  }, [setArenaRec])

  const handleStop = useCallback(() => {
    api.stop(); autoScrollRef.current = true; audioEngineRef.current.stop()
  }, [])

  // SHOW mode while playing: stopping takes a second press within STOP_CONFIRM_MS (a stray
  // Space must not stop a running show) and the playhead can't be moved by clicks
  // The same confirmation guards switching timelines from the rundown while the show runs
  const [stopArmed, setStopArmed] = useState<string | null>(null)   // 'stop' or the entry id clicked
  const stopArmedRef = useRef<string | null>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disarm = useCallback(() => {
    clearTimeout(stopTimerRef.current)
    stopArmedRef.current = null; setStopArmed(null)
  }, [])
  /** SHOW mode while playing: true the first time (armed, do nothing), true again only after
   *  the confirmation window; false = go ahead. */
  const needsConfirm = useCallback((what: string) => {
    if (!showModeRef.current || !engineRef.current.playing || stopArmedRef.current === what) { disarm(); return false }
    clearTimeout(stopTimerRef.current)
    stopArmedRef.current = what; setStopArmed(what)
    stopTimerRef.current = setTimeout(disarm, STOP_CONFIRM_MS)
    return true
  }, [disarm])
  const requestStop = useCallback(() => {
    if (needsConfirm('stop')) return
    handleStop()
  }, [handleStop, needsConfirm])
  // A transport that stopped or started by itself (LTC lost / back) drops a pending confirmation
  useEffect(() => { disarm() }, [engineState.playing, disarm])
  useEffect(() => () => clearTimeout(stopTimerRef.current), [])
  const stopRef = useRef(requestStop)
  stopRef.current = requestStop

  const handleLocate = useCallback((frame: number) => {
    if (showLockedRef()) return
    api.locate(frame); setScrollFrame(Math.max(0, frame - 50))
    if (engineRef.current.playing && audioLoadedRef.current) audioEngineRef.current.play(frame)
    else audioEngineRef.current.stop()
  }, [])

  const handleSeek = useCallback((frame: number) => {
    if (showLockedRef()) return
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
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
  }, [rundown.length])

  // Import a timeline exported as a file: it becomes part of this showfile
  const handleImportTimeline = useCallback(async () => {
    if (REMOTE) return   // files live on the computer running the app
    const result = await api.openShowFile()
    if (!result) return
    const idx = rundown.length
    const entry = makeShowEntry(result.show, null, idx)
    setRundown(prev => [...prev, entry])
    setActiveId(entry.id)
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
  }, [rundown.length])

  const handleAddBreak = useCallback(() => {
    const entry = makeBreakEntry()
    setRundown(prev => [...prev, entry])
  }, [])

  const rundownRef = useRef(rundown)
  rundownRef.current = rundown
  const handleSelectEntry = useCallback((id: string) => {
    if (id === activeId) return
    // The new timeline starts at 0, stopped. An LTC timeline runs as soon as its own
    // timecode arrives (never on the internal clock from the old timeline's position).
    api.stop(); api.locate(0); audioEngineRef.current.stop()
    setActiveId(id)
    clearSelection(); setScrollFrame(0)
    autoScrollRef.current = true
  }, [activeId])

  // GO: step through the rundown. Ignores repeats within 300 ms so a double press
  // cannot skip an entry.
  const selectEntryRef = useRef(handleSelectEntry)
  selectEntryRef.current = handleSelectEntry
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
  }, [rundown, clearSelection])

  const handleReorder = useCallback((newOrder: RundownEntry[]) => {
    setRundown(newOrder)
  }, [])

  const handleEditEntry = useCallback((id: string, updates: Partial<Pick<BreakEntry, 'color' | 'notes' | 'label' | 'duration'>> & {
    name?: string; clock?: { source: Show['clock']['source']; offset: string }
    tempo?: Pick<Show, 'bpm' | 'beatsPerBar' | 'downbeat'>   // undefined fields = none / default
  }) => {
    setRundown(prev => prev.map(e => {
      if (e.id !== id) return e
      if (e.type === 'show') {
        const renamed = updates.name !== undefined && updates.name !== e.show.name
        const reclocked = !!updates.clock && (updates.clock.source !== e.show.clock.source || updates.clock.offset !== e.show.clock.offset)
        const t = updates.tempo
        const retimed = !!t && (t.bpm !== e.show.bpm || (t.beatsPerBar ?? 4) !== (e.show.beatsPerBar ?? 4)
          || (t.downbeat || '00:00:00:00') !== (e.show.downbeat || '00:00:00:00'))
        const show = renamed || reclocked || retimed ? {
          ...e.show,
          ...(renamed ? { name: updates.name! } : {}),
          ...(reclocked ? { clock: { ...e.show.clock, ...updates.clock } } : {}),
          ...(retimed ? { bpm: t!.bpm, beatsPerBar: t!.beatsPerBar, downbeat: t!.downbeat } : {}),
        } : e.show
        return {
          ...e, color: updates.color ?? e.color, notes: updates.notes ?? e.notes,
          ...(show !== e.show ? { show, dirty: true } : {}),
        }
      }
      return { ...e, ...updates }
    }))
  }, [])

  // Export the active timeline as its own file (a copy; the showfile keeps it too)
  const handleExportTimeline = useCallback(async () => {
    if (REMOTE || !activeShowEntry) return   // files live on the computer running the app
    await api.saveShow(activeShowEntry.show)
  }, [activeShowEntry])

  const handleOpenShowfile = useCallback(async () => {
    if (REMOTE) return
    const result = await api.showfileOpen()
    if (!result) return
    if (!isShowfile(result.data)) { setShowfileError('That file is not a showfile.'); return }
    const d: ShowfileData = result.data
    const entries = d.entries.map(e => e.type === 'show' ? { ...e, filePath: null, dirty: false } : e)
    api.stop(); audioEngineRef.current.stop()
    clearSelection(); setScrollFrame(0)
    const active = entries.some(e => e.id === d.activeId) ? d.activeId : entries[0].id
    // A converted .concert.json (or a file picked in a browser) has no showfile path yet:
    // it is saved as a new showfile, the file it came from stays untouched
    savedKeyRef.current = result.path ? showfileKey(d.name, entries) : ''
    activeIdRef.current = active
    setRundown(entries); setActiveId(active)
    setShowfile({ name: d.name, path: result.path, autosave: d.autosave !== false })
    setShowfileDirty(!result.path)
    setShowfileError(null); setRestoredAt(null)
  }, [clearSelection])

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
    if (REMOTE) return   // files live on the computer running the app
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
    // A tablet doesn't play the audio track: no need to pull the whole file over Wi-Fi
    if (!wantedAudioPath || REMOTE) return
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
      audioEngineRef.current.play(frameStore.get())
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

  // Deleting a clip deletes the lanes bound to it (they can't play without it)
  const handleDeleteCues = useCallback((cueIds: string[]) => {
    const gone = new Set(cueIds)
    setShow(prev => ({
      ...prev,
      tracks: prev.tracks.map(t => {
        if (t.type !== 'layer') return t
        const lt = t as LayerTrack
        if (!lt.clips.some(c => gone.has(c.id))) return t
        return {
          ...lt,
          clips: lt.clips.filter(c => !gone.has(c.id)),
          automations: lt.automations.filter(a => !(a.clipId && gone.has(a.clipId) && !a.layerBound)),
        }
      }),
    }))
    setSelection(sel => (sel.cueId && gone.has(sel.cueId) ? { ...sel, cueId: null } : sel))
  }, [setShow])

  // Selection edits from the timeline (move, copy, paste, delete, split…): one change
  const handleEditTracks = useCallback((edit: (tracks: Track[]) => Track[]) => {
    setShow(prev => {
      const tracks = edit(prev.tracks)
      return tracks === prev.tracks ? prev : { ...prev, tracks }
    })
  }, [setShow])

  const handleDeleteCue = useCallback((trackIdx: number, cueIdx: number) => {
    const id = (showRef.current.tracks[trackIdx] as LayerTrack | undefined)?.clips?.[cueIdx]?.id
    if (id) handleDeleteCues([id])
  }, [handleDeleteCues])

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

  // ── Clip automation templates (clip right-click) ─────────────────────────────
  // Resolume JSON of a cue's clip: the live composition, else the last copy seen (clips of a
  // deck Resolume isn't showing). null = Resolume hasn't shown this clip.
  const clipJsonOf = useCallback((lt: LayerTrack | undefined, cue: ClipCue | undefined): any => {
    if (lt?.type !== 'layer' || !cue) return null
    const layer = composition?.layers?.find(l => l?.id === lt.resolumeLayerId) as any
    return (layer?.clips ?? []).find((c: any) => c?.id === cue.clipId) ?? knownClip(cue.clipId)
  }, [composition])

  const clipOpacityInfo = useCallback((trackIdx: number, cueIdx: number): ParamInfo | null => {
    const lt = showRef.current.tracks[trackIdx] as LayerTrack | undefined
    const cue = lt?.clips?.[cueIdx]
    const json = clipJsonOf(lt, cue)
    return json && cue
      ? resolveRef(json, { scope: 'clip', clipId: cue.clipId, path: CLIP_OPACITY_PATH, label: 'Opacity' })
      : null
  }, [clipJsonOf])

  /** Why the opacity fade can't be made for a cue (menu tooltip), or null when it can. */
  const clipFadeUnavailable = useCallback((trackIdx: number, cueIdx: number): string | null => {
    const lt = showRef.current.tracks[trackIdx] as LayerTrack | undefined
    const cue = lt?.clips?.[cueIdx]
    if (!cue) return 'No clip'
    if (clipOpacityInfo(trackIdx, cueIdx)) return null
    if (clipJsonOf(lt, cue)) return 'This clip has no video opacity parameter'
    return composition
      ? 'Clip is not in the deck Resolume is showing: show its deck in Resolume once, then try again'
      : 'Resolume is offline: the clip\'s opacity parameter can\'t be read'
  }, [clipOpacityInfo, clipJsonOf, composition])

  // Fade in / out on the clip's video opacity: a clip lane bound to the cue (reused when the
  // cue already has one), keyframes inside the fade ranges replaced, others kept
  const handleClipFade = useCallback((trackIdx: number, cueIdx: number, mode: 'in' | 'out' | 'inout', seconds: number) => {
    if (showModeRef.current) return
    const info = clipOpacityInfo(trackIdx, cueIdx)
    if (!info) return
    setShow(prev => {
      const tracks = [...prev.tracks]
      const lt = tracks[trackIdx] as LayerTrack
      const cue = lt?.type === 'layer' && !lt.locked ? lt.clips[cueIdx] : undefined
      if (!cue) return prev
      const fps = prev.frameRate
      const s = smpteToFrames(cue.time, fps), dur = smpteToFrames(cue.duration, fps), e = s + dur
      if (mode !== 'in' && dur <= 0) return prev  // trigger-only cue: no end to fade out to
      const maxLen = dur > 0 ? (mode === 'inout' ? Math.floor(dur / 2) : dur) : Infinity
      const len = Math.max(1, Math.min(Math.round(seconds * fps), maxLen))
      const keys: CueKey[] = [], ranges: [number, number][] = []
      if (mode !== 'out') {
        ranges.push([s, s + len])
        keys.push({ frame: s, value: 0, ease: 'sineInOut' }, { frame: s + len, value: 1, ease: 'linear' })
      }
      if (mode !== 'in') {
        ranges.push([e - len, e])
        keys.push({ frame: e - len, value: 1, ease: 'sineInOut' }, { frame: e, value: 0, ease: 'linear' })
        // A lane sends nothing before its first key: without a start key a clip faded out
        // once (opacity left at 0 in Resolume) would play black until the fade on the next run
        const existing = lt.automations.find(a => a.clipId === cue.id && !a.layerBound && sameRef(a.ref, info.ref))
        const hasEarlier = existing?.keyframes.some(k => { const f = smpteToFrames(k.time, fps); return f >= s && f < e - len })
        if (mode === 'out' && !hasEarlier && e - len > s) { ranges.push([s, s]); keys.push({ frame: s, value: 1, ease: 'linear' }) }
      }
      const fresh = (): AutomationSubTrack => {
        const palette = SCOPE_COLORS.clip
        const sameScope = lt.automations.filter(a => (a.ref?.scope ?? 'layer') === 'clip').length
        return {
          id: `auto-${Date.now()}-${uid++}`, keyframes: [], enabled: true,
          color: palette[sameScope % palette.length], clipId: cue.id,
          ...laneFieldsFor(info, lt.resolumeLayerIndex, cue.clipIndex),
        } as AutomationSubTrack
      }
      tracks[trackIdx] = mergeCueLane(lt, cue, info.ref, fresh, keys, ranges, fps)
      return { ...prev, tracks }
    })
  }, [clipOpacityInfo, setShow])

  // Copy / paste every lane bound to a cue, keyframes relative to the cue start
  const clipAutoClipboardRef = useRef<ClipAutoClipboard | null>(null)
  const [canPasteClipAutomation, setCanPasteClipAutomation] = useState(false)

  const handleCopyClipAutomation = useCallback((trackIdx: number, cueIdx: number) => {
    const cur = showRef.current
    const lt = cur.tracks[trackIdx] as LayerTrack | undefined
    const cue = lt?.type === 'layer' ? lt.clips[cueIdx] : undefined
    if (!lt || !cue) return
    const fps = cur.frameRate, s = smpteToFrames(cue.time, fps)
    const lanes = lt.automations.filter(a => a.clipId === cue.id && !a.layerBound).map(lane => ({
      lane,
      keys: lane.keyframes.map(k => ({
        offset: smpteToFrames(k.time, fps) - s, value: k.value, ease: k.ease,
        ...(k.option !== undefined ? { option: k.option } : {}),
      })),
    }))
    clipAutoClipboardRef.current = lanes.length ? { fps, layerId: lt.resolumeLayerId, cueName: cue.clipName, lanes } : null
    setCanPasteClipAutomation(lanes.length > 0)
    console.info(`[clip automation] copied ${lanes.length} lane(s) from "${cue.clipName}"`)
  }, [])

  const handlePasteClipAutomation = useCallback((trackIdx: number, cueIdx: number) => {
    const clip = clipAutoClipboardRef.current
    if (showModeRef.current || !clip) return
    const cur = showRef.current
    const lt = cur.tracks[trackIdx] as LayerTrack | undefined
    const cue = lt?.type === 'layer' && !lt.locked ? lt.clips[cueIdx] : undefined
    if (!lt || !cue) return
    const fps = cur.frameRate, start = smpteToFrames(cue.time, fps)
    const sameLayer = lt.resolumeLayerId === clip.layerId
    const clipJson = clipJsonOf(lt, cue)
    const layerJson = composition?.layers?.find(l => l?.id === lt.resolumeLayerId)
    const skipped: string[] = []
    const plan: { lane: AutomationSubTrack; ref: ParamRef; fields: Partial<AutomationSubTrack>; keys: CueKey[] }[] = []
    for (const { lane, keys } of clip.lanes) {
      const ref = lane.ref
      const label = ref?.label ?? lane.name
      let fields: Partial<AutomationSubTrack>
      if (!ref || ref.scope === 'group') { skipped.push(`${label} (no parameter reference)`); continue }
      if (ref.scope === 'clip') {
        // Re-point at the target clip; resolve there when Resolume has shown it
        const target: ParamRef = { ...ref, clipId: cue.clipId }
        if (clipJson) {
          const info = resolveRef(clipJson, target)
          if (!info) { skipped.push(`${label} (not on clip "${cue.clipName}")`); continue }
          fields = laneFieldsFor(info, lt.resolumeLayerIndex, cue.clipIndex)
        } else {
          fields = { ref: target, target: oscAddress(target, lt.resolumeLayerIndex, cue.clipIndex) }
        }
      } else if (sameLayer) {
        fields = {}
      } else {
        // Layer parameter following the cue, pasted onto another layer: same path there
        const info = layerJson ? resolveRef(layerJson, ref) : null
        if (!info) { skipped.push(`${label} (not on layer "${lt.name}"${layerJson ? '' : ', Resolume offline'})`); continue }
        fields = laneFieldsFor(info, lt.resolumeLayerIndex)
      }
      plan.push({
        lane, ref: fields.ref ?? ref, fields,
        keys: keys.map(k => ({ ...k, frame: start + Math.round(k.offset * fps / clip.fps) })).filter(k => k.frame >= 0),
      })
    }
    if (plan.length) setShow(prev => {
      const tracks = [...prev.tracks]
      let t = tracks[trackIdx] as LayerTrack
      const target = t?.type === 'layer' ? t.clips.find(c => c.id === cue.id) : undefined
      if (!target) return prev
      for (const p of plan) {
        const frames = p.keys.map(k => k.frame)
        const ranges: [number, number][] = frames.length ? [[Math.min(...frames), Math.max(...frames)]] : []
        const fresh = (): AutomationSubTrack => ({
          ...p.lane, ...p.fields, id: `auto-${Date.now()}-${uid++}`, keyframes: [],
          clipId: target.id, layerBound: undefined, visible: undefined, paramId: undefined,
        })
        t = mergeCueLane(t, target, p.ref, fresh, p.keys, ranges, prev.frameRate)
      }
      tracks[trackIdx] = t
      return { ...prev, tracks }
    })
    console.info(`[clip automation] pasted ${plan.length} lane(s) from "${clip.cueName}" onto "${cue.clipName}"`
      + (skipped.length ? `; skipped ${skipped.length}: ${skipped.join(', ')}` : ''))
  }, [clipJsonOf, composition, setShow])

  // ── One lane copied whole (lane header right-click › Copy lane) ──
  // Pasted onto a layer / group: the same parameter there, at the same times. Onto a clip: the
  // same parameter following that clip, from its start. Onto another lane: its curve.
  const laneClipboardRef = useRef<{ lane: AutomationSubTrack; keys: CueKey[]; start: number | null } | null>(null)
  const [laneClipboard, setLaneClipboard] = useState<string | null>(null)

  const handleCopyLane = useCallback((trackIdx: number, autoIdx: number) => {
    const cur = showRef.current
    const t = cur.tracks[trackIdx] as LayerTrack | undefined
    const lane = t?.automations?.[autoIdx]
    if (!lane) return
    const fr = cur.frameRate
    // A lane that follows a clip keeps its timing relative to the clip
    const cue = lane.clipId && !lane.layerBound ? t!.clips?.find(c => c.id === lane.clipId) : undefined
    laneClipboardRef.current = {
      lane,
      keys: lane.keyframes.map(k => ({ frame: smpteToFrames(k.time, fr), value: k.value, ease: k.ease, ...(k.option !== undefined ? { option: k.option } : {}) })),
      start: cue ? smpteToFrames(cue.time, fr) : null,
    }
    setLaneClipboard(lane.ref?.label ?? lane.name)
  }, [])

  const handlePasteLane = useCallback((trackIdx: number, cueIdx?: number) => {
    const cb = laneClipboardRef.current
    if (showModeRef.current || !cb) return
    const cur = showRef.current
    const fr = cur.frameRate
    const t = cur.tracks[trackIdx] as LayerTrack | GroupTrack | undefined
    if (!t || (t.type !== 'layer' && t.type !== 'group') || t.locked) return
    const ref = cb.lane.ref
    if (!ref) { console.warn('[lane paste] the lane has no parameter reference'); return }
    const isGroup = t.type === 'group'
    if ((ref.scope === 'group') !== isGroup) { console.warn('[lane paste] group parameters go onto groups, layer and clip parameters onto layers'); return }
    const lt = t as LayerTrack
    const cue = cueIdx != null && !isGroup ? lt.clips[cueIdx] : undefined
    if (ref.scope === 'clip' && !cue) { console.warn('[lane paste] a clip parameter needs a clip: right-click a clip › Paste lane'); return }
    const index = isGroup ? (t as GroupTrack).resolumeGroupIndex : lt.resolumeLayerIndex
    // The same parameter on the target, resolved now when Resolume shows it (else on the next sync)
    let target: ParamRef = ref
    let json: any = null
    if (ref.scope === 'clip' && cue) { target = { ...ref, clipId: cue.clipId }; json = clipJsonOf(lt, cue) }
    else if (isGroup) json = composition?.layergroups?.[index - 1]
    else json = composition?.layers?.find(l => l?.id === lt.resolumeLayerId)
    const info = json ? resolveRef(json, target) : null
    if (json && !info) { console.warn(`[lane paste] ${ref.label} is not on ${cue ? `clip "${cue.clipName}"` : `"${t.name}"`}`); return }
    const fields: Partial<AutomationSubTrack> = info
      ? laneFieldsFor(info, index, cue?.clipIndex)
      : { ref: target, target: oscAddress(target, index, cue?.clipIndex) }
    const shift = cue ? smpteToFrames(cue.time, fr) - (cb.start ?? Math.min(...cb.keys.map(k => k.frame))) : 0
    const keys = cb.keys.map(k => ({ ...k, frame: k.frame + shift })).filter(k => k.frame >= 0)
    const frames = keys.map(k => k.frame)
    const ranges: [number, number][] = frames.length ? [[Math.min(...frames), Math.max(...frames)]] : []
    const fresh = (): AutomationSubTrack => ({
      ...cb.lane, ...fields, id: `auto-${Date.now()}-${uid++}`, keyframes: [], visible: undefined, paramId: undefined,
      ...(cue ? { clipId: cue.id, layerBound: undefined } : { clipId: undefined, layerBound: true }),
    })
    setShow(prev => {
      const tracks = [...prev.tracks]
      const cur = tracks[trackIdx] as LayerTrack
      if (!cur || cur.id !== t.id) return prev
      if (cue) {
        const c = cur.clips.find(x => x.id === cue.id)
        if (!c) return prev
        tracks[trackIdx] = mergeCueLane(cur, c, fields.ref ?? target, fresh, keys, ranges, fr)
      } else {
        // Onto a layer / group: the lane fixed on the timeline with this parameter (its keys in
        // the pasted range are replaced), or a new one
        const idx = cur.automations.findIndex(a => sameRef(a.ref, fields.ref ?? target) && a.layerBound)
        const base = idx >= 0 ? cur.automations[idx] : fresh()
        const inRange = (f: number) => ranges.some(([a, b]) => f >= a && f <= b)
        const byTime = new Map<string, Keyframe>()
        for (const k of base.keyframes) if (!inRange(smpteToFrames(k.time, fr))) byTime.set(k.time, k)
        for (const k of keys) {
          const time = framesToSmpte(k.frame, fr)
          byTime.set(time, { time, value: k.value, ease: k.ease, ...(k.option !== undefined ? { option: k.option } : {}) })
        }
        const lane = { ...base, keyframes: [...byTime.values()].sort((a, b) => smpteToFrames(a.time, fr) - smpteToFrames(b.time, fr)), ...(base.visible === false ? { visible: true } : {}) }
        tracks[trackIdx] = { ...cur, expanded: true, automations: idx >= 0 ? cur.automations.map((a, i) => (i === idx ? lane : a)) : [...cur.automations, lane] }
      }
      return { ...prev, tracks }
    })
  }, [clipJsonOf, composition, setShow])

  // The copied lane's curve onto another lane (any parameter), at the same times
  const handlePasteCurve = useCallback((trackIdx: number, autoIdx: number) => {
    const cb = laneClipboardRef.current
    if (showModeRef.current || !cb) return
    const lane = (showRef.current.tracks[trackIdx] as LayerTrack | undefined)?.automations?.[autoIdx]
    if (!lane || !cb.keys.length) return
    const at = Math.min(...cb.keys.map(k => k.frame))
    const opts = laneStatus[lane.id]?.info?.options ?? lane.options ?? []
    const items = convertItems(cb.keys.map(k => ({ offsetFrames: k.frame - at, value: k.value, ease: k.ease, ...(k.option !== undefined ? { option: k.option } : {}) })),
      cb.lane.kind ?? 'range', lane.kind ?? 'range', opts)
    handlePasteKeyframes(trackIdx, autoIdx, at, items)
  }, [laneStatus])   // eslint-disable-line react-hooks/exhaustive-deps

  // ◇/◆ in the inspector (After Effects stopwatch + Resolve keyframe button): start
  // animating with a keyframe at the playhead, or toggle the keyframe at the playhead
  const handleToggleKey = useCallback((trackIdx: number, info: ParamInfo, real: number | string | boolean, binding: 'layer' | { cueId: string }) => {
    const lt = showRef.current.tracks[trackIdx] as LayerTrack
    const frame = frameStore.get()
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
    handleAddKeyframe(trackIdx, autoIdx, frameStore.get(), normalize(info, real),
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
    handleAddKeyframe(trackIdx, autoIdx, frameStore.get(), v, info.kind === 'choice' ? String(p.value) : undefined)
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
  const endFrame = useMemo(() => {
    let end = 0
    for (const t of show.tracks) {
      if (t.type !== 'layer') continue
      for (const c of (t as LayerTrack).clips)
        end = Math.max(end, smpteToFrames(c.time, fps) + smpteToFrames(c.duration, fps))
    }
    if (audioLoaded && show.audioTrack)
      end = Math.max(end, smpteToFrames(show.audioTrack.startOffset, fps) + Math.round(audioEngineRef.current.duration * fps))
    return end
  }, [show.tracks, show.audioTrack, audioLoaded, waveformInfo, fps])  // waveformInfo: a new audio file

  // End of the take: the timeline end, or the transport stopped (Stop, LTC gone)
  useEffect(() => {
    if (arenaRec.state !== 'recording') return
    const check = () => {
      if (engineState.playing) { recSeenPlayingRef.current = true }
      const atEnd = endFrame > 0 && frameStore.get() >= endFrame
      if (atEnd || (recSeenPlayingRef.current && !engineState.playing)) stopArenaRecording()
    }
    check()
    return frameStore.subscribe(check)
  }, [engineState.playing, arenaRec.state, endFrame, stopArenaRecording])


  const editingEntry = editingEntryId ? rundown.find(e => e.id === editingEntryId) ?? null : null

  return (
    <div className={`app${showMode ? ' show-mode' : ''}${recordArmed && !showMode ? ' rec-armed' : ''}`}>
      <RundownStrip
        rundown={rundown}
        activeId={activeId}
        playing={engineState.playing}
        endFrame={endFrame} fps={fps}
        showMode={showMode}
        showfileName={showfileName}
        showfilePath={showfile.path}
        showfileDirty={showfileDirty}
        autosave={showfile.autosave}
        savedAt={showfileSavedAt}
        saveError={showfileError}
        resolumeConnected={engineState.resolumeConnected}
        resolumeHost={show.resolume.host}
        currentDeck={selectedDeck ? { index: selectedDeck.index, name: selectedDeck.name, color: selectedDeck.color, count: decks.length } : null}
        onSelect={id => { if (id !== activeId && !needsConfirm(id)) handleSelectEntry(id) }}
        confirmEntryId={stopArmed && stopArmed !== 'stop' ? stopArmed : null}
        onGo={handleGo}
        onReorder={handleReorder}
        onAddShow={handleAddShow}
        onAddBreak={handleAddBreak}
        onEdit={setEditingEntryId}
        onDelete={handleDeleteEntry}
        onNewShowfile={handleNewShowfile}
        onOpenShowfile={handleOpenShowfile}
        onSaveShowfile={handleSaveShowfile}
        onSaveShowfileAs={api.__web ? null : handleSaveShowfileAs}
        onRenameShowfile={handleRenameShowfile}
        onToggleAutosave={handleToggleAutosave}
        onImportTimeline={handleImportTimeline}
        onExportTimeline={handleExportTimeline}
        onSettings={() => setShowSettings(true)}
        onToggleShowMode={() => setShowMode(m => !m)}
        onReconnect={handleReconnect}
      />

      {(restoredAt || autosaveFailed) && (
        <div className={`notice-bar ${autosaveFailed ? 'warn' : ''}`}>
          {autosaveFailed
            ? <span>Autosave failed (not enough storage). Save the timeline manually.</span>
            : <span>Restored unsaved changes from the last session ({new Date(restoredAt!).toLocaleString('en-GB')}). Autosave is off: save with ⌘S.</span>}
          {restoredAt && !autosaveFailed && (
            <button className="btn-sm" onClick={handleNewShowfile}>New showfile</button>
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
        ltcOutside={ltcOutside}
        ltcRawTC={ltcRawTC}
        followTc={followTc}
        onToggleFollowTc={() => setFollowTc(f => !f)}
        anyLtcTimeline={ltcShouldRun}
        recordArmed={recordArmed}
        onToggleRecord={() => setRecordArmed(r => !r)}
        arenaRec={arenaRec}
        onToggleArenaRec={() => {
          if (arenaRecRef.current.state !== 'idle') { stopArenaRecording(); api.stop(); audioEngineRef.current.stop(); return }
          setArenaRec({ armed: !arenaRecRef.current.armed, error: null })
        }}
        overrideCount={Object.keys(overrides).length}
        onReenable={() => handleReenable()}
        readOnly={showMode}
        onPlay={handlePlay}
        onStop={requestStop}
        stopArmed={stopArmed === 'stop'}
        onLocate={handleLocate}
        onToggleBrowser={() => setShowBrowser(b => !b)}
        browserOpen={showBrowser}
        onSetBpm={bpm => setShow(prev => ({ ...prev, bpm }))}
        arenaBpm={arenaTempo ? arenaTempo.value : null}
        onToggleLinkTempo={() => setShow(prev => ({ ...prev, linkTempo: prev.linkTempo === false ? undefined : false }))}
        onPushTempo={() => { if (arenaTempo && show.bpm) api.setParamById(arenaTempo.id, show.bpm) }}
        snap={snap}
        snapAuto={formatSnapStep(gridSnapOf({ on: true, grid: 'auto' }, tempo, rulerMode, pxPerFrame, fps)!, fps)}
        onSetSnap={setSnap}
        lockEnvelopes={!!show.lockEnvelopes}
        onToggleLockEnvelopes={() => syncShow(prev => ({ ...prev, lockEnvelopes: prev.lockEnvelopes ? undefined : true }))}
      />

      <HealthBar
        active={showMode || engineState.playing}
        resolumeConnected={engineState.resolumeConnected}
        ltcSelected={!REMOTE && isLtcSource(show.clock.source)}
        ltcActive={ltcActive}
        ltcNotHere={ltcOutside && isLtcSource(show.clock.source)
          ? `incoming ${ltcRawTC} is outside this timeline (starts at ${show.clock.offset || '00:00:00:00'})${followTc ? '' : ' — Follow TC is off'}` : null}
        brokenLanes={Object.values(laneStatus).filter(st => st.state === 'broken').length}
        manual={manualLanes}
        arenaRec={arenaRec}
        fps={fps}
        onDismissRecError={() => setArenaRec({ error: null })}
        onReenable={handleReenable}
        onReconnect={handleReconnect}
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
          <div className="timeline-column">
          <OverviewBar
            tracks={show.tracks} markers={show.markers} fps={fps} decks={decks}
            endFrame={endFrame} playing={engineState.playing}
            readOnly={showMode} scrollFrame={scrollFrame} pxPerFrame={pxPerFrame}
            onScrollFrame={f => { autoScrollRef.current = false; setScrollFrame(f) }}
              onPxPerFrame={setPxPerFrame} onSeek={handleSeek}
          />
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
              fps={fps}
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
              rulerMode={rulerMode} hasTempo={!!tempo}
              onSetRulerMode={m => syncShow(prev => ({ ...prev, rulerMode: m }))}
              laneClipboard={laneClipboard} onCopyLane={handleCopyLane}
              onPasteLane={ti => handlePasteLane(ti)} onPasteCurve={handlePasteCurve}
            />
            <TimelineCanvas
              tracks={show.tracks} markers={show.markers} fps={fps} tempo={tempo} rulerMode={rulerMode} snap={snap}
              onSetDownbeat={f => setShow(prev => ({ ...prev, downbeat: f > 0 ? framesToSmpte(f, prev.frameRate) : undefined }))}
              readOnly={showMode} laneStatus={laneStatus} overrides={overrides} decks={decks}
              pxPerFrame={pxPerFrame} scrollFrame={scrollFrame}
              draggingClip={draggingClip} autoLaneHeights={autoLaneHeights}
              layerRowHeights={layerRowHeights}
              audioTrack={show.audioTrack}
              audioDuration={audioLoaded ? audioEngineRef.current.duration : 0}
              waveformInfo={waveformInfo}
              scrollY={scrollY} onScrollY={handleScrollY}
              onScrollFrame={setScrollFrame} onSeek={handleSeek}
              onZoom={f => setPxPerFrame(p => Math.max(PPF_MIN, Math.min(PPF_MAX, p * f)))}
              onSelectCue={selectCue}
              onDropClip={handleDropClip} onUpdateCue={handleUpdateCue}
              onEditTracks={handleEditTracks} historyTick={historyTick} lockEnvelopes={!!show.lockEnvelopes} playing={engineState.playing}
              onAddKeyframe={handleAddKeyframe}
              onUpdateKeyframe={handleUpdateKeyframe}
              onDeleteKeyframe={handleDeleteKeyframe}
              onUpdateKeyframes={handleUpdateKeyframes}
              onDeleteKeyframes={handleDeleteKeyframes}
              onClipFade={handleClipFade} clipFadeUnavailable={clipFadeUnavailable}
              onCopyClipAutomation={handleCopyClipAutomation}
              onPasteClipAutomation={handlePasteClipAutomation}
              canPasteClipAutomation={canPasteClipAutomation}
              laneClipboard={laneClipboard} onPasteLaneOnCue={(ti, ci) => handlePasteLane(ti, ci)}
              onResizeAutoLane={handleResizeAutoLane}
              selectedTrackIdx={selectedTrackIdx} selectedCueIdx={selectedCueIdx}
            />
          </div>
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
          isActive={editingEntry.id === activeShowEntry?.id}
          otherTimelines={rundown.filter((e): e is ShowEntry => e.type === 'show' && e.id !== editingEntry.id)
            .map(e => ({ name: e.show.name, source: e.show.clock.source, offset: e.show.clock.offset || '00:00:00:00' }))}
          onClose={() => setEditingEntryId(null)}
        />
      )}
    </div>
  )
}
