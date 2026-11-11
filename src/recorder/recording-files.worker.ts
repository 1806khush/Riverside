/// <reference lib="webworker" />

import { WebmBoundary } from './webm-boundary'

const boundaries = new Map<string, WebmBoundary>()

type WriteRequest = { sessionId: string; track: string; offset: number; blob: Blob }

self.onmessage = async ({ data }: MessageEvent<WriteRequest | null>) => {
  try {
    const root = await navigator.storage.getDirectory()
    let playableEnd: number | undefined
    if (!data) {
      if (typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function') {
        throw new DOMException('Synchronous file writes are unavailable.', 'NotSupportedError')
      }
    } else {
      const recordings = await root.getDirectoryHandle('mosaic-recordings', { create: true })
      const session = await recordings.getDirectoryHandle(data.sessionId, { create: true })
      const file = await session.getFileHandle(data.track + '.webm', { create: true })
      const bytes = new Uint8Array(await data.blob.arrayBuffer())
      const access = await file.createSyncAccessHandle()
      try {
        if (access.getSize() < data.offset) throw new DOMException('Saved video is missing.', 'NotReadableError')
        if (access.write(bytes, { at: data.offset }) !== bytes.byteLength) {
          throw new DOMException('Could not write the full video chunk.', 'QuotaExceededError')
        }
        access.flush()
      } finally {
        access.close()
      }
      let boundary = boundaries.get(data.track)
      if (!boundary) boundaries.set(data.track, boundary = new WebmBoundary())
      playableEnd = boundary.push(bytes, data.offset)
    }
    self.postMessage({ ok: true, playableEnd })
  } catch (error) {
    self.postMessage({ ok: false, name: error instanceof Error ? error.name : 'UnknownError' })
  }
}

export {}
