import { useEffect, useRef } from 'react'
import type { Marker } from '../../../shared/show'
import { TOUCH } from '../touch'

// Marker editor (Ableton Live's locators): name, a quick song-part name, colour, move, delete.
// Opens on a new marker (ruler right-click › Add marker) and on right-click / double-click of one.
// Markers are the song's sections everywhere (show view, transport bar): a section runs from its
// marker to the next one.

// Section colours: identity, not state, so no mint (on air) or yellow (selection)
export const MARKER_COLORS = ['#ff5c5c', '#f2a33a', '#d9a441', '#6fd6a8', '#4fc1c9', '#7fb8ff', '#b48cff', '#ff8fc8', '#9a9a9a'] as const
export const DEFAULT_MARKER_COLOR = '#f2a33a'

// The usual song parts, each with the colour it brings (unless a colour of your own was picked)
const PARTS: [string, string][] = [
  ['INTRO', '#9a9a9a'], ['VERSE', '#7fb8ff'], ['PRE', '#4fc1c9'], ['CHORUS', '#ff5c5c'],
  ['BRIDGE', '#f2a33a'], ['BREAK', '#b48cff'], ['DROP', '#6fd6a8'], ['OUTRO', '#9a9a9a'],
]

interface Props {
  marker: Marker
  all: Marker[]                    // every marker of the timeline (a song part renumbers its kind)
  timeLabel: string                // where it is ("17.1 · 00:00:32:00")
  style: React.CSSProperties       // position
  onChange: (patch: Partial<Marker>) => void
  onSetAll: (markers: Marker[]) => void
  onMoveToPlayhead: () => void
  onDelete: () => void
  onClose: () => void
}

export function MarkerMenu({ marker, all, timeLabel, style, onChange, onSetAll, onMoveToPlayhead, onDelete, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  // A keyboard is there to type the name at once; a tablet would pop its keyboard over the menu
  useEffect(() => { if (!TOUCH) inputRef.current?.select() }, [])

  const part = (name: string, color: string) => {
    // Every marker of that kind is numbered in time order: VERSE 1, VERSE 2… (one alone is just
    // VERSE). The part's colour comes along unless a colour of your own was picked.
    const kind = new RegExp(`^${name}( \\d+)?$`)
    const group = all.filter(m => m.id === marker.id || kind.test(m.name)).sort((a, b) => a.time.localeCompare(b.time))
    const names = new Map(group.map((m, i) => [m.id, group.length > 1 ? `${name} ${i + 1}` : name]))
    const recolor = marker.color === DEFAULT_MARKER_COLOR || PARTS.some(([, c]) => c === marker.color)
    onSetAll(all.map(m => !names.has(m.id) ? m : { ...m, name: names.get(m.id)!, ...(m.id === marker.id && recolor ? { color } : {}) }))
  }

  return (
    <div className="ctx-menu marker-menu" style={style} onMouseDown={e => e.nativeEvent.stopImmediatePropagation()}
      onPointerDown={e => e.stopPropagation()}>
      <div className="ctx-title">Marker <span className="marker-menu-at mono">{timeLabel}</span></div>
      <input ref={inputRef} className="marker-name" value={marker.name} placeholder="Name (CHORUS, Drop…)" maxLength={40}
        onChange={e => onChange({ name: e.target.value })}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') onClose() }} />
      <div className="marker-parts">
        {PARTS.map(([name, color]) => (
          <button key={name} className="marker-part" style={{ boxShadow: `inset 3px 0 0 ${color}` }} onClick={() => part(name, color)}>{name}</button>
        ))}
      </div>
      <div className="marker-colors" role="radiogroup" aria-label="Colour">
        {MARKER_COLORS.map(c => (
          <button key={c} className={`marker-swatch${marker.color === c ? ' on' : ''}`} style={{ background: c }}
            role="radio" aria-checked={marker.color === c} aria-label={c} onClick={() => onChange({ color: c })} />
        ))}
      </div>
      <div className="ctx-divider" />
      <button className="ctx-btn" onClick={onMoveToPlayhead}>Move to playhead</button>
      <button className="ctx-btn danger" onClick={onDelete}>Delete marker</button>
      <div className="ctx-divider" />
      <button className="ctx-btn dim" onClick={onClose}>Done</button>
    </div>
  )
}
