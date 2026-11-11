import { DB, type Chunk, type Recording } from './storage'
import { WebmBoundary } from './webm-boundary'

export const CHUNK_MS = 5000

export async function createRecordingFiles() {
  let worker: Worker | undefined
  let storage: Recording['storage'] = 'indexeddb'

  const send = (data: { sessionId: string; track: string; offset: number; blob: Blob } | null) => {
    const target = worker!
    return new Promise<number | undefined>((resolve, reject) => {
      const finish = (error?: Error, playableEnd?: number) => {
        clearTimeout(timer)
        target.onmessage = target.onerror = target.onmessageerror = null
        if (error) reject(error)
        else resolve(playableEnd)
      }
      const timer = setTimeout(() => finish(new DOMException('Local video write timed out.', 'TimeoutError')), 20000)
      target.onmessage = ({ data: reply }) => finish(reply.ok ? undefined : new DOMException('Local video write failed.', reply.name), reply.playableEnd)
      target.onerror = target.onmessageerror = () => finish(new DOMException('Local video writer stopped.', 'NotReadableError'))
      try { target.postMessage(data) } catch { finish(new DOMException('Could not send a local video chunk.', 'DataError')) }
    })
  }

  if (typeof navigator.storage?.getDirectory === 'function') {
    try {
      worker = new Worker(new URL('./recording-files.worker.ts', import.meta.url), { type: 'module' })
      await send(null)
      storage = 'opfs'
    } catch {
      worker?.terminate()
      worker = undefined
    }
  }

  let failNextWrite = false
  const offsets = new Map<string, number>()
  const boundaries = new Map<string, WebmBoundary>()
  return {
    storage,
    close: () => worker?.terminate(),
    ...(import.meta.env.DEV ? { simulateWriteFailure: () => { failNextWrite = true } } : {}),
    async write(chunk: Chunk & { blob: Blob }, session: Recording) {
      if (import.meta.env.DEV && failNextWrite) {
        failNextWrite = false
        throw new DOMException('Simulated storage failure.', 'QuotaExceededError')
      }
      const { blob, ...metadata } = chunk
      const offset = offsets.get(chunk.track) ?? 0
      const byteEnd = offset + blob.size
      let playableEnd: number | undefined
      if (worker) {
        playableEnd = await send({ sessionId: session.id, track: chunk.track, offset, blob })
      } else {
        let boundary = boundaries.get(chunk.track)
        if (!boundary) boundaries.set(chunk.track, boundary = new WebmBoundary())
        playableEnd = boundary.push(new Uint8Array(await blob.arrayBuffer()), offset)
      }
      // Only journal the new prefix after the file has been flushed.
      const entry = { ...metadata, byteEnd, playableEnd, ...(worker ? {} : { blob }) }
      const savedAt = new Date().toISOString()
      await DB.commitChunk({ ...entry, savedAt }, { ...session, lastSavedAt: savedAt })
      offsets.set(chunk.track, byteEnd)
      return savedAt
    },
  }
}

export function recordingLock(id: string) { return 'mosaic-recording:' + id }

export function lockRecording(id: string) {
  return new Promise<() => void>((resolve, reject) => {
    // The browser releases this lock automatically if the page or process goes away.
    void navigator.locks.request(recordingLock(id), () => new Promise<void>(release => resolve(release))).catch(reject)
  })
}

export async function readRecordingFiles(session: Recording, chunks: Chunk[]) {
  const files: Record<string, { blob: Blob; last: Chunk }> = {}
  for (const [track, info] of Object.entries(session.tracks)) {
    if (session.unavailableTracks?.includes(track)) continue
    const entries = chunks.filter(chunk => chunk.track === track).sort((a, b) => a.seq - b.seq)
    if (!entries.length) continue
    let file: File | undefined
    if (session.storage === 'opfs') {
      try {
        const root = await navigator.storage.getDirectory()
        const recordings = await root.getDirectoryHandle('mosaic-recordings')
        const folder = await recordings.getDirectoryHandle(session.id)
        file = await (await folder.getFileHandle(track + '.webm')).getFile()
      } catch (error) {
        if (error instanceof Error && error.name === 'NotFoundError') continue
        throw error
      }
    }
    let valid = 0
    let byteEnd = 0
    for (const chunk of entries) {
      if (chunk.seq !== valid) break
      if (file) {
        if (chunk.byteEnd !== byteEnd + (chunk.size ?? 0) || chunk.byteEnd > file.size) break
        byteEnd = chunk.byteEnd
      } else if (!chunk.blob?.size) break
      valid++
    }
    if (!valid) continue
    const blob = file
      ? file.slice(0, byteEnd, info.mime)
      : new Blob(entries.slice(0, valid).map(chunk => chunk.blob!), { type: info.mime })
    const recoveredSize = session.recoveredBytes?.[track]
    const output = recoveredSize === undefined ? blob : blob.slice(0, recoveredSize, info.mime)
    if (output.size) files[track] = { blob: output, last: entries[valid - 1] }
  }
  return files
}
