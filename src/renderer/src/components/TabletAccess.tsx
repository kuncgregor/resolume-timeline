import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

// Top-bar control for the app's tablet server: the UI in a browser on the same network
// (src/main/web-server.ts). In a tablet's browser it shows that this UI is the remote.
interface RemoteInfo { enabled: boolean; running: boolean; port: number; urls: string[]; error: string | null }

const api = (window as any).timeline

export function TabletAccess() {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { api.getRemoteServer?.().then((i: RemoteInfo | null) => setInfo(i)) }, [])
  // The network can change (Wi-Fi joined later): refresh the addresses when opened
  useEffect(() => { if (open) api.getRemoteServer?.().then((i: RemoteInfo | null) => setInfo(i)) }, [open])

  const url = info?.urls[0] ?? null
  useEffect(() => {
    if (!url) { setQr(null); return }
    QRCode.toDataURL(url, { margin: 1, width: 168, color: { dark: '#111111', light: '#ffffff' } })
      .then(setQr, () => setQr(null))
  }, [url])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])

  if (api.__remote) {
    return (
      <span className="chip tablet-chip remote"
        title="This is the tablet view of the app on the computer. Timelines and edits are shared; LTC, the audio track and recording run on the computer.">
        Tablet view
      </span>
    )
  }
  if (!info) return null   // browser dev mode: no tablet server

  const toggle = async () => {
    setBusy(true)
    try { setInfo(await api.setRemoteServer(!info.enabled)) } finally { setBusy(false) }
  }
  const copy = (u: string) => {
    navigator.clipboard?.writeText(u).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }, () => {})
  }

  return (
    <div className="menu-anchor" ref={rootRef}>
      <button className={`chip tablet-chip ${info.running ? 'on' : ''}`} onClick={() => setOpen(o => !o)}
        title={info.running ? 'Tablet access is on: the app can be used from a browser on this network' : 'Use the app from a tablet (browser on the same network)'}>
        Tablet{info.running ? ' · on' : ''}
      </button>
      {open && (
        <div className="dropdown tablet-pop">
          <div className="tablet-head">
            <b>Tablet access</b>
            <button className={`tablet-switch ${info.enabled ? 'on' : ''}`} onClick={toggle} disabled={busy}
              aria-pressed={info.enabled}>{info.enabled ? 'ON' : 'OFF'}</button>
          </div>
          {!info.enabled && (
            <p className="tablet-note">Turn on to open this app in a browser on a tablet or another computer on the same network. Both show and edit the same timelines.</p>
          )}
          {info.error && <p className="tablet-note danger">Could not start: {info.error}</p>}
          {info.running && !url && <p className="tablet-note danger">This computer is not on a network.</p>}
          {info.running && url && (
            <>
              <div className="tablet-qr">{qr && <img src={qr} alt="QR code of the tablet link" width={168} height={168} />}</div>
              <p className="tablet-note">Scan with the tablet's camera, or open:</p>
              {info.urls.map(u => (
                <button key={u} className="tablet-url mono" onClick={() => copy(u)} title="Copy the link">{u}</button>
              ))}
              {copied && <span className="tablet-copied">Copied</span>}
              <p className="tablet-note dim">LTC, the audio track and recording stay on this computer. The link holds an access key: share it only with your crew.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
