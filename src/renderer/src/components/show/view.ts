import { useSyncExternalStore } from 'react'
import { TOUCH } from '../../touch'

// Which view this device shows: the show view (ShowView) or the full editor. A phone, and by
// default a tablet on the LAN link, start in the show view; the editor is one tap away (SETUP).

const api = (window as any).timeline

const PHONE_QUERY = '(orientation: portrait) and (max-width: 600px)'
const VIEW_KEY = 'resolume-timeline:view'
type View = 'remote' | 'full' | 'auto'

// The view chosen on this device (VIEW menu, Setup / Show buttons, or ?view=remote|full|auto)
let chosen: View = (() => {
  const v = new URLSearchParams(location.search).get('view')
  try {
    if (v === 'remote' || v === 'full') localStorage.setItem(VIEW_KEY, v)
    else if (v === 'auto') localStorage.removeItem(VIEW_KEY)
    const kept = localStorage.getItem(VIEW_KEY)
    return kept === 'remote' || kept === 'full' ? kept : 'auto'
  } catch { return v === 'remote' || v === 'full' ? v : 'auto' }
})()
const viewListeners = new Set<() => void>()

/** Show view (remote) or the full editor on this device; 'auto' = by screen. */
export function setAppView(v: View) {
  chosen = v
  try { if (v === 'auto') localStorage.removeItem(VIEW_KEY); else localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ }
  viewListeners.forEach(f => f())
}

const media = (q: string) => typeof matchMedia === 'function' ? matchMedia(q) : null
const subscribeMedia = (m: MediaQueryList | null) => (cb: () => void) => {
  m?.addEventListener('change', cb)
  return () => m?.removeEventListener('change', cb)
}
const subscribeView = (cb: () => void) => { viewListeners.add(cb); return () => { viewListeners.delete(cb) } }

const queries = new Map<string, { m: MediaQueryList | null; sub: (cb: () => void) => () => void }>()
/** Whether a media query matches, kept up to date. */
export function useMedia(q: string): boolean {
  let e = queries.get(q)
  if (!e) { const m = media(q); e = { m, sub: subscribeMedia(m) }; queries.set(q, e) }
  const m = e.m
  return useSyncExternalStore(e.sub, () => !!m?.matches)
}

/** True when the app should show the show view instead of the timeline. */
export function useRemoteLayout(): boolean {
  const phone = useMedia(PHONE_QUERY)
  const view = useSyncExternalStore(subscribeView, () => chosen)
  if (view !== 'auto') return view === 'remote'
  return phone || (!!api.__remote && TOUCH)
}
