import { useState, useEffect, useRef } from 'react'
import { useEscape } from './useEscape'
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

// Opens the input briefly to read its channel count. Voice processing must be off,
// otherwise Chromium reports a folded-down mono/stereo capture.
async function probeInputChannels(deviceId: string): Promise<number | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId }, channelCount: { ideal: 32 },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    })
    const count = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1
    stream.getTracks().forEach(t => t.stop())
    return Math.max(1, count)
  } catch { return null }
}

async function probeOutputChannels(deviceId: string): Promise<number | null> {
  const ctx = new AudioContext()
  try {
    const ctxAny = ctx as any
    if (typeof ctxAny.setSinkId === 'function') await ctxAny.setSinkId(deviceId)
    return Math.max(2, ctx.destination.maxChannelCount)
  } catch { return null } finally {
    ctx.close().catch(() => {})  // always release: Chromium limits open AudioContexts
  }
}

// "http://10.0.0.5:8080/ " → "10.0.0.5" (ports have their own fields); IPv6 literals stay as typed
function cleanHost(raw: string): string {
  let h = raw.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  if ((h.match(/:/g) ?? []).length === 1) h = h.replace(/:\d*$/, '')
  return h || '127.0.0.1'
}

export function ClockSettingsModal({ show, onUpdate, onClose }: Props) {
  useEscape(onClose)
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
  const [deckReturn, setDeckReturn] = useState(show.deckReturn !== false)
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
    ;(async () => {
      try {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true })
          s.getTracks().forEach(t => t.stop())
        } catch {}
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (!mounted) return
        setAudioInputs(devices.filter(d => d.kind === 'audioinput'))
        setAudioOutputs(devices.filter(d => d.kind === 'audiooutput'))
      } catch {}
    })()
    return () => { mounted = false }
  }, [])

  // Probe channel counts when a device is chosen. Channels are only clamped when the user
  // picks a different device; the saved device keeps its saved channel even if the probe
  // under-reports (some interfaces show 2 channels until they are opened natively).
  const initialDevices = useRef({ a: ltcDeviceA, b: ltcDeviceB, out: audioOutputDevice })
  useEffect(() => {
    if (!ltcDeviceA) return
    let cancelled = false
    probeInputChannels(ltcDeviceA).then(n => {
      if (cancelled || n == null) return
      setChannelCountByDevice(prev => ({ ...prev, [ltcDeviceA]: n }))
      if (ltcDeviceA !== initialDevices.current.a) setLtcChannelA(c => Math.min(c, n - 1))
    })
    return () => { cancelled = true }
  }, [ltcDeviceA])

  useEffect(() => {
    if (!ltcDeviceB) return
    let cancelled = false
    probeInputChannels(ltcDeviceB).then(n => {
      if (cancelled || n == null) return
      setChannelCountByDevice(prev => ({ ...prev, [ltcDeviceB]: n }))
      if (ltcDeviceB !== initialDevices.current.b) setLtcChannelB(c => Math.min(c, n - 1))
    })
    return () => { cancelled = true }
  }, [ltcDeviceB])

  useEffect(() => {
    if (!audioOutputDevice) return
    let cancelled = false
    probeOutputChannels(audioOutputDevice).then(n => {
      if (cancelled || n == null) return
      setChannelCountByDevice(prev => ({ ...prev, [audioOutputDevice]: n }))
      if (audioOutputDevice !== initialDevices.current.out) {
        setAudioOutputChannelL(c => Math.min(c, n - 1))
        setAudioOutputChannelR(c => Math.min(c, n - 1))
      }
    })
    return () => { cancelled = true }
  }, [audioOutputDevice])

  // A lower frame rate can leave the offset's frame field out of range (30 → 25 fps with ff=29)
  useEffect(() => {
    setParts(prev => prev.ff > fps - 1 ? { ...prev, ff: fps - 1 } : prev)
  }, [fps])

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
      // "http://10.0.0.5:8080/ " → "10.0.0.5": ports have their own fields
      resolume: { ...show.resolume, host: cleanHost(host), oscPort, restPort },
      deckReturn,
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Timeline settings</span>
          <button className="btn ghost modal-close" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="modal-body">
          {/* ── Project ── */}
          <div className="modal-section">
            <div className="modal-section-title">Timeline</div>
            <Row label="Name">
              <input className="modal-inp" value={name} onChange={e => setName(e.target.value)} />
            </Row>
            <Row label="BPM">
              <input
                type="number" className="modal-inp modal-num" min={20} max={999} step={1}
                value={bpm} onChange={e => setBpm(Math.max(1, Number(e.target.value)))}
              />
              <span className="modal-hint inline">BPM grid on the timeline</span>
            </Row>
          </div>

          {/* ── Timecode and frame rate ── */}
          <div className="modal-section">
            <div className="modal-section-title">Timecode and frame rate</div>
            <Row label="FPS">
              <select className="modal-inp modal-sel" value={fps} onChange={e => setFps(Number(e.target.value))}>
                {[24, 25, 30, 50, 60].map(f => <option key={f} value={f}>{f} fps</option>)}
              </select>
              <span className="modal-hint inline">FPS can be changed at any time</span>
            </Row>
            <Row label="Source">
              <label className="modal-radio">
                <input type="radio" name="tc-src" checked={source === 'internal'}
                  onChange={() => setSource('internal')} />
                Internal
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

            <Row label="Start TC">
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
                Timecode at which this timeline starts (timeline 0). With LTC it runs from here until the next LTC timeline's start TC.
              </span>
            </Row>

            <Row label="Freewheel">
              <input type="number" className="modal-inp modal-num" min={0} max={300}
                value={freewheel} onChange={e => setFreewheel(Number(e.target.value))} />
              <span className="modal-hint inline">frames</span>
            </Row>
          </div>

          {/* ── Audio ── */}
          <div className="modal-section">
            <div className="modal-section-title">Audio</div>
            <Row label="Audio output">
              <select
                className="modal-inp modal-sel-wide"
                value={audioOutputDevice}
                onChange={e => setAudioOutputDevice(e.target.value)}
              >
                <option value="">— default device —</option>
                {audioOutputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio output ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              {(() => {
                const n = channelCountByDevice[audioOutputDevice]
                  ? Math.max(channelCountByDevice[audioOutputDevice], audioOutputChannelL + 1, audioOutputChannelR + 1) : 0
                const opts = n > 0
                  ? Array.from({ length: n }, (_, i) => <option key={i} value={i}>Ch {i + 1}</option>)
                  : Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>Ch {i + 1}</option>)
                return <>
                  <select className="modal-inp modal-sel" value={audioOutputChannelL}
                    onChange={e => setAudioOutputChannelL(Number(e.target.value))}
                    title="Left channel">{opts}</select>
                  <select className="modal-inp modal-sel" value={audioOutputChannelR}
                    onChange={e => setAudioOutputChannelR(Number(e.target.value))}
                    title="Right channel">{opts}</select>
                  <span className="modal-hint inline">L / R</span>
                </>
              })()}
            </Row>
            <Row label="SMPTE A">
              <select
                className="modal-inp modal-sel-wide"
                value={ltcDeviceA}
                onChange={e => setLtcDeviceA(e.target.value)}
              >
                <option value="">— default device —</option>
                {audioInputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio input ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <select
                className="modal-inp modal-sel"
                value={ltcChannelA}
                onChange={e => setLtcChannelA(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(channelCountByDevice[ltcDeviceA] ?? 16, ltcChannelA + 1) }, (_, i) => (
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
                <option value="">— default device —</option>
                {audioInputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio input ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <select
                className="modal-inp modal-sel"
                value={ltcChannelB}
                onChange={e => setLtcChannelB(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(channelCountByDevice[ltcDeviceB] ?? 16, ltcChannelB + 1) }, (_, i) => (
                  <option key={i} value={i}>Ch {i + 1}</option>
                ))}
              </select>
            </Row>
            <span className="modal-hint modal-hint-indent">
              SMPTE A/B are two separate LTC inputs; the choice under "Source" sets which one this project uses
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
            <Row label="Decks">
              <label className="modal-check" title="A cue from another deck makes Resolume show that deck to fire its clip. With this on, Resolume goes back to the deck it was showing; the clip keeps playing.">
                <input type="checkbox" checked={deckReturn} onChange={e => setDeckReturn(e.target.checked)} />
                <span>Return to the previous deck after firing a cue from another deck</span>
              </label>
            </Row>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn modal-primary" onClick={handleSave}>Save</button>
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
      <input type="number" className="smpte-input mono" min={0} max={max} value={value}
        onChange={e => onChange(e.target.value)} onFocus={e => e.target.select()} />
      <span className="smpte-label">{label}</span>
    </div>
  )
}
