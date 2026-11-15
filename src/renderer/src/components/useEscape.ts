import { useEffect, type RefObject } from 'react'

// Closes a modal on Escape
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])
}

/** An open menu closes on Escape and on a press outside `root`. That press only closes it:
 *  during a show it could land on PLAY, STOP, GO or REC ARENA, so it is caught before anything
 *  else sees it (capture on the window), its click too. */
export function useDismiss(open: boolean, root: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    let swallow = false
    const down = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return
      // Another menu's button, or a right-click (it opens its own menu, and no click follows
      // it to swallow): closes this one and goes on
      if (e.button !== 0 || (e.target as Element).closest?.('.menu-anchor')) { onClose(); return }
      e.stopPropagation(); e.preventDefault()
      swallow = true; onClose()
    }
    // A right-click elsewhere (another context menu) closes it too, and still opens its own
    const ctx = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) onClose() }
    const click = (e: MouseEvent) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault() } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('contextmenu', ctx, true)
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('contextmenu', ctx, true)
      window.removeEventListener('keydown', esc, true)
      // The click of the closing press comes after the menu is gone: still swallowed
      setTimeout(() => window.removeEventListener('click', click, true), 400)
    }
  }, [open, root, onClose])
}
