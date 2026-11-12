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

export interface ResolumeComposition {
  name: ResolumeParam<string> | string
  layers: ResolumeLayer[]
  columns: ({ id: number; name: ResolumeParam<string> | string } | null)[]
  [key: string]: unknown
}
