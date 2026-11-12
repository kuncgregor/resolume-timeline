import { useState } from 'react'
import type { Show, EngineState } from '../../../shared/show'
import { framesToSmpte } from './timeUtils'

const api = (window as any).timeline

interface Props {
  engineState: EngineState
  show: Show | null
  offsetFrames: number
  onPlay: () => void
  onStop: () => void
  onLocate: (frame: number) => void
  onToggleBrowser: () => void
  browserOpen: boolean
}

export function TransportBar({
  engineState, show, offsetFrames,
  onPlay, onStop, onLocate, onToggleBrowser, browserOpen,
}: Props) {
  const { frame, playing, fps, resolumeConnected } = engineState
  const displayFrame = frame + offsetFrames
  const tc = framesToSmpte(displayFrame, fps)
  const [pinging, setPinging] = useState(false)

  const host = show?.resolume.host ?? '127.0.0.1'
  const oscPort = show?.resolume.oscPort ?? 7000
  const restPort = show?.resolume.restPort ?? 8080

  const handlePing = async () => {
    setPinging(true)
    await api.connectResolume(host, oscPort, restPort)
    setPinging(false)
  }

  const bpm = show?.bpm

  return (
    <div className="transport-bar">
      <div className="tc-display">{tc}</div>
      <div className="tc-fps-group">
        <div className="tc-fps">{fps} fps</div>
        {bpm != null && <div className="tc-bpm">{bpm} BPM</div>}
      </div>

      <div className="transport-controls">
        <button
          className={`btn-transport ${playing ? 'active' : ''}`}
          onClick={playing ? onStop : onPlay}
        >
          {playing ? '■ STOP' : '▶ PLAY'}
        </button>
        <button className="btn-icon" onClick={() => onLocate(0)} title="Na začetek">⏮</button>
      </div>

      <div className="status-row" title={`REST: http://${host}:${restPort} · OSC: ${host}:${oscPort}`}>
        <span className={`status-dot ${resolumeConnected ? 'ok' : 'err'}`} />
        <span className="status-label">
          {resolumeConnected ? `Resolume ${host}` : `Ni povezave (${host}:${restPort})`}
        </span>
        <button
          className="btn-sm"
          onClick={handlePing}
          disabled={pinging}
          style={{ marginLeft: 4 }}
          title="Poveži Resolume"
        >
          {pinging ? '…' : '↺'}
        </button>
      </div>

      <div className="spacer" />

      <button className={`btn-sm ${browserOpen ? 'active' : ''}`} onClick={onToggleBrowser}>
        Clips
      </button>
    </div>
  )
}
