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

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const comp = await api.getComposition()
      if (!comp) {
        setError('Resolume ni dosegljiv.\nPreferences → Webserver → Enable')
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

  return (
    <div className="clip-browser">
      <div className="browser-header">
        <span className="browser-title">Clips</span>
        <button className="btn-sm" onClick={refresh} disabled={loading}>{loading ? '…' : '↺'}</button>
        <button className="btn-icon" onClick={onClose}>✕</button>
      </div>

      <div className="browser-body">
        {loading && <div className="bp-empty">Nalagam…</div>}
        {!loading && error && <div className="browser-error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}

        {!loading && !error && composition && (composition.layers ?? []).map((layer, li) => {
          if (!layer) return null
          const layerName = layerDisplayName(rv(layer.name, `Layer ${li + 1}`), li + 1)
          const hasTrack = trackedIds.has(layer.id)
          const isCollapsed = collapsed.has(layer.id)
          // Keep the original slot index: it is the clip number Resolume expects over OSC
          const clips = (layer.clips ?? [])
            .map((clip, ci) => ({ clip, ci }))
            .filter(({ clip }) => clip && !isEmptySlot(clip))

          return (
            <div key={layer.id} className="browser-layer-section">
              <div
                className={`browser-layer-row ${hasTrack ? 'tracked' : 'untracked'}`}
                onClick={() => toggleCollapse(layer.id)}
              >
                <span className="layer-collapse-arrow">{isCollapsed ? '▶' : '▼'}</span>
                <span className={`layer-track-dot ${hasTrack ? 'ok' : ''}`} />
                <span className="browser-layer-name">L{li + 1}: {layerName}</span>
                <span className="browser-layer-count">{clips.length}</span>
              </div>

              {!isCollapsed && (
                <div className="browser-clips-list">
                  {clips.length === 0 && <div className="bp-empty">Ni clipov</div>}
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
                        title={canDrag ? `Povleci na L${li+1} v timelineu` : 'Layer ni v timelineu'}
                      >
                        <div className="clip-row-thumb">
                          {thumb
                            ? <img src={thumb} alt="" />
                            : <div className="clip-row-num">{ci + 1}</div>
                          }
                        </div>
                        <span className="clip-row-name">{clipName || `Slot ${ci + 1}`}</span>
                        {canDrag && <span className="clip-row-drag">⠿</span>}
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
