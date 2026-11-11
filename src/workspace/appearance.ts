import { useEffect, useSyncExternalStore } from 'react'

export type Appearance = 'system' | 'light' | 'dark'
const key = 'mosaic-web:appearance'
const change = 'mosaic-web:appearance-change'
const darkMode = '(prefers-color-scheme: dark)'

export const appearanceScript = `(() => {
  const root = document.documentElement
  let preference
  try { preference = localStorage.getItem('${key}') } catch {}
  root.dataset.appearance = preference === 'light' || preference === 'dark'
    ? preference : matchMedia('${darkMode}').matches ? 'dark' : 'light'
  if (location.pathname !== '/' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  try {
    if (sessionStorage.getItem('mosaic-web:splash')) return
    sessionStorage.setItem('mosaic-web:splash', 'seen')
    root.dataset.splash = 'on'
  } catch {}
})()`

function read(): Appearance {
  try {
    const value = localStorage.getItem(key)
    if (value === 'light' || value === 'dark') return value
  } catch {}
  return 'system'
}

function apply() {
  const preference = read()
  document.documentElement.dataset.appearance = preference === 'system'
    ? (matchMedia(darkMode).matches ? 'dark' : 'light')
    : preference
}

export function setAppearance(value: Appearance) {
  localStorage.setItem(key, value)
  apply()
  window.dispatchEvent(new Event(change))
}

function subscribe(callback: () => void) {
  window.addEventListener(change, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(change, callback)
    window.removeEventListener('storage', callback)
  }
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, read, () => 'system' as Appearance)
}

export function AppearanceSync() {
  useEffect(() => {
    const query = matchMedia(darkMode)
    apply()
    query.addEventListener('change', apply)
    window.addEventListener('storage', apply)
    return () => {
      query.removeEventListener('change', apply)
      window.removeEventListener('storage', apply)
    }
  }, [])
  return null
}
