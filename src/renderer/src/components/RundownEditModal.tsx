import { useState } from 'react'
import { useEscape } from './useEscape'
import type { RundownEntry, BreakEntry, ShowEntry } from '../../../shared/concert'
import { TAG_COLORS } from '../theme'

// Muted Resolume-style tags first, then a few saturated ones and neutral greys
const COLORS = [
  ...TAG_COLORS,
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C', '#1ABC9C',
  '#333333', '#555555',
]

interface Updates {
  color?: string
  notes?: string
  label?: string
  duration?: string
  name?: string        // timeline name (show.name)
}

interface Props {
  entry: RundownEntry
  onSave: (id: string, updates: Updates) => void
  onClose: () => void
}

export function RundownEditModal({ entry, onSave, onClose }: Props) {
  useEscape(onClose)
  const [color, setColor] = useState(entry.color)
  const [notes, setNotes] = useState(entry.notes)
  const [label, setLabel] = useState(entry.type === 'break' ? (entry as BreakEntry).label : '')
  const [name, setName] = useState(entry.type === 'show' ? (entry as ShowEntry).show.name : '')
  const [duration, setDuration] = useState(entry.type === 'break' ? (entry as BreakEntry).duration : '')

  const handleSave = () => {
    const updates: Updates = { color, notes }
    if (entry.type === 'break') { updates.label = label || 'Break'; updates.duration = duration }
    else if (name.trim()) updates.name = name.trim()
    onSave(entry.id, updates)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{entry.type === 'break' ? 'Edit break' : 'Edit timeline'}</span>
          <button className="btn ghost modal-close" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="modal-body">

          {entry.type === 'show' && (
            <div className="modal-section">
              <div className="modal-section-title">Timeline</div>
              <div className="modal-row">
                <span className="modal-label">Name</span>
                <input
                  className="modal-inp modal-inp-mid"
                  value={name} autoFocus
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  placeholder="e.g. Opener"
                />
              </div>
            </div>
          )}

          {entry.type === 'break' && (
            <div className="modal-section">
              <div className="modal-section-title">Break</div>
              <div className="modal-row">
                <span className="modal-label">Name</span>
                <input
                  className="modal-inp modal-inp-mid"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. Intermission"
                />
              </div>
              <div className="modal-row">
                <span className="modal-label">Duration</span>
                <input
                  className="modal-inp modal-tc mono"
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  placeholder="00:20:00:00"
                />
              </div>
            </div>
          )}

          <div className="modal-section">
            <div className="modal-section-title">Colour</div>
            <div className="modal-swatches">
              {COLORS.map(c => (
                <button
                  key={c}
                  className={`modal-swatch ${color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">Notes</div>
            <textarea
              className="modal-inp modal-textarea"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Notes for this song…"
              rows={3}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn modal-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
