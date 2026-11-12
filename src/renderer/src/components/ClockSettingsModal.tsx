import { useState, useEffect } from 'react'
import type { Show } from '../../../shared/show'

type ClockSource = 'internal' | 'ltc-a' | 'ltc-b'

interface Props {
  show: Show
  onUpdate: (partial: Partial<Show>) => void
  onClose: () => void
}

function normalizeSource(src: string): ClockSource {
  if (src === 'ltc-a') return 'ltc-a'
  if (src === 'ltc-b') return 'ltc-b'
  if (src === 'ltc') return 'ltc-a'  // legacy mapping
  return 'internal'
}

export function ClockSettingsModal({ show, onUpdate, onClose }: Props) {
  const [name, setName] = useState(show.name)
  const [bpm, setBpm] = useState(show.bpm ?? 120)
  const [fps, setFps] = useState(show.frameRate)
  const [source, setSource] = useState<ClockSource>(normalizeSource(show.clock.source))
  const [ltcDeviceA, setLtcDeviceA] = useState(show.clock.ltcDeviceA ?? show.clock.ltcDevice ?? '')
  const [ltcDeviceB, setLtcDeviceB] = useState(show.clock.ltcDeviceB ?? '')
  const [ltcChannelA, setLtcChannelA] = useState(show.clock.ltcChannelA ?? 0)
  const [ltcChannelB, setLtcChannelB] = useState(show.clock.ltcChannelB ?? 0)
  const [audioOutputDevice, setAudioOutputDevice] = useState(show.clock.audioOutputDevice ?? '')
  const [audioOutputChannelL, setAudioOutputChannelL] = useState(show.clock.audioOutputChannelL ?? 0)
  const [audioOutputChannelR, setAudioOutputChannelR] = useState(show.clock.audioOutputChannelR ?? 1)
  const [freewheel, setFreewheel] = useState(show.clock.freewheelFrames)
  const [host, setHost] = useState(show.resolume.host)
  const [oscPort, setOscPort] = useState(show.resolume.oscPort)
  const [restPort, setRestPort] = useState(show.resolume.restPort)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [channelCountByDevice, setChannelCountByDevice] = useState<Record<string, number>>({})

  // Parse offset "HH:MM:SS:FF"
  const [parts, setParts] = useState(() => {
    const p = (show.clock.offset || '00:00:00:00').split(':').map(Number)
    return { hh: p[0] ?? 0, mm: p[1] ?? 0, ss: p[2] ?? 0, ff: p[3] ?? 0 }
  })
  const pad = (n: number) => String(Math.floor(Math.max(0, n))).padStart(2, '0')
  const offsetStr = `${pad(parts.hh)}:${pad(parts.mm)}:${pad(parts.ss)}:${pad(parts.ff)}`

  const setPart = (key: 'hh' | 'mm' | 'ss' | 'ff', val: string) => {
    const n = parseInt(val, 10)
    if (isNaN(n)) return
    const max = { hh: 23, mm: 59, ss: 59, ff: fps - 1 }[key]
    setParts(prev => ({ ...prev, [key]: Math.min(max, Math.max(0, n)) }))
  }

  // Fetch all audio devices on mount (need media permission for labels)
  useEffect(() => {
    let mounted = true

    const probeInput = async (deviceId: string) => {
      if (!deviceId) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 32 } },
        })
        const count = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1
        stream.getTracks().forEach(t => t.stop())
        if (mounted) setChannelCountByDevice(prev => ({ ...prev, [deviceId]: Math.max(1, count) }))
      } catch {}
    }

    const probeOutput = async (deviceId: string) => {
      if (!deviceId) return
      try {
        const ctx = new AudioContext()
        const ctxAny = ctx as any
        if (typeof ctxAny.setSinkId === 'function') await ctxAny.setSinkId(deviceId)
        const count = ctx.destination.maxChannelCount
        await ctx.close()
        if (mounted) setChannelCountByDevice(prev => ({ ...prev, [deviceId]: Math.max(2, count) }))
      } catch {}
    }

    const fetchDevices = async () => {
      try {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true })
          s.getTracks().forEach(t => t.stop())
        } catch {}
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (!mounted) return
        setAudioInputs(devices.filter(d => d.kind === 'audioinput'))
        setAudioOutputs(devices.filter(d => d.kind === 'audiooutput'))
        await Promise.all([
          probeInput(show.clock.ltcDeviceA ?? show.clock.ltcDevice ?? ''),
          probeInput(show.clock.ltcDeviceB ?? ''),
          probeOutput(show.clock.audioOutputDevice ?? ''),
        ])
      } catch {}
    }
    fetchDevices()
    return () => { mounted = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-probe when device selection changes
  useEffect(() => {
    if (!ltcDeviceA) return
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: ltcDeviceA }, channelCount: { ideal: 32 } } })
      .then(stream => {
        const count = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1
        stream.getTracks().forEach(t => t.stop())
        if (!cancelled) {
          const n = Math.max(1, count)
          setChannelCountByDevice(prev => ({ ...prev, [ltcDeviceA]: n }))
          setLtcChannelA(c => Math.min(c, n - 1))
        }
      }).catch(() => {})
    return () => { cancelled = true }
  }, [ltcDeviceA])

  useEffect(() => {
    if (!ltcDeviceB) return
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: ltcDeviceB }, channelCount: { ideal: 32 } } })
      .then(stream => {
        const count = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1
        stream.getTracks().forEach(t => t.stop())
        if (!cancelled) {
          const n = Math.max(1, count)
          setChannelCountByDevice(prev => ({ ...prev, [ltcDeviceB]: n }))
          setLtcChannelB(c => Math.min(c, n - 1))
        }
      }).catch(() => {})
    return () => { cancelled = true }
  }, [ltcDeviceB])

  useEffect(() => {
    if (!audioOutputDevice) return
    let cancelled = false
    ;(async () => {
      try {
        const ctx = new AudioContext()
        const ctxAny = ctx as any
        if (typeof ctxAny.setSinkId === 'function') await ctxAny.setSinkId(audioOutputDevice)
        const count = ctx.destination.maxChannelCount
        await ctx.close()
        if (!cancelled) {
          const n = Math.max(2, count)
          setChannelCountByDevice(prev => ({ ...prev, [audioOutputDevice]: n }))
          setAudioOutputChannelL(c => Math.min(c, n - 1))
          setAudioOutputChannelR(c => Math.min(c, n - 1))
        }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [audioOutputDevice])

  const handleSave = () => {
    onUpdate({
      name,
      bpm: bpm > 0 ? bpm : undefined,
      frameRate: fps,
      clock: {
        source,
        offset: offsetStr,
        freewheelFrames: freewheel,
        ltcDeviceA: ltcDeviceA || undefined,
        ltcDeviceB: ltcDeviceB || undefined,
        ltcDevice: ltcDeviceA || undefined, // back-compat
        ltcChannelA,
        ltcChannelB,
        audioOutputDevice: audioOutputDevice || undefined,
        audioOutputChannelL,
        audioOutputChannelR,
      },
      resolume: { ...show.resolume, host, oscPort, restPort },
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Nastavitve projekta</span>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* ── Projekt ── */}
          <div className="modal-section">
            <div className="modal-section-title">Projekt</div>
            <Row label="Ime">
              <input className="modal-inp" value={name} onChange={e => setName(e.target.value)} />
            </Row>
            <Row label="BPM">
              <input
                type="number" className="modal-inp modal-num" min={20} max={999} step={1}
                value={bpm} onChange={e => setBpm(Math.max(1, Number(e.target.value)))}
              />
              <span className="modal-hint" style={{ marginLeft: 8 }}>BPM grid na timelinu</span>
            </Row>
          </div>

          {/* ── Timecode in hitrost ── */}
          <div className="modal-section">
            <div className="modal-section-title">Timecode in hitrost</div>
            <Row label="FPS">
              <select className="modal-inp modal-sel" value={fps} onChange={e => setFps(Number(e.target.value))}>
                {[24, 25, 30, 50, 60].map(f => <option key={f} value={f}>{f} fps</option>)}
              </select>
              <span className="modal-hint" style={{ marginLeft: 8 }}>FPS lahko spreminjate kadarkoli</span>
            </Row>
            <Row label="Vir">
              <label className="modal-radio">
                <input type="radio" name="tc-src" checked={source === 'internal'}
                  onChange={() => setSource('internal')} />
                Interno
              </label>
              <label className="modal-radio">
                <input type="radio" name="tc-src" checked={source === 'ltc-a'}
                  onChange={() => setSource('ltc-a')} />
                SMPTE A
              </label>
              <label className="modal-radio">
                <input type="radio" name="tc-src" checked={source === 'ltc-b'}
                  onChange={() => setSource('ltc-b')} />
                SMPTE B
              </label>
            </Row>

            <Row label="TC offset">
              <div className="smpte-row">
                <SmpteField label="HH" value={parts.hh} max={23} onChange={v => setPart('hh', v)} />
                <span className="smpte-sep">:</span>
                <SmpteField label="MM" value={parts.mm} max={59} onChange={v => setPart('mm', v)} />
                <span className="smpte-sep">:</span>
                <SmpteField label="SS" value={parts.ss} max={59} onChange={v => setPart('ss', v)} />
                <span className="smpte-sep">:</span>
                <SmpteField label="FF" value={parts.ff} max={fps - 1} onChange={v => setPart('ff', v)} />
              </div>
              <span className="modal-hint">
                TC offset lahko spreminjate kadarkoli — določa pri katerem timecode se projekt začne
              </span>
            </Row>

            <Row label="Freewheel">
              <input type="number" className="modal-inp modal-num" min={0} max={300}
                value={freewheel} onChange={e => setFreewheel(Number(e.target.value))} />
              <span className="modal-hint">okvirjev</span>
            </Row>
          </div>

          {/* ── Audio ── */}
          <div className="modal-section">
            <div className="modal-section-title">Audio</div>
            <Row label="Audio izhod">
              <select
                className="modal-inp modal-sel-wide"
                value={audioOutputDevice}
                onChange={e => setAudioOutputDevice(e.target.value)}
              >
                <option value="">— privzeta naprava —</option>
                {audioOutputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio izhod ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              {(() => {
                const n = channelCountByDevice[audioOutputDevice] ?? 0
                const opts = n > 0
                  ? Array.from({ length: n }, (_, i) => <option key={i} value={i}>Ch {i + 1}</option>)
                  : Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>Ch {i + 1}</option>)
                return <>
                  <select className="modal-inp modal-sel" value={audioOutputChannelL}
                    onChange={e => setAudioOutputChannelL(Number(e.target.value))}
                    style={{ marginLeft: 6 }} title="Levi kanal">{opts}</select>
                  <select className="modal-inp modal-sel" value={audioOutputChannelR}
                    onChange={e => setAudioOutputChannelR(Number(e.target.value))}
                    style={{ marginLeft: 4 }} title="Desni kanal">{opts}</select>
                  <span className="modal-hint" style={{ marginLeft: 6 }}>L / R</span>
                </>
              })()}
            </Row>
            <Row label="SMPTE A">
              <select
                className="modal-inp modal-sel-wide"
                value={ltcDeviceA}
                onChange={e => setLtcDeviceA(e.target.value)}
              >
                <option value="">— privzeta naprava —</option>
                {audioInputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio vhod ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <select
                className="modal-inp modal-sel"
                value={ltcChannelA}
                onChange={e => setLtcChannelA(Number(e.target.value))}
                style={{ marginLeft: 6 }}
              >
                {Array.from({ length: channelCountByDevice[ltcDeviceA] ?? 16 }, (_, i) => (
                  <option key={i} value={i}>Ch {i + 1}</option>
                ))}
              </select>
            </Row>
            <Row label="SMPTE B">
              <select
                className="modal-inp modal-sel-wide"
                value={ltcDeviceB}
                onChange={e => setLtcDeviceB(e.target.value)}
              >
                <option value="">— privzeta naprava —</option>
                {audioInputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio vhod ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <select
                className="modal-inp modal-sel"
                value={ltcChannelB}
                onChange={e => setLtcChannelB(Number(e.target.value))}
                style={{ marginLeft: 6 }}
              >
                {Array.from({ length: channelCountByDevice[ltcDeviceB] ?? 16 }, (_, i) => (
                  <option key={i} value={i}>Ch {i + 1}</option>
                ))}
              </select>
            </Row>
            <span className="modal-hint" style={{ paddingLeft: 82 }}>
              SMPTE A/B sta dva ločena LTC vhoda; izbira pod "Vir" določi kateri se uporabi za ta projekt
            </span>
          </div>

          {/* ── Resolume ── */}
          <div className="modal-section">
            <div className="modal-section-title">Resolume</div>
            <Row label="Host">
              <input className="modal-inp modal-inp-mid" value={host}
                onChange={e => setHost(e.target.value)} />
            </Row>
            <Row label="OSC port">
              <input type="number" className="modal-inp modal-num" value={oscPort}
                onChange={e => setOscPort(Number(e.target.value))} />
            </Row>
            <Row label="REST port">
              <input type="number" className="modal-inp modal-num" value={restPort}
                onChange={e => setRestPort(Number(e.target.value))} />
            </Row>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-sm" onClick={onClose}>Prekliči</button>
          <button className="modal-save-btn" onClick={handleSave}>Shrani</button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="modal-row">
      <span className="modal-label">{label}</span>
      <div className="modal-control">{children}</div>
    </div>
  )
}

function SmpteField({ label, value, max, onChange }: {
  label: string; value: number; max: number; onChange: (v: string) => void
}) {
  return (
    <div className="smpte-field">
      <input type="number" className="smpte-input" min={0} max={max} value={value}
        onChange={e => onChange(e.target.value)} onFocus={e => e.target.select()} />
      <span className="smpte-label">{label}</span>
    </div>
  )
}
