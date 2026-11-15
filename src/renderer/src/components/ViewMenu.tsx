import { useEffect, useRef, useState } from 'react'
import { TOUCH, UI_SCALE, UI_SCALES, touchSettings } from '../touch'
import { clearForcedView, showSize, showStyle, usePhone, useShowSize, useShowStyle } from './show/view'

// VIEW menu, per device: what SHOW mode looks like here (Tablet / Desktop), touch mode, size and
// scale. In the editor's top bar and in the show view's band (a tablet must reach Scale there too).

export function ViewMenu({ showMode, className = 'btn ghost', label = 'View ▾' }: {
  showMode: boolean; className?: string; label?: string
}) {
  const [open, setOpen] = useState(false)
  const style = useShowStyle()
  const size = useShowSize()
  const phone = usePhone()
  const rootRef = useRef<HTMLDivElement>(null)
  // The mini show window (the app only: a browser can't float a window over Resolume)
  const api = (window as any).timeline
  const [miniOpen, setMiniOpen] = useState(false)
  useEffect(() => {
    if (!api?.miniGet) return
    api.miniGet().then((st: { open: boolean }) => setMiniOpen(st.open), () => {})
    return api.onMiniState?.((st: { open: boolean }) => setMiniOpen(st.open))
  }, [])

  useEffect(() => {
    if (!open) return
    // A tap outside only closes the menu: during a show it could land on PLAY, STOP or GO.
    // Caught before anything else sees it (capture on the window), its click too.
    let swallow = false
    const close = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      e.stopPropagation(); e.preventDefault()
      swallow = true; setOpen(false)
    }
    const click = (e: MouseEvent) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault() } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc)
      // The click of the closing tap comes after the menu is gone: still swallowed
      setTimeout(() => window.removeEventListener('click', click, true), 400)
    }
  }, [open])

  return (
    <div className="menu-anchor" ref={rootRef}>
      <button className={className} aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>{label}</button>
      {open && (
        <div className="dropdown view-menu" onClick={e => e.stopPropagation()}>
          {/* What SHOW mode looks like on this device (a phone has only the show view) */}
          {!phone && <>
          <div className="view-menu-row" title="How this device looks in SHOW mode. Tablet: big clock, radar of the next bars and the coming events, no editor around it. Desktop: the same with the editor's top bar and show bar.">
            <span>Show view</span>
            {(['tablet', 'desktop'] as const).map(v => (
              <button key={v} className={`seg-btn${style === v ? ' on' : ''}`}
                onClick={() => { clearForcedView(); showStyle.set(v) }}>{v === 'tablet' ? 'Tablet' : 'Desktop'}</button>
            ))}
          </div>
          <div className="view-menu-note">Used in SHOW mode{showMode ? '' : ' — switch to SHOW to see it'}</div>
          </>}
          {api?.miniToggle && (
            <div className="view-menu-row" title="A small strip (or column) that floats over Resolume: NOW / NEXT, bar and section, time to end, what comes next, BACK · STOP · PLAY · GO. For one laptop without a tablet.">
              <span>Mini window</span>
              <button className={`seg-btn${miniOpen ? ' on' : ''}`} onClick={() => api.miniToggle().then((st: { open: boolean }) => setMiniOpen(st.open))}>
                {miniOpen ? 'Open · close it' : 'Open'}</button>
            </div>
          )}
          {/* The show view's type, bars and buttons (changes at once, no reload) */}
          <div className="view-menu-row" title="Size of the show view: Compact fits more, Large reads from further away">
            <span>Show size</span>
            {(['compact', 'normal', 'large'] as const).map(z => (
              <button key={z} className={`seg-btn${size === z ? ' on' : ''}`} onClick={() => showSize.set(z)}>
                {z === 'compact' ? 'Compact' : z === 'normal' ? 'Normal' : 'Large'}</button>
            ))}
          </div>
          <div className="dropdown-sep" />
          <div className="view-menu-row">
            <span>Touch</span>
            {(['auto', 'on', 'off'] as const).map(m => (
              <button key={m} className={`seg-btn${touchSettings.mode() === m ? ' on' : ''}`}
                title={m === 'auto' ? 'On for touch screens (tablets)' : m === 'on' ? 'Finger gestures and the touch toolbar on this device' : 'Mouse and keyboard only'}
                onClick={() => touchSettings.setMode(m)}>{m === 'auto' ? 'Auto' : m === 'on' ? 'On' : 'Off'}</button>
            ))}
          </div>
          {TOUCH && (
            <div className="view-menu-row">
              <span>Size</span>
              {(['large', 'compact'] as const).map(z => (
                <button key={z} className={`seg-btn${touchSettings.size() === z ? ' on' : ''}`}
                  title={z === 'large' ? 'Finger-sized buttons and rows' : 'Desktop sizes: more fits on the screen'}
                  onClick={() => touchSettings.setSize(z)}>{z === 'large' ? 'Large' : 'Compact'}</button>
              ))}
            </div>
          )}
          {(TOUCH || UI_SCALE !== 1 || !!(window as any).timeline?.setUiZoom) && (
            <div className="view-menu-row" title="The whole page drawn smaller, so more fits (tablets and the app window; in a desktop browser use its zoom)">
              <span>Scale</span>
              {UI_SCALES.map(v => (
                <button key={v} className={`seg-btn${UI_SCALE === v ? ' on' : ''}`} onClick={() => touchSettings.setScale(v)}>{Math.round(v * 100)}%</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
