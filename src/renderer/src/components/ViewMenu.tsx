import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from './useEscape'
import { TOUCH, UI_SCALE, UI_SCALES, touchSettings } from '../touch'
import { clearForcedView, showSize, showStyle, usePhone, useShowSize, useShowStyle } from './show/view'

// VIEW menu, per device: what SHOW mode looks like here (Tablet / Desktop), touch mode, size and
// scale. In the editor's top bar and in the show view's band (a tablet must reach Scale there too).

export function ViewMenu({ showMode, playing = false, className = 'btn ghost', label = 'View ▾' }: {
  showMode: boolean; playing?: boolean; className?: string; label?: string
}) {
  const [open, setOpen] = useState(false)
  const style = useShowStyle()
  const size = useShowSize()
  const phone = usePhone()
  const rootRef = useRef<HTMLDivElement>(null)
  // The mini show window (the app only: a browser can't float a window over Resolume)
  const api = (window as any).timeline
  const [miniOpen, setMiniOpen] = useState(false)
  // Touch, Size and Scale reload the page. The app window (not a tablet) decodes LTC and plays
  // the audio track: while the timeline runs they wait
  const reloadLocked = playing && !api?.__remote
  const lockedTitle = 'Stop the timeline first: this reloads the window (LTC and the audio track would drop)'
  useEffect(() => {
    if (!api?.miniGet) return
    api.miniGet().then((st: { open: boolean }) => setMiniOpen(st.open), () => {})
    return api.onMiniState?.((st: { open: boolean }) => setMiniOpen(st.open))
  }, [])

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, rootRef, close)

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
            <div className="view-menu-row" title="A bar along the screen's edge that floats over Resolume, beside this window (which stays open): NOW / NEXT, bar and section, time to end, what comes next, ⏮ · STOP · PLAY · BACK · GO. For one laptop without a tablet. Also View › Mini Window (⇧⌘M).">
              <span>Mini window</span>
              {([false, true] as const).map(on => (
                <button key={String(on)} className={`seg-btn${miniOpen === on ? ' on' : ''}`}
                  onClick={() => { if (miniOpen !== on) api.miniToggle().then((st: { open: boolean }) => setMiniOpen(st.open)) }}>{on ? 'On' : 'Off'}</button>
              ))}
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
                disabled={reloadLocked && touchSettings.mode() !== m}
                title={reloadLocked ? lockedTitle : m === 'auto' ? 'On for touch screens (tablets)' : m === 'on' ? 'Finger gestures and the touch toolbar on this device' : 'Mouse and keyboard only'}
                onClick={() => touchSettings.setMode(m)}>{m === 'auto' ? 'Auto' : m === 'on' ? 'On' : 'Off'}</button>
            ))}
          </div>
          {TOUCH && (
            <div className="view-menu-row">
              <span>Size</span>
              {(['large', 'compact'] as const).map(z => (
                <button key={z} className={`seg-btn${touchSettings.size() === z ? ' on' : ''}`}
                  disabled={reloadLocked && touchSettings.size() !== z}
                  title={reloadLocked ? lockedTitle : z === 'large' ? 'Finger-sized buttons and rows' : 'Desktop sizes: more fits on the screen'}
                  onClick={() => touchSettings.setSize(z)}>{z === 'large' ? 'Large' : 'Compact'}</button>
              ))}
            </div>
          )}
          {(TOUCH || UI_SCALE !== 1 || !!(window as any).timeline?.setUiZoom) && (
            <div className="view-menu-row" title="The whole page drawn smaller, so more fits (tablets and the app window; in a desktop browser use its zoom)">
              <span>Scale</span>
              {UI_SCALES.map(v => (
                <button key={v} className={`seg-btn${UI_SCALE === v ? ' on' : ''}`}
                  disabled={reloadLocked && UI_SCALE !== v} title={reloadLocked ? lockedTitle : undefined} onClick={() => touchSettings.setScale(v)}>{Math.round(v * 100)}%</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
