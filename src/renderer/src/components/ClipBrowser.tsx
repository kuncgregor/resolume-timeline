import { useEffect, useState, useCallback, useRef } from 'react'
import type { ResolumeComposition, ResolumeLayer, ResolumeClip } from '../../../shared/resolume'
import type { Track, LayerTrack } from '../../../shared/show'
import type { DragClipData } from '../App'
import { rv, layerDisplayName } from '../../../shared/resolume'
import { decksOf } from '../decks'
import { TOUCH } from '../touch'

// Empty slots are listed by Resolume too; they cannot be triggered meaningfully
const isEmptySlot = (clip: ResolumeClip) => rv(clip.connected as any, '') === 'Empty'

const api = (window as any).timeline

interface Props {
  tracks: Track[]
  liveComposition: ResolumeComposition | null   // the app's 2 s polling: refresh when layers, clips or the deck change
  onClose: () => void
  onDragStart: (data: DragClipData) => void
  onDragEnd: () => void
  onPlace: (clips: DragClipData[]) => void   // touch: picked clips go where the timeline is tapped
}

// What the list shows: deck, layers and their non-empty clips. A change means a refresh.
function contentKey(comp: ResolumeComposition | null): string {
  if (!comp) return ''
  const decks = decksOf(comp).map(d => `${d.id}${d.selected ? '*' : ''}=${d.name}`).join(',')
  return `${decks}|` + (comp.layers ?? []).filter(Boolean).map(l =>
    `${l.id}:${rv(l.name, '')}:` + (l.clips ?? []).filter(c => c && !isEmptySlot(c)).map(c => `${c.id}=${rv(c.name, '')}`).join(',')
  ).join(';')
}

export function ClipBrowser({ tracks, liveComposition, onClose, onDragStart, onDragEnd, onPlace }: Props) {
  const [composition, setComposition] = useState<ResolumeComposition | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const thumbsRef = useRef(thumbnails)
  thumbsRef.current = thumbnails
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set<number>([999999]))
  const [query, setQuery] = useState('')
  // Selected clips (one layer at a time): dragging one of them drags them all, in list order
  const [picked, setPicked] = useState<{ layerId: number; ids: number[]; anchor: number } | null>(null)

  // quiet: background refresh after a change in Resolume — no "Loading…" flash
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const comp = await api.getComposition()
      if (!comp) {
        setError('Resolume is unreachable.\nPreferences → Webserver → Enable')
      } else {
        setComposition(comp)
        // Collapse all by default when composition first loads
        setCollapsed(prev => {
          if (prev.has(999999)) {
            return new Set((comp.layers ?? []).filter(Boolean).map((l: any) => l.id))
          }
          return prev
        })
        const jobs: Promise<void>[] = []
        for (const layer of comp.layers ?? []) {
          for (const clip of layer?.clips ?? []) {
            if (!clip || isEmptySlot(clip) || thumbsRef.current[`${layer.id}-${clip.id}`]) continue
            jobs.push(api.getThumbnail(layer.id, clip.id).then((t: string | null) => {
              if (t) setThumbnails(prev => ({ ...prev, [`${layer.id}-${clip.id}`]: t }))
            }))
          }
        }
        await Promise.all(jobs)
      }
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [])

  // Resolume only reports the selected deck's clips, so the list follows the selected deck
  // The deck clicked shows as selected at once: loading the new deck's composition takes
  // up to ~1.5 s, and a key that didn't react looked like the click was lost
  const [pendingDeck, setPendingDeck] = useState<number | null>(null)
  const decks = decksOf(composition).map(d => pendingDeck == null ? d : { ...d, selected: d.index === pendingDeck })
  const shownDeck = decks.find(d => d.selected)
  // Follow Resolume: clips added, layers added/renamed, another deck shown
  const liveKey = contentKey(liveComposition)
  useEffect(() => {
    if (!loading && liveKey && composition && liveKey !== contentKey(composition)) refresh(true)
  }, [liveKey])
  const showDeck = async (index: number) => {
    setPendingDeck(index)
    try {
      if (!(await api.selectDeck(index))) return
      // Resolume reports the previous deck for ~100 ms after the switch (it loads the deck):
      // reading too early showed the old deck again, as if the click was lost
      for (let t0 = Date.now(); Date.now() - t0 < 2000;) {
        const comp = await api.getComposition()
        if (decksOf(comp).find(d => d.selected)?.index === index) break
        await new Promise(r => setTimeout(r, 100))
      }
      await refresh(true)
    } finally { setPendingDeck(p => p === index ? null : p) }
  }

  // Timeline cues per deck: marks the decks the show actually fires from
  const cuesByDeck = new Map<number, number>()
  for (const t of tracks) if (t.type === 'layer')
    for (const c of (t as LayerTrack).clips) if (c.deckId !== undefined) cuesByDeck.set(c.deckId, (cuesByDeck.get(c.deckId) ?? 0) + 1)

  const trackedIds = new Set(
    tracks.filter(t => t.type === 'layer').map(t => (t as LayerTrack).resolumeLayerId)
  )

  const dragData = (layer: ResolumeLayer, clip: ResolumeClip, li: number, ci: number): DragClipData => ({
    layerIndex: li + 1, layerId: layer.id,
    clipIndex: ci + 1, clipId: clip.id, clipName: rv(clip.name, `Slot ${ci + 1}`),
    ...(shownDeck ? { deckId: shownDeck.id, deckIndex: shownDeck.index, deckName: shownDeck.name } : {}),
  })

  // Click selects a clip, ⌘-click adds / removes one, Shift-click a range (within one layer)
  const pick = (e: React.MouseEvent, layerId: number, clipId: number, order: number[]) => {
    setPicked(prev => {
      const same = prev?.layerId === layerId ? prev : null
      if (e.metaKey || e.ctrlKey || TOUCH) {   // touch: a tap adds / removes, no modifier keys
        const ids = same?.ids.includes(clipId) ? same.ids.filter(id => id !== clipId) : [...(same?.ids ?? []), clipId]
        return ids.length ? { layerId, ids, anchor: clipId } : null
      }
      if (e.shiftKey && same) {
        const a = order.indexOf(same.anchor), b = order.indexOf(clipId)
        if (a >= 0 && b >= 0) return { layerId, ids: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: same.anchor }
      }
      return { layerId, ids: [clipId], anchor: clipId }
    })
  }

  // Dragging a selected clip takes the whole selection (list order); another clip goes alone
  const handleDragStart = (e: React.DragEvent, layer: ResolumeLayer, clip: ResolumeClip, li: number, ci: number,
    rows: { clip: ResolumeClip; ci: number }[]) => {
    const group = picked?.layerId === layer.id && picked.ids.includes(clip.id)
      ? rows.filter(r => picked.ids.includes(r.clip.id)) : [{ clip, ci }]
    if (!group.some(r => r.clip.id === clip.id) || group.length === 1) setPicked({ layerId: layer.id, ids: [clip.id], anchor: clip.id })
    const data = group.map(r => dragData(layer, r.clip, li, r.ci))
    e.dataTransfer.setData('application/timeline-clip', JSON.stringify(data))
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart(data[0])
  }

  const toggleCollapse = (id: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const q = query.trim().toLowerCase()

  return (
    <div className="clip-browser">
      <div className="browser-header">
        <span className="browser-title">Clips</span>
        <button className="btn ghost browser-icon" onClick={() => refresh()} disabled={loading} title="Refresh from Resolume">
          {loading ? '…' : '↺'}
        </button>
        <button className="btn ghost browser-icon" onClick={onClose} title="Close">✕</button>
      </div>

      {decks.length > 0 && (
        // Numbered keys scale to 10+ decks (Resolume's own tabs are names; names don't fit
        // ten across a side panel). The shown deck's full name sits on the line below.
        <div className="browser-decks">
          <div className="deck-keys" title="Resolume decks. Clips you drag from a deck fire from that deck."
            // Up to 10 per row, rows balanced (12 decks = 2 × 6, not 10 + 2)
            style={{ gridTemplateColumns: `repeat(${Math.ceil(decks.length / Math.ceil(decks.length / 10))}, 1fr)` }}>
            {decks.map(d => {
              const used = cuesByDeck.get(d.id) ?? 0
              return (
                <button key={d.id}
                  className={`deck-key ${d.selected ? 'on' : ''}`}
                  style={{ ['--deck-color' as any]: d.color }}
                  onClick={() => { if (!d.selected) showDeck(d.index) }}
                  title={`Deck ${d.index}: ${d.name}${used ? ` · ${used} ${used === 1 ? 'cue' : 'cues'} on the timeline` : ''}${d.selected ? ' (shown)' : '\nClick: show this deck (switches the deck in Resolume)'}`}
                >
                  {d.index}
                  {used > 0 && <span className="deck-key-dot" />}
                </button>
              )
            })}
          </div>
          {shownDeck && (
            <div className="deck-current" style={{ ['--deck-color' as any]: shownDeck.color }}>
              <span className="deck-current-num">D{shownDeck.index}</span>
              <span className="deck-current-name" title={shownDeck.name}>{shownDeck.name}</span>
              {(cuesByDeck.get(shownDeck.id) ?? 0) > 0 && (
                <span className="deck-current-used">{cuesByDeck.get(shownDeck.id)} on timeline</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="browser-search">
        <input
          className="browser-search-inp" type="search" placeholder="Search clips…"
          value={query} onChange={e => setQuery(e.target.value)}
        />
      </div>

      <div className="browser-body">
        {loading && <div className="browser-msg">Loading…</div>}
        {!loading && error && <div className="browser-msg error">{error}</div>}

        {!loading && !error && composition && (composition.layers ?? []).map((layer, li) => {
          if (!layer) return null
          const layerName = layerDisplayName(rv(layer.name, `Layer ${li + 1}`), li + 1)
          const hasTrack = trackedIds.has(layer.id)
          // Keep the original slot index: it is the clip number Resolume expects over OSC
          const clips = (layer.clips ?? [])
            .map((clip, ci) => ({ clip, ci }))
            .filter(({ clip }) => clip && !isEmptySlot(clip))
            .filter(({ clip, ci }) => !q || rv(clip.name, `Slot ${ci + 1}`).toLowerCase().includes(q))
          if (q && clips.length === 0) return null
          // A search shows every match, regardless of collapsed layers
          const isCollapsed = !q && collapsed.has(layer.id)

          return (
            <div key={layer.id}>
              <button
                className="browser-layer-row"
                onClick={() => toggleCollapse(layer.id)}
                title={hasTrack ? 'Layer is in the timeline' : 'Layer is not in the timeline'}
              >
                <span className="browser-arrow">{isCollapsed ? '▸' : '▾'}</span>
                <span className="browser-layer-num">L{li + 1}</span>
                <span className="browser-layer-name">{layerName}</span>
                <span className="browser-layer-count">{clips.length}</span>
                <span className={`browser-track-dot ${hasTrack ? 'on' : ''}`} />
              </button>

              {!isCollapsed && (
                <div>
                  {clips.length === 0 && <div className="browser-msg">No clips</div>}
                  {clips.map(({ clip, ci }) => {
                    const clipName = rv(clip.name, '')
                    const thumb = thumbnails[`${layer.id}-${clip.id}`]
                    const canDrag = hasTrack
                    const isPicked = picked?.layerId === layer.id && picked.ids.includes(clip.id)
                    const nPicked = picked?.layerId === layer.id ? picked.ids.length : 0

                    return (
                      <div
                        key={clip.id}
                        className={`browser-clip-row ${canDrag ? 'draggable' : 'nodrop'}${isPicked ? ' picked' : ''}`}
                        draggable={canDrag && !TOUCH}
                        onClick={e => pick(e, layer.id, clip.id, clips.map(r => r.clip.id))}
                        onDragStart={e => handleDragStart(e, layer, clip, li, ci, clips)}
                        onDragEnd={onDragEnd}
                        title={!canDrag ? `Layer L${li + 1} is not in the timeline — add a lane for this layer first`
                          : isPicked && nPicked > 1 ? `Drag the ${nPicked} selected clips onto L${li + 1}: they go one after another`
                          : `Drag onto L${li + 1} in the timeline. ⌘-click / Shift-click to select several and drag them together`}
                      >
                        <div className="clip-row-thumb">
                          {thumb
                            ? <img src={thumb} alt="" draggable={false} />
                            : <span className="clip-row-num">{ci + 1}</span>
                          }
                        </div>
                        <div className="clip-row-text">
                          <span className="clip-row-name">{clipName || `Slot ${ci + 1}`}</span>
                          <span className="clip-row-meta">slot {ci + 1}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {TOUCH && picked && (() => {
        // Touch has no drag & drop into the timeline: the picked clips are placed by a tap there
        const li = (composition?.layers ?? []).findIndex(l => l?.id === picked.layerId)
        const layer = li >= 0 ? composition!.layers![li] : null
        const rows = (layer?.clips ?? []).map((clip, ci) => ({ clip, ci })).filter(r => r.clip && picked.ids.includes(r.clip.id))
        if (!layer || !rows.length || !trackedIds.has(layer.id)) return null
        return (
          <div className="browser-place">
            <button className="btn modal-primary" onClick={() => { onPlace(rows.map(r => dragData(layer, r.clip, li, r.ci))); setPicked(null) }}>
              Place {rows.length === 1 ? 'clip' : `${rows.length} clips`}
            </button>
            <button className="btn" onClick={() => setPicked(null)}>Clear</button>
          </div>
        )
      })()}

    </div>
  )
}
