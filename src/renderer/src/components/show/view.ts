import { useSyncExternalStore } from 'react'
import { TOUCH } from '../../touch'

// What this device shows. SETUP mode: the editor. SHOW mode: the show view in the style chosen per
// device in VIEW › Show view — Tablet (ShowView: big, radar, COMING) or Desktop (the editor in its
// SHOW dress: timeline, show bar, COMING column). A phone always gets the show view's phone
// layout (the editor doesn't fit it). ?view=remote / ?view=full force one for the tab (testing).

const api = (window as any).timeline

const PHONE_QUERY = '(orientation: portrait) and (max-width: 600px)'
const STYLE_KEY = 'resolume-timeline:show-style'
const OLD_VIEW_KEY = 'resolume-timeline:view'   // before Tablet / Desktop: 'remote' | 'full'
const TAB_KEY = 'tl-view'

export type ShowStyle = 'tablet' | 'desktop'

let style: ShowStyle = (() => {
  try {
    const old = localStorage.getItem(OLD_VIEW_KEY)
    if (old) { localStorage.removeItem(OLD_VIEW_KEY); if (old === 'remote') localStorage.setItem(STYLE_KEY, 'tablet') }
    const v = localStorage.getItem(STYLE_KEY)
    if (v === 'tablet' || v === 'desktop') return v
  } catch { /* storage blocked: the default */ }
  // A tablet on the LAN link: the tablet show view; the computer: the editor's SHOW dress
  return api?.__remote && TOUCH ? 'tablet' : 'desktop'
})()

// This tab only (sessionStorage, so test iframes don't change each other)
let forced: 'remote' | 'full' | null = (() => {
  try {
    const v = new URLSearchParams(location.search).get('view')
    if (v === 'remote' || v === 'full') sessionStorage.setItem(TAB_KEY, v)
    else if (v === 'auto') sessionStorage.removeItem(TAB_KEY)
    const kept = sessionStorage.getItem(TAB_KEY)
    return kept === 'remote' || kept === 'full' ? kept : null
  } catch { return null }
})()

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(f => f())
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

export const showStyle = {
  get: (): ShowStyle => style,
  set(v: ShowStyle) {
    style = v
    try { localStorage.setItem(STYLE_KEY, v) } catch { /* ignore */ }
    notify()
  },
}

/** Drops a ?view= forced for this tab (SETUP in the show view goes to the editor). */
export function clearForcedView() {
  forced = null
  try { sessionStorage.removeItem(TAB_KEY) } catch { /* ignore */ }
  notify()
}

export function useShowStyle(): ShowStyle {
  return useSyncExternalStore(subscribe, () => style)
}

const queries = new Map<string, { m: MediaQueryList | null; sub: (cb: () => void) => () => void }>()
/** Whether a media query matches, kept up to date. */
export function useMedia(q: string): boolean {
  let e = queries.get(q)
  if (!e) {
    const m = typeof matchMedia === 'function' ? matchMedia(q) : null
    e = { m, sub: (cb: () => void) => { m?.addEventListener('change', cb); return () => m?.removeEventListener('change', cb) } }
    queries.set(q, e)
  }
  const m = e.m
  return useSyncExternalStore(e.sub, () => !!m?.matches)
}

/** A phone in portrait: only the show view's phone layout. */
export const usePhone = () => useMedia(PHONE_QUERY)

/** True when this device shows ShowView instead of the editor. */
export function useShowViewActive(showMode: boolean): boolean {
  const phone = usePhone()
  const s = useShowStyle()
  const f = useSyncExternalStore(subscribe, () => forced)
  if (f) return f === 'remote'
  if (phone) return true
  return showMode && s === 'tablet'
}
