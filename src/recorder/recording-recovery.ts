import { DB, type Recording } from './storage'
import { readRecordingFiles, recordingLock } from './recording-files'
import { errorName, logRecording } from './recording-log'
import { trimInterruptedWebm } from './webm-boundary'

function probeVideo(blob: Blob, seekForDuration: boolean) {
  return new Promise<{ playable: boolean; durationMs?: number }>(resolve => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(blob)
    video.muted = true
    video.preload = 'auto'
    const finish = (playable: boolean) => {
      clearTimeout(timer)
      const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined
      video.onloadeddata = video.onerror = video.onseeked = null
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve({ playable, durationMs })
    }
    const timer = setTimeout(() => finish(video.readyState >= 2 || video.onseeked !== null), 6000)
    video.onloadeddata = () => {
      if (!seekForDuration || Number.isFinite(video.duration)) return finish(true)
      video.onloadeddata = null
      video.onseeked = () => finish(true)
      video.currentTime = 1e101
    }
    video.onerror = () => finish(false)
    video.src = url
  })
}

let scan: Promise<Recording[]> | undefined

export function recoverRecordings() {
  scan ??= scanRecordings().finally(() => { scan = undefined })
  return scan
}

export function recoverStressRecordings() {
  return scanRecordings(true)
}

async function scanRecordings(stressOnly = false) {
  const sessions = await DB.listSessions()
  if (!navigator.locks) return sessions
  for (const { id, status, stressTest } of sessions) {
    if (status !== 'recording' || (stressOnly && !stressTest)) continue
    await navigator.locks.request(recordingLock(id), { ifAvailable: true }, async lock => {
      if (!lock) return
      const session = await DB.getSession(id)
      if (session?.status !== 'recording') return
      logRecording('recovery_started', id, { storage: session.storage ?? 'legacy-indexeddb' })
      try {
        const files = await readRecordingFiles(session, await DB.getChunks(id))
        const unavailableTracks: string[] = []
        const ends: Record<string, number> = {}
        const recoveredBytes: Record<string, number> = {}
        for (const [track, info] of Object.entries(session.tracks)) {
          const file = files[track]
          const playable = file && await trimInterruptedWebm(file.blob, file.last.playableEnd)
          const probe = playable?.size && await probeVideo(playable, file?.last.endMs === undefined)
          if (!probe || !probe.playable || !file || !playable) {
            unavailableTracks.push(track)
            continue
          }
          recoveredBytes[track] = playable.size
          ends[track] = probe.durationMs
            ? (info.offsetMs ?? 0) + probe.durationMs
            : file.last.endMs ?? session.durationMs
        }
        if (!Object.keys(ends).length) {
          logRecording('recovery_no_playable_tracks', id, { savedTracks: Object.keys(files).length })
          return
        }
        const durationMs = Math.max(0, ends.camera ?? ends.screen ?? 0)
        const recovered: Recording = {
          ...session, status: 'complete', recovered: true, unavailableTracks, recoveredBytes, durationMs,
          issues: [...(session.issues ?? []), 'Recovered after an interruption. The final unsaved moments may be missing.',
            ...(unavailableTracks.includes('camera') ? ['The camera and microphone track could not be recovered.'] : []),
            ...(unavailableTracks.includes('screen') ? ['The screen track could not be recovered.'] : [])],
        }
        if (ends.screen > 0) {
          recovered.tracks.screen = { ...recovered.tracks.screen, endedAtMs: ends.screen }
        }
        await DB.putSession(recovered)
        logRecording('recovery_completed', id, { durationMs, cameraBytes: recoveredBytes.camera, screenBytes: recoveredBytes.screen })
      } catch (error) {
        logRecording('recovery_failed', id, { error: errorName(error) })
      }
    })
  }
  return DB.listSessions()
}
