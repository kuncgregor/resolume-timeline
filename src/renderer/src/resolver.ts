// Maps every automation lane's stable ParamRef to the live Resolume parameter. Runs on
// every composition update and show change: ids change when Resolume reloads or effects
// are re-added, paths don't. Old lanes (OSC address / runtime id only) are migrated.
import type { Show, LayerTrack, AutomationSubTrack } from '../../shared/show'
import type { ResolumeComposition } from '../../shared/resolume'
import { listParams, resolveRef, findById, oscAddress, type ParamInfo, type LaneTarget } from '../../shared/paramTree'
import type { LaneStatusMap } from './laneStatus'

export interface Resolution {
  status: LaneStatusMap
  targets: Record<string, LaneTarget>
  // Lane fields to store back into the show (migration, latest known range/options)
  updates: { trackIdx: number; autoIdx: number; updates: Partial<AutomationSubTrack> }[]
}

const sameList = (a?: string[], b?: string[]) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b?.[i])

/** Lane fields describing a resolved parameter; also used when a lane is created. */
export function laneFieldsFor(info: ParamInfo, layerIndex: number, clipSlot?: number): Partial<AutomationSubTrack> {
  return {
    ref: info.ref, kind: info.kind, options: info.options, min: info.min, max: info.max,
    name: info.name, target: oscAddress(info.ref, layerIndex, clipSlot),
  }
}

function legacyMatch(auto: AutomationSubTrack, layer: any, layerIndex: number): { info: ParamInfo; slot?: number } | null {
  if (auto.paramId !== undefined) {
    const byLayer = findById(layer, auto.paramId, 'layer')
    if (byLayer) return { info: byLayer }
    for (const [i, clip] of (layer.clips ?? []).entries()) {
      const byClip = findById(clip, auto.paramId, 'clip', clip.id)
      if (byClip) return { info: byClip, slot: i + 1 }
    }
  }
  const target = auto.target?.toLowerCase()
  if (!target) return null
  const clipMatch = /\/clips\/(\d+)\//.exec(target)
  if (clipMatch) {
    const slot = Number(clipMatch[1])
    const clip = layer.clips?.[slot - 1]
    const info = clip && listParams(clip, 'clip', clip.id).find(p => oscAddress(p.ref, layerIndex, slot) === target)
    return info ? { info, slot } : null
  }
  const info = listParams(layer, 'layer').find(p => oscAddress(p.ref, layerIndex) === target)
  return info ? { info } : null
}

export function resolveShow(show: Show, comp: ResolumeComposition | null): Resolution {
  const status: LaneStatusMap = {}
  const targets: Record<string, LaneTarget> = {}
  const updates: Resolution['updates'] = []

  show.tracks.forEach((track, trackIdx) => {
    if (track.type !== 'layer') return
    const lt = track as LayerTrack
    const layer = comp?.layers?.find(l => l?.id === lt.resolumeLayerId) as any
    lt.automations.forEach((auto, autoIdx) => {
      if (!comp) { status[auto.id] = { state: 'offline' }; return }
      if (!layer) { status[auto.id] = { state: 'broken', reason: 'Layer ni več v Resolume' }; return }

      let info: ParamInfo | null = null
      if (auto.ref) {
        const root = auto.ref.scope === 'clip'
          ? (layer.clips ?? []).find((c: any) => c?.id === auto.ref!.clipId) : layer
        info = root ? resolveRef(root, auto.ref) : null
        if (!info) {
          status[auto.id] = {
            state: 'broken',
            reason: auto.ref.scope === 'clip' && !root
              ? `Clip ni več v Resolume (${auto.ref.label})`
              : `Parameter ni več v Resolume: ${auto.ref.label}`,
          }
          return
        }
        // Keep the last known range/options in the show so the lane still reads correctly offline
        if (info.min !== auto.min || info.max !== auto.max || info.kind !== (auto.kind ?? 'range') || !sameList(info.options, auto.options))
          updates.push({ trackIdx, autoIdx, updates: { min: info.min, max: info.max, kind: info.kind, options: info.options } })
      } else {
        const match = legacyMatch(auto, layer, lt.resolumeLayerIndex)
        if (!match) { status[auto.id] = { state: 'legacy', reason: 'Stara steza: pošilja se po OSC naslovu' }; return }
        info = match.info
        updates.push({ trackIdx, autoIdx, updates: { ...laneFieldsFor(info, lt.resolumeLayerIndex, match.slot), paramId: undefined } })
      }

      status[auto.id] = { state: 'ok', info }
      targets[auto.id] = { paramId: info.id, kind: info.kind, min: info.min, max: info.max, options: info.options }
    })
  })
  return { status, targets, updates }
}
