import { useEffect, useState, useCallback } from 'react'
import type { ResolumeComposition, ResolumeLayer, ResolumeClip } from '../../../shared/resolume'
import type { Track, LayerTrack } from '../../../shared/show'
import type { DragClipData } from '../App'
import { rv, layerDisplayName } from '../../../shared/resolume'

// Empty slots are listed by Resolume too; they cannot be triggered meaningfully
const isEmptySlot = (clip: ResolumeClip) => rv(clip.connected as any, '') === 'Empty'

const api = (window as any).timeline

interface Props {
  tracks: Track[]
  onClose: () => void
  onDragStart: (data: DragClipData) => void
  onDragEnd: () => void
}

export function ClipBrowser({ tracks, onClose, onDragStart, onDragEnd }: Props) {
  const [composition, setComposition] = useState<ResolumeComposition | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set<number>([999999]))
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
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
            if (!clip || isEmptySlot(clip)) continue
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

  const trackedIds = new Set(
    tracks.filter(t => t.type === 'layer').map(t => (t as LayerTrack).resolumeLayerId)
  )

  const handleDragStart = (e: React.DragEvent, layer: ResolumeLayer, clip: ResolumeClip, li: number, ci: number) => {
    const clipName = rv(clip.name, `Slot ${ci + 1}`)
    const data: DragClipData = {
      layerIndex: li + 1, layerId: layer.id,
      clipIndex: ci + 1, clipId: clip.id, clipName,
    }
    e.dataTransfer.setData('application/timeline-clip', JSON.stringify(data))
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart(data)
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
        <button className="btn ghost browser-icon" onClick={refresh} disabled={loading} title="Refresh from Resolume">
          {loading ? '…' : '↺'}
        </button>
        <button className="btn ghost browser-icon" onClick={onClose} title="Close">✕</button>
      </div>

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

                    return (
                      <div
                        key={clip.id}
                        className={`browser-clip-row ${canDrag ? 'draggable' : 'nodrop'}`}
                        draggable={canDrag}
                        onDragStart={e => handleDragStart(e, layer, clip, li, ci)}
                        onDragEnd={onDragEnd}
                        title={canDrag ? `Drag onto L${li + 1} in the timeline` : `Layer L${li + 1} is not in the timeline — add a lane for this layer first`}
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
    </div>
  )
}
