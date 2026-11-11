export type Recording = {
  id: string
  title: string
  createdAt: string
  durationMs: number
  status: 'recording' | 'complete'
  issues?: string[]
  tracks: Record<string, { mime: string; offsetMs?: number; endedAtMs?: number }>
  poster?: string
  storage?: 'opfs' | 'indexeddb'
  lastSavedAt?: string
  recovered?: boolean
  unavailableTracks?: string[]
  recoveredBytes?: Record<string, number>
  stressTest?: boolean
}
export type Chunk = {
  sessionId: string
  track: string
  seq: number
  blob?: Blob
  byteEnd?: number
  playableEnd?: number
  size?: number
  endMs?: number
  savedAt?: string
}
export type Diagnostic = {
  id: string
  at: string
  event: string
  sessionId?: string
  details?: Record<string, string | number | boolean | undefined>
}
const LOG_LIMIT = 9000

let connection: Promise<IDBDatabase> | undefined

function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    // Keep the original database name so recordings from earlier web builds stay visible.
    const request = indexedDB.open('cpe-studio', 2)
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('sessions', { keyPath: 'id' })
        request.result.createObjectStore('chunks', { autoIncrement: true }).createIndex('sessionId', 'sessionId')
      }
      request.result.createObjectStore('diagnostics', { autoIncrement: true })
    }
    let blocked = false
    request.onblocked = () => {
      blocked = true
      connection = undefined
      reject(new Error('Close older Mosaic Web tabs and try again.'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) { db.close(); return }
      db.onversionchange = () => { db.close(); connection = undefined }
      resolve(db)
    }
    request.onerror = () => { connection = undefined; reject(request.error) }
  })
  return connection
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode, store === 'sessions' && mode === 'readwrite'
      ? { durability: 'strict' } : undefined)
    const request = work(transaction.objectStore(store))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function updateRecording(id: string, title: string | null) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['sessions', 'chunks'], 'readwrite')
    const sessions = transaction.objectStore('sessions')
    const request = sessions.get(id)
    request.onsuccess = () => {
      const recording = request.result as Recording | undefined
      if (!recording || recording.status !== 'complete') {
        transaction.abort()
        return
      }
      if (title !== null) {
        sessions.put({ ...recording, title })
        return
      }
      sessions.delete(id)
      const chunks = transaction.objectStore('chunks')
      const cursor = chunks.index('sessionId').openKeyCursor(IDBKeyRange.only(id))
      cursor.onsuccess = () => {
        const item = cursor.result
        if (!item) return
        chunks.delete(item.primaryKey)
        item.continue()
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('This recording is no longer available.'))
  })
}

export const DB = {
  putSession: (session: Recording) => run('sessions', 'readwrite', (store) => store.put(session)),
  getSession: (id: string) => run<Recording | undefined>('sessions', 'readonly', (store) => store.get(id)),
  listSessions: () => run<Recording[]>('sessions', 'readonly', (store) => store.getAll()),
  async commitChunk(chunk: Chunk, session: Recording) {
    const db = await open()
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['chunks', 'sessions'], 'readwrite', { durability: 'strict' })
      transaction.objectStore('chunks').add(chunk)
      transaction.objectStore('sessions').put(session)
      const timer = setTimeout(() => transaction.abort(), 20000)
      transaction.oncomplete = () => {
        clearTimeout(timer)
        resolve()
      }
      transaction.onabort = () => {
        clearTimeout(timer)
        reject(transaction.error ?? new DOMException('The save was interrupted.', 'AbortError'))
      }
    })
  },
  putDiagnostic: (entry: Diagnostic) => run('diagnostics', 'readwrite', (store) => {
    const request = store.add(entry)
    request.onsuccess = () => {
      const oldest = Number(request.result) - LOG_LIMIT
      if (oldest > 0) store.delete(IDBKeyRange.upperBound(oldest))
    }
    return request
  }),
  getDiagnostics: () => run<Diagnostic[]>('diagnostics', 'readonly', (store) => store.getAll()),
  clearDiagnostics: () => run('diagnostics', 'readwrite', (store) => store.clear()),
  getChunks: (id: string) => run<Chunk[]>('chunks', 'readonly', (store) => store.index('sessionId').getAll(id)),
  renameSession: (id: string, title: string) => updateRecording(id, title),
  async deleteSession(id: string) {
    const session = await DB.getSession(id)
    await updateRecording(id, null)
    if (session?.storage === 'opfs') {
      await navigator.storage.getDirectory()
        .then(root => root.getDirectoryHandle('mosaic-recordings'))
        .then(folder => folder.removeEntry(id, { recursive: true }))
        .catch(error => console.warn('Could not remove local recording files', error.name))
    }
  },
}
