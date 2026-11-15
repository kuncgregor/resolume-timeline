// The playhead frame, kept outside React state. It changes at frame rate while the timeline
// runs; as App state it re-rendered the whole app on every frame. Components that show it
// subscribe with useFrame(); event handlers read frameStore.get().
import { useEffect, useState, useSyncExternalStore } from 'react'

let current = 0
const listeners = new Set<() => void>()

export const frameStore = {
  get: (): number => current,
  set(frame: number) {
    if (frame === current) return
    current = frame
    listeners.forEach(l => l())
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
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
