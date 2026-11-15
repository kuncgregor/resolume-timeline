import type { Show } from '../../../../shared/show'
import type { RundownEntry } from '../../../../shared/concert'
import type { LaneStatusMap } from '../../laneStatus'
import { tempoOf } from '../../grid'
import { showModelOf } from '../../showModel'
import { EMPTY_MODEL, LayerNow, SectionStrip } from './ShowView'
import { Radar } from './Radar'
import { ShowColumn } from './ShowColumn'
import { useMedia, useShowSize } from './view'

// SHOW mode in the Desktop style: under the editor's top bar and show bar, the tablet show view's
// minimal picture of the timeline instead of the editor's lanes — the sections, LAYER · NOW, the
// radar of the next bars and COMING. During a break: what the next timeline opens with.

export function ShowMain({ show, next, isBreak, playing, endFrame, laneStatus, onSeek, onLocate }: {
  show: Show
  next: RundownEntry | null
  isBreak: boolean
  playing: boolean
  endFrame: number
  laneStatus: LaneStatusMap
  onSeek: (frame: number) => void
  onLocate: (frame: number) => void
}) {
  const big = useMedia('(min-width: 1400px)')
  const size = useShowSize()
  const viewShow = isBreak ? (next?.type === 'show' ? next.show : null) : show
  const model = viewShow ? showModelOf(viewShow) : EMPTY_MODEL
  const tempo = viewShow ? tempoOf(viewShow) : null
  const fps = viewShow?.frameRate ?? show.frameRate
  const fixedFrame = isBreak ? 0 : undefined
  return (
    <div className={`show-main size-${size}`}>
      {!isBreak && <SectionStrip fps={fps} endFrame={endFrame} model={model} tempo={tempo} locked={playing} disabled={false}
        onSeek={onSeek} onLocate={onLocate} />}
      <div className="show-main-row">
        <LayerNow model={model} fps={fps} tempo={tempo} laneStatus={laneStatus} fixedFrame={fixedFrame} preview={isBreak} />
        <Radar model={model} tempo={tempo} fps={fps} bars={big ? 16 : 8} secs={big ? 30 : 15} labels={false}
          fixedFrame={fixedFrame} title={isBreak && viewShow ? `GO OPENS WITH ${viewShow.name}` : undefined} />
        <ShowColumn show={viewShow} preview={isBreak} laneStatus={laneStatus} />
      </div>
    </div>
  )
}
