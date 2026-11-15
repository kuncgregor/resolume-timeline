// Keeps a tablet's screen on while the app is open (the show view stands on a desk for hours).
// The Screen Wake Lock API only exists on HTTPS / localhost; the tablet link is plain HTTP on the
// LAN, so there a muted, inline, looping 2 s video does it (iOS / Android keep the screen on while
// a video plays). It starts on the first touch when the browser wants a gesture first.
import { useEffect, useState } from 'react'

// 16 × 16 black, 2 s, H.264 baseline (1.5 KB; made with ffmpeg)
const VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PEyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApQAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAACiQAAAAsAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDEAAAAIZnJlZQAAApxtZGF0AAACcgYF//9u3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOi0zOi0zIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0yLjAwOjAuNzAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS00IHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4yMACAAAAAD2WIhAXzn///D0UAAVefgAAAAAdBmjgL5zqA'

type Nav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: 'release', f: () => void): void }> } }

/** True once the screen is held on (API or video). */
export function useKeepAwake(active: boolean): boolean {
  const [awake, setAwake] = useState(false)
  useEffect(() => {
    if (!active) return
    let alive = true, lock: { release(): Promise<void> } | null = null, video: HTMLVideoElement | null = null
    const nav = navigator as Nav

    const viaApi = async () => {
      if (!nav.wakeLock || !window.isSecureContext) return false
      try {
        const l = await nav.wakeLock.request('screen')
        if (!alive) { l.release(); return true }
        lock = l
        l.addEventListener('release', () => { lock = null; if (alive) setAwake(false) })
        setAwake(true)
        return true
      } catch { return false }
    }
    const viaVideo = () => {
      if (!video) {
        video = document.createElement('video')
        video.muted = true; video.loop = true; video.playsInline = true
        video.setAttribute('playsinline', ''); video.setAttribute('muted', '')
        video.src = VIDEO
        Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0.01', left: '0', bottom: '0', pointerEvents: 'none' })
        document.body.appendChild(video)
      }
      video.play().then(() => alive && setAwake(true)).catch(() => {})
    }
    const start = async () => { if (!(await viaApi())) viaVideo() }
    // The lock is dropped when the page is hidden; take it again when it comes back
    const onVisible = () => { if (document.visibilityState === 'visible' && !lock) start() }
    // Without a gesture the browser may refuse: the first touch / click anywhere starts it
    const onGesture = () => { start() }
    start()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pointerdown', onGesture, { capture: true, once: true })
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pointerdown', onGesture, { capture: true })
      lock?.release().catch(() => {})
      if (video) { video.pause(); video.remove() }
      setAwake(false)
    }
  }, [active])
  return awake
}
