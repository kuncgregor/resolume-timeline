import { useEffect } from 'react'

// A yes / no question in the app's modal style (browser confirm() would block the page).
// Enter confirms, Escape or a click outside cancels.
interface Props {
  title: string
  message: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm() }
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [onConfirm, onCancel])
  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal modal-narrow" role="alertdialog" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">{title}</span></div>
        <div className="confirm-message">{message}</div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'modal-danger' : 'modal-primary'}`} autoFocus onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
