import { useEffect, useRef, useState } from 'react'
import type { Show, EngineState } from '../../../shared/show'
import { framesToSmpte } from './timeUtils'
import {
  BPM_MIN, BPM_MAX, formatBarBeat, formatBpm, frameToBarBeat, roundBpm, tempoOf, validBpm,
  TC_SNAP_GRIDS, SNAP_GRID_LABEL, snapGridsFor, type SnapGrid, type SnapSettings,
} from '../grid'

interface Props {
  engineState: EngineState
  show: Show | null
  offsetFrames: number
  endFrame: number          // last frame with content (clips / audio); 0 = empty show
  ltcActive: boolean
  ltcOutside: boolean         // LTC arrives but is outside this timeline's TC range
  ltcRawTC: string            // last incoming timecode
  followTc: boolean
  onToggleFollowTc: () => void
  anyLtcTimeline: boolean     // some timeline follows LTC (Follow TC makes sense)
  recordArmed: boolean
  onToggleRecord: () => void
  // Arena recording (Arena's own recorder): armed = the next Play records from the timeline start
  arenaRec: { armed: boolean; state: 'idle' | 'starting' | 'recording' }
  onToggleArenaRec: () => void
  overrideCount: number       // lanes the operator took over in Resolume
  onReenable: () => void
  readOnly: boolean
  onPlay: () => void
  onStop: () => void
  stopArmed: boolean          // SHOW mode: first stop press done, waiting for the second
  onLocate: (frame: number) => void
  onToggleBrowser: () => void
  browserOpen: boolean
  onSetBpm: (bpm: number | undefined) => void   // undefined = no BPM
  arenaBpm: number | null                        // Resolume's composition tempo (null = offline)
  onToggleLinkTempo: () => void
  onPushTempo: () => void                         // send this timeline's BPM to Arena now
  snap: SnapSettings                             // in effect (see snapOf)
  snapAuto: string                               // what 'auto' snaps to at the current zoom ("1/4 beat")
  onSetSnap: (patch: { on?: boolean; grid?: SnapGrid }) => void
}

const TAP_RESET_MS = 2000   // idle time after which tapping starts over
const TAP_MAX_INTERVALS = 8
const TAP_MIN_TAPS = 4      // BPM is set from the 4th tap on

// Remaining-time thresholds (seconds) for the warning and danger colours
const WARN_S = 30
const DANGER_S = 10

export function TransportBar({
  engineState, show, offsetFrames, endFrame, ltcActive, ltcOutside, ltcRawTC, followTc, onToggleFollowTc, anyLtcTimeline, recordArmed, onToggleRecord, arenaRec, onToggleArenaRec,
  overrideCount, onReenable, readOnly, onPlay, onStop, stopArmed, onLocate, onToggleBrowser, browserOpen, onSetBpm, arenaBpm, onToggleLinkTempo, onPushTempo,
  snap, snapAuto, onSetSnap,
}: Props) {
  const { frame, playing, fps } = engineState
  const tc = framesToSmpte(frame + offsetFrames, fps)
  const source = show?.clock.source ?? 'internal'
  const isLtc = source === 'ltc' || source === 'ltc-a' || source === 'ltc-b'
  const ltcName = source === 'ltc-b' ? 'LTC B' : 'LTC A'
  const tempo = show ? tempoOf(show) : null
  const barPos = tempo ? formatBarBeat(frameToBarBeat(frame, tempo)) : null

  const remaining = Math.max(0, endFrame - frame)
  const remainingS = remaining / fps
  const remainClass = endFrame === 0 ? 'idle' : remainingS <= DANGER_S ? 'danger' : remainingS <= WARN_S ? 'warn' : ''

  return (
    <div className="transport-bar">
      <div className="tc-block">
        <div className={`tc-display ${playing ? 'running' : ''}`}>{tc}</div>
        <div className="tc-badges">
          <span className="fps-badge" title="Project frame rate">{fps}</span>
          {barPos && <span className={`bar-pos mono ${playing ? 'running' : ''}`} title="Musical position at the playhead (bar.beat.sixteenth)">{barPos}</span>}
          {isLtc ? (
            !ltcActive
              ? <span className="chip warn blink" title="No LTC signal">○ {ltcName} no signal</span>
              : ltcOutside
                ? <span className="chip warn" title={`Incoming LTC ${ltcRawTC} is outside this timeline (starts at ${show?.clock.offset || '00:00:00:00'}, ends at the next LTC timeline's start)`}>{ltcName} {ltcRawTC} · not here</span>
                : <span className="chip live" title={`Receiving timecode ${ltcRawTC}`}>● {ltcName}</span>
          ) : (
            <span className="chip" title="Internal clock">INT</span>
          )}
          {anyLtcTimeline && (
            <button className={`chip follow-chip ${followTc ? 'on' : ''}`} onClick={onToggleFollowTc}
              title={followTc
                ? 'Follow TC on: incoming LTC selects the timeline whose TC range it is in (click to turn off)'
                : 'Follow TC off: LTC only drives the selected timeline (click to switch timelines by timecode)'}
            >Follow TC</button>
          )}
        </div>
      </div>

      <div className="transport-buttons">
        <button className="tbtn" onClick={() => onLocate(0)} disabled={readOnly && playing}
          title={readOnly && playing ? 'Locked while the show runs (SHOW mode)' : 'Go to start (Home)'}>⏮</button>
        <button className={`tbtn ${!playing ? 'stopped' : ''} ${stopArmed ? 'stop-armed' : ''}`} onClick={onStop}
          title={readOnly && playing ? 'Stop — SHOW mode: press twice (Space twice)' : 'Stop (Space)'}>
          ■{stopArmed && <span className="tbtn-label">AGAIN TO STOP</span>}
        </button>
        <button className={`tbtn play ${playing ? 'on-live' : ''}`} onClick={playing ? onStop : onPlay}
          title={playing ? 'Playing — Space to stop' : 'Play (Space)'}>
          ▶{playing && <span className="tbtn-label">PLAY</span>}
        </button>
        {/* Record sits with the transport like in a DAW: arm it, then change parameters in Resolume */}
        <button className={`tbtn rec ${recordArmed ? 'armed' : ''}`} onClick={onToggleRecord} disabled={readOnly}
          title={recordArmed
            ? 'KEYS armed (auto-key): changes to automated parameters in Resolume are written as keyframes at the playhead'
            : 'KEYS (auto-key): record changes you make in Resolume as keyframes — not a video recording (that is REC ARENA)'}>
          <span className="rec-dot">◆</span><span className="tbtn-label">KEYS</span>
        </button>
        {/* Arena's recorder: the take starts exactly at the timeline start (Play goes to 0 first) */}
        <button
          className={`tbtn arena-rec ${arenaRec.armed ? 'armed' : ''} ${arenaRec.state !== 'idle' ? 'recording' : ''}`}
          tabIndex={-1} onMouseDown={e => e.preventDefault()} onClick={onToggleArenaRec}
          title={arenaRec.state === 'recording' ? 'Recording in Arena — click to stop the take'
            : arenaRec.state === 'starting' ? 'Starting Arena\'s recorder…'
            : arenaRec.armed ? 'Armed: Play jumps to the timeline start and records in Arena from there (LTC: from its start TC) until the timeline end. Click to disarm.'
            : 'Record this timeline in Arena: arm, then Play — the recording starts exactly at the timeline start and stops at its end'}
        ><span className="arena-rec-icon">●</span><span className="tbtn-label">{
          arenaRec.state === 'recording' ? `REC ${framesToSmpte(frame, fps).slice(3, 8)}`
          : arenaRec.state === 'starting' ? 'START…'
          : arenaRec.armed ? 'ARMED' : 'REC ARENA'}</span></button>
      </div>

      <div className={`remain ${remainClass}`} title="Time until the end of the last clip or audio">
        <span className="remain-label">
          {remainClass === 'danger' ? '!! End' : remainClass === 'warn' ? '▲ End' : 'Remaining'}
        </span>
        <span className="remain-value mono">
          {endFrame === 0 ? '--:--:--' : `−${framesToSmpte(remaining, fps)}`}
        </span>
      </div>

      <BpmBlock show={show} readOnly={readOnly} onSetBpm={onSetBpm}
        arenaBpm={arenaBpm} onToggleLink={onToggleLinkTempo} onPush={onPushTempo} />

      <SnapBlock snap={snap} hasTempo={!!tempo} grids={show ? snapGridsFor(show) : TC_SNAP_GRIDS} autoText={snapAuto} disabled={readOnly || !show} readOnly={readOnly} onSetSnap={onSetSnap} />

      <div className="spacer" />


      <button className={`btn toggle ${browserOpen ? 'on' : ''}`} onClick={onToggleBrowser}
        title="Show or hide Resolume clips">
        Clips
      </button>
    </div>
  )
}

// BPM display / inline editor + tap tempo. Always visible ("—" without a BPM).
function BpmBlock({ show, readOnly, onSetBpm, arenaBpm, onToggleLink, onPush }: {
  show: Show | null; readOnly: boolean; onSetBpm: (bpm: number | undefined) => void
  arenaBpm: number | null; onToggleLink: () => void; onPush: () => void
}) {
  const bpm = show?.bpm
  const has = validBpm(bpm)
  const tempo = show ? tempoOf(show) : null
  const sig = `${tempo?.beatsPerBar ?? show?.beatsPerBar ?? 4}/4`
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  // After a BPM change / push Arena reports the old tempo until the next poll (~2 s)
  const [settling, setSettling] = useState(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout>>()
  const lastClickRef = useRef(0)
  const settle = () => { setSettling(true); clearTimeout(settleTimer.current); settleTimer.current = setTimeout(() => setSettling(false), 2500) }
  useEffect(() => { settle() }, [bpm])
  useEffect(() => () => clearTimeout(settleTimer.current), [])
  const inputRef = useRef<HTMLInputElement>(null)
  const closedRef = useRef(false)   // Enter / Esc already handled: the blur that follows must not commit again
  const taps = useRef<number[]>([])
  const [tapCount, setTapCount] = useState(0)
  const tapTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { if (readOnly) setEditing(false) }, [readOnly])
  useEffect(() => () => clearTimeout(tapTimer.current), [])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const parsed = text.trim() === '' ? undefined : Number(text.trim().replace(',', '.'))
  const valid = parsed === undefined || (Number.isFinite(parsed) && parsed >= BPM_MIN && parsed <= BPM_MAX)

  const startEdit = () => {
    if (readOnly || !show) return
    setText(has ? String(roundBpm(bpm)) : '')
    closedRef.current = false
    setEditing(true)
  }
  const commit = () => {
    if (!valid || closedRef.current) return
    closedRef.current = true
    setEditing(false)
    const next = parsed === undefined ? undefined : roundBpm(parsed)
    if (next !== bpm) onSetBpm(next)
  }
  const step = (delta: number) => {
    const base = parsed !== undefined && Number.isFinite(parsed) ? parsed : has ? bpm : 120
    const v = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round((base + delta) * 10) / 10))
    setText(String(v))
  }

  // Festival tracks are whole BPMs: round to 1 (Shift+tap keeps one decimal)
  const tap = (precise: boolean) => {
    if (readOnly || !show) return
    const now = performance.now()
    const t = taps.current
    if (t.length && now - t[t.length - 1] > TAP_RESET_MS) t.length = 0
    t.push(now)
    if (t.length > TAP_MAX_INTERVALS + 1) t.splice(0, t.length - TAP_MAX_INTERVALS - 1)
    setTapCount(t.length)
    clearTimeout(tapTimer.current)
    tapTimer.current = setTimeout(() => { taps.current = []; setTapCount(0) }, TAP_RESET_MS)
    if (t.length >= TAP_MIN_TAPS) {
      const avg = (t[t.length - 1] - t[0]) / (t.length - 1)
      const v = precise ? Math.round((60000 / avg) * 10) / 10 : Math.round(60000 / avg)
      if (v >= BPM_MIN && v <= BPM_MAX && v !== bpm) onSetBpm(v)
    }
  }

  return (
    <div className={`bpm-block ${has ? '' : 'none'}`}>
      <div className="bpm-head">
        <span className="remain-label">BPM</span>
        <span className="bpm-sig mono" title="Time signature (beats per bar) — ✎ Edit timeline › Tempo">{has ? sig : ''}</span>
        {has && (() => {
          // LINK: this timeline's BPM drives Arena's tempo (pushed on load / change, beat
          // resynced at every bar line while playing). Arena at another tempo = amber, click to push.
          // Right after a change Arena still reports the old tempo until the next poll: no warning then.
          const linked = show?.linkTempo !== false
          const off = linked && !settling && arenaBpm != null && Math.abs(arenaBpm - (bpm as number)) >= 0.01
          const r = (v: number) => Math.round(v * 10) / 10
          const click = (e: React.MouseEvent) => {
            if (performance.now() - lastClickRef.current < 600) return   // no double-click push + unlink
            lastClickRef.current = performance.now()
            if (e.altKey || !off) { onToggleLink(); return }             // Alt-click: (un)link in any state
            onPush(); settle()
          }
          return (
            <button className={`bpm-link ${off ? 'off' : linked ? 'on' : ''}`} tabIndex={-1}
              onMouseDown={e => e.preventDefault()} disabled={readOnly && off} onClick={click}
              title={off
                ? `Arena runs at ${arenaBpm} BPM (changed in Resolume). Click: send ${bpm} BPM to Arena. Alt-click: unlink and keep Arena's tempo.`
                : linked
                  ? `Linked to Resolume${arenaBpm == null ? ' (offline)' : ''}: Arena's tempo follows this timeline's BPM and its beat is resynced at every bar line while playing. Click to unlink.`
                  : 'Free: Arena keeps its own tempo. Click to link this timeline\'s BPM to Resolume.'}
            >{off ? `↻ ${r(arenaBpm!)}→${r(bpm as number)}` : linked ? 'LINK' : 'FREE'}</button>
          )
        })()}
      </div>
      <div className="bpm-row">
        {editing ? (
          <input
            ref={inputRef}
            className={`bpm-input mono ${valid ? '' : 'invalid'}`}
            value={text} inputMode="decimal" placeholder="—"
            onChange={e => setText(e.target.value)}
            onBlur={() => { if (closedRef.current) return; if (valid) commit(); else { closedRef.current = true; setEditing(false) } }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); closedRef.current = true; setEditing(false) }
              else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1))
              }
            }}
            title={`BPM ${BPM_MIN}–${BPM_MAX}. Enter = set, Esc = cancel, ↑/↓ ±1, Shift+↑/↓ ±0.1, empty = no BPM`}
          />
        ) : (
          <button className="bpm-value mono" onClick={startEdit} disabled={readOnly || !show}
            title={readOnly ? 'BPM (locked in SHOW mode)' : has ? 'Click to change the BPM' : 'Click to set a BPM (bar grid on the timeline)'}
          >{formatBpm(bpm)}</button>
        )}
        {/* Never takes keyboard focus: Enter must stay GO, Space play/stop */}
        <button className={`bpm-tap ${tapCount > 0 ? 'on' : ''}`} tabIndex={-1}
          onPointerDown={e => { e.preventDefault(); if (e.button === 0) tap(e.shiftKey) }}
          disabled={readOnly || !show}
          title={readOnly ? 'Tap tempo (locked in SHOW mode)' : 'Tap tempo: tap 4 or more times on the beat (whole BPM; Shift+tap for decimals; resets after 2 s)'}
        >{tapCount > 0 && tapCount < TAP_MIN_TAPS ? `TAP ${tapCount}` : 'TAP'}</button>
      </div>
    </div>
  )
}

// Snap to grid: on/off toggle + grid size menu. Neither control ever takes keyboard focus
// (Enter must stay GO, Space play/stop); the menu is a flat popup, not a native <select>.
/** "1/2 beat" → "1/2", "1 beat" → "BEAT", "4 bars" → "4BAR", "15 s" → "15S", "5 frames" → "5F". */
function shortStep(t: string): string {
  const m = /^([\d./]+) (bars?|beats?|s|min|frames?)$/.exec(t)
  if (!m) return t
  const [, n, unit] = m
  if (unit.startsWith('bar')) return n === '1' ? 'BAR' : `${n}BAR`
  if (unit.startsWith('beat')) return n === '1' ? 'BEAT' : n.includes('/') ? n : `${n}BT`
  if (unit === 's') return `${n}S`
  if (unit === 'min') return `${n}M`
  return `${n}F`
}

function SnapBlock({ snap, hasTempo, grids, autoText, disabled, readOnly, onSetSnap }: {
  snap: SnapSettings; hasTempo: boolean; grids: readonly SnapGrid[]; autoText: string; disabled: boolean; readOnly: boolean
  onSetSnap: (patch: { on?: boolean; grid?: SnapGrid }) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const musical = grids.includes('beat')
  // Auto shows what it snaps to right now, short enough for the button: A·1/2, A·BEAT, A·4BAR, A·15S, A·5F
  const autoShort = shortStep(autoText)

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  // Close on any mousedown outside the block and on Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const label = (g: SnapGrid) => SNAP_GRID_LABEL[g]
  const toggleTitle = readOnly ? 'Snap to grid (locked in SHOW mode)'
    : `Snap to grid (N) — hold Alt to place freely. ${snap.on ? 'On' : 'Off'}`
  const gridTitle = readOnly ? 'Snap grid size (locked in SHOW mode)'
    : `Snap grid size${snap.grid === 'auto' ? ` — Auto follows the zoom (now ${autoText})` : ''}${musical ? '' : hasTempo ? '. BARS ruler for bar and beat grids' : '. Set a BPM for bar and beat grids'}`

  return (
    <div ref={rootRef} className={`snap-block ${snap.on ? '' : 'off'}`}>
      <div className="bpm-head">
        <span className="remain-label">Snap</span>
        <span className="snap-key mono" title="Keyboard shortcut">N</span>
      </div>
      <div className="bpm-row">
        <button className={`snap-toggle ${snap.on ? 'on' : ''}`} tabIndex={-1} disabled={disabled}
          onMouseDown={e => e.preventDefault()}
          onClick={() => onSetSnap({ on: !snap.on })}
          aria-pressed={snap.on} title={toggleTitle}
        >{snap.on ? 'ON' : 'OFF'}</button>
        <button className={`snap-grid ${open ? 'open' : ''}`} tabIndex={-1} disabled={disabled}
          onMouseDown={e => e.preventDefault()}
          onClick={() => setOpen(o => !o)}
          aria-haspopup="menu" aria-expanded={open} title={gridTitle}
        >
          <span className="snap-grid-label">{snap.grid === 'auto' ? <>A<span className="snap-grid-auto">·{autoShort}</span></> : label(snap.grid)}</span>
          <span className="snap-grid-caret">▾</span>
        </button>
      </div>
      {open && (
        <div className="ctx-menu snap-menu" role="menu">
          <div className="ctx-title">Snap grid</div>
          {grids.map(g => (
            <button key={g} role="menuitemradio" aria-checked={snap.grid === g} tabIndex={-1}
              className={`ctx-btn snap-item ${snap.grid === g ? 'on' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onSetSnap({ grid: g, on: true }); setOpen(false) }}   // picking a grid means snapping to it
            >
              <span className="snap-check">{snap.grid === g ? '✓' : ''}</span>
              <span className="snap-item-label">{label(g)}</span>
              {g === 'auto' && <span className="snap-item-hint mono">{autoText}</span>}
            </button>
          ))}
          {!musical && <div className="ctx-note">{hasTempo ? 'Switch the ruler to BARS for bar and beat grids.' : 'Set a BPM for bar and beat grids.'}</div>}
        </div>
      )}
    </div>
  )
}
