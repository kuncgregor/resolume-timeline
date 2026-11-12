import { useEffect, useRef, useState } from 'react'

// Show-safety alarms under the top bar. Shown while playing or in SHOW mode, when a
// silent failure would otherwise go unnoticed from FOH: Resolume gone, timecode gone,
// lanes that lost their target.
interface Props {
  active: boolean              // playing or SHOW mode
  resolumeConnected: boolean
  ltcSelected: boolean         // clock source is LTC
  ltcActive: boolean
  ltcNotHere: string | null    // LTC arrives but belongs to another timeline / none
  brokenLanes: number
  // Automated parameters the operator took over live in Resolume (lane id + readable name)
  manual: { id: string; name: string }[]
  arenaRec: { armed: boolean; state: 'idle' | 'starting' | 'recording'; file: string | null; error: string | null }
  recSeconds: number          // take length so far (= timeline position, the take starts at 0)
  onDismissRecError: () => void
  onReenable: (ids?: string[]) => void
  onReconnect: () => void
}

/** Wall-clock time a condition has been true (null while false). */
function useSince(on: boolean): number | null {
  const [since, setSince] = useState<number | null>(null)
  useEffect(() => { setSince(on ? Date.now() : null) }, [on])
  return since
}

const ago = (since: number, now: number) => {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function HealthBar({ active, resolumeConnected, ltcSelected, ltcActive, ltcNotHere, brokenLanes, manual, arenaRec, recSeconds, onDismissRecError, onReenable, onReconnect }: Props) {
  const offline = !resolumeConnected
  const noLtc = ltcSelected && !ltcActive
  const offSince = useSince(offline)
  const ltcSince = useSince(noLtc)
  // Ticks the "for 12s" counters while an alarm is up
  const [now, setNow] = useState(Date.now())
  const timer = useRef<number | null>(null)
  const alarm = active && (offline || noLtc)
  useEffect(() => {
    if (!alarm) return
    timer.current = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [alarm])

  // Manual takeover is shown in SETUP too: a parameter that silently stopped following the
  // timeline is the easiest thing to forget after live VJing
  const rec = arenaRec.state !== 'idle' || arenaRec.armed || !!arenaRec.error
  if (!rec && !manual.length && (!active || (!offline && !noLtc && !ltcNotHere && brokenLanes === 0))) return null
  return (
    <div className="health-bar" role="alert">
      {arenaRec.state === 'recording' && (
        <div className="health-item recording">
          <span className="health-rec-dot" />
          <b>RECORDING IN ARENA</b>
          <span className="mono">{ago(Date.now() - recSeconds * 1000, Date.now())}</span>
          <span className="health-file">{arenaRec.file ? arenaRec.file.split('/').pop() : ''}</span>
        </div>
      )}
      {arenaRec.state === 'idle' && arenaRec.armed && !arenaRec.error && (
        <div className="health-item rec-armed">
          <b>ARENA REC ARMED</b>
          <span>the next Play records from the timeline start until its end</span>
        </div>
      )}
      {arenaRec.error && (
        <div className="health-item danger">
          <b>ARENA REC</b>
          <span>{arenaRec.error}</span>
          <button className="btn-sm" onClick={onDismissRecError}>OK</button>
        </div>
      )}
      {active && offline && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>RESOLUME OFFLINE</b>
          <span>cues and automation are not reaching Arena{offSince ? ` · ${ago(offSince, now)}` : ''}</span>
          <button className="btn-sm" onClick={onReconnect}>Reconnect</button>
        </div>
      )}
      {active && noLtc && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>NO LTC</b>
          <span>the timeline is not following timecode{ltcSince ? ` · ${ago(ltcSince, now)}` : ''}</span>
        </div>
      )}
      {active && ltcNotHere && !noLtc && (
        <div className="health-item warn">
          <b>TIMELINE NOT RUNNING</b>
          <span>{ltcNotHere}</span>
        </div>
      )}
      {manual.length > 0 && (
        <div className="health-item manual">
          <b>MANUAL · {manual.length}</b>
          <span className="health-manual-list">
            {manual.slice(0, 4).map(m => (
              <button key={m.id} className="health-manual-param" title={`${m.name}: you moved it in Resolume, so its automation is paused. Click to give it back to the timeline.`}
                onClick={() => onReenable([m.id])}>{m.name} ↺</button>
            ))}
            {manual.length > 4 && <span className="health-more">+{manual.length - 4} more</span>}
          </span>
          <button className="btn-sm health-back" onClick={() => onReenable()}
            title="Give every taken-over parameter back to the timeline (it follows the timecode again)">↺ Back to timeline</button>
        </div>
      )}
      {active && brokenLanes > 0 && (
        <div className="health-item warn">
          <b>{brokenLanes} {brokenLanes === 1 ? 'LANE' : 'LANES'} WITHOUT TARGET</b>
          <span>their parameter no longer exists in Resolume — they send nothing</span>
        </div>
      )}
    </div>
  )
}
