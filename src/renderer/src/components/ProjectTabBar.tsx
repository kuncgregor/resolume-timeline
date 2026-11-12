import type { Show } from '../../../shared/show'

export interface ProjectEntry {
  id: string
  show: Show
  filePath: string | null
  dirty: boolean
}

interface Props {
  projects: ProjectEntry[]
  activeIdx: number
  ltcActive: boolean          // is LTC decoder running and receiving signal
  ltcDisplay: string          // raw LTC timecode string for status display
  onSelect: (idx: number) => void
  onNew: () => void
  onOpen: () => void
  onClose: (idx: number) => void
  onSave: () => void
  onSettings: () => void
}

export function ProjectTabBar({
  projects, activeIdx, ltcActive, ltcDisplay,
  onSelect, onNew, onOpen, onClose, onSave, onSettings,
}: Props) {
  return (
    <div className="project-tab-bar">
      {/* Space for macOS traffic light buttons (close / minimize / maximize) */}
      <div className="ptb-mac-spacer" />

      <div className="ptb-tabs">
        {projects.map((p, i) => (
          <button
            key={p.id}
            className={`ptb-tab ${i === activeIdx ? 'active' : ''}`}
            onClick={() => onSelect(i)}
            title={p.filePath ?? p.show.name}
          >
            {p.show.clock.source === 'ltc' && (
              <span className={`ptb-ltc-dot ${ltcActive ? 'live' : ''}`} title={ltcActive ? `LTC: ${ltcDisplay}` : 'LTC: ni signala'} />
            )}
            <span className="ptb-tab-name">{p.show.name || 'Brez imena'}</span>
            {p.dirty && <span className="ptb-dirty">·</span>}
            <span className="ptb-close" role="button"
              onClick={e => { e.stopPropagation(); onClose(i) }}>×</span>
          </button>
        ))}
        <button className="ptb-new" onClick={onNew} title="Nov projekt">+</button>
      </div>

      {ltcActive && (
        <div className="ptb-ltc-status">
          <span className="ptb-ltc-label">LTC</span>
          <span className="ptb-ltc-tc">{ltcDisplay}</span>
        </div>
      )}

      <div className="ptb-actions">
        <button className="ptb-action-btn" onClick={onOpen}>Odpri</button>
        <button className="ptb-action-btn" onClick={onSave} disabled={projects.length === 0}>Shrani</button>
        <button className="ptb-action-btn" onClick={onSettings} title="Nastavitve projekta">⚙ Nastavitve</button>
      </div>
    </div>
  )
}
