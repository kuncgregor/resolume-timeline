import { useEffect, useRef, useState } from 'react'
import type { Track, LayerTrack, Show } from '../../../shared/show'

const DEFAULT_CLIP_H = 52
const DEFAULT_AUTO_H = 72

interface Props {
  tracks: Track[]
  selectedIdx: number | null
  layerRowHeights: Record<string, number>
  autoLaneHeights: Record<string, number>
  scrollY: number
  audioTrack?: Show['audioTrack']
  onSelect: (idx: number) => void
  onToggleExpand: (idx: number) => void
  onResizeLayer: (id: string, h: number) => void
  onResizeAutoLane: (id: string, h: number) => void
  onDeleteAutomation: (trackIdx: number, autoIdx: number) => void
  onToggleLayerBound: (trackIdx: number, autoIdx: number) => void
  onEditAutomationTarget: (trackIdx: number, autoIdx: number, newTarget: string) => void
  onScrollY: (delta: number) => void
  onLoadAudio: () => void
  onUpdateAudio: (updates: Partial<NonNullable<Show['audioTrack']>>) => void
}

interface ResizeState { id: string; kind: 'layer' | 'auto'; startY: number; startH: number }
interface EditState { ti: number; ai: number }

export function LaneHeaders({
  tracks, selectedIdx, layerRowHeights, autoLaneHeights, scrollY, audioTrack,
  onSelect, onToggleExpand, onResizeLayer, onResizeAutoLane,
  onDeleteAutomation, onToggleLayerBound, onEditAutomationTarget, onScrollY,
  onLoadAudio, onUpdateAudio,
}: Props) {
  const [resizing, setResizing] = useState<ResizeState | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const delta = e.clientY - resizing.startY
      const newH = Math.max(32, resizing.startH + delta)
      if (resizing.kind === 'layer') onResizeLayer(resizing.id, newH)
      else onResizeAutoLane(resizing.id, newH)
    }
    const onUp = () => setResizing(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [resizing, onResizeLayer, onResizeAutoLane])

  // Escape unmounts the input, which fires blur → commitEdit; this flag turns that commit off
  const cancelEditRef = useRef(false)
  const commitEdit = () => {
    if (cancelEditRef.current) { cancelEditRef.current = false; return }
    if (!editing) return
    onEditAutomationTarget(editing.ti, editing.ai, editValue.trim())
    setEditing(null)
  }

  const handleWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); onScrollY(e.deltaY) }
  }

  const color = audioTrack?.color ?? '#1ABC9C'

  return (
    <div className="lane-headers-wrapper" style={{ userSelect: resizing ? 'none' : undefined } as any}>
      <div className="ruler-corner" />

      {/* ── Audio track header — PINNED, always visible at top ── */}
      <div className="audio-lane-fixed" onClick={e => e.stopPropagation()}>
        <div className="audio-lane-fixed-stripe" style={{ background: color }} />
        <div className="audio-lane-fixed-inner">
          {audioTrack ? (
            <div className="audio-lane-fixed-content">
              <div className="audio-lane-fixed-top">
                <span className="audio-lane-icon">♪</span>
                <span className="audio-lane-name" title={audioTrack.filePath}>{audioTrack.name}</span>
                <button className="btn-icon" title="Naloži drug fajl"
                  style={{ fontSize: 11 }}
                  onClick={e => { e.stopPropagation(); onLoadAudio() }}>📁</button>
              </div>
              <div className="audio-lane-fixed-bottom">
                <span className="audio-gain-label">GAIN</span>
                <input
                  type="range" min={0} max={1} step={0.01}
                  value={audioTrack.gain}
                  onChange={e => onUpdateAudio({ gain: Number(e.target.value) })}
                  onClick={e => e.stopPropagation()}
                  style={{ flex: 1 }}
                />
                <span className="audio-gain-val">{Math.round(audioTrack.gain * 100)}%</span>
              </div>
            </div>
          ) : (
            <button className="audio-load-btn" onClick={e => { e.stopPropagation(); onLoadAudio() }}>
              ♪  Naloži avdio datoteko
            </button>
          )}
        </div>
      </div>

      {/* ── Scrollable track headers ── */}
      <div className="lanes-viewport" onWheel={handleWheel}>
        <div className="lanes-inner" style={{ transform: `translateY(-${scrollY}px)` }}>
          {tracks.map((track, i) => {
            if (track.type !== 'layer') {
              const h = layerRowHeights[track.id] ?? DEFAULT_CLIP_H
              return (
                <div key={track.id} className={`lane-row ${i === selectedIdx ? 'selected' : ''}`}
                  style={{ height: h }} onClick={() => onSelect(i)}>
                  <div className="lane-stripe" style={{ background: track.color ?? '#555' }} />
                  <div className="lane-inner">
                    <div className="lane-info">
                      <div className="lane-name">{track.name}</div>
                      <div className="lane-sub">{track.type}</div>
                    </div>
                  </div>
                  <ResizeHandle onStart={y => setResizing({ id: track.id, kind: 'layer', startY: y, startH: h })} />
                </div>
              )
            }

            const lt = track as LayerTrack
            const clipH = layerRowHeights[lt.id] ?? DEFAULT_CLIP_H
            const isSelected = i === selectedIdx

            return (
              <div key={lt.id}>
                <div
                  className={`lane-row layer-row ${isSelected ? 'selected' : ''}`}
                  style={{ height: clipH }}
                  onClick={() => onSelect(i)}
                >
                  <div className="lane-stripe" style={{ background: lt.color ?? '#555' }} />
                  <div className="lane-inner">
                    <button className="expand-btn" onClick={e => { e.stopPropagation(); onToggleExpand(i) }}>
                      {lt.expanded ? '▾' : '▸'}
                    </button>
                    <div className="lane-info">
                      <div className="lane-name">{lt.name}</div>
                      <div className="lane-sub">
                        <span style={{ color: lt.color ?? '#555' }}>L{lt.resolumeLayerIndex}</span>
                        {lt.clips.length > 0 && <span style={{ marginLeft: 4 }}>{lt.clips.length}c</span>}
                        {lt.automations.length > 0 && <span style={{ marginLeft: 4, opacity: 0.5 }}>{lt.automations.length}a</span>}
                      </div>
                    </div>
                  </div>
                  <ResizeHandle onStart={y => setResizing({ id: lt.id, kind: 'layer', startY: y, startH: clipH })} />
                </div>

                {lt.expanded && lt.automations.map((auto, ai) => {
                  const autoH = autoLaneHeights[auto.id] ?? DEFAULT_AUTO_H
                  const isEditingThis = editing?.ti === i && editing?.ai === ai
                  const shortPath = auto.target.split('/').slice(-2).join('/')

                  const isLayerBound = !!auto.layerBound
                  return (
                    <div key={auto.id} className="lane-row auto-row" style={{ height: autoH, background: isLayerBound ? '#120f08' : undefined }}>
                      <div className="lane-stripe" style={{ background: auto.color ?? '#2ECC71', width: isLayerBound ? 4 : 2 }} />
                      <div className="lane-inner" style={{ paddingLeft: 16 }}>
                        <div style={{ width: 5, height: 5, borderRadius: '50%', background: auto.color ?? '#2ECC71', flexShrink: 0 }} />
                        <div className="lane-info" style={{ minWidth: 0 }}>
                          <div className="lane-name" style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <button
                              title={isLayerBound ? 'Fiksno na layer — klikni za clip-bound' : 'Sledi clipu — klikni za fiksno'}
                              onClick={e => { e.stopPropagation(); onToggleLayerBound(i, ai) }}
                              style={{ fontSize: 7, lineHeight: 1, padding: '0 2px', borderRadius: 2, border: 'none', cursor: 'pointer',
                                background: isLayerBound ? '#332a14' : '#1a2a1a',
                                color: isLayerBound ? '#c8941a' : '#4ec94e', flexShrink: 0 }}>
                              {isLayerBound ? 'L' : 'C'}
                            </button>
                            {auto.name}
                          </div>

                          {isEditingThis ? (
                            <input
                              className="lane-path-edit"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitEdit()
                                if (e.key === 'Escape') { cancelEditRef.current = true; setEditing(null) }
                                e.stopPropagation()
                              }}
                              onClick={e => e.stopPropagation()}
                              autoFocus
                            />
                          ) : (
                            <div
                              className="lane-sub lane-sub-editable"
                              title={`${auto.target}\n\nDvoklik za urejanje OSC poti`}
                              onDoubleClick={e => {
                                e.stopPropagation()
                                cancelEditRef.current = false
                                setEditing({ ti: i, ai })
                                setEditValue(auto.target)
                              }}
                            >
                              {shortPath}
                            </div>
                          )}
                        </div>
                        <button className="btn-icon dng" style={{ fontSize: 8, padding: '1px 3px', opacity: 0.35 }}
                          onClick={e => { e.stopPropagation(); onDeleteAutomation(i, ai) }}>✕</button>
                      </div>
                      <ResizeHandle onStart={y => setResizing({ id: auto.id, kind: 'auto', startY: y, startH: autoH })} />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ResizeHandle({ onStart }: { onStart: (y: number) => void }) {
  return (
    <div
      className="lane-resize-handle"
      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onStart(e.clientY) }}
    />
  )
}
