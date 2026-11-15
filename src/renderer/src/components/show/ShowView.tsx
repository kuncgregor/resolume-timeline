import { useEffect, useRef, useState, type ReactNode } from 'react'
import { frameStore, useFrame, useFrameEvery } from '../../frameStore'
import type { Show } from '../../../../shared/show'
import type { RundownEntry } from '../../../../shared/concert'
import type { LaneStatusMap } from '../../laneStatus'
import type { Alarm, ArenaRecState } from '../../alarms'
import { framesToSmpte, smpteToFrames } from '../timeUtils'
import { beatsToFrame, formatBarBeat, frameToBarBeat, frameToBeats, tempoOf, type Tempo } from '../../grid'
import {
  showModelOf, countdown, seconds, clockText, imminent, eventAtOrAfter, sectionAt, clipAtFrame, moveAt, moveTarget, runAt, inSpan,
  sampleAt, laneValue, moveText, type ShowModel, type ShowEvent, type ShowLayer,
} from '../../showModel'
import { Radar } from './Radar'
import { useMedia, useShowSize } from './view'
import { ViewMenu } from '../ViewMenu'

// Show view: what an operator needs at showtime, readable from two metres, on a tablet, a phone
// or the computer (VIEW › Show view). Where in the song you are (bar, section, time to end), what
// is on air on every layer and which parameters move right now, what comes next with a countdown
// in bars, and the alarms. Every button calls the same App handler as the full UI, so SHOW-mode
// guards apply (two taps for STOP, GO, ◀ and giving a parameter back while playing).
//
// Layouts: phone (narrow), tablet portrait (radar across, COMING under it), tablet landscape and
// computer (LAYER · NOW | radar | COMING), ≥ 1400 px more bars and events, ≥ 1800 px the rundown
// as a fourth column. The playhead never re-renders the whole view: the radar draws from
// frameStore, the clock reads it per frame, lists ten times a second.

const api = (window as any).timeline

interface Props {
  rundown: RundownEntry[]
  activeId: string
  show: Show
  playing: boolean
  fps: number
  offsetFrames: number
  endFrame: number
  tempo: Tempo | null
  clockLabel: string            // INT, LTC A, LTC B
  clockOk: boolean | null       // LTC arriving; null = internal clock
  resolumeConnected: boolean
  showMode: boolean
  stopArmed: boolean            // SHOW mode: first Stop press done
  goArmed: string | null        // SHOW mode: the entry a first GO press asked for
  manualArmed: boolean          // SHOW mode: first "give back" press done
  setupArmed: boolean           // SHOW mode while playing: first SETUP press done
  arenaRec: ArenaRecState
  alarms: Alarm[]
  manual: { id: string; name: string }[]
  awake: boolean                // the screen is held on (tablet / phone on the LAN link)
  laneStatus: LaneStatusMap     // lane ranges, for values in real units
  onPlay: () => void
  onStop: () => void
  onLocate: (frame: number) => void   // jumps (start, bar, markers)
  onSeek: (frame: number) => void     // scrubbing
  onGo: (direction: 1 | -1) => void
  onToggleArenaRec: () => void
  onReenable: (ids?: string[]) => void
  onSetup: () => void           // leave SHOW mode: the editor
}

type Layout = 'phone' | 'portrait' | 'landscape'

const buzz = () => { try { navigator.vibrate?.(8) } catch { /* not supported */ } }

const entryName = (e: RundownEntry | undefined | null) =>
  !e ? '—' : e.type === 'show' ? e.show.name : e.label || 'Break'

export function ShowView(p: Props) {
  const wide = useMedia('(min-width: 700px) and (min-height: 560px)')
  const portrait = useMedia('(orientation: portrait)')
  const big = useMedia('(min-width: 1400px) and (min-height: 700px)')
  const huge = useMedia('(min-width: 1800px) and (min-height: 700px)')
  const layout: Layout = !wide ? 'phone' : portrait ? 'portrait' : 'landscape'
  const size = useShowSize()

  const idx = p.rundown.findIndex(e => e.id === p.activeId)
  const entry = p.rundown[idx]
  const prev = p.rundown[idx - 1] ?? null
  const next = p.rundown[idx + 1] ?? null
  const isBreak = entry?.type === 'break'
  // SHOW mode while playing: the playhead only moves with the clock and GO
  const locked = p.showMode && p.playing
  // No link to the engine: taps would go nowhere, so nothing pretends to work
  const off = !useEngineLink()

  // During a break: what GO opens with (the next timeline from its start)
  const nextShow = isBreak && next?.type === 'show' ? next.show : null
  const viewShow = nextShow ?? (isBreak ? null : p.show)
  const model = viewShow ? showModelOf(viewShow) : EMPTY_MODEL
  const tempo = nextShow ? tempoOf(nextShow) : p.tempo
  const fps = viewShow?.frameRate ?? p.fps
  const fixedFrame = isBreak ? 0 : undefined

  // Right column: COMING while it runs, the rundown when stopped; a tap on the other tab peeks
  // until Play / Stop
  const [peek, setPeek] = useState<'coming' | 'rundown' | null>(null)
  useEffect(() => setPeek(null), [p.playing])
  const side = huge ? 'coming' : peek ?? (p.playing || isBreak ? 'coming' : 'rundown')
  // As many as fit: rows that don't fit whole are hidden by the list itself
  const events = big ? 12 : 9

  // Phones scroll and zoom the page on drags and double taps: not on this one
  useEffect(() => {
    document.documentElement.classList.add('show-view')
    return () => document.documentElement.classList.remove('show-view')
  }, [])

  const rundownList = <RundownList rundown={p.rundown} idx={idx} />
  return (
    <div className={`sv sv-${layout} size-${size}${big ? ' big' : ''}${huge ? ' huge' : ''}${p.showMode ? ' show-mode' : ''}${off ? ' offline' : ''}`}>
      <Band {...p} off={off} locked={locked} phone={layout === 'phone'} />
      {off && <div className="sv-offline">No connection to the app — reconnecting…</div>}
      <Head entry={entry} next={next} idx={idx} count={p.rundown.length} fps={p.fps} tempo={p.tempo}
        offsetFrames={p.offsetFrames} endFrame={p.endFrame} model={isBreak ? EMPTY_MODEL : model} playing={p.playing && !off} />
      {isBreak
        ? <BreakStrip entry={entry} />
        : <SectionStrip fps={p.fps} endFrame={p.endFrame} model={model} tempo={p.tempo} locked={locked} disabled={off}
            onSeek={p.onSeek} onLocate={p.onLocate} />}
      {layout === 'landscape' && <LayerNow model={model} fps={fps} tempo={tempo} laneStatus={p.laneStatus} fixedFrame={fixedFrame} preview={isBreak} />}
      {layout === 'phone'
        ? <PhoneLayers model={model} laneStatus={p.laneStatus} fixedFrame={fixedFrame} />
        : <Radar model={model} tempo={tempo} fps={fps} bars={big ? 16 : 8} secs={big ? 30 : 15}
            labels={layout === 'portrait'} fixedFrame={fixedFrame} title={nextShow ? `GO OPENS WITH ${nextShow.name}` : undefined} />}
      <section className="sv-side" aria-label={side === 'coming' ? 'Coming' : 'Rundown'}>
        <div className="sv-tabs" role="tablist">
          <button role="tab" aria-selected={side === 'coming'} className={side === 'coming' ? 'on' : ''}
            onClick={() => setPeek('coming')}>{isBreak ? 'AFTER GO' : 'COMING'}</button>
          {!huge && <button role="tab" aria-selected={side === 'rundown'} className={side === 'rundown' ? 'on' : ''}
            onClick={() => setPeek('rundown')}>RUNDOWN</button>}
        </div>
        {side === 'coming'
          ? <Coming model={model} tempo={tempo} fps={fps} laneStatus={p.laneStatus} max={events} fixedFrame={fixedFrame} />
          : rundownList}
      </section>
      {huge && <section className="sv-rundown-col" aria-label="Rundown"><div className="sv-colhead">RUNDOWN</div>{rundownList}</section>}
      <Controls {...p} prev={prev} next={next} isBreak={isBreak} off={off} />
    </div>
  )
}

export const EMPTY_MODEL: ShowModel = { layers: [], events: [], sections: [] }

/** Whether the page reaches the engine (the app window over IPC always does). */
function useEngineLink(): boolean {
  const [up, setUp] = useState(true)
  useEffect(() => api.onLink?.(setUp), [])
  return up
}

// ── Top band: status and alarms ─────────────────────────────────────────────

function Band(p: Props & { off: boolean; locked: boolean; phone: boolean }) {
  const recording = p.arenaRec.state !== 'idle'
  // Arena recording has its own button here; the band lists what needs attention
  const alarms = p.alarms.filter(a => a.level !== 'rec')
  return (
    <header className="sv-band">
      <span className={`sv-dot engine ${p.off ? 'bad' : 'ok'}`}>{p.off ? 'NO LINK' : 'ENGINE'}</span>
      {/* Without the link, Resolume's state is unknown here */}
      <span className={`sv-dot ${p.off ? 'unknown' : p.resolumeConnected ? 'ok' : 'bad'}`}>RESOLUME</span>
      <span className={`sv-dot ${p.clockOk === null ? 'plain' : p.clockOk ? 'ok' : 'bad'}`}>{p.clockLabel}</span>
      {p.showMode && <span className="chip on-live">SHOW</span>}
      {p.awake && <span className="sv-dot ok sv-awake" title="The screen stays on while this page is open">AWAKE</span>}
      <div className="sv-alarms" role="alert">
        {alarms.map(a => a.id === 'manual' ? (
          <span key={a.id} className="sv-alarm manual" title={`${a.detail}: moved in Resolume, so their automation is paused`}>
            <b>{a.title}</b>
            {p.manual.slice(0, 2).map(m => (
              <button key={m.id} className="sv-giveback" disabled={p.off} title={`Give ${m.name} back to the timeline`}
                onClick={() => { buzz(); p.onReenable([m.id]) }}>{p.manualArmed ? 'AGAIN ↺' : `${m.name.split(' › ').pop()} ↺`}</button>
            ))}
            {p.manual.length > 2 && <button className="sv-giveback" disabled={p.off} onClick={() => { buzz(); p.onReenable() }}>
              {p.manualArmed ? 'AGAIN ↺' : `ALL ${p.manual.length} ↺`}</button>}
          </span>
        ) : (
          <span key={a.id} className={`sv-alarm ${a.level}`} title={a.detail}>{a.level === 'danger' && <i />}<b>{a.title}</b></span>
        ))}
      </div>
      {/* Rarely used and must not be hit by accident: up here, away from the thumb */}
      <RecButton rec={p.arenaRec} fps={p.fps} stopArmed={p.stopArmed && recording}
        disabled={p.off || (p.locked && !recording)} onToggle={() => { buzz(); p.onToggleArenaRec() }} />
      {/* This device only: Tablet / Desktop style, scale (SHOW mode stays on for everyone) */}
      <ViewMenu showMode={p.showMode} className="sv-setup" label="VIEW" />
      {/* A phone has only this view: no editor to go to */}
      {!p.phone && (
        <button className={`sv-setup${p.setupArmed ? ' armed' : ''}`} disabled={p.off} onClick={() => { buzz(); p.onSetup() }}
          title="Leave SHOW mode: the editor (timeline, lanes, clips). SHOW comes back here (VIEW › Show view: Tablet).">
          {p.setupArmed ? 'AGAIN' : 'SETUP'}</button>
      )}
    </header>
  )
}

function RecButton({ rec, fps, stopArmed, disabled, onToggle }: {
  rec: ArenaRecState; fps: number; stopArmed: boolean; disabled: boolean; onToggle: () => void
}) {
  const frame = useFrameEvery(250)
  // "ARENA" drops out on a phone (sv-long), the rest must fit beside the status dots
  const label = stopArmed ? 'AGAIN TO STOP'
    : rec.state === 'recording' ? `REC ${clockText(frame, fps)} · STOP`
    : rec.state === 'starting' ? 'STARTING…'
    : rec.armed ? 'REC ARMED' : <>REC<span className="sv-long"> ARENA</span></>
  return (
    <button className={`sv-rec ${rec.armed ? 'armed' : ''} ${rec.state !== 'idle' ? 'recording' : ''} ${stopArmed ? 'stop-armed' : ''}`}
      disabled={disabled} onClick={onToggle} title={rec.error ?? (rec.armed ? 'The next Play records from the timeline start until its end' : 'Record the output in Arena')}>
      <span className="sv-rec-dot">●</span>{label}
    </button>
  )
}

// ── Head: song, position, time to end ───────────────────────────────────────

function Head({ entry, next, idx, count, fps, tempo, offsetFrames, endFrame, model, playing }: {
  entry: RundownEntry | undefined; next: RundownEntry | null; idx: number; count: number; fps: number; tempo: Tempo | null
  offsetFrames: number; endFrame: number; model: ShowModel; playing: boolean
}) {
  const frame = useFrame()
  const isBreak = entry?.type === 'break'
  const remaining = Math.max(0, endFrame - frame)
  const rs = remaining / fps
  // Warning colours only while it runs: a short timeline that is stopped is no emergency
  const cls = endFrame === 0 ? 'idle' : !playing ? '' : rs <= 10 ? 'danger' : rs <= 30 ? 'warn' : ''
  const tc = framesToSmpte(frame + offsetFrames, fps)
  const cur = sectionAt(model.sections, frame)
  const nextSec = model.sections.find(s => s.start > frame)
  return (
    <section className="sv-head">
      <div className="sv-songs">
        <div className="sv-song-row">
          {/* Mint only while it is on air, as on the editor's rundown cards */}
          <span className={`chip sv-tag${playing ? ' live' : ''}`}>NOW</span>
          <span className="sv-song">{entryName(entry)}</span>
          <span className="sv-count mono">{String(idx + 1).padStart(2, '0')}/{String(count).padStart(2, '0')}</span>
        </div>
        <div className="sv-next-row">
          <span className="chip next sv-tag">NEXT</span>
          <span className="sv-next-name">{entryName(next)}</span>
        </div>
      </div>
      {isBreak ? (
        <div className="sv-pos">
          <div className="sv-bar">BREAK</div>
          <div className="sv-sect dim">GO starts {entryName(next)}</div>
        </div>
      ) : (
        <div className="sv-pos">
          <div className="sv-pos-row">
            <span className={`sv-bar mono ${playing ? 'running' : ''}`}>{tempo ? `BAR ${formatBarBeat(frameToBarBeat(frame, tempo), 2)}` : tc}</span>
            {tempo && <span className="sv-tc mono">{tc}</span>}
          </div>
          <div className="sv-sect">
            {cur && <span style={{ color: cur.marker.color }}>{cur.marker.name || 'Marker'}</span>}
            {nextSec && <span className="sv-sect-next">{cur ? ' · ' : ''}◆ {nextSec.marker.name || 'Marker'} in {countdown(nextSec.start - frame, tempo, fps)}</span>}
          </div>
        </div>
      )}
      {isBreak ? (
        <div className="sv-remain">
          <div className="sv-remain-big mono idle">{clockText(smpteToFrames((entry as any).duration ?? '00:00:00:00', fps), fps)}</div>
          <small>PLANNED BREAK</small>
        </div>
      ) : (
        <div className="sv-remain">
          <div className={`sv-remain-big mono ${cls}`}>{endFrame === 0 ? '—' : remaining === 0 ? 'END' : `−${clockText(remaining, fps, true)}`}</div>
          <small>{endFrame === 0 ? 'EMPTY TIMELINE' : 'TO END'}</small>
          <div className="sv-prog"><i style={{ width: `${endFrame > 0 ? Math.min(100, frame / endFrame * 100) : 0}%` }} /></div>
        </div>
      )}
    </section>
  )
}

// ── Section strip: the whole timeline, its sections, scrub and jumps ────────

// Drag anywhere on the strip to move the playhead; section starts catch the finger within a few px
const SCRUB_SEND_MS = 50
const MARKER_CATCH_PX = 10

/** The whole timeline with its sections: scrub, ⏮ −BAR / +BAR ◆▸ (also the Desktop SHOW style). */
export function SectionStrip({ fps, endFrame, model, tempo, locked, disabled, onSeek, onLocate }: {
  fps: number; endFrame: number; model: ShowModel; tempo: Tempo | null; locked: boolean; disabled: boolean
  onSeek: (frame: number) => void; onLocate: (frame: number) => void
}) {
  const frame = useFrame()
  const [drag, setDrag] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const spanRef = useRef(0)
  const sendRef = useRef({ last: 0, timer: 0 as any, pending: -1 })
  useEffect(() => () => clearTimeout(sendRef.current.timer), [])
  // The timeline's content (a minute when empty); frozen while dragging
  const span = drag != null ? spanRef.current : endFrame > 0 ? Math.max(endFrame, frame, fps) : Math.max(frame, fps * 60)
  const starts = model.sections.map(s => s.start)

  const frameAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect()
    const x = Math.min(r.width, Math.max(0, clientX - r.left))
    for (const f of starts) if (Math.abs(f / spanRef.current * r.width - x) <= MARKER_CATCH_PX) return f
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
  // Step: to the previous / next bar line with a BPM (as in a DAW), else 5 seconds
  const step = (f: number, dir: 1 | -1) => {
    if (!tempo) return f + dir * 5 * fps
    const bars = frameToBeats(f, tempo) / tempo.beatsPerBar
    const to = dir > 0 ? Math.floor(bars + 1e-6) + 1 : Math.ceil(bars - 1e-6) - 1
    return Math.round(beatsToFrame(to * tempo.beatsPerBar, tempo))
  }
  // Jumps stay on the timeline: +BAR at the end goes no further than its end
  const jump = (to: (f: number) => number | undefined) => {
    const f = to(frameStore.get())
    if (f != null) { buzz(); onLocate(Math.max(0, endFrame > 0 ? Math.min(f, endFrame) : f)) }
  }
  const stepLabel = tempo ? 'BAR' : '5 s'
  const noJump = locked || disabled
  const shown = drag ?? frame
  const pct = (f: number) => `${Math.min(100, Math.max(0, f / span * 100))}%`
  const caught = drag != null ? model.sections.find(s => s.start === drag) : undefined

  return (
    <section className={`sv-strip ${locked ? 'locked' : ''} ${drag != null ? 'dragging' : ''}`}>
      <div className="sv-jumps left">
        {locked
          // SHOW mode while playing: the jumps and the strip are locked, said where the jumps are
          ? <div className="sv-lockcell" title="SHOW mode: the playhead moves only with the clock and GO">LOCKED</div>
          : <>
            <button disabled={noJump} onClick={() => jump(() => 0)} aria-label="To the start">⏮</button>
            <button disabled={noJump} onClick={() => jump(f => step(f, -1))}>−{stepLabel}</button>
          </>}
      </div>
      <div className="sv-secs" ref={barRef}
        onPointerDown={e => {
          if (locked || disabled) return
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
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
        <div className="sv-secs-fill" style={{ width: pct(shown) }} />
        {model.sections.map(s => {
          const end = Math.min(s.end, span)
          if (s.start >= span) return null
          const cur = shown >= s.start && shown < s.end
          return (
            <div key={s.marker.id} className={`sv-sec${cur ? ' cur' : ''}`}
              style={{ left: pct(s.start), width: pct(end - s.start), borderLeftColor: s.marker.color, ['--sec' as any]: s.marker.color }}>
              <SectionName name={s.marker.name || 'Marker'} />
            </div>
          )
        })}
        {endFrame > 0 && endFrame < span && <div className="sv-secs-end" style={{ left: pct(endFrame) }} />}
        <div className="sv-secs-head" style={{ left: pct(shown) }} />
        {drag != null && <div className="sv-secs-target mono">{caught ? `◆ ${caught.marker.name || 'Marker'} ` : ''}{clockText(drag, fps)}</div>}
      </div>
      <div className="sv-jumps right">
        <button disabled={noJump} onClick={() => jump(f => step(f, 1))}>+{stepLabel}</button>
        {/* Always there (disabled without a section ahead), so the row doesn't change between timelines */}
        <button disabled={noJump || !starts.some(s => s > frame)} onClick={() => jump(f => starts.find(s => s > f))} aria-label="Next section">◆▸</button>
      </div>
    </section>
  )
}

// During a break the strip carries its notes (what to do before the next song)
function BreakStrip({ entry }: { entry: RundownEntry | undefined }) {
  const notes = entry?.type === 'break' ? entry.notes.trim() : ''
  return (
    <section className="sv-strip break">
      <div className={`sv-break-note${notes ? '' : ' none'}`}>{notes || 'No notes for this break · GO starts the next song from its beginning'}</div>
    </section>
  )
}

// ── LAYER · NOW: per layer, the clip on air and what moves now ─────────────

function useShownFrame(fixedFrame: number | undefined) {
  const frame = useFrameEvery(100)
  return fixedFrame ?? frame
}

/** Per layer: the clip on air and what moves now (also the Desktop SHOW style). */
export function LayerNow({ model, fps, tempo, laneStatus, fixedFrame, preview }: {
  model: ShowModel; fps: number; tempo: Tempo | null; laneStatus: LaneStatusMap; fixedFrame?: number; preview: boolean
}) {
  const frame = useShownFrame(fixedFrame)
  // During a break: what the next timeline opens with (blue, not on air)
  return (
    <section className={`sv-layers${preview ? ' preview' : ''}`} aria-label="Layers now">
      <div className="sv-colhead">{preview ? 'LAYER · AT GO' : 'LAYER · NOW'}</div>
      {model.layers.length ? model.layers.map(L => (
        <LayerCell key={L.id} layer={L} frame={frame} fps={fps} tempo={tempo} laneStatus={laneStatus} />
      )) : <div className="sv-cell empty">Nothing plays on this timeline</div>}
    </section>
  )
}

function LayerCell({ layer, frame, fps, tempo, laneStatus }: {
  layer: ShowLayer; frame: number; fps: number; tempo: Tempo | null; laneStatus: LaneStatusMap
}) {
  const clip = clipAtFrame(layer, frame)
  const moving = layer.lanes.flatMap(lane => { const m = moveAt(lane, frame); return m ? [{ lane, m }] : [] })
  const strobing = layer.lanes.flatMap(lane => { const r = runAt(lane, frame); return r ? [{ lane, r }] : [] })
  // Nothing moving: the layer's next move, so a quiet layer still says what it waits for
  const upcoming = moving.length || strobing.length ? null : layer.lanes
    .flatMap(lane => lane.moves.filter(m => m.from > frame).slice(0, 1).map(m => ({ lane, m })))
    .sort((a, b) => a.m.from - b.m.from)[0]
  return (
    <div className="sv-cell" style={{ ['--c' as any]: layer.color ?? 'var(--bg-splitter)' }}>
      <div className="sv-cell-name"><span className="mono">{layer.tag}</span> {layer.name}</div>
      {layer.clips.length > 0 && <div className={`sv-cell-clip${clip ? '' : ' none'}`}>{clip ? `▶ ${clip.name}` : 'no clip'}</div>}
      {moving.map(({ lane, m }) => {
        const now = sampleAt(lane, frame)
        const v = inSpan(lane, now?.value ?? 0)   // the bar spans what the lane uses
        return (
          <div key={lane.lane.id} className="sv-mv">
            <span className="sv-mv-name">{lane.name}</span>
            <span className="sv-mv-bar"><i style={{ width: `${v * 100}%` }} /></span>
            <span className="sv-mv-val mono">{now ? laneValue(lane, laneStatus, now.value, now.option) : '—'} → {laneValue(lane, laneStatus, moveTarget(m, frame))}</span>
          </div>
        )
      })}
      {strobing.map(({ lane, r }) => {
        const now = sampleAt(lane, frame)
        return (
          <div key={lane.lane.id} className="sv-mv">
            <span className="sv-mv-name">{lane.name}</span>
            <span className="sv-mv-bar"><i style={{ width: `${inSpan(lane, now?.value ?? 0) * 100}%` }} /></span>
            <span className="sv-mv-val mono">×{r.last - r.first + 1} steps · {now ? laneValue(lane, laneStatus, now.value, now.option) : '—'}</span>
          </div>
        )
      })}
      {upcoming && <div className="sv-cell-quiet">{upcoming.lane.name} in {countdown(upcoming.m.from - frame, tempo, fps)}</div>}
    </div>
  )
}

/** Phone: one line per layer — the clip on air and what moves (no room for the radar). */
function PhoneLayers({ model, laneStatus, fixedFrame }: { model: ShowModel; laneStatus: LaneStatusMap; fixedFrame?: number }) {
  const frame = useShownFrame(fixedFrame)
  return (
    <section className="sv-phone-layers" aria-label="Layers now">
      {model.layers.map(L => {
        const clip = clipAtFrame(L, frame)
        const moving = L.lanes.filter(lane => moveAt(lane, frame))
        return (
          <div key={L.id} className="sv-pl" style={{ ['--c' as any]: L.color ?? 'var(--bg-splitter)' }}>
            <b className="mono">{L.tag}</b>
            <span className={`sv-pl-clip${clip ? '' : ' none'}`}>{clip ? clip.name : L.clips.length ? 'no clip' : L.name}</span>
            {moving.length > 0 && <span className="sv-pl-mv">{moving.map(lane => {
              const s = sampleAt(lane, frame)
              return `${lane.name} ${s ? laneValue(lane, laneStatus, s.value, s.option) : ''}`
            }).join(' · ')}</span>}
          </div>
        )
      })}
    </section>
  )
}

// ── COMING: the next events, grouped by time, with a countdown ──────────────

/** The next events, grouped by time, with a countdown (also the editor's COMING column in SHOW mode). */
export function Coming({ model, tempo, fps, laneStatus, max, fixedFrame }: {
  model: ShowModel; tempo: Tempo | null; fps: number; laneStatus: LaneStatusMap; max: number; fixedFrame?: number
}) {
  const frame = useShownFrame(fixedFrame)
  // What happens on this very frame is done: the list starts after it
  const groups: { frame: number; items: ShowEvent[] }[] = []
  for (let i = eventAtOrAfter(model.events, frame + 1); i < model.events.length && groups.length <= max; i++) {
    const ev = model.events[i]
    const g = groups[groups.length - 1]
    if (g && g.frame === ev.frame) { g.items.push(ev); g.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]) }
    else if (groups.length < max) groups.push({ frame: ev.frame, items: [ev] })
    else break
  }
  if (!groups.length) return <div className="sv-ev-empty">Nothing more on this timeline</div>
  return (
    <div className="sv-events">
      {groups.map((g, i) => {
        const d = g.frame - frame
        const soon = i === 0 && imminent(d, tempo, fps)
        return (
          <div key={g.frame} className={`sv-ev${i === 0 ? ' first' : ''}${soon ? ' imminent' : ''}`}>
            <div className="sv-cd mono">{countdown(d, tempo, fps)}{tempo && <small>{seconds(d, fps)}</small>}</div>
            <div className="sv-its">
              {(g.items.length > 4 ? g.items.slice(0, 3) : g.items).map((ev, k) => <div key={k} className={`sv-it${ev.kind === 'section' ? ' sec' : ''}`}>{eventText(ev, laneStatus)}</div>)}
              {g.items.length > 4 && <div className="sv-it more">+{g.items.length - 3} more</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** A section name with its number kept whole: "CHORU… 2" still tells two choruses apart. */
function SectionName({ name }: { name: string }) {
  const m = /^(.*?)(\s+\d+)$/.exec(name)
  return <span className="sv-sec-name"><span>{m ? m[1] : name}</span>{m && <b>{m[2]}</b>}</span>
}

// The layer tag in its own column, so a text that wraps keeps its indent
// Within one moment: the section, then what moves, then the clips
const ORDER: Record<ShowEvent['kind'], number> = { section: 0, move: 1, steps: 1, clip: 2, clear: 3 }

function eventText(ev: ShowEvent, laneStatus: LaneStatusMap): ReactNode {
  if (ev.kind === 'section') return <span className="sv-it-text" style={{ color: ev.marker.color }}>◆ {ev.marker.name || 'Marker'}</span>
  const ly = <span className="sv-ly mono">{ev.layer.tag}</span>
  const text = ev.kind === 'clip'
    ? ev.from ? <>{ev.from === ev.name ? '↻ ' : `${ev.from} → `}<b>{ev.name}</b></> : <>▶ <b>{ev.name}</b></>
    : ev.kind === 'clear' ? <>■ <b>{ev.name}</b> out</>
    : ev.kind === 'steps' ? <><b>{ev.lane.name}</b> ×{ev.count} steps</>
    : (() => {
      const t = moveText(ev.lane, ev.move, laneStatus)
      return t.startsWith(ev.lane.name + ' ') ? <><b>{ev.lane.name}</b>{t.slice(ev.lane.name.length)}</> : <b>{t}</b>
    })()
  return <>{ly}<span className="sv-it-text">{text}</span></>
}

function RundownList({ rundown, idx }: { rundown: RundownEntry[]; idx: number }) {
  const nowRef = useRef<HTMLDivElement>(null)
  useEffect(() => { nowRef.current?.scrollIntoView({ block: 'nearest' }) }, [idx])
  return (
    <div className="sv-rundown">
      {rundown.map((e, i) => (
        <div key={e.id} ref={i === idx ? nowRef : undefined}
          className={`sv-rd${i === idx ? ' now' : ''}${i === idx + 1 ? ' next' : ''}${e.type === 'break' ? ' break' : ''}${i < idx ? ' done' : ''}`}>
          <span className="sv-rd-num mono">{String(i + 1).padStart(2, '0')}</span>
          <span className="sv-rd-name">{entryName(e)}</span>
          {i === idx && <span className="chip live sv-tag">NOW</span>}
          {i === idx + 1 && <span className="chip next sv-tag">NEXT</span>}
        </div>
      ))}
    </div>
  )
}

// ── Transport: ◀ · STOP · PLAY · GO ─────────────────────────────────────────

function Controls(p: Props & { prev: RundownEntry | null; next: RundownEntry | null; isBreak: boolean; off: boolean }) {
  const recording = p.arenaRec.state !== 'idle'
  const goArmed = !!p.next && p.goArmed === p.next.id
  const prevArmed = !!p.prev && p.goArmed === p.prev.id
  return (
    <section className="sv-ctl">
      <button className={`sv-btn prev ${prevArmed ? 'armed' : ''}`} disabled={!p.prev || p.off} onClick={() => { buzz(); p.onGo(-1) }}
        aria-label={p.prev ? `Previous: ${entryName(p.prev)}` : 'No previous timeline'}>
        <span className="sv-ic">◀</span><span className="sv-lb">{prevArmed ? 'AGAIN' : 'BACK'}</span>
      </button>
      <button className={`sv-btn stop ${p.stopArmed ? 'armed' : ''}`} disabled={p.off} onClick={() => { buzz(); p.onStop() }}>
        <span className="sv-ic">■</span><span className="sv-lb">{p.stopArmed ? 'AGAIN TO STOP' : 'STOP'}</span>
      </button>
      {/* Only STOP stops: a second "did it register?" tap on PLAY must not end the show */}
      <button className={`sv-btn play ${p.playing ? 'on' : ''} ${p.arenaRec.armed && !recording ? 'rec-armed' : ''}`}
        disabled={p.off || (p.isBreak && !p.playing)} aria-pressed={p.playing}
        onClick={() => { if (p.playing) return; buzz(); p.onPlay() }}>
        <span className="sv-ic">{p.arenaRec.armed && !recording && !p.playing ? <><span className="sv-rec-dot">●</span>▶</> : '▶'}</span>
        <span className="sv-lb">{p.playing ? 'PLAYING' : p.arenaRec.armed ? 'PLAY + REC' : 'PLAY'}</span>
      </button>
      <button className={`sv-btn go ${goArmed ? 'armed' : ''}`} disabled={!p.next || p.off} onClick={() => { buzz(); p.onGo(1) }}>
        <span className="sv-lb">{goArmed ? 'AGAIN TO GO' : 'GO'}</span>
        <span className="sv-sub">{prevArmed ? `◀ back to ${entryName(p.prev)}` : p.next ? entryName(p.next) : 'end of rundown'}</span>
      </button>
    </section>
  )
}
