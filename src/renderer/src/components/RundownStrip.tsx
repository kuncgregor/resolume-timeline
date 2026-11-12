import { useState, useRef } from 'react'
import type { RundownEntry, ShowEntry, BreakEntry } from '../../../shared/concert'

interface Props {
  rundown: RundownEntry[]
  activeId: string
  playing: boolean
  nowRemaining: string | null    // time to its end, null when empty
  showMode: boolean
  concertDirty: boolean
  activeShowDirty: boolean
  concertFilePath: string | null
  resolumeConnected: boolean
  resolumeHost: string
  currentDeck: { index: number; name: string; color: string; count: number } | null  // deck selected in Resolume
  onSelect: (id: string) => void
  confirmEntryId: string | null   // SHOW mode while playing: this block was clicked once, click again to switch
  onGo: (direction: 1 | -1) => void
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
  onToggleShowMode: () => void
  onReconnect: () => void
}

const entryMeta = (e: RundownEntry) => e.type === 'break'
  ? `⏸ Break ${(e as BreakEntry).duration}`
  : `Timeline${(e as ShowEntry).show.bpm ? ` · ${(e as ShowEntry).show.bpm} BPM` : ''}`

const entryName = (e: RundownEntry) =>
  e.type === 'show' ? ((e as ShowEntry).show.name || 'Untitled') : ((e as BreakEntry).label || 'Break')

const tcSourceLabel = (src: string) => src === 'ltc-b' ? 'LTC B' : src === 'ltc-a' || src === 'ltc' ? 'LTC A' : 'INT'

export function RundownStrip({
  rundown, activeId, playing, nowRemaining, showMode, concertDirty, activeShowDirty, concertFilePath,
  resolumeConnected, resolumeHost, currentDeck,
  onSelect, confirmEntryId, onGo, onReorder, onAddShow, onAddBreak, onEdit, onDelete,
  onOpenConcert, onSaveConcert, onOpenShowFile, onSaveActiveShow, onSettings,
  onToggleShowMode, onReconnect,
}: Props) {
  const [menu, setMenu] = useState<'add' | 'file' | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropSide, setDropSide] = useState<'before' | 'after'>('after')
  // Delete takes two clicks: the first arms the button, the second removes the entry
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const concertName = concertFilePath
    ? concertFilePath.split('/').pop()?.replace(/\.concert\.json$|\.json$/, '') ?? 'Concert'
    : 'Concert'

  const activeIdx = rundown.findIndex(e => e.id === activeId)
  const active = rundown[activeIdx]
  const next = rundown[activeIdx + 1]

  // ── Drag & drop reordering (SETUP only) ──────────────────────────────────

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetId(targetId)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropSide(e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
  }

  const clearDrag = () => { setDragId(null); setDropTargetId(null) }

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    if (!dragId || dragId === targetId) { clearDrag(); return }
    const from = rundown.findIndex(x => x.id === dragId)
    const toIdx = rundown.findIndex(x => x.id === targetId)
    if (from < 0 || toIdx < 0) { clearDrag(); return }
    const reordered = [...rundown]
    const [item] = reordered.splice(from, 1)
    const insertAt = dropSide === 'before' ? toIdx : toIdx + 1
    reordered.splice(Math.max(0, from < toIdx ? insertAt - 1 : insertAt), 0, item)
    onReorder(reordered)
    clearDrag()
  }

  return (
    <div className="rundown" onClick={() => setMenu(null)}>

      {/* ── Top bar: file actions · mode · connection ── */}
      <div className="topbar">
        <div className="topbar-mac-spacer" />
        <span className="topbar-title" title={concertFilePath ?? undefined}>
          {concertName}{concertDirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
        </span>

        <div className="topbar-group">
          <div className="menu-anchor">
            <button className="btn ghost" disabled={showMode}
              onClick={e => { e.stopPropagation(); setMenu(m => m === 'add' ? null : 'add') }}>
              + Add ▾
            </button>
            {menu === 'add' && (
              <div className="dropdown" onClick={e => e.stopPropagation()}>
                <button className="dropdown-item" onClick={() => { onAddShow(); setMenu(null) }}>New timeline</button>
                <button className="dropdown-item" onClick={() => { onOpenShowFile(); setMenu(null) }}>Open timeline from file…</button>
                <div className="dropdown-sep" />
                <button className="dropdown-item" onClick={() => { onAddBreak(); setMenu(null) }}>Break</button>
              </div>
            )}
          </div>

          <div className="menu-anchor">
            <button className="btn ghost"
              onClick={e => { e.stopPropagation(); setMenu(m => m === 'file' ? null : 'file') }}>
              Concert ▾
            </button>
            {menu === 'file' && (
              <div className="dropdown" onClick={e => e.stopPropagation()}>
                <button className="dropdown-item" disabled={showMode}
                  onClick={() => { onOpenConcert(); setMenu(null) }}>Open concert…</button>
                <button className="dropdown-item" onClick={() => { onSaveConcert(); setMenu(null) }}>
                  Save concert{concertDirty ? ' ●' : ''}
                </button>
              </div>
            )}
          </div>

          <button className={`btn ${activeShowDirty ? '' : 'ghost'}`} onClick={onSaveActiveShow}
            title="Save the active timeline to a file">
            Save timeline{activeShowDirty && <span className="dirty-dot">●</span>}
          </button>

          <button className="btn ghost" onClick={onSettings} disabled={showMode} title="Timeline settings">⚙</button>
        </div>

        <div className="spacer" />

        <button
          className={`mode-switch ${showMode ? 'show' : 'setup'}`}
          onClick={onToggleShowMode}
          title={showMode
            ? 'SHOW: editing is locked. Click for SETUP.'
            : 'SETUP: editing allowed. Click for SHOW (locks editing).'}
        >
          <span className={showMode ? '' : 'active'}>Setup</span>
          <span className={showMode ? 'active' : ''}>Show</span>
        </button>

        {currentDeck && currentDeck.count > 1 && (
          <span className="chip deck-chip" style={{ ['--deck-color' as any]: currentDeck.color }}
            title={`Resolume is showing deck ${currentDeck.index} of ${currentDeck.count}. Cues from other decks switch to their deck when they fire.`}>
            Deck {currentDeck.index} · {currentDeck.name}
          </span>
        )}

        <button className={`chip ${resolumeConnected ? 'live' : 'danger blink'} conn-chip`} onClick={onReconnect}
          title={resolumeConnected ? `Connected to Resolume (${resolumeHost}). Click to reconnect.` : 'Resolume is unreachable. Click to retry.'}>
          {resolumeConnected ? `● Resolume ${resolumeHost}` : '✕ Resolume not connected'}
        </button>
      </div>

      {/* ── Rundown row + NOW/NEXT/GO ── */}
      <div className="rundown-row">
        <div className="rundown-scroll" ref={scrollRef}>
          {rundown.map((entry, idx) => {
            const isActive = entry.id === activeId
            const isNext = next?.id === entry.id
            const isLive = isActive && playing && entry.type === 'show'
            const dirty = entry.type === 'show' && (entry as ShowEntry).dirty
            return (
              <div key={entry.id} className="rd-slot">
                {dropTargetId === entry.id && dropSide === 'before' && <div className="rd-drop-indicator" />}
                <div
                  className={`rd-block${isActive ? ' active' : ''}${isLive ? ' live' : ''}${isNext ? ' next' : ''}${entry.type === 'break' ? ' break' : ''}`}
                  style={{ opacity: entry.id === dragId ? 0.35 : 1 }}
                  draggable={!showMode}
                  onDragStart={e => { setDragId(entry.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={e => handleDragOver(e, entry.id)}
                  onDrop={e => handleDrop(e, entry.id)}
                  onDragEnd={clearDrag}
                  onClick={() => onSelect(entry.id)}
                  onDoubleClick={() => { if (!showMode) onEdit(entry.id) }}
                  onMouseLeave={() => { if (confirmDeleteId === entry.id) setConfirmDeleteId(null) }}
                >
                  <div className="rd-stripe" style={{ background: entry.color }} />
                  <div className="rd-body">
                    <div className="rd-head">
                      <span className="rd-num mono">{String(idx + 1).padStart(2, '0')}{dirty ? '*' : ''}</span>
                      {isLive && <span className="chip live">▶ Live</span>}
                      {isActive && !isLive && <span className="chip">Now</span>}
                      {isNext && <span className="chip next">▷ Next</span>}
                      {confirmEntryId === entry.id && <span className="chip warn blink">Click again</span>}
                    </div>
                    <div className="rd-name" title={`${entryName(entry)}${showMode ? '' : ' — double-click to rename'}`}>{entryName(entry)}</div>
                    {entry.type === 'show' ? (() => {
                      // An internal-clock timeline at 00:00:00:00 needs no start TC: leave room for the BPM
                      const sh = (entry as ShowEntry).show
                      const src = tcSourceLabel(sh.clock.source)
                      const start = sh.clock.offset || '00:00:00:00'
                      const parts = [src, ...(src === 'INT' && start === '00:00:00:00' ? [] : [start]), ...(sh.bpm ? [`${sh.bpm} BPM`] : [])]
                      return <div className="rd-meta mono" title={`Clock: ${src} · start ${start}${sh.bpm ? ` · ${sh.bpm} BPM ${sh.beatsPerBar ?? 4}/4` : ''}`}>{parts.join(' · ')}</div>
                    })() : (
                      <div className="rd-meta mono">⏸ {(entry as BreakEntry).duration}</div>
                    )}
                  </div>
                  {!showMode && (
                    <div className={`rd-controls${confirmDeleteId === entry.id ? ' confirming' : ''}`}>
                      <button className="rd-ctl" title="Edit" onClick={e => { e.stopPropagation(); onEdit(entry.id) }}>✎</button>
                      {confirmDeleteId === entry.id ? (
                        <button className="rd-ctl armed"
                          title={dirty ? 'Timeline has unsaved changes' : 'Remove from rundown'}
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); onDelete(entry.id) }}>
                          {dirty ? 'Delete (unsaved)?' : 'Delete?'}
                        </button>
                      ) : (
                        <button className="rd-ctl" title="Remove" onClick={e => { e.stopPropagation(); setConfirmDeleteId(entry.id) }}>✕</button>
                      )}
                    </div>
                  )}
                </div>
                {dropTargetId === entry.id && dropSide === 'after' && <div className="rd-drop-indicator" />}
              </div>
            )
          })}
        </div>

        {/* Now → Next → GO: what is running, what GO will load, and the button itself */}
        <div className="now-next">
          <button className="nn-back" onClick={() => onGo(-1)} disabled={activeIdx <= 0}
            title={activeIdx > 0 ? `Back to: ${entryName(rundown[activeIdx - 1])}` : 'This is the first entry'}>◀</button>
          <div className={`nn-card now ${playing ? 'live' : ''}`}>
            <div className="nn-head">
              <span className="nn-label">Now</span>
              {active && <span className="nn-num mono">{String(activeIdx + 1).padStart(2, '0')}</span>}
              <span className={`nn-state ${playing ? 'live' : ''}`}>{playing ? '▶ Live' : '■ Stopped'}</span>
            </div>
            <div className="nn-name" title={active ? `${entryName(active)}${showMode ? '' : ' — double-click to rename'}` : ''}
              onDoubleClick={() => { if (active && !showMode) onEdit(active.id) }}>{active ? entryName(active) : '—'}</div>
            <div className="nn-sub mono">
              {active?.type === 'break' ? `Break · ${(active as BreakEntry).duration}`
                : nowRemaining ? <><span className="nn-remain">−{nowRemaining}</span> to end</> : 'Empty timeline'}
            </div>
          </div>
          <div className="nn-arrow" aria-hidden>→</div>
          <div className={`nn-card next ${next ? '' : 'empty'}`}>
            <div className="nn-head">
              <span className="nn-label">Next</span>
              {next && <span className="nn-num mono">{String(activeIdx + 2).padStart(2, '0')}</span>}
            </div>
            <div className="nn-name" title={next ? entryName(next) : ''}>{next ? entryName(next) : 'End of rundown'}</div>
            <div className="nn-sub">{next ? entryMeta(next) : 'No more entries'}</div>
          </div>
          <button className="go-btn" onClick={() => onGo(1)} disabled={!next}
            title={next ? `GO: load “${entryName(next)}” (Enter)` : 'No next entry'}>
            <span className="go-word">GO</span>
            <span className="go-hint">{next ? `load ${String(activeIdx + 2).padStart(2, '0')}` : 'end'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
