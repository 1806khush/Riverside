import { ArrowsDownUp, CaretDown, Check } from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

const options = [
  { value: 'recent', label: 'Date recorded' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
] as const

export type Order = typeof options[number]['value']

export function RecordingSort({ value, onChange }: { value: Order; onChange: (value: Order) => void }) {
  const menuId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selected = options.findIndex((option) => option.value === value)
  const initialFocus = useRef(selected)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelectorAll('button')[initialFocus.current]?.focus()
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [open])

  function show(index: number) {
    initialFocus.current = index
    setOpen(true)
  }

  function closeAndFocus() {
    setOpen(false)
    trigger.current?.focus()
  }

  function handleMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAndFocus()
      return
    }
    const items = Array.from(menu.current?.querySelectorAll('button') ?? [])
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (current + 1) % items.length; break
      case 'ArrowUp': next = (current - 1 + items.length) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div ref={root} className="mw-sort" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button ref={trigger} className="mw-sort-trigger" type="button"
        aria-label={`Sort recordings: ${options[selected].label}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => open ? closeAndFocus() : show(selected)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          show(event.key === 'ArrowDown' ? 0 : options.length - 1)
        }}>
        <ArrowsDownUp size={15} aria-hidden />
        <span>{options[selected].label}</span>
        <CaretDown className="mw-sort-caret" size={12} aria-hidden />
      </button>
      {open && (
        <div ref={menu} id={menuId} className="mw-sort-menu" role="menu" aria-label="Sort recordings" onKeyDown={handleMenuKey}>
          {options.map((option) => (
            <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value} tabIndex={-1}
              onClick={() => {
                onChange(option.value)
                closeAndFocus()
              }}>
              <span>{option.label}</span>
              {value === option.value && <Check size={14} weight="bold" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
