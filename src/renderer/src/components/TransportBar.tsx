import type { Show, EngineState } from '../../../shared/show'
import { framesToSmpte } from './timeUtils'

interface Props {
  engineState: EngineState
  show: Show | null
  offsetFrames: number
  endFrame: number          // last frame with content (clips / audio); 0 = empty show
  ltcActive: boolean
  recordArmed: boolean
  onToggleRecord: () => void
  overrideCount: number       // lanes the operator took over in Resolume
  onReenable: () => void
  readOnly: boolean
  onPlay: () => void
  onStop: () => void
  onLocate: (frame: number) => void
  onToggleBrowser: () => void
  browserOpen: boolean
}

// Remaining-time thresholds (seconds) for the warning and danger colours
const WARN_S = 30
const DANGER_S = 10

export function TransportBar({
  engineState, show, offsetFrames, endFrame, ltcActive, recordArmed, onToggleRecord,
  overrideCount, onReenable, readOnly, onPlay, onStop, onLocate, onToggleBrowser, browserOpen,
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
          <span className="fps-badge" title="Frame rate projekta">{fps}</span>
          {isLtc ? (
            ltcActive
              ? <span className="chip live" title="Timecode prihaja">● {ltcName}</span>
              : <span className="chip warn blink" title="Ni LTC signala">○ {ltcName} ni signala</span>
          ) : (
            <span className="chip" title="Interna ura">INT</span>
          )}
        </div>
      </div>

      <div className="transport-buttons">
        <button className="tbtn" onClick={() => onLocate(0)} title="Na začetek (Home)">⏮</button>
        <button className={`tbtn ${!playing ? 'stopped' : ''}`} onClick={onStop} title="Stop (Space)">■</button>
        <button className={`tbtn play ${playing ? 'on-live' : ''}`} onClick={playing ? onStop : onPlay}
          title={playing ? 'Predvaja — Space za stop' : 'Predvajaj (Space)'}>
          ▶{playing && <span className="tbtn-label">PLAY</span>}
        </button>
      </div>

      <div className={`remain ${remainClass}`} title="Čas do konca zadnjega clipa ali avdia">
        <span className="remain-label">
          {remainClass === 'danger' ? '!! Konec' : remainClass === 'warn' ? '▲ Konec' : 'Do konca'}
        </span>
        <span className="remain-value mono">
          {endFrame === 0 ? '--:--:--' : `−${framesToSmpte(remaining, fps)}`}
        </span>
      </div>

      {show?.bpm != null && (
        <div className="bpm-block" title="BPM (mreža na časovnici)">
          <span className="remain-label">BPM</span>
          <span className="bpm-value mono">{show.bpm}</span>
        </div>
      )}

      <div className="spacer" />

      {overrideCount > 0 && (
        <button className="btn reenable-btn" onClick={onReenable}
          title="Operater je v Resolume premaknil avtomatizirane parametre; te steze ne pošiljajo. Klikni, da jih vrneš časovnici.">
          ↺ Re-enable {overrideCount}
        </button>
      )}
      <button className={`btn rec-btn ${recordArmed ? 'armed' : ''}`} onClick={onToggleRecord} disabled={readOnly}
        title={recordArmed
          ? 'REC: spremembe avtomatiziranih parametrov v Resolume se zapišejo kot keyframe na playhead'
          : 'Vklopi snemanje keyframov iz Resolume (auto-key)'}>
        ● Rec
      </button>

      <button className={`btn toggle ${browserOpen ? 'on' : ''}`} onClick={onToggleBrowser}
        title="Pokaži ali skrij Resolume clipe">
        Clipi
      </button>
    </div>
  )
}
