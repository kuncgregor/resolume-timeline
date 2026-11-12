import { useEffect, useRef, useState } from 'react'
import type { Track, LayerTrack, Show } from '../../../shared/show'
import { DEFAULT_LANE_H, DEFAULT_AUTO_H, MIN_LANE_H, MIN_AUTO_H } from '../layout'

interface Props {
  tracks: Track[]
  selectedIdx: number | null
  layerRowHeights: Record<string, number>
  autoLaneHeights: Record<string, number>
  scrollY: number
  audioTrack?: Show['audioTrack']
  readOnly: boolean
  onSelect: (idx: number) => void
  onToggleExpand: (idx: number) => void
  onToggleMute: (idx: number) => void
  onToggleLock: (idx: number) => void
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
  tracks, selectedIdx, layerRowHeights, autoLaneHeights, scrollY, audioTrack, readOnly,
  onSelect, onToggleExpand, onToggleMute, onToggleLock, onResizeLayer, onResizeAutoLane,
  onDeleteAutomation, onToggleLayerBound, onEditAutomationTarget, onScrollY,
  onLoadAudio, onUpdateAudio,
}: Props) {
  const [resizing, setResizing] = useState<ResizeState | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editValue, setEditValue] = useState('')
  // Removing a lane loses its keyframes: first click arms, second removes
  const [armedDelete, setArmedDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const delta = e.clientY - resizing.startY
      if (resizing.kind === 'layer') onResizeLayer(resizing.id, Math.max(MIN_LANE_H, resizing.startH + delta))
      else onResizeAutoLane(resizing.id, Math.max(MIN_AUTO_H, resizing.startH + delta))
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

  // Native non-passive listener: React's wheel handler is passive and cannot preventDefault
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const fn = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); onScrollY(e.deltaY) }
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [onScrollY])

  const audioColor = audioTrack?.color ?? 'var(--live-fill)'

  return (
    <div className="lane-headers" style={{ userSelect: resizing ? 'none' : undefined }}>
      <div className="ruler-corner">
        <span>Sloji</span>
        <span className="ruler-corner-count">{tracks.length}</span>
      </div>

      {/* Audio lane header — pinned under the ruler like the canvas audio lane */}
      <div className="audio-head" onClick={e => e.stopPropagation()}>
        <div className="lane-stripe" style={{ background: audioColor }} />
        {audioTrack ? (
          <div className="audio-head-body">
            <div className="audio-head-top">
              <span className="audio-head-icon">♪</span>
              <span className="audio-head-name" title={audioTrack.filePath}>{audioTrack.name}</span>
              {!readOnly && (
                <button className="lane-tool" title="Naloži drugo avdio datoteko"
                  onClick={e => { e.stopPropagation(); onLoadAudio() }}>⇄</button>
              )}
            </div>
            <div className="audio-head-gain">
              <span className="lane-meta">Gain</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={audioTrack.gain} disabled={readOnly}
                onChange={e => onUpdateAudio({ gain: Number(e.target.value) })}
                onClick={e => e.stopPropagation()}
              />
              <span className="audio-head-val mono">{Math.round(audioTrack.gain * 100)}%</span>
            </div>
          </div>
        ) : (
          <button className="audio-load" disabled={readOnly}
            onClick={e => { e.stopPropagation(); onLoadAudio() }}>
            ♪ Naloži avdio
          </button>
        )}
      </div>

      <div className="lanes-viewport" ref={viewportRef}>
        <div className="lanes-inner" style={{ transform: `translateY(-${scrollY}px)` }}>
          {tracks.map((track, i) => {
            const h = layerRowHeights[track.id] ?? DEFAULT_LANE_H
            const isSelected = i === selectedIdx
            if (track.type !== 'layer') {
              return (
                <div key={track.id} className={`lane-row ${isSelected ? 'selected' : ''} ${i % 2 ? 'alt' : ''}`}
                  style={{ height: h }} onClick={() => onSelect(i)}>
                  <div className="lane-stripe" style={{ background: track.color ?? 'var(--bg-splitter)' }} />
                  <div className="lane-body">
                    <div className="lane-name">{track.name}</div>
                    <div className="lane-meta">{track.type}</div>
                  </div>
                </div>
              )
            }

            const lt = track as LayerTrack
            const offline = lt.resolumeLayerIndex < 1
            return (
              <div key={lt.id}>
                <div
                  className={`lane-row ${isSelected ? 'selected' : ''} ${i % 2 ? 'alt' : ''} ${lt.muted ? 'muted' : ''}`}
                  style={{ height: h }}
                  onClick={() => onSelect(i)}
                >
                  <div className="lane-stripe" style={{ background: lt.color ?? 'var(--bg-splitter)' }} />
                  <button
                    className={`lane-expand ${lt.automations.length ? '' : 'empty'}`}
                    title={lt.expanded ? 'Skrij avtomacijo' : 'Pokaži avtomacijo'}
                    onClick={e => { e.stopPropagation(); onToggleExpand(i) }}
                  >{lt.expanded ? '▾' : '▸'}</button>
                  <div className="lane-body">
                    <div className="lane-title">
                      <span className={`lane-num ${offline ? 'offline' : ''}`}
                        title={offline ? 'Layerja ni več v Resolume' : `Resolume layer ${lt.resolumeLayerIndex}`}>
                        {offline ? '—' : lt.resolumeLayerIndex}
                      </span>
                      <span className="lane-name" title={lt.name}>{lt.name}</span>
                    </div>
                    <div className="lane-meta">
                      {lt.clips.length} {lt.clips.length === 1 ? 'clip' : 'clipi'}
                      {lt.automations.length > 0 && ` · ${lt.automations.length} auto`}
                      {offline && <span className="lane-warn"> · ni v Resolume</span>}
                    </div>
                  </div>
                  <div className="lane-toggles">
                    <button
                      className={`lane-toggle ${lt.muted ? 'on-mute' : ''}`}
                      title={lt.muted ? 'Utišano: ne pošilja v Resolume (klikni za vklop)' : 'Utišaj layer'}
                      disabled={readOnly}
                      onClick={e => { e.stopPropagation(); onToggleMute(i) }}
                    >M</button>
                    <button
                      className={`lane-toggle ${lt.locked ? 'on-lock' : ''}`}
                      title={lt.locked ? 'Zaklenjeno za urejanje (klikni za odklep)' : 'Zakleni za urejanje'}
                      disabled={readOnly}
                      onClick={e => { e.stopPropagation(); onToggleLock(i) }}
                    >L</button>
                  </div>
                  {!readOnly && <ResizeHandle onStart={y => setResizing({ id: lt.id, kind: 'layer', startY: y, startH: h })} />}
                </div>

                {lt.expanded && lt.automations.map((auto, ai) => {
                  const autoH = autoLaneHeights[auto.id] ?? DEFAULT_AUTO_H
                  const isEditingThis = editing?.ti === i && editing?.ai === ai
                  const shortPath = auto.target.split('/').slice(-2).join('/')
                  const isLayerBound = !!auto.layerBound
                  return (
                    <div key={auto.id} className="lane-row auto-row" style={{ height: autoH }}>
                      <div className="lane-stripe auto" style={{ background: auto.color ?? 'var(--live-fill)' }} />
                      <div className="lane-body">
                        <div className="lane-title">
                          <button
                            className={`bind-chip ${isLayerBound ? 'layer' : 'clip'}`}
                            title={isLayerBound
                              ? 'Fiksno na časovnici — klikni, da sledi clipu'
                              : 'Sledi clipu — klikni za fiksno na časovnici'}
                            disabled={readOnly}
                            onClick={e => { e.stopPropagation(); onToggleLayerBound(i, ai) }}
                          >{isLayerBound ? 'FIX' : 'CLIP'}</button>
                          <span className="lane-name">{auto.name}</span>
                        </div>
                        {isEditingThis ? (
                          <input
                            className="lane-path-edit mono"
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
                            className="lane-meta lane-path mono"
                            title={`${auto.target}${readOnly ? '' : '\n\nDvoklik za urejanje OSC poti'}`}
                            onDoubleClick={e => {
                              if (readOnly) return
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
                      {!readOnly && (armedDelete === auto.id ? (
                        <button className="lane-tool armed" title="Klikni še enkrat za odstranitev"
                          onMouseLeave={() => setArmedDelete(null)}
                          onClick={e => { e.stopPropagation(); setArmedDelete(null); onDeleteAutomation(i, ai) }}>Odstrani?</button>
                      ) : (
                        <button className="lane-tool danger" title="Odstrani avtomacijo"
                          onClick={e => { e.stopPropagation(); setArmedDelete(auto.id) }}>✕</button>
                      ))}
                      {!readOnly && <ResizeHandle onStart={y => setResizing({ id: auto.id, kind: 'auto', startY: y, startH: autoH })} />}
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
