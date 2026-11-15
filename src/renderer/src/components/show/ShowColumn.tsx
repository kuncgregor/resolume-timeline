import type { Show } from '../../../../shared/show'
import type { LaneStatusMap } from '../../laneStatus'
import { tempoOf } from '../../grid'
import { showModelOf } from '../../showModel'
import { Coming, EMPTY_MODEL } from './ShowView'

// SHOW mode in the Desktop style: the editor's right column (where the clip browser is in SETUP)
// lists what comes next, as the tablet show view does. During a break: what the next timeline
// opens with.

export function ShowColumn({ show, preview, laneStatus }: {
  show: Show | null      // the active timeline, or the next one during a break
  preview: boolean       // a break: the next timeline from its start
  laneStatus: LaneStatusMap
}) {
  const model = show ? showModelOf(show) : EMPTY_MODEL
  return (
    <aside className="show-column" aria-label="Coming">
      <div className="sv-colhead">{preview ? `AFTER GO · ${show?.name ?? '—'}` : 'COMING'}</div>
      <Coming model={model} tempo={show ? tempoOf(show) : null} fps={show?.frameRate ?? 25} laneStatus={laneStatus}
        max={12} fixedFrame={preview ? 0 : undefined} />
    </aside>
  )
}
