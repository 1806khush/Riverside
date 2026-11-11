import { X } from '@phosphor-icons/react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

export function Dialog({ title, description, children, close, busy = false }: {
  title: string
  description?: string
  children: ReactNode
  close: () => void
  busy?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    const trigger = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  return (
    <dialog
      className="mw-dialog"
      ref={ref}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) close() }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) close() }}
    >
      <div className="mw-dialog-inner">
        <div className="mw-dialog-heading">
          <div>
            <h2 id={id}>{title}</h2>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          <button type="button" className="mw-icon-button" aria-label="Close dialog" disabled={busy} onClick={close}><X size={17} /></button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
