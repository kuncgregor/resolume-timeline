import { useState, useEffect, useRef } from 'react'
import { useEscape } from './useEscape'
import type { ProjectSettings } from '../../../shared/showfile'

// ⚙ Project settings: what the whole showfile shares on this rig (Resolume's address, the LTC
// inputs, the audio output, decks, Follow TC). Saved in the showfile. Each timeline's own clock
// (which input it follows, start TC, fps, freewheel) is in ✎ Edit timeline.

interface Props {
  settings: ProjectSettings
  showfileName: string
  onSave: (settings: ProjectSettings) => void
  onClose: () => void
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

export function ClockSettingsModal({ settings, showfileName, onSave, onClose }: Props) {
  useEscape(onClose)
  const [ltcDeviceA, setLtcDeviceA] = useState(settings.ltcA.device ?? '')
  const [ltcDeviceB, setLtcDeviceB] = useState(settings.ltcB.device ?? '')
  const [ltcChannelA, setLtcChannelA] = useState(settings.ltcA.channel)
  const [ltcChannelB, setLtcChannelB] = useState(settings.ltcB.channel)
  const [audioOutputDevice, setAudioOutputDevice] = useState(settings.audioOut.device ?? '')
  const [audioOutputChannelL, setAudioOutputChannelL] = useState(settings.audioOut.left)
  const [audioOutputChannelR, setAudioOutputChannelR] = useState(settings.audioOut.right)
  const [host, setHost] = useState(settings.resolume.host)
  const [oscPort, setOscPort] = useState(settings.resolume.oscPort)
  const [restPort, setRestPort] = useState(settings.resolume.restPort)
  const [deckReturn, setDeckReturn] = useState(settings.deckReturn)
  const [followTc, setFollowTc] = useState(settings.followTc)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [channelCountByDevice, setChannelCountByDevice] = useState<Record<string, number>>({})

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

  const handleSave = () => {
    onSave({
      // "http://10.0.0.5:8080/ " → "10.0.0.5": ports have their own fields
      resolume: { host: cleanHost(host), oscPort, restPort },
      ltcA: { device: ltcDeviceA || undefined, channel: ltcChannelA },
      ltcB: { device: ltcDeviceB || undefined, channel: ltcChannelB },
      audioOut: { device: audioOutputDevice || undefined, left: audioOutputChannelL, right: audioOutputChannelR },
      deckReturn, followTc,
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Project settings <span className="modal-title-sub">{showfileName}</span></span>
          <button className="btn ghost modal-close" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="modal-body">
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
              SMPTE A/B are two separate LTC inputs. Which one a timeline follows, and from which start TC, is set per timeline in ✎ Edit timeline.
            </span>
            <Row label="Follow TC">
              <label className="modal-check" title="Incoming LTC selects the timeline whose start TC it belongs to (one song per TC range), and it plays from the right place. Also the FOLLOW TC chip next to the clock.">
                <input type="checkbox" checked={followTc} onChange={e => setFollowTc(e.target.checked)} />
                <span>Incoming LTC selects its timeline (no GO needed)</span>
              </label>
            </Row>
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
