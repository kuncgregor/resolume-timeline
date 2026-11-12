// The playhead frame, kept outside React state. It changes at frame rate while the timeline
// runs; as App state it re-rendered the whole app on every frame. Components that show it
// subscribe with useFrame(); event handlers read frameStore.get().
import { useSyncExternalStore } from 'react'

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
