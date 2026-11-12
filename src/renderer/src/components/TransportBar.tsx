import type { Show, EngineState } from '../../../shared/show'
import { framesToSmpte } from './timeUtils'

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
  overrideCount: number       // lanes the operator took over in Resolume
  onReenable: () => void
  readOnly: boolean
  onPlay: () => void
  onStop: () => void
  stopArmed: boolean          // SHOW mode: first stop press done, waiting for the second
  onLocate: (frame: number) => void
  onToggleBrowser: () => void
  browserOpen: boolean
}

// Remaining-time thresholds (seconds) for the warning and danger colours
const WARN_S = 30
const DANGER_S = 10

export function TransportBar({
  engineState, show, offsetFrames, endFrame, ltcActive, ltcOutside, ltcRawTC, followTc, onToggleFollowTc, anyLtcTimeline, recordArmed, onToggleRecord,
  overrideCount, onReenable, readOnly, onPlay, onStop, stopArmed, onLocate, onToggleBrowser, browserOpen,
}: Props) {
  const { frame, playing, fps } = engineState
  const tc = framesToSmpte(frame + offsetFrames, fps)
  const source = show?.clock.source ?? 'internal'
  const isLtc = source === 'ltc' || source === 'ltc-a' || source === 'ltc-b'
  const ltcName = source === 'ltc-b' ? 'LTC B' : 'LTC A'

  const remaining = Math.max(0, endFrame - frame)
  const remainingS = remaining / fps
  const remainClass = endFrame === 0 ? 'idle' : remainingS <= DANGER_S ? 'danger' : remainingS <= WARN_S ? 'warn' : ''

  return (
    <div className="transport-bar">
      <div className="tc-block">
        <div className={`tc-display ${playing ? 'running' : ''}`}>{tc}</div>
        <div className="tc-badges">
          <span className="fps-badge" title="Project frame rate">{fps}</span>
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
            ? 'REC armed: changes to automated parameters in Resolume are written as keyframes at the playhead'
            : 'REC: record changes from Resolume as keyframes (auto-key)'}>
          <span className="rec-dot">●</span><span className="tbtn-label">REC</span>
        </button>
      </div>

      <div className={`remain ${remainClass}`} title="Time until the end of the last clip or audio">
        <span className="remain-label">
          {remainClass === 'danger' ? '!! End' : remainClass === 'warn' ? '▲ End' : 'Remaining'}
        </span>
        <span className="remain-value mono">
          {endFrame === 0 ? '--:--:--' : `−${framesToSmpte(remaining, fps)}`}
        </span>
      </div>

      {show?.bpm != null && (
        <div className="bpm-block" title="BPM (timeline grid)">
          <span className="remain-label">BPM</span>
          <span className="bpm-value mono">{show.bpm}</span>
        </div>
      )}

      <div className="spacer" />

      {overrideCount > 0 && (
        <button className="btn reenable-btn" onClick={onReenable}
          title="The operator moved automated parameters in Resolume, so those lanes are not sending. Click to hand them back to the timeline.">
          ↺ Re-enable {overrideCount}
        </button>
      )}

      <button className={`btn toggle ${browserOpen ? 'on' : ''}`} onClick={onToggleBrowser}
        title="Show or hide Resolume clips">
        Clips
      </button>
    </div>
  )
}
