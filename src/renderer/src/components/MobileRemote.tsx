import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { frameStore, useFrame } from '../frameStore'
import type { Marker, Track, LayerTrack, GroupTrack, AutomationSubTrack, LaneKind } from '../../../shared/show'
import { frameKeyframes, sampleLane } from '../../../shared/automation'
import { formatValue } from '../../../shared/paramTree'
import type { LaneStatusMap } from '../laneStatus'
import type { RundownEntry } from '../../../shared/concert'
import { framesToSmpte, smpteToFrames } from './timeUtils'
import { beatsToFrame, formatBarBeat, frameToBarBeat, frameToBeats, type Tempo } from '../grid'
import { TOUCH } from '../touch'

// Phone remote: what the app shows on a small portrait screen (the tablet link opened on a
// phone). No timeline, only the show controls: transport, scrubbing, GO and REC ARENA.
// Every button calls the same App handler as the full UI, so SHOW-mode guards apply.

const api = (window as any).timeline

// ── Layout switch ────────────────────────────────────────────────────────────

const PHONE_QUERY = '(orientation: portrait) and (max-width: 600px)'
const VIEW_KEY = 'resolume-timeline:view'
const SIDE_KEY = 'resolume-timeline:show-side'   // show view side panel: rundown / layers
type View = 'remote' | 'full' | 'auto'

// The view chosen on this device (VIEW menu, Setup / Show buttons, or ?view=remote|full|auto)
let chosen: View = (() => {
  const v = new URLSearchParams(location.search).get('view')
  try {
    if (v === 'remote' || v === 'full') localStorage.setItem(VIEW_KEY, v)
    else if (v === 'auto') localStorage.removeItem(VIEW_KEY)
    const kept = localStorage.getItem(VIEW_KEY)
    return kept === 'remote' || kept === 'full' ? kept : 'auto'
  } catch { return v === 'remote' || v === 'full' ? v : 'auto' }
})()
const viewListeners = new Set<() => void>()

/** Show view (remote) or the full editor on this device; 'auto' = by screen. */
export function setAppView(v: View) {
  chosen = v
  try { if (v === 'auto') localStorage.removeItem(VIEW_KEY); else localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ }
  viewListeners.forEach(f => f())
}

const phoneMedia = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null
const subscribePhone = (cb: () => void) => {
  phoneMedia?.addEventListener('change', cb)
  return () => phoneMedia?.removeEventListener('change', cb)
}
const subscribeView = (cb: () => void) => { viewListeners.add(cb); return () => { viewListeners.delete(cb) } }

/** True when the app should show the show view (remote) instead of the timeline: a phone, and
 *  by default a tablet on the LAN link (touch); the full editor is one tap away (Setup). */
export function useRemoteLayout(): boolean {
  const phone = useSyncExternalStore(subscribePhone, () => !!phoneMedia?.matches)
  const view = useSyncExternalStore(subscribeView, () => chosen)
  if (view !== 'auto') return view === 'remote'
  return phone || (!!api.__remote && TOUCH)
}

// ── Remote ───────────────────────────────────────────────────────────────────

type ArenaRec = { armed: boolean; state: 'idle' | 'starting' | 'recording'; error: string | null }

interface Props {
  rundown: RundownEntry[]
  activeId: string
  playing: boolean
  fps: number
  offsetFrames: number
  endFrame: number
  tempo: Tempo | null
  markers: Marker[]
  clockLabel: string            // INT, LTC A, LTC B
  resolumeConnected: boolean
  showMode: boolean
  stopArmed: boolean            // SHOW mode: first Stop press done
  goArmed: string | null        // SHOW mode: the entry a first GO press asked for
  arenaRec: ArenaRec
  onPlay: () => void
  onStop: () => void
  onLocate: (frame: number) => void   // jumps (start, nudge, markers)
  onSeek: (frame: number) => void     // scrubbing
  onGo: (direction: 1 | -1) => void
  onToggleArenaRec: () => void
  awake: boolean                // the screen is held on (tablet / phone on the LAN link)
  tracks: Track[]               // the timeline's layers and lanes (Layers panel)
  laneStatus: LaneStatusMap     // lane ranges, for the values in real units
}

const buzz = () => { try { navigator.vibrate?.(8) } catch { /* not supported */ } }

export function MobileRemote(p: Props) {
  const idx = p.rundown.findIndex(e => e.id === p.activeId)
  const entry = p.rundown[idx]
  const prev = p.rundown[idx - 1] ?? null
  const next = p.rundown[idx + 1] ?? null
  const isBreak = entry?.type === 'break'
  // SHOW mode while playing: the playhead only moves with the clock and GO
  const locked = p.showMode && p.playing
  // No link to the engine: taps would go nowhere, so nothing pretends to work
  const off = !useEngineLink()
  const recording = p.arenaRec.state !== 'idle'
  const goArmed = !!next && p.goArmed === next.id
  const [side, setSideState] = useState<'rundown' | 'layers'>(() => {
    try { return localStorage.getItem(SIDE_KEY) === 'layers' ? 'layers' : 'rundown' } catch { return 'rundown' }
  })
  const setSide = (v: 'rundown' | 'layers') => { setSideState(v); try { localStorage.setItem(SIDE_KEY, v) } catch { /* ignore */ } }
  const prevArmed = !!prev && p.goArmed === prev.id

  // Phones scroll and zoom the page on drags and double taps: not on this one
  useEffect(() => {
    document.documentElement.classList.add('phone-remote')
    return () => document.documentElement.classList.remove('phone-remote')
  }, [])

  return (
    <div className={`remote ${p.showMode ? 'show-mode' : ''} ${p.playing ? 'playing' : ''} ${off ? 'offline' : ''}`}>
      <header className="rm-status">
        <span className={`rm-dot ${off ? 'bad' : 'ok'}`}>{off ? 'NO LINK' : 'ENGINE'}</span>
        {/* Without the link, Resolume's state is unknown here */}
        <span className={`rm-dot ${off ? 'unknown' : p.resolumeConnected ? 'ok' : 'bad'}`}>{p.resolumeConnected || off ? 'RESOLUME' : 'RESOLUME OFF'}</span>
        <span className="rm-spacer" />
        {p.awake && <span className="rm-dot ok rm-awake" title="The screen stays on while this page is open">AWAKE</span>}
        {p.showMode && <span className="rm-chip show">SHOW</span>}
        <span className="rm-chip">{p.clockLabel}</span>
        {/* Tablets: the full editor (the phone layout has no room for it) */}
        <button className="rm-setup" onClick={() => setAppView('full')} title="Open the full editor (timeline, lanes, clips). VIEW › Show view comes back here.">SETUP</button>
      </header>
      {off && <div className="rm-offline">No connection to the app — reconnecting…</div>}

      <section className="rm-now">
        <div className="rm-now-row">
          <span className="rm-tag live">NOW</span>
          <span className="rm-name">{entryName(entry)}</span>
          <span className="rm-count mono">{idx + 1}/{p.rundown.length}</span>
        </div>
        <div className="rm-now-row dim">
          <span className="rm-tag next">NEXT</span>
          <span className="rm-name">{next ? entryName(next) : '—'}</span>
        </div>
      </section>

      {/* Rarely used and must not be hit by accident: away from the thumb, at the top */}
      <RecButton rec={p.arenaRec} fps={p.fps} stopArmed={p.stopArmed && recording}
        disabled={off || (locked && !recording)} onToggle={() => { buzz(); p.onToggleArenaRec() }} />

      {isBreak ? (
        <section className="rm-break">
          <div className="rm-break-label">BREAK</div>
          <div className="rm-break-time mono">{formatDuration(smpteToFrames((entry as any).duration ?? '00:00:00:00', p.fps), p.fps)}</div>
          <div className="rm-break-note">planned · GO starts the next timeline</div>
        </section>
      ) : (
        <>
          <Clock fps={p.fps} offsetFrames={p.offsetFrames} endFrame={p.endFrame} tempo={p.tempo} markers={p.markers}
            playing={p.playing && !off} />
          <Scrub fps={p.fps} endFrame={p.endFrame} markers={p.markers} locked={locked} disabled={off} onSeek={p.onSeek} />
          <Jumps fps={p.fps} tempo={p.tempo} markers={p.markers} disabled={locked || off} onLocate={p.onLocate} />
        </>
      )}

      <section className="rm-transport">
        <button className={`rm-btn stop ${p.stopArmed ? 'armed' : ''}`} disabled={off} onClick={() => { buzz(); p.onStop() }}>
          <span className="rm-icon">■</span>
          <span className="rm-label">{p.stopArmed ? 'AGAIN TO STOP' : 'STOP'}</span>
        </button>
        {/* Only STOP stops: a second "did it register?" tap on PLAY must not end the show */}
        <button className={`rm-btn play ${p.playing ? 'on' : ''} ${p.arenaRec.armed && !recording ? 'rec-armed' : ''}`}
          disabled={off || (isBreak && !p.playing)} aria-pressed={p.playing}
          onClick={() => { if (p.playing) return; buzz(); p.onPlay() }}>
          <span className="rm-icon">{p.arenaRec.armed && !recording && !p.playing ? <><span className="rm-rec-dot">●</span>▶</> : '▶'}</span>
          <span className="rm-label">{p.playing ? 'PLAYING' : p.arenaRec.armed ? 'PLAY + REC' : 'PLAY'}</span>
        </button>
      </section>

      {/* Wide screens (tablets): the whole rundown, or the parameters the timeline moves */}
      <section className="rm-rundown" aria-label={side === 'layers' ? 'Layers' : 'Rundown'}>
        <div className="rm-side-tabs">
          <button className={side === 'rundown' ? 'on' : ''} onClick={() => setSide('rundown')}>RUNDOWN</button>
          <button className={side === 'layers' ? 'on' : ''} onClick={() => setSide('layers')}>LAYERS</button>
        </div>
        {side === 'layers' ? <LayerParams tracks={p.tracks} fps={p.fps} laneStatus={p.laneStatus} /> : p.rundown.map((e, i) => (
          <div key={e.id} className={`rm-rd-row${i === idx ? ' now' : ''}${i === idx + 1 ? ' next' : ''}${e.type === 'break' ? ' break' : ''}${i < idx ? ' done' : ''}`}>
            <span className="rm-rd-num mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="rm-rd-name">{entryName(e)}</span>
            {i === idx && <span className="rm-tag live">NOW</span>}
            {i === idx + 1 && <span className="rm-tag next">NEXT</span>}
          </div>
        ))}
      </section>

      <section className="rm-go">
        <button className={`rm-btn prev ${prevArmed ? 'armed' : ''}`} disabled={!prev || off} onClick={() => { buzz(); p.onGo(-1) }}
          aria-label={prev ? `Previous: ${entryName(prev)}` : 'No previous timeline'}>
          <span className="rm-icon">◀</span>
          {prevArmed && <span className="rm-again">AGAIN</span>}
        </button>
        <button className={`rm-btn go ${goArmed ? 'armed' : ''}`} disabled={!next || off}
          onClick={() => { buzz(); p.onGo(1) }}>
          <span className="rm-label">{goArmed ? 'AGAIN TO GO' : 'GO'}</span>
          <span className="rm-sub">{prevArmed ? `◀ back to ${entryName(prev)}` : next ? entryName(next) : 'end of rundown'}</span>
        </button>
      </section>
    </div>
  )
}

/** "4:07", "1:02:30", "0:08". `up`: time left rounds up (4.2 s left reads 0:05, as on a countdown). */
function formatDuration(frames: number, fps: number, up = false): string {
  const t = Math.max(0, (up ? Math.ceil : Math.floor)(frames / fps))
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const entryName = (e: RundownEntry | undefined) =>
  !e ? '—' : e.type === 'show' ? e.show.name : e.label || 'Break'

/** Whether the page reaches the engine (the app window over IPC always does). */
function useEngineLink(): boolean {
  const [up, setUp] = useState(true)
  useEffect(() => api.onLink?.(setUp), [])
  return up
}

function Clock({ fps, offsetFrames, endFrame, tempo, markers, playing }: {
  fps: number; offsetFrames: number; endFrame: number; tempo: Tempo | null; markers: Marker[]; playing: boolean
}) {
  const frame = useFrame()
  const remaining = Math.max(0, endFrame - frame)
  const rs = remaining / fps
  // Warning colours only while it runs: a short timeline that is stopped is no emergency
  const cls = endFrame === 0 ? 'idle' : !playing ? '' : rs <= 10 ? 'danger' : rs <= 30 ? 'warn' : ''
  const next = markers.map(m => ({ m, f: smpteToFrames(m.time, fps) })).filter(x => x.f > frame).sort((a, b) => a.f - b.f)[0]
  return (
    <section className="rm-clock">
      <div className={`rm-tc mono ${playing ? 'running' : ''}`}>{framesToSmpte(frame + offsetFrames, fps)}</div>
      <div className={`rm-remain mono ${cls}`}>
        {endFrame === 0 ? 'empty timeline' : remaining === 0 ? 'END' : `−${formatDuration(remaining, fps, true)}`}
        {endFrame > 0 && remaining > 0 && <span className="rm-remain-label">to end</span>}
      </div>
      <div className="rm-clock-row">
        {tempo ? <span className="rm-bar mono">BAR {formatBarBeat(frameToBarBeat(frame, tempo))}</span> : <span />}
        {next && <span className="rm-next-marker mono"><span style={{ color: next.m.color }}>◆</span> {next.m.name || 'marker'} in {formatDuration(next.f - frame, fps, true)}</span>}
      </div>
    </section>
  )
}

// Drag anywhere on the bar to move the playhead; markers catch the finger within a few px
const SCRUB_SEND_MS = 50
const MARKER_CATCH_PX = 10

function Scrub({ fps, endFrame, markers, locked, disabled, onSeek }: {
  fps: number; endFrame: number; markers: Marker[]; locked: boolean; disabled: boolean; onSeek: (frame: number) => void
}) {
  const frame = useFrame()
  const [drag, setDrag] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const spanRef = useRef(0)
  const sendRef = useRef({ last: 0, timer: 0 as any, pending: -1 })
  // The timeline's content (a minute when empty); frozen while dragging
  const span = drag != null ? spanRef.current : endFrame > 0 ? Math.max(endFrame, frame, fps) : Math.max(frame, fps * 60)
  const markerFrames = markers.map(m => smpteToFrames(m.time, fps))

  const frameAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect()
    const x = Math.min(r.width, Math.max(0, clientX - r.left))
    for (const mf of markerFrames) if (Math.abs(mf / spanRef.current * r.width - x) <= MARKER_CATCH_PX) return mf
    return Math.round(x / r.width * spanRef.current)
  }
  const send = (f: number, now = false) => {
    const s = sendRef.current
    s.pending = f
    clearTimeout(s.timer)
    const wait = SCRUB_SEND_MS - (performance.now() - s.last)
    const go = () => { s.last = performance.now(); onSeek(s.pending) }
    if (now || wait <= 0) go()
    else s.timer = setTimeout(go, wait)
  }
  useEffect(() => () => clearTimeout(sendRef.current.timer), [])

  const shown = drag ?? frame
  const caught = drag != null ? markers[markerFrames.indexOf(drag)] : undefined
  const pct = (f: number) => `${Math.min(100, Math.max(0, f / span * 100))}%`

  return (
    <section className={`rm-scrub ${locked ? 'locked' : ''} ${drag != null ? 'dragging' : ''}`}>
      {/* Above the bar: under it, the finger would cover it */}
      <div className="rm-scrub-scale mono">
        <span>0:00</span>
        {drag != null && (caught
          ? <span className="rm-scrub-target marker"><span style={{ color: caught.color }}>◆</span> {caught.name || 'marker'} {formatDuration(drag, fps)}</span>
          : <span className="rm-scrub-target">{formatDuration(drag, fps)}</span>)}
        <span>{formatDuration(span, fps, true)}</span>
      </div>
      <div className="rm-scrub-bar" ref={barRef}
        onPointerDown={e => {
          if (locked || disabled) return
          e.currentTarget.setPointerCapture(e.pointerId)
          spanRef.current = span
          const f = frameAt(e.clientX)
          setDrag(f); send(f)
        }}
        onPointerMove={e => {
          if (drag == null) return
          const f = frameAt(e.clientX)
          if (f !== drag) { setDrag(f); send(f) }
        }}
        onPointerUp={e => { if (drag == null) return; send(frameAt(e.clientX), true); setDrag(null) }}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="rm-scrub-fill" style={{ width: pct(shown) }} />
        {endFrame > 0 && endFrame < span && <div className="rm-scrub-end" style={{ left: pct(endFrame) }} />}
        <div className="rm-scrub-head" style={{ left: pct(shown) }} />
        {markers.map((m, i) => (
          <div key={m.id} className="rm-scrub-marker" style={{ left: pct(markerFrames[i]), background: m.color }} />
        ))}
        {locked && <div className="rm-scrub-lock">LOCKED · SHOW MODE</div>}
      </div>
    </section>
  )
}

function Jumps({ fps, tempo, markers, disabled, onLocate }: {
  fps: number; tempo: Tempo | null; markers: Marker[]; disabled: boolean; onLocate: (frame: number) => void
}) {
  const frame = useFrame()
  // Step: to the previous / next bar line when the timeline has a BPM (as in a DAW), else 5 seconds
  const step = (f: number, dir: 1 | -1) => {
    if (!tempo) return f + dir * 5 * fps
    const bars = frameToBeats(f, tempo) / tempo.beatsPerBar
    const to = dir > 0 ? Math.floor(bars + 1e-6) + 1 : Math.ceil(bars - 1e-6) - 1
    return Math.round(beatsToFrame(to * tempo.beatsPerBar, tempo))
  }
  const stepLabel = tempo ? 'BAR' : '5 s'
  const mf = markers.map(m => smpteToFrames(m.time, fps)).sort((a, b) => a - b)
  const nextMarker = mf.find(m => m > frame)
  const jump = (to: (f: number) => number | undefined) => {
    const f = to(frameStore.get())
    if (f != null) { buzz(); onLocate(Math.max(0, f)) }
  }
  return (
    <section className="rm-jumps">
      <button className="rm-btn small" disabled={disabled} onClick={() => jump(() => 0)}>
        <span className="rm-icon">⏮</span><span className="rm-label">START</span>
      </button>
      <button className="rm-btn small" disabled={disabled} onClick={() => jump(f => step(f, -1))}>
        <span className="rm-label">− {stepLabel}</span>
      </button>
      <button className="rm-btn small" disabled={disabled} onClick={() => jump(f => step(f, 1))}>
        <span className="rm-label">+ {stepLabel}</span>
      </button>
      {/* Always there (disabled without a marker ahead), so the row doesn't change between timelines */}
      <button className="rm-btn small" disabled={disabled || nextMarker == null} onClick={() => jump(f => mf.find(m => m > f))}>
        <span className="rm-icon marker">◆</span><span className="rm-label">NEXT</span>
      </button>
    </section>
  )
}

function RecButton({ rec, fps, stopArmed, disabled, onToggle }: {
  rec: ArenaRec; fps: number; stopArmed: boolean; disabled: boolean; onToggle: () => void
}) {
  const frame = useFrame()
  const label = stopArmed ? 'AGAIN TO STOP'
    : rec.state === 'recording' ? `REC ${formatDuration(frame, fps)} · STOP`
    : rec.state === 'starting' ? 'STARTING…'
    : rec.armed ? 'REC ARMED · PLAY RECORDS' : 'REC ARENA'
  return (
    <section className="rm-rec">
      <button className={`rm-btn rec ${rec.armed ? 'armed' : ''} ${rec.state !== 'idle' ? 'recording' : ''} ${stopArmed ? 'stop-armed' : ''}`}
        disabled={disabled} onClick={onToggle}>
        <span className="rm-icon">●</span><span className="rm-label">{label}</span>
      </button>
      {rec.error && <div className="rm-error">{rec.error}</div>}
    </section>
  )
}

// ── Layers: the parameters the show moves ────────────────────────────────────
// Per layer (and group), only the lanes whose value changes somewhere on the timeline (two keys
// or more, not all the same); a flat or empty lane tells nothing during the show. Each shows its
// value at the playhead and lights up while it is moving.

function changes(a: AutomationSubTrack): boolean {
  if (a.enabled === false || a.keyframes.length < 2) return false
  const first = a.keyframes[0]
  return a.keyframes.some(k => k.value !== first.value || (k.option ?? '') !== (first.option ?? ''))
}

function LayerParams({ tracks, fps, laneStatus }: { tracks: Track[]; fps: number; laneStatus: LaneStatusMap }) {
  const frame = useFrame()
  const toF = (t: string) => smpteToFrames(t, fps)
  const layers = tracks.flatMap(t => {
    if (t.type !== 'layer' && t.type !== 'group') return []
    const lanes = (t as LayerTrack | GroupTrack).automations.filter(changes)
    return lanes.length ? [{ t, lanes }] : []
  })
  if (!layers.length) return <div className="rm-lp-empty">No parameter changes on this timeline</div>
  return (
    <>
      {layers.map(({ t, lanes }) => {
        // The clip on the layer at the playhead (the last one started, while it lasts)
        const clips = t.type === 'layer' ? (t as LayerTrack).clips : []
        const clip = clips.filter(c => toF(c.time) <= frame)
          .sort((a, b) => toF(b.time) - toF(a.time))
          .find(c => { const d = toF(c.duration); return d === 0 || frame < toF(c.time) + d })
        return (
          <div key={t.id} className="rm-lp-layer">
            <div className="rm-lp-head" style={{ boxShadow: `inset 3px 0 0 ${t.color ?? 'var(--bg-splitter)'}` }}>
              <span className="rm-lp-name">{t.name}</span>
              {clip && <span className="rm-lp-clip">▶ {clip.clipName}</span>}
            </div>
            {lanes.map(a => {
              const kind: LaneKind = a.kind ?? 'range'
              const st = laneStatus[a.id]
              const range = { min: st?.info?.min ?? a.min, max: st?.info?.max ?? a.max, options: st?.info?.options ?? a.options, multiplier: st?.info?.multiplier }
              const kfs = frameKeyframes(a.keyframes, fps, toF)
              const now = sampleLane(kfs, frame, kind)
              const soon = sampleLane(kfs, frame + 1, kind)
              const inside = frame >= kfs[0].frame && frame <= kfs[kfs.length - 1].frame
              const moving = inside && !!now && !!soon && (now.value !== soon.value || now.option !== soon.option)
              const v = Math.max(0, Math.min(1, now?.value ?? 0))
              return (
                <div key={a.id} className={`rm-lp-row${moving ? ' moving' : ''}${inside ? '' : ' idle'}`}>
                  <span className="rm-lp-param">{a.ref?.label ?? a.name}</span>
                  <span className="rm-lp-bar"><span style={{ width: `${v * 100}%` }} /></span>
                  <span className="rm-lp-val mono">{now ? formatValue(kind, now.value, range, now.option, st?.info?.suffix) : '—'}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}
