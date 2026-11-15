// Touch screens (tablets on the LAN, touch PCs): the full UI with finger gestures in place of the
// mouse-only ones (right-click, wheel, hover, keyboard). On for a coarse primary pointer, or set
// per device in the VIEW menu (kept in localStorage); ?touch=1 / ?touch=0 forces it for the tab.
// Size: Large (finger-sized buttons and rows) or Compact (desktop sizes, more on screen).
// Scale (tablets): the whole page drawn smaller through the viewport, so more fits.

const TAB_KEY = 'tl-touch'
const DEVICE_KEY = 'resolume-timeline:touch'
const SIZE_KEY = 'resolume-timeline:touch-size'
const SCALE_KEY = 'resolume-timeline:ui-scale'

const local = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }

function detect(): boolean {
  try {
    const forced = new URLSearchParams(location.search).get('touch')
    if (forced === '1' || forced === '0') sessionStorage.setItem(TAB_KEY, forced)
    const tab = sessionStorage.getItem(TAB_KEY)
    if (tab === '1' || tab === '0') return tab === '1'
  } catch { /* storage blocked: device setting / detection only */ }
  const device = local(DEVICE_KEY)
  if (device === 'on' || device === 'off') return device === 'on'
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export const TOUCH = detect()
/** Finger-sized buttons and rows (touch mode, size Large). */
export const TOUCH_LARGE = TOUCH && local(SIZE_KEY) !== 'compact'
export const UI_SCALES = [1, 0.9, 0.8, 0.7] as const
export const UI_SCALE: number = (() => {
  const v = Number(local(SCALE_KEY))
  return (UI_SCALES as readonly number[]).includes(v) ? v : 1
})()

/** Marks the page (html.touch, html.touch-large) and sets the viewport: the scale, and no browser
 *  pinch / double-tap page zoom (it would fight the timeline's gestures). */
export function applyTouchMode() {
  const html = document.documentElement
  if (TOUCH) html.classList.add('touch')
  if (TOUCH_LARGE) html.classList.add('touch-large')
  // The app window (Electron): its page zoom; browsers: the viewport (tablets, phones)
  const api = (window as any).timeline
  if (api?.setUiZoom) { api.setUiZoom(UI_SCALE); if (!TOUCH) return }
  if (!TOUCH && UI_SCALE === 1) return
  const s = UI_SCALE
  document.querySelector('meta[name="viewport"]')?.setAttribute('content',
    `width=device-width, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`)
}

// Reload to apply a setting, without ?touch / ?view in the address (they would override it
// again); the access key and anything else stay
function reloadClean() {
  const url = new URL(location.href)
  url.searchParams.delete('touch'); url.searchParams.delete('view')
  location.replace(url.toString())
}

/** VIEW menu settings, per device; the page reloads to apply them. */
export const touchSettings = {
  /** 'auto' = on for touch screens (coarse pointer). */
  mode: (): 'auto' | 'on' | 'off' => { const v = local(DEVICE_KEY); return v === 'on' || v === 'off' ? v : 'auto' },
  setMode(v: 'auto' | 'on' | 'off') {
    try {
      if (v === 'auto') localStorage.removeItem(DEVICE_KEY); else localStorage.setItem(DEVICE_KEY, v)
      sessionStorage.removeItem(TAB_KEY)
    } catch { /* ignore */ }
    reloadClean()
  },
  size: (): 'large' | 'compact' => local(SIZE_KEY) === 'compact' ? 'compact' : 'large',
  setSize(v: 'large' | 'compact') { try { localStorage.setItem(SIZE_KEY, v) } catch { /* ignore */ } reloadClean() },
  setScale(v: number) { try { localStorage.setItem(SCALE_KEY, String(v)) } catch { /* ignore */ } reloadClean() },
}

/** Long press (ms, finger still) = what a right-click does with a mouse. */
export const LONG_PRESS_MS = 500
/** Two taps this close in time (ms) and space (px) = a double-click. */
export const DOUBLE_TAP_MS = 320
export const DOUBLE_TAP_PX = 24
