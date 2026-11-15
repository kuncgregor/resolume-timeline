// Show-safety alarms, one list for every view: the desktop's health bar and the show view's top
// band show the same conditions with the same words. Shown while playing or in SHOW mode, when a
// silent failure would otherwise go unnoticed from FOH; a manual takeover and Arena recording
// are shown always.

export type ArenaRecState = { armed: boolean; state: 'idle' | 'starting' | 'recording'; file?: string | null; error: string | null }

/** The clock as the app window sees it (it decodes LTC); tablets get it published. */
export interface ClockStatus {
  ltcSelected: boolean         // the timeline's clock is LTC
  ltcActive: boolean           // timecode is arriving
  ltcNotHere: string | null    // it arrives but belongs to another timeline / none
}

export interface HealthInput extends ClockStatus {
  active: boolean              // playing or SHOW mode
  resolumeConnected: boolean
  brokenLanes: number
  manual: { id: string; name: string }[]   // automated parameters the operator took over in Resolume
  arenaRec: ArenaRecState
}

export type AlarmId = 'recording' | 'rec-armed' | 'rec-error' | 'offline' | 'no-ltc' | 'ltc-not-here' | 'manual' | 'broken'

export interface Alarm {
  id: AlarmId
  level: 'danger' | 'warn' | 'rec'
  title: string                // short, uppercase: what the band shows
  detail: string               // one line more: what the health bar adds
}

export function alarmsOf(h: HealthInput): Alarm[] {
  const out: Alarm[] = []
  const r = h.arenaRec
  if (r.state === 'recording') out.push({ id: 'recording', level: 'rec', title: 'RECORDING IN ARENA', detail: r.file ? r.file.split('/').pop()! : '' })
  if (r.state === 'idle' && r.armed && !r.error) out.push({ id: 'rec-armed', level: 'rec', title: 'ARENA REC ARMED', detail: 'the next Play records from the timeline start until its end' })
  if (r.error) out.push({ id: 'rec-error', level: 'danger', title: 'ARENA REC', detail: r.error })
  const noLtc = h.ltcSelected && !h.ltcActive
  if (h.active && !h.resolumeConnected) out.push({ id: 'offline', level: 'danger', title: 'RESOLUME OFFLINE', detail: 'cues and automation are not reaching Arena' })
  if (h.active && noLtc) out.push({ id: 'no-ltc', level: 'danger', title: 'NO LTC', detail: 'the timeline is not following timecode' })
  if (h.active && h.ltcNotHere && !noLtc) out.push({ id: 'ltc-not-here', level: 'warn', title: 'TIMELINE NOT RUNNING', detail: h.ltcNotHere })
  if (h.manual.length) out.push({ id: 'manual', level: 'warn', title: `MANUAL · ${h.manual.length}`, detail: h.manual.map(m => m.name).join(', ') })
  if (h.active && h.brokenLanes > 0) out.push({
    id: 'broken', level: 'warn', title: `${h.brokenLanes} ${h.brokenLanes === 1 ? 'LANE' : 'LANES'} WITHOUT TARGET`,
    detail: 'their parameter no longer exists in Resolume — they send nothing',
  })
  return out
}
