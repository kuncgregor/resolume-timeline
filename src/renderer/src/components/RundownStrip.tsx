import { useState, useRef, useEffect } from 'react'
import { TabletAccess } from './TabletAccess'
import { useFrame } from '../frameStore'
import { framesToSmpte } from './timeUtils'
import type { RundownEntry, ShowEntry, BreakEntry } from '../../../shared/concert'

interface Props {
  rundown: RundownEntry[]
  activeId: string
  playing: boolean
  endFrame: number               // last frame with content of the active timeline (0 = empty)
  fps: number
  showMode: boolean
  // The showfile (every timeline in one file)
  showfileName: string
  showfilePath: string | null
  showfileDirty: boolean
  autosave: boolean
  savedAt: number | null
  saveError: string | null
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
  onNewShowfile: () => void
  onOpenShowfile: () => void
  onSaveShowfile: () => void
  onSaveShowfileAs: (() => void) | null   // null: no file dialog (browser)
  onRenameShowfile: (name: string) => void
  onToggleAutosave: () => void
  onImportTimeline: () => void
  onExportTimeline: () => void
  onSettings: () => void
  onToggleShowMode: () => void
  onReconnect: () => void
}

const remote: boolean = !!(window as any).timeline?.__remote

const entryMeta = (e: RundownEntry) => e.type === 'break'
  ? `⏸ Break ${(e as BreakEntry).duration}`
  : `Timeline${(e as ShowEntry).show.bpm ? ` · ${(e as ShowEntry).show.bpm} BPM` : ''}`

const entryName = (e: RundownEntry) =>
  e.type === 'show' ? ((e as ShowEntry).show.name || 'Untitled') : ((e as BreakEntry).label || 'Break')

const tcSourceLabel = (src: string) => src === 'ltc-b' ? 'LTC B' : src === 'ltc-a' || src === 'ltc' ? 'LTC A' : 'INT'

export function RundownStrip({
  rundown, activeId, playing, endFrame, fps, showMode,
  showfileName, showfilePath, showfileDirty, autosave, savedAt, saveError,
  resolumeConnected, resolumeHost, currentDeck,
  onSelect, confirmEntryId, onGo, onReorder, onAddShow, onAddBreak, onEdit, onDelete,
  onNewShowfile, onOpenShowfile, onSaveShowfile, onSaveShowfileAs, onRenameShowfile, onToggleAutosave,
  onImportTimeline, onExportTimeline, onSettings,
  onToggleShowMode, onReconnect,
}: Props) {
  const [menu, setMenu] = useState<'add' | 'file' | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropSide, setDropSide] = useState<'before' | 'after'>('after')
  // Delete takes two clicks: the first arms the button, the second removes the entry
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Renaming the showfile in place (click its name)
  const [renaming, setRenaming] = useState<string | null>(null)
  // New / Open over unsaved changes (autosave off) takes a second click
  const [confirmReplace, setConfirmReplace] = useState<'new' | 'open' | null>(null)
  useEffect(() => { if (menu !== 'file') setConfirmReplace(null) }, [menu])
  const replace = (what: 'new' | 'open') => {
    if (showfileDirty && !autosave && confirmReplace !== what) { setConfirmReplace(what); return }
    setMenu(null)
    if (what === 'new') onNewShowfile(); else onOpenShowfile()
  }
  // "Saved 21:04" ticks over to the right minute without a re-render from elsewhere
  const savedLabel = saveError ? 'Not saved'
    : showfileDirty ? (autosave && showfilePath ? 'Saving…' : 'Unsaved')
    : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : showfilePath ? 'Saved' : ''
  const FILES = 'Files are opened and saved on the computer running the app'

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
        {renaming !== null ? (
          <input className="topbar-title-edit" autoFocus value={renaming} onFocus={e => e.target.select()}
            onChange={e => setRenaming(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={() => { onRenameShowfile(renaming); setRenaming(null) }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(null)
            }} />
        ) : (
          <button className="topbar-title" disabled={remote || showMode}
            title={`Showfile: ${showfileName}${showfilePath ? `\n${showfilePath}` : '\nnot saved yet'}${remote || showMode ? '' : '\n\nClick to rename (renames the file too)'}`}
            onClick={e => { e.stopPropagation(); setMenu(null); setRenaming(showfileName) }}>
            {showfileName}
          </button>
        )}
        {!remote && (
          <span className={`save-state ${saveError ? 'danger' : showfileDirty && !(autosave && showfilePath) ? 'dirty' : ''}`}
            title={saveError ?? (autosave ? 'Autosave is on: every change is saved to the showfile' : 'Autosave is off: save with ⌘S')}>
            {showfileDirty && !(autosave && showfilePath) && <span className="dirty-dot">●</span>}{savedLabel}{autosave ? ' · auto' : ''}
          </span>
        )}

        <div className="topbar-group">
          <div className="menu-anchor">
            <button className="btn ghost" disabled={remote} title={remote ? FILES : 'Showfile: every timeline of the show in one file'}
              onClick={e => { e.stopPropagation(); setMenu(m => m === 'file' ? null : 'file') }}>
              Showfile ▾
            </button>
            {menu === 'file' && (
              <div className="dropdown" onClick={e => e.stopPropagation()}>
                <button className={`dropdown-item ${confirmReplace === 'new' ? 'confirm' : ''}`} disabled={showMode}
                  onClick={() => replace('new')}>{confirmReplace === 'new' ? 'Discard unsaved changes? Click again' : 'New showfile'}</button>
                <button className={`dropdown-item ${confirmReplace === 'open' ? 'confirm' : ''}`} disabled={showMode}
                  onClick={() => replace('open')}>{confirmReplace === 'open' ? 'Discard unsaved changes? Click again' : 'Open showfile…'}</button>
                <div className="dropdown-sep" />
                <button className="dropdown-item" onClick={() => { onSaveShowfile(); setMenu(null) }}>
                  Save<span className="dropdown-key">⌘S</span>
                </button>
                {onSaveShowfileAs && (
                  <button className="dropdown-item" onClick={() => { onSaveShowfileAs(); setMenu(null) }}>Save as…</button>
                )}
                <button className="dropdown-item" disabled={showMode} onClick={() => { setMenu(null); setRenaming(showfileName) }}>Rename…</button>
                <button className="dropdown-item" aria-checked={autosave} role="menuitemcheckbox" onClick={onToggleAutosave}
                  title="Save every change to the showfile automatically">
                  Autosave<span className={`dropdown-key ${autosave ? 'on' : ''}`}>{autosave ? 'On' : 'Off'}</span>
                </button>
                <div className="dropdown-sep" />
                <button className="dropdown-item" onClick={() => { onExportTimeline(); setMenu(null) }}>Export timeline…</button>
              </div>
            )}
          </div>

          <div className="menu-anchor">
            <button className="btn ghost" disabled={showMode}
              onClick={e => { e.stopPropagation(); setMenu(m => m === 'add' ? null : 'add') }}>
              + Add ▾
            </button>
            {menu === 'add' && (
              <div className="dropdown" onClick={e => e.stopPropagation()}>
                <button className="dropdown-item" onClick={() => { onAddShow(); setMenu(null) }}>New timeline</button>
                <button className="dropdown-item" disabled={remote} title={remote ? FILES : 'Add a timeline exported from another showfile'}
                  onClick={() => { onImportTimeline(); setMenu(null) }}>Import timeline…</button>
                <div className="dropdown-sep" />
                <button className="dropdown-item" onClick={() => { onAddBreak(); setMenu(null) }}>Break</button>
              </div>
            )}
          </div>

          <button className={`btn ${showfileDirty && !(autosave && showfilePath) ? '' : 'ghost'}`} onClick={onSaveShowfile} disabled={remote}
            title={remote ? FILES : 'Save the showfile (⌘S)'}>
            Save
          </button>

          <button className="btn ghost" onClick={onSettings} disabled={showMode || remote}
            title={remote ? 'Timecode and audio settings are made on the computer running the app' : 'Timeline settings'}>⚙</button>
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

        <TabletAccess />

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
                      <span className="rd-num mono">{String(idx + 1).padStart(2, '0')}</span>
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
                          title="Remove from the showfile"
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); onDelete(entry.id) }}>
                          Delete?
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
                : endFrame > 0 ? <><Remaining endFrame={endFrame} fps={fps} /> to end</> : 'Empty timeline'}
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

// Time to the end of the timeline; its own component, so only it follows the playhead
function Remaining({ endFrame, fps }: { endFrame: number; fps: number }) {
  const frame = useFrame()
  return <span className="nn-remain">−{framesToSmpte(Math.max(0, endFrame - frame), fps)}</span>
}
