// Resolume REST API wraps every parameter in { valuetype, id, value }
export interface ResolumeParam<T> {
  valuetype: string
  id: number
  value: T
}

// Helper: extract plain value from either a wrapped param or a plain value
export function rv<T>(param: ResolumeParam<T> | T | undefined, fallback: T): T {
  if (param === undefined || param === null) return fallback
  if (typeof param === 'object' && param !== null && 'value' in (param as object)) {
    return (param as ResolumeParam<T>).value
  }
  return param as T
}

// Resolume names layers "Layer #" where # stands for the layer number
export const layerDisplayName = (name: string, index: number) => name.replace(/#/g, String(index))

export interface ResolumeClip {
  id: number
  name: ResolumeParam<string> | string
  connected: ResolumeParam<boolean | number> | boolean
  thumbnail?: string
  // clips can have many more fields; we only care about these
  [key: string]: unknown
}

export interface ResolumeLayer {
  id: number
  name: ResolumeParam<string> | string
  clips: ResolumeClip[]
  [key: string]: unknown
}

// Colour tags (colorid "1".."6"; "1" = no colour). Measured from official Arena 7
// screenshots (menu swatches, sRGB) — see reports/Skupine barve in snemanje keyframov.md
export const RESOLUME_TAG_COLORS: Record<string, string> = {
  '2': '#C35839', '3': '#81B035', '4': '#00B285', '5': '#0077AF', '6': '#C22596',
}
export const resolumeColor = (colorid: unknown): string | undefined =>
  RESOLUME_TAG_COLORS[String(rv(colorid as any, ''))]

export interface ResolumeLayerGroup {
  id: number
  name: ResolumeParam<string> | string
  colorid?: ResolumeParam<string>
  layers: ResolumeLayer[]
  [key: string]: unknown
}

export interface ResolumeDeck {
  id: number
  name: ResolumeParam<string> | string
  selected: ResolumeParam<boolean> | boolean
  colorid?: ResolumeParam<string>
  [key: string]: unknown
}

export interface ResolumeComposition {
  name: ResolumeParam<string> | string
  layers: ResolumeLayer[]
  decks?: ResolumeDeck[]
  layergroups?: ResolumeLayerGroup[]
  columns: ({ id: number; name: ResolumeParam<string> | string } | null)[]
  [key: string]: unknown
}

/** A Resolume layer's own transition (layer.transition.duration, seconds 0..10, measured on
 *  Arena 7.24): clip changes on the layer blend over it, in Resolume's own time (the blend
 *  doesn't pause or scrub). null = none (0) or not reported. */
export function layerTransition(layer: unknown): { seconds: number; paramId: number } | null {
  const tr = layerTransitionParam(layer)
  return tr && tr.seconds > 0 ? tr : null
}

/** The layer's transition-time parameter, also at 0 (to set it from the app). */
export function layerTransitionParam(layer: unknown): { seconds: number; paramId: number } | null {
  const d = (layer as any)?.transition?.duration
  return d?.id != null ? { seconds: Number(rv(d, 0)), paramId: d.id as number } : null
}
