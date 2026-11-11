import { CheckCircle, Desktop, Moon, Sun } from '@phosphor-icons/react'
import { useState } from 'react'
import { setAppearance, useAppearance, type Appearance } from './appearance'

const options = [
  { value: 'system', label: 'System', icon: Desktop },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const

export function AppearanceSettings() {
  const appearance = useAppearance()
  const [failed, setFailed] = useState(false)
  function select(value: Appearance) {
    try { setAppearance(value); setFailed(false) } catch { setFailed(true) }
  }
  return (
    <>
      <fieldset className="mw-appearance">
        <legend>Appearance</legend>
        {options.map(({ value, label, icon: Icon }) => (
          <label className="mw-theme-option" key={value}>
            <input type="radio" name="appearance" value={value} checked={appearance === value} onChange={() => select(value)} />
            <span className="mw-theme-art" data-preview={value} aria-hidden="true">
              <span className="mw-theme-sidebar"><i /><i /><i /></span>
              <span className="mw-theme-page"><i /><b /><b /></span>
            </span>
            <span className="mw-theme-label"><Icon size={15} />{label}{appearance === value && <CheckCircle size={15} weight="fill" />}</span>
          </label>
        ))}
      </fieldset>
      {failed && <p role="alert" className="mw-error">This browser couldn’t save the appearance setting.</p>}
    </>
  )
}
