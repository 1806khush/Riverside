import { DB, type Diagnostic } from './storage'

const unsaved: Diagnostic[] = []
let pending = Promise.resolve()
let queued = 0

export function logRecording(event: string, sessionId?: string, details?: Diagnostic['details']) {
  const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), event, sessionId, details }
  const remember = () => {
    if (unsaved.length >= 120) unsaved.shift()
    unsaved.push(entry)
  }
  if (queued >= 64) return remember()
  queued++
  pending = pending.then(() => DB.putDiagnostic(entry)).then(() => {}, remember).finally(() => { queued-- })
}

export function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'UnknownError'
}

export async function storageEstimate() {
  return navigator.storage?.estimate?.().catch(() => ({} as StorageEstimate)) ?? {}
}

export function heapUsed() {
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
}

export async function recordingReport(summary: object) {
  await pending
  const stored = await DB.getDiagnostics().catch(() => [] as Diagnostic[])
  const events = [...stored, ...unsaved].sort((a, b) => a.at.localeCompare(b.at))
  const environment = { browser: navigator.userAgent, platform: navigator.platform, heapBytes: heapUsed() }
  return ['Mosaic Web recording diagnostics', new Date().toISOString(),
    JSON.stringify({ ...environment, ...summary }, null, 2),
    ...events.map(({ at, event, sessionId, details }) =>
      [at, event, sessionId, details && JSON.stringify(details)].filter(Boolean).join('  ')),
  ].join('\n')
}

export async function clearRecordingLog() {
  pending = pending.then(async () => {
    await DB.clearDiagnostics()
    unsaved.length = 0
  })
  const cleared = pending
  pending = cleared.catch(() => {})
  await cleared
}
