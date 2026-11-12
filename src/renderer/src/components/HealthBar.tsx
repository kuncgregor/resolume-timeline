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

export function HealthBar({ active, resolumeConnected, ltcSelected, ltcActive, ltcNotHere, brokenLanes, onReconnect }: Props) {
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

  if (!active || (!offline && !noLtc && !ltcNotHere && brokenLanes === 0)) return null
  return (
    <div className="health-bar" role="alert">
      {offline && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>RESOLUME OFFLINE</b>
          <span>cues and automation are not reaching Arena{offSince ? ` · ${ago(offSince, now)}` : ''}</span>
          <button className="btn-sm" onClick={onReconnect}>Reconnect</button>
        </div>
      )}
      {noLtc && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>NO LTC</b>
          <span>the timeline is not following timecode{ltcSince ? ` · ${ago(ltcSince, now)}` : ''}</span>
        </div>
      )}
      {ltcNotHere && !noLtc && (
        <div className="health-item warn">
          <b>TIMELINE NOT RUNNING</b>
          <span>{ltcNotHere}</span>
        </div>
      )}
      {brokenLanes > 0 && (
        <div className="health-item warn">
          <b>{brokenLanes} {brokenLanes === 1 ? 'LANE' : 'LANES'} WITHOUT TARGET</b>
          <span>their parameter no longer exists in Resolume — they send nothing</span>
        </div>
      )}
    </div>
  )
}
