import { useEffect, useRef, useState } from 'react'
import { useFrame } from '../frameStore'
import { alarmsOf, type HealthInput } from '../alarms'

// Show-safety alarms under the top bar (the list and its words: alarms.ts, shared with the show
// view's band): Resolume gone, timecode gone, lanes that lost their target, manual takeovers,
// Arena recording.
interface Props extends HealthInput {
  fps: number                 // take length so far = timeline position (the take starts at 0)
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

export function HealthBar(p: Props) {
  const { manual, fps, onDismissRecError, onReenable, onReconnect } = p
  const alarms = alarmsOf(p)
  const get = (id: string) => alarms.find(a => a.id === id)
  const offline = get('offline'), noLtc = get('no-ltc')
  const offSince = useSince(!!offline)
  const ltcSince = useSince(!!noLtc)
  // Ticks the "for 12s" counters while an alarm is up
  const [now, setNow] = useState(Date.now())
  const timer = useRef<number | null>(null)
  const ticking = !!offline || !!noLtc
  useEffect(() => {
    if (!ticking) return
    timer.current = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [ticking])

  if (!alarms.length) return null
  const recording = get('recording'), recArmed = get('rec-armed'), recError = get('rec-error')
  const notHere = get('ltc-not-here'), manualAlarm = get('manual'), broken = get('broken')
  return (
    <div className="health-bar" role="alert">
      {recording && (
        <div className="health-item recording">
          <span className="health-rec-dot" />
          <b>{recording.title}</b>
          <RecLength fps={fps} />
          <span className="health-file">{recording.detail}</span>
        </div>
      )}
      {recArmed && (
        <div className="health-item rec-armed">
          <b>{recArmed.title}</b>
          <span>{recArmed.detail}</span>
        </div>
      )}
      {recError && (
        <div className="health-item danger">
          <b>{recError.title}</b>
          <span>{recError.detail}</span>
          <button className="btn-sm" onClick={onDismissRecError}>OK</button>
        </div>
      )}
      {offline && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>{offline.title}</b>
          <span>{offline.detail}{offSince ? ` · ${ago(offSince, now)}` : ''}</span>
          <button className="btn-sm" onClick={onReconnect}>Reconnect</button>
        </div>
      )}
      {noLtc && (
        <div className="health-item danger">
          <span className="health-dot" />
          <b>{noLtc.title}</b>
          <span>{noLtc.detail}{ltcSince ? ` · ${ago(ltcSince, now)}` : ''}</span>
        </div>
      )}
      {notHere && (
        <div className="health-item warn">
          <b>{notHere.title}</b>
          <span>{notHere.detail}</span>
        </div>
      )}
      {manualAlarm && (
        <div className="health-item manual">
          <b>{manualAlarm.title}</b>
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
      {broken && (
        <div className="health-item warn">
          <b>{broken.title}</b>
          <span>{broken.detail}</span>
        </div>
      )}
    </div>
  )
}

function RecLength({ fps }: { fps: number }) {
  const frame = useFrame()
  return <span className="mono">{ago(Date.now() - frame / fps * 1000, Date.now())}</span>
}
