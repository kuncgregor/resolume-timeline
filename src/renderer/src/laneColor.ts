// Colour of an automation lane (curve, header stripe, inspector faders): the Resolume colour
// tag of what it controls — the clip for clip parameters, the layer / group otherwise — so
// the timeline matches Arena. Without a tag the lane keeps its own colour.
import type { AutomationSubTrack, ClipCue, GroupTrack, LayerTrack } from '../../shared/show'

/** Resolume colour tag of a layer / group track (synced from Arena), or undefined. */
export function trackTag(t: Pick<LayerTrack | GroupTrack, 'color' | 'appColor'> | null | undefined): string | undefined {
  // withTagColor (App.tsx) keeps the app colour aside in appColor while a tag is applied
  return t && t.appColor !== undefined ? t.color : undefined
}

/** Resolume colour tag of the owner of a lane's parameter, or undefined. */
export function laneTag(auto: AutomationSubTrack, track: LayerTrack | GroupTrack | null | undefined): string | undefined {
  if (auto.ref?.scope === 'clip') {
    const cue: ClipCue | undefined = (track as LayerTrack | undefined)?.clips?.find(c => c.clipId === auto.ref?.clipId)
    return cue?.resolumeColor
  }
  return trackTag(track)
}

export function laneColor(auto: AutomationSubTrack, track: LayerTrack | GroupTrack | null | undefined, fallback: string): string {
  return laneTag(auto, track) ?? auto.color ?? fallback
}

/** Darker shade of a #rrggbb colour (slider fills). */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  const ch = (s: number) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}
