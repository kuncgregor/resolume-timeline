import { useState } from 'react'
import type { RundownEntry, BreakEntry } from '../../../shared/concert'

const COLORS = [
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C',
  '#1ABC9C', '#F39C12', '#3498DB', '#E91E63', '#00BCD4',
  '#FF6B6B', '#95A5A6', '#333333', '#555555',
]

interface Updates {
  color?: string
  notes?: string
  label?: string
  duration?: string
}

interface Props {
  entry: RundownEntry
  onSave: (id: string, updates: Updates) => void
  onClose: () => void
}

export function RundownEditModal({ entry, onSave, onClose }: Props) {
  const [color, setColor] = useState(entry.color)
  const [notes, setNotes] = useState(entry.notes)
  const [label, setLabel] = useState(entry.type === 'break' ? (entry as BreakEntry).label : '')
  const [duration, setDuration] = useState(entry.type === 'break' ? (entry as BreakEntry).duration : '')

  const handleSave = () => {
    const updates: Updates = { color, notes }
    if (entry.type === 'break') { updates.label = label || 'Break'; updates.duration = duration }
    onSave(entry.id, updates)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 300 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{entry.type === 'break' ? 'Uredi break' : 'Uredi vnos'}</span>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {entry.type === 'break' && (
            <div className="modal-section">
              <div className="modal-section-title">Break</div>
              <div className="modal-row">
                <span className="modal-label">Ime</span>
                <input
                  className="modal-inp modal-inp-mid"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="npr. Odmor"
                />
              </div>
              <div className="modal-row">
                <span className="modal-label">Trajanje</span>
                <input
                  className="modal-inp"
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  placeholder="00:20:00:00"
                  style={{ width: 110, fontVariantNumeric: 'tabular-nums' }}
                />
              </div>
            </div>
          )}

          <div className="modal-section">
            <div className="modal-section-title">Barva</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 0' }}>
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 22, height: 22, background: c, border: 'none', borderRadius: 2,
                    cursor: 'pointer', outline: color === c ? '2px solid #fff' : 'none',
                    outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="modal-section" style={{ borderBottom: 'none' }}>
            <div className="modal-section-title">Opomba</div>
            <textarea
              className="modal-inp"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Opombe za to skladbo…"
              rows={3}
              style={{ width: '100%', resize: 'none', marginTop: 4 }}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-sm" onClick={onClose}>Prekliči</button>
          <button className="modal-save-btn" onClick={handleSave}>Shrani</button>
        </div>
      </div>
    </div>
  )
}
