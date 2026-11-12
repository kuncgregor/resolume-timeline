import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ParamRef, LaneKind } from '../../../shared/show'
import { listParams, sameRef, formatValue, normalize, type ParamInfo } from '../../../shared/paramTree'

// Parameter picker popover (spec: "Parameter picker"). Lists every automatable parameter of
// one layer and of the clips that layer's timeline uses, grouped like Resolume shows them.
// Rendered through a portal: the lane headers sit inside a transformed container, which would
// otherwise turn position: fixed into "fixed to that container".

export type PickBinding = 'layer' | { cueId: string }

export interface PickerClip { cueId: string; clipId: number; name: string; json: any | null }

interface Props {
  anchor: DOMRect
  scope?: 'layer' | 'group'   // layerJson is a layer or a layer group
  layerJson: any | null
  clips: PickerClip[]
  automated: ParamRef[]
  mode: 'add' | 'retarget'
  title?: string
  onPick: (info: ParamInfo, binding: PickBinding) => void
  onClose: () => void
}

export const KIND_GLYPH: Record<LaneKind, string> = { range: '∿', choice: '▤', boolean: '⏻' }

const W = 340
const MAX_H = 480
const FIXED_ORDER = ['Layer', 'Transform']
const LATE_ORDER = ['Audio', 'Dashboard', 'Transition']

interface Row { info: ParamInfo; binding: PickBinding; label: string; hay: string; auto: boolean; key: string }
interface Group { key: string; title: string; rows: Row[]; clip: boolean }

export function ParamPicker({ anchor, layerJson, clips, automated, mode, title, onPick, onClose, scope = 'layer' }: Props) {
  const [query, setQuery] = useState('')
  // Clip groups start closed (a layer can carry many clips); layer groups start open
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [hi, setHi] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo<Group[]>(() => {
    if (!layerJson) return []
    const isAuto = (ref: ParamRef) => automated.some(a => sameRef(a, ref))
    const byGroup = new Map<string, Row[]>()
    for (const info of listParams(layerJson, scope)) {
      const row: Row = {
        info, binding: 'layer', label: info.name, key: `L:${info.id}`,
        hay: `${info.group} ${info.name}`.toLowerCase(), auto: isAuto(info.ref),
      }
      byGroup.set(info.group, [...(byGroup.get(info.group) ?? []), row])
    }
    // Layer, Transform, effects in Resolume's order, then Audio / Dashboard / Transition, then the rest
    const names = [...byGroup.keys()]
    const rank = (g: string) => {
      const f = FIXED_ORDER.indexOf(g)
      if (f >= 0) return f
      const l = LATE_ORDER.indexOf(g)
      if (l >= 0) return 1000 + l
      return 10 + names.indexOf(g)
    }
    const out: Group[] = names.sort((a, b) => rank(a) - rank(b))
      .map(g => ({ key: `L:${g}`, title: g, rows: byGroup.get(g)!, clip: false }))

    for (const c of clips) {
      if (!c.json) continue
      const gTitle = `Clip: ${c.name || `#${c.clipId}`}`
      const rows: Row[] = listParams(c.json, 'clip', c.clipId).map(info => ({
        info, binding: { cueId: c.cueId }, label: info.ref.label, key: `C:${c.cueId}:${info.id}`,
        hay: `${gTitle} ${info.group} ${info.name}`.toLowerCase(), auto: isAuto(info.ref),
      }))
      if (rows.length) out.push({ key: `C:${c.cueId}`, title: gTitle, rows, clip: true })
    }
    return out
  }, [layerJson, clips, automated, scope])

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = tokens.length > 0
  const visible = groups
    .map(g => ({ ...g, rows: searching ? g.rows.filter(r => tokens.every(t => r.hay.includes(t))) : g.rows }))
    .filter(g => g.rows.length > 0)
  const isOpen = (g: Group) => searching || (g.clip ? toggled.has(g.key) : !toggled.has(g.key))
  const flat = visible.flatMap(g => (isOpen(g) ? g.rows : []))

  useEffect(() => { setHi(0) }, [query])

  // Keep the highlighted row in view while moving with the arrow keys
  useEffect(() => {
    const el = listRef.current?.querySelector('.pp-row.hi') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  // Outside click closes. A press inside the anchor is ignored so its own click can toggle.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      if (e.clientX >= anchor.left && e.clientX <= anchor.right && e.clientY >= anchor.top && e.clientY <= anchor.bottom) return
      onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [anchor, onClose])

  // Place below the anchor; flip / clamp to stay on screen
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 2 })
  useLayoutEffect(() => {
    const h = rootRef.current?.offsetHeight ?? MAX_H
    const vw = window.innerWidth, vh = window.innerHeight
    const left = Math.max(8, Math.min(anchor.left, vw - W - 8))
    let top = anchor.bottom + 2
    if (top + h > vh - 8) top = anchor.top - h - 2 >= 8 ? anchor.top - h - 2 : Math.max(8, vh - h - 8)
    setPos({ left, top })
  }, [anchor, visible.length, flat.length])

  const pick = (r: Row) => { onPick(r.info, r.binding); onClose() }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(flat.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const r = flat[hi]; if (r) pick(r) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const toggle = (k: string) => setToggled(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })

  let idx = -1
  return createPortal(
    <div
      ref={rootRef} className="param-picker" style={{ left: pos.left, top: pos.top, width: W, maxHeight: MAX_H }}
      onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()} onKeyDown={onKey}
    >
      <div className="pp-head">
        <span className="pp-title">{title ?? (mode === 'add' ? 'Add automation' : 'Retarget lane')}</span>
        <button className="pp-close" title="Close (Esc)" onMouseDown={e => e.preventDefault()} onClick={onClose}>✕</button>
      </div>
      <input
        className="pp-search" autoFocus placeholder="Search parameters… (e.g. blur x)"
        value={query} onChange={e => setQuery(e.target.value)} spellCheck={false}
      />
      <div className="pp-list" ref={listRef}>
        {!layerJson ? (
          <div className="pp-empty">Resolume not connected — parameters cannot be read</div>
        ) : visible.length === 0 ? (
          <div className="pp-empty">{searching ? 'No matches' : 'This layer has no parameters to automate'}</div>
        ) : visible.map(g => {
          const open = isOpen(g)
          return (
            <div key={g.key}>
              <div className={`pp-group ${g.clip ? 'scope-clip' : 'scope-layer'}`} onMouseDown={e => e.preventDefault()} onClick={() => !searching && toggle(g.key)}>
                <span className="pp-arrow">{open ? '▾' : '▸'}</span>
                <span className="pp-group-name">{g.title}</span>
                <span className="pp-group-count">{g.rows.length}</span>
              </div>
              {open && g.rows.map(r => {
                idx++
                const my = idx
                const val = formatValue(r.info.kind, normalize(r.info, r.info.value), r.info, undefined, r.info.suffix)
                return (
                  <div
                    key={r.key}
                    className={`pp-row ${my === hi ? 'hi' : ''}`}
                    title={`${r.info.ref.label}${r.auto ? '\n● already automated' + (mode === 'add' ? ' — picking it focuses the existing lane' : '') : ''}`}
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setHi(my)}
                    onClick={() => pick(r)}
                  >
                    <span className="pp-glyph">{KIND_GLYPH[r.info.kind]}</span>
                    <span className="pp-name">{r.label}</span>
                    <span className="pp-val mono">{val}</span>
                    <span className={`pp-dot ${r.auto ? 'on' : ''}`}>{r.auto ? '●' : ''}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
