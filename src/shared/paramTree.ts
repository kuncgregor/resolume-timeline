// Resolume parameter discovery and addressing, shared by renderer (picker, inspector,
// resolver) and main (scheduler value encoding).
//
// Verified on Arena 7 (see research_notes/Layerji in avtomacija efektov/live_rig_measurements.md):
// - REST PUT /parameter/by-id/{id} takes REAL values: ranges as numbers, choices as the exact
//   option string, booleans as true/false. ~3000 updates/s on localhost.
// - OSC addresses of added effects differ per parameter kind and cannot be derived reliably,
//   so the engine sends by id; oscAddress() below is only a display/fallback hint.
// - Two effects of the same name share REST keys; only their order tells them apart.
import type { ParamRef, LaneKind } from './show'

export type RefSegment = ParamRef['path'][number]

export interface ParamInfo {
  ref: ParamRef
  group: string        // picker group: "Layer", "Audio", "Blur 2", "Clip · Transform" …
  name: string         // parameter name: "Opacity", "Blur X Distance"
  kind: LaneKind
  id: number           // runtime id, valid until Resolume reloads / the effect is re-added
  valuetype: string
  min?: number
  max?: number
  options?: string[]
  value: unknown       // current real value
  suffix?: string      // display unit from Resolume's view, e.g. " %", " °"
  multiplier?: number  // display = real × multiplier (opacity 0..1 shown as 0..100 %)
}

const AUTOMATABLE = new Set(['ParamRange', 'ParamChoice', 'ParamState', 'ParamBoolean'])

// Keys that hold Resolume UI/state, not show parameters
const SKIP_KEYS = new Set([
  'id', 'name', 'display_name', 'selected', 'colorid', 'thumbnail', 'clips', 'connected', 'target',
  'triggerstyle', 'beatsnap', 'transporttype', 'ignorecolumntrigger', 'faderstart', 'maskmode',
  'is_user_removable', 'active_clip', 'autopilot', 'faderstart', 'columns', 'decks', 'layers',
])

const kindOf = (valuetype: string): LaneKind =>
  valuetype === 'ParamBoolean' ? 'boolean' : valuetype === 'ParamChoice' || valuetype === 'ParamState' ? 'choice' : 'range'

const RENAME: Record<string, string> = { bypassed: 'Bypass', crossfadergroup: 'Crossfader Group', playdirection: 'Play Direction', playmode: 'Play Mode', playmodeaway: 'Play Mode Away' }
const title = (s: string) => {
  if (RENAME[s]) return RENAME[s]
  const t = s.replace(/_/g, ' ')
  return t.replace(/\b\w/g, c => c.toUpperCase())
}

function effectLabel(name: string, instance: number, displayName?: string) {
  const base = displayName && displayName !== name ? displayName : name
  return instance > 1 ? `${base} ${instance}` : base
}

/** Every automatable parameter under a layer or clip JSON, in Resolume's order. */
export function listParams(root: any, scope: ParamRef['scope'], clipId?: number): ParamInfo[] {
  const out: ParamInfo[] = []
  const prefix = scope === 'clip' ? 'Clip · ' : scope === 'group' ? 'Group · ' : ''
  const top = scope === 'clip' ? 'Clip' : scope === 'group' ? 'Group' : 'Layer'

  const visit = (node: any, path: RefSegment[], group: string, key: string) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.valuetype === 'string') {
      if (!AUTOMATABLE.has(node.valuetype) || typeof node.id !== 'number') return
      if (node.valuetype === 'ParamRange' && (typeof node.min !== 'number' || typeof node.max !== 'number')) return
      const name = title(key)
      out.push({
        ref: { scope, clipId, path, label: group === top ? name : `${group.replace(prefix, '')} › ${name}` },
        group, name, kind: kindOf(node.valuetype), id: node.id, valuetype: node.valuetype,
        min: node.min, max: node.max, options: Array.isArray(node.options) ? node.options.map(String) : undefined,
        value: node.value, suffix: node.view?.suffix || undefined,
        multiplier: typeof node.view?.multiplier === 'number' && node.view.multiplier !== 1 ? node.view.multiplier : undefined,
      })
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k) || !v || typeof v !== 'object') continue
      if (k === 'effects' && Array.isArray(v)) {
        const seen = new Map<string, number>()
        for (const fx of v as any[]) {
          if (!fx || typeof fx.name !== 'string') continue
          const instance = (seen.get(fx.name) ?? 0) + 1
          seen.set(fx.name, instance)
          const fxGroup = prefix + effectLabel(fx.name, instance, fx.display_name)
          const fxPath = [...path, 'effects', { effect: fx.name, instance }]
          if (fx.bypassed) visit(fx.bypassed, [...fxPath, 'bypassed'], fxGroup, 'Bypass')
          if (fx.mixer) for (const [mk, mv] of Object.entries(fx.mixer)) visit(mv, [...fxPath, 'mixer', mk], fxGroup, mk)
          if (fx.params) for (const [pk, pv] of Object.entries(fx.params)) visit(pv, [...fxPath, 'params', pk], fxGroup, pk)
        }
        continue
      }
      if (Array.isArray(v)) continue
      const childGroup = group !== top ? group
        : k === 'audio' ? prefix + 'Audio'
        : k === 'dashboard' ? prefix + 'Dashboard'
        : k === 'transport' ? prefix + 'Transport'
        : k === 'transition' ? prefix + 'Transition'
        : group
      visit(v, [...path, k], childGroup, k)
    }
  }

  visit(root, [], top, '')
  return out
}

const segEq = (a: RefSegment, b: RefSegment) =>
  typeof a === 'string' ? a === b
    : typeof b !== 'string' && a.effect === b.effect && a.instance === b.instance

/** Current parameter for a stable ref, or null when it no longer exists. */
export function resolveRef(root: any, ref: ParamRef): ParamInfo | null {
  if (!root) return null
  const found = listParams(root, ref.scope, ref.clipId)
    .find(p => p.ref.path.length === ref.path.length && p.ref.path.every((s, i) => segEq(s, ref.path[i])))
  return found ?? null
}

/** Stable ref for a runtime parameter id (migrating shows that only stored the id). */
export function findById(root: any, id: number, scope: ParamRef['scope'], clipId?: number): ParamInfo | null {
  return root ? listParams(root, scope, clipId).find(p => p.id === id) ?? null : null
}

/** Normalized 0..1 value → value for REST PUT /parameter/by-id. */
export function toRestValue(
  kind: LaneKind, v: number, range: { min?: number; max?: number; options?: string[] }, option?: string,
): number | string | boolean {
  if (kind === 'boolean') return v >= 0.5
  if (kind === 'choice') {
    const opts = range.options ?? []
    if (option && opts.includes(option)) return option
    return opts[Math.round(Math.max(0, Math.min(1, v)) * Math.max(0, opts.length - 1))] ?? option ?? ''
  }
  const min = range.min ?? 0, max = range.max ?? 1
  return min + Math.max(0, Math.min(1, v)) * (max - min)
}

/** Real Resolume value → normalized 0..1 (for snapshots and display). */
export function normalize(info: Pick<ParamInfo, 'kind' | 'min' | 'max' | 'options'>, value: unknown): number {
  if (info.kind === 'boolean') return value ? 1 : 0
  if (info.kind === 'choice') {
    const opts = info.options ?? []
    const i = opts.indexOf(String(value))
    return opts.length > 1 && i >= 0 ? i / (opts.length - 1) : 0
  }
  const min = info.min ?? 0, max = info.max ?? 1
  return max > min && typeof value === 'number' ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
}

/** Human-readable real value for a normalized lane value. */
export function formatValue(
  kind: LaneKind, v: number,
  range: { min?: number; max?: number; options?: string[]; suffix?: string; multiplier?: number },
  option?: string, suffix?: string,
): string {
  const real = toRestValue(kind, v, range, option)
  if (typeof real === 'boolean') return real ? 'On' : 'Off'
  if (typeof real === 'string') return real || '—'
  // Resolume's own display rule: value × multiplier with its suffix (" %", " °")
  const m = range.multiplier ?? 1
  const shown = real * m
  const span = Math.abs((range.max ?? 1) - (range.min ?? 0)) * m
  const unit = (suffix ?? range.suffix ?? '').trim()
  return `${shown.toFixed(span > 10 ? 0 : span > 1 ? 2 : 3)}${unit ? ` ${unit}` : ''}`
}

/** OSC address hint for display / copy (not used for sending). See module comment. */
export function oscAddress(ref: ParamRef, layerIndex: number, clipSlot?: number): string {
  const osc = (s: string) => s.toLowerCase().replace(/[\s()\-]/g, '')
  // layerIndex is the group index for scope 'group' (verified: /composition/groups/{n}/master)
  let addr = ref.scope === 'group' ? `/composition/groups/${layerIndex}`
    : `/composition/layers/${layerIndex}` + (ref.scope === 'clip' ? `/clips/${clipSlot ?? 0}` : '')
  const p = ref.path
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (typeof seg !== 'string') {
      const fx = osc(seg.effect) + (seg.instance > 1 ? seg.instance : '')
      const section = p[i + 1], param = p[i + 2]
      const builtinTransform = seg.effect === 'Transform' && seg.instance === 1
      if (section === 'bypassed') return `${addr}/${fx}/bypassed`
      if (section === 'mixer') return `${addr}/${fx}/mixer/${osc(String(param))}`
      if (builtinTransform || String(param).toLowerCase() === 'opacity') return `${addr}/${fx}/${osc(String(param))}`
      return `${addr}/${fx}/effect/${osc(String(param))}`
    }
    if (seg === 'params') continue
    addr += `/${osc(seg)}`
  }
  return addr
}

/** True when two refs point at the same parameter (same scope, clip and path). */
export function sameRef(a: ParamRef | undefined, b: ParamRef | undefined): boolean {
  if (!a || !b || a.scope !== b.scope || (a.clipId ?? null) !== (b.clipId ?? null) || a.path.length !== b.path.length) return false
  return a.path.every((s, i) => segEq(s, b.path[i]))
}

/** Resolved Resolume parameter for an automation lane (runtime; renderer → engine). */
export interface LaneTarget { paramId: number; kind: LaneKind; min?: number; max?: number; options?: string[] }
