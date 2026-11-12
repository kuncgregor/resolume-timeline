// Maps every automation lane's stable ParamRef to the live Resolume parameter. Runs on
// every composition update and show change: ids change when Resolume reloads or effects
// are re-added, paths don't. Old lanes (OSC address / runtime id only) are migrated.
import type { Show, LayerTrack, GroupTrack, AutomationSubTrack } from '../../shared/show'
import { rv, type ResolumeComposition } from '../../shared/resolume'
import { listParams, resolveRef, findById, oscAddress, type ParamInfo, type LaneTarget } from '../../shared/paramTree'
import type { LaneStatusMap } from './laneStatus'

export interface Resolution {
  status: LaneStatusMap
  targets: Record<string, LaneTarget>
  // Lane fields to store back into the show (migration, latest known range/options)
  updates: { trackIdx: number; autoIdx: number; updates: Partial<AutomationSubTrack> }[]
}

// Resolume's REST lists only the clips of the deck it is showing. Clips seen earlier are
// remembered by id so lanes on clips of other decks keep their parameters (ids stay valid
// while the clip plays across a deck switch).
const clipCache = new Map<number, any>()

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

  for (const l of comp?.layers ?? []) for (const c of (l as any)?.clips ?? []) if (c?.id != null) clipCache.set(c.id, c)
  const shownDeck = comp?.decks?.find(d => !!rv((d as any)?.selected, false))?.id

  show.tracks.forEach((track, trackIdx) => {
    if (track.type !== 'layer' && track.type !== 'group') return
    const isGroup = track.type === 'group'
    const lt = track as LayerTrack
    // Group lanes resolve against the layer-group JSON (Arena), layer lanes against the layer
    const layer = (isGroup
      ? comp?.layergroups?.find(g => g?.id === (track as GroupTrack).resolumeGroupId)
      : comp?.layers?.find(l => l?.id === lt.resolumeLayerId)) as any
    const ownerIndex = isGroup ? (track as GroupTrack).resolumeGroupIndex : lt.resolumeLayerIndex
    lt.automations.forEach((auto, autoIdx) => {
      if (!comp) { status[auto.id] = { state: 'offline' }; return }
      if (!layer) { status[auto.id] = { state: 'broken', reason: isGroup ? 'Group no longer exists in Resolume' : 'Layer no longer exists in Resolume' }; return }

      let info: ParamInfo | null = null
      if (auto.ref) {
        let root = auto.ref.scope === 'clip'
          ? (layer.clips ?? []).find((c: any) => c?.id === auto.ref!.clipId) : layer
        if (!root && auto.ref.scope === 'clip') {
          root = clipCache.get(auto.ref.clipId!)
          const cue = lt.clips?.find(c => c.id === auto.clipId) ?? lt.clips?.find(c => c.clipId === auto.ref!.clipId)
          // Missing from the shown deck is only an error when it is the clip's own deck (or
          // there is just one deck); cues from before deck tagging have no deck to compare
          const multiDeck = (comp.decks?.length ?? 0) > 1
          if (!root && multiDeck && cue?.deckId !== shownDeck) {
            status[auto.id] = {
              state: 'elsewhere',
              reason: cue?.deckId != null
                ? `Clip is in deck ${cue.deckName ?? cue.deckIndex ?? ''} — Resolume is showing another deck`
                : 'Clip is not in the deck Resolume is showing — show its deck to check it',
            }
            return
          }
        }
        info = root ? resolveRef(root, auto.ref) : null
        if (!info) {
          status[auto.id] = {
            state: 'broken',
            reason: auto.ref.scope === 'clip' && !root
              ? `Clip no longer exists in Resolume (${auto.ref.label})`
              : `Parameter no longer exists in Resolume: ${auto.ref.label}`,
          }
          return
        }
        // Keep the last known range/options in the show so the lane still reads correctly offline
        if (info.min !== auto.min || info.max !== auto.max || info.kind !== (auto.kind ?? 'range') || !sameList(info.options, auto.options))
          updates.push({ trackIdx, autoIdx, updates: { min: info.min, max: info.max, kind: info.kind, options: info.options } })
      } else {
        const match = isGroup ? null : legacyMatch(auto, layer, ownerIndex)
        if (!match) { status[auto.id] = { state: 'legacy', reason: 'Legacy lane: sent by OSC address' }; return }
        info = match.info
        updates.push({ trackIdx, autoIdx, updates: { ...laneFieldsFor(info, ownerIndex, match.slot), paramId: undefined } })
      }

      status[auto.id] = { state: 'ok', info }
      targets[auto.id] = { paramId: info.id, kind: info.kind, min: info.min, max: info.max, options: info.options }
    })
  })
  return { status, targets, updates }
}
