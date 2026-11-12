import { useState, useRef } from 'react'
import type { RundownEntry, ShowEntry, BreakEntry } from '../../../shared/concert'

const PRESET_COLORS = [
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C',
  '#1ABC9C', '#F39C12', '#3498DB', '#E91E63', '#00BCD4',
  '#FF6B6B', '#555555',
]

interface Props {
  rundown: RundownEntry[]
  activeId: string
  ltcActive: boolean
  ltcDisplay: string
  concertDirty: boolean
  activeShowDirty: boolean
  concertFilePath: string | null
  onSelect: (id: string) => void
  onReorder: (newOrder: RundownEntry[]) => void
  onAddShow: () => void
  onAddBreak: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onOpenConcert: () => void
  onSaveConcert: () => void
  onOpenShowFile: () => void
  onSaveActiveShow: () => void
  onSettings: () => void
}

export function RundownStrip({
  rundown, activeId, ltcActive, ltcDisplay, concertDirty, activeShowDirty, concertFilePath,
  onSelect, onReorder, onAddShow, onAddBreak, onEdit, onDelete,
  onOpenConcert, onSaveConcert, onOpenShowFile, onSaveActiveShow, onSettings,
}: Props) {
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropSide, setDropSide] = useState<'before' | 'after'>('after')
  const scrollRef = useRef<HTMLDivElement>(null)

  const concertName = concertFilePath
    ? concertFilePath.split('/').pop()?.replace(/\.concert\.json$|\.json$/, '') ?? 'Concert'
    : 'Concert'

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetId(targetId)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropSide(e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
  }

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    if (!dragId || dragId === targetId) { clearDrag(); return }
    const from = rundown.findIndex(e => e.id === dragId)
    const toIdx = rundown.findIndex(e => e.id === targetId)
    if (from < 0 || toIdx < 0) { clearDrag(); return }

    const next = [...rundown]
    const [item] = next.splice(from, 1)
    const insertAt = dropSide === 'before' ? toIdx : toIdx + 1
    next.splice(Math.max(0, from < toIdx ? insertAt - 1 : insertAt), 0, item)
    onReorder(next)
    clearDrag()
  }

  const handleDragEnd = () => clearDrag()
  const clearDrag = () => { setDragId(null); setDropTargetId(null) }

  return (
    <div className="rundown-strip" onClick={() => { setAddMenuOpen(false); setFileMenuOpen(false) }}>

      {/* ── Toolbar ── */}
      <div className="rundown-toolbar">
        <div className="ptb-mac-spacer" style={{ width: 72, flexShrink: 0, WebkitAppRegion: 'drag' } as any} />

        {/* Concert title */}
        <span className="rd-concert-name" title={concertFilePath ?? undefined}>
          {concertName}{concertDirty ? ' ·' : ''}
        </span>

        <div className="rd-toolbar-sep" />

        {/* Add button */}
        <div style={{ position: 'relative' }}>
          <button className="ptb-action-btn" onClick={e => { e.stopPropagation(); setAddMenuOpen(o => !o); setFileMenuOpen(false) }}>
            + Dodaj
          </button>
          {addMenuOpen && (
            <div className="rd-dropdown" onClick={e => e.stopPropagation()}>
              <button className="rd-dropdown-item" onClick={() => { onAddShow(); setAddMenuOpen(false) }}>
                ♪ Nov show
              </button>
              <button className="rd-dropdown-item" onClick={() => { onOpenShowFile(); setAddMenuOpen(false) }}>
                📁 Odpri show iz datoteke
              </button>
              <div className="rd-dropdown-sep" />
              <button className="rd-dropdown-item" onClick={() => { onAddBreak(); setAddMenuOpen(false) }}>
                ⏸ Break / odmor
              </button>
            </div>
          )}
        </div>

        {/* File menu */}
        <div style={{ position: 'relative' }}>
          <button className="ptb-action-btn" onClick={e => { e.stopPropagation(); setFileMenuOpen(o => !o); setAddMenuOpen(false) }}>
            Concert ▾
          </button>
          {fileMenuOpen && (
            <div className="rd-dropdown" onClick={e => e.stopPropagation()}>
              <button className="rd-dropdown-item" onClick={() => { onOpenConcert(); setFileMenuOpen(false) }}>
                📁 Odpri concert
              </button>
              <button className="rd-dropdown-item" onClick={() => { onSaveConcert(); setFileMenuOpen(false) }}>
                💾 Shrani concert{concertDirty ? ' ·' : ''}
              </button>
            </div>
          )}
        </div>

        <button
          className="ptb-action-btn"
          onClick={onSaveActiveShow}
          title="Shrani aktivni show"
          style={{ opacity: activeShowDirty ? 1 : 0.5 }}
        >
          Shrani show{activeShowDirty ? ' ·' : ''}
        </button>

        <div className="rd-toolbar-sep" />

        <button className="ptb-action-btn" onClick={onSettings}>⚙</button>

        <div style={{ flex: 1 }} />

        {ltcActive && (
          <div className="ptb-ltc-status">
            <span className="ptb-ltc-dot live" />
            <span className="ptb-ltc-label">LTC</span>
            <span className="ptb-ltc-tc">{ltcDisplay}</span>
          </div>
        )}
      </div>

      {/* ── Blocks ── */}
      <div className="rundown-scroll" ref={scrollRef}>
        {rundown.map((entry) => {
          const isActive = entry.id === activeId
          const isDragging = entry.id === dragId
          const isDropTarget = entry.id === dropTargetId

          return (
            <div key={entry.id} style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
              {/* Drop indicator: before */}
              {isDropTarget && dropSide === 'before' && (
                <div className="rd-drop-indicator" />
              )}

              <div
                className={`rundown-block${isActive ? ' active' : ''}${entry.type === 'break' ? ' break-type' : ''}`}
                style={{ opacity: isDragging ? 0.35 : 1 }}
                draggable
                onDragStart={e => handleDragStart(e, entry.id)}
                onDragOver={e => handleDragOver(e, entry.id)}
                onDrop={e => handleDrop(e, entry.id)}
                onDragEnd={handleDragEnd}
                onClick={() => onSelect(entry.id)}
                onDoubleClick={() => onEdit(entry.id)}
              >
                <div className="rundown-block-stripe" style={{ background: entry.color }} />
                <div className="rundown-block-body">
                  {entry.type === 'show' ? (
                    <ShowBlock entry={entry as ShowEntry} dirty={(entry as ShowEntry).dirty} />
                  ) : (
                    <BreakBlock entry={entry as BreakEntry} />
                  )}
                </div>
                {/* Hover controls */}
                <div className="rd-block-controls">
                  <button
                    className="rd-block-btn"
                    title="Uredi"
                    onClick={e => { e.stopPropagation(); onEdit(entry.id) }}
                  >✎</button>
                  <button
                    className="rd-block-btn rd-block-btn-del"
                    title="Odstrani"
                    onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
                  >×</button>
                </div>
              </div>

              {/* Drop indicator: after */}
              {isDropTarget && dropSide === 'after' && (
                <div className="rd-drop-indicator" />
              )}
            </div>
          )
        })}

        {rundown.length === 0 && (
          <div className="rd-empty">Klikni "+ Dodaj" za dodajanje skladbe ali breaka</div>
        )}
      </div>
    </div>
  )
}

function ShowBlock({ entry, dirty }: { entry: ShowEntry; dirty: boolean }) {
  const tc = entry.show.clock.offset || '00:00:00:00'
  const bpm = entry.show.bpm
  const name = entry.show.name || 'Brez imena'
  return (
    <>
      <div className="rundown-block-name">
        {dirty && <span style={{ color: '#5599ff', marginRight: 3 }}>·</span>}
        {name}
      </div>
      {bpm != null && (
        <div className="rundown-block-meta">{bpm} BPM</div>
      )}
      <div className="rundown-block-tc">{tc}</div>
      {entry.notes && (
        <div className="rundown-block-notes">{entry.notes}</div>
      )}
    </>
  )
}

function BreakBlock({ entry }: { entry: BreakEntry }) {
  return (
    <>
      <div className="rundown-block-name" style={{ letterSpacing: '0.04em' }}>
        {entry.label || 'Break'}
      </div>
      <div className="rundown-block-meta" style={{ color: '#555' }}>
        {entry.duration}
      </div>
      {entry.notes && (
        <div className="rundown-block-notes">{entry.notes}</div>
      )}
    </>
  )
}

export { PRESET_COLORS }
