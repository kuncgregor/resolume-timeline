// The playhead frame, kept outside React state. It changes at frame rate while the timeline
// runs; as App state it re-rendered the whole app on every frame. Components that show it
// subscribe with useFrame(); event handlers read frameStore.get().
import { useEffect, useState, useSyncExternalStore } from 'react'

let current = 0
const listeners = new Set<() => void>()
// For smooth motion between frames: when the last frame came and how fast frames advance
let setAt = 0, rate = 0   // rate: frames per ms (0 = not advancing steadily)

export const frameStore = {
  get: (): number => current,
  set(frame: number) {
    if (frame === current) return
    const now = performance.now(), d = frame - current, dt = now - setAt
    // Playing: one or two frames forward in under 200 ms. Anything else (a locate, a scrub,
    // backwards) stops the extrapolation
    rate = d > 0 && d <= 2 && dt > 0 && dt < 200 ? (rate ? rate * 0.7 + (d / dt) * 0.3 : d / dt) : 0
    current = frame; setAt = now
    listeners.forEach(l => l())
  },
  /** The playhead between frames (what a 60–120 Hz display shows while frames come at 25–30 Hz):
   *  the last frame moved on by the time since it came, at most a frame and a half ahead, and
   *  only while frames keep coming (stopped, it is the frame). */
  smooth(now = performance.now()): number {
    const dt = now - setAt
    return rate > 0 && dt < 120 ? current + Math.min(1.5, dt * rate) : current
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

// The last incoming LTC timecode ("01:00:12:04"): it changes at frame rate, so it stays out of
// App state too; only the clock chip shows it
let ltcTc = '--:--:--:--'
const ltcListeners = new Set<() => void>()
export const ltcTcStore = {
  get: (): string => ltcTc,
  set(tc: string) { if (tc !== ltcTc) { ltcTc = tc; ltcListeners.forEach(l => l()) } },
  subscribe(listener: () => void): () => void { ltcListeners.add(listener); return () => { ltcListeners.delete(listener) } },
}
export function useLtcTc(): string {
  return useSyncExternalStore(ltcTcStore.subscribe, ltcTcStore.get)
}

/** The playhead frame; the component re-renders when it changes. */
export function useFrame(): number {
  return useSyncExternalStore(frameStore.subscribe, frameStore.get)
}

/** The playhead frame, re-rendering at most every `ms` (text that needs no frame rate: lists,
 *  countdowns, values). A change while stopped (locate, scrub) shows at once. */
export function useFrameEvery(ms: number): number {
  const [frame, setFrame] = useState(frameStore.get)
  useEffect(() => {
    let last = 0, timer = 0
    const update = () => { timer = 0; last = performance.now(); setFrame(frameStore.get()) }
    const unsub = frameStore.subscribe(() => {
      if (timer) return
      const wait = ms - (performance.now() - last)
      if (wait <= 0) update(); else timer = window.setTimeout(update, wait)
    })
    return () => { unsub(); clearTimeout(timer) }
  }, [ms])
  return frame
}
