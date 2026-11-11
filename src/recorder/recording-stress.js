import { DB } from './storage';
import { readRecordingFiles } from './recording-files';
import { recoverStressRecordings } from './recording-recovery';
import { clearRecordingLog, errorName, logRecording, recordingReport, storageEstimate } from './recording-log';

export function addStressPanel({ $, S, startRecording, interruptRecording, formatBytes, downloadLocalTrack }) {
  if ($('recordingStress')) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = 'Recording Stress Test';
  trigger.setAttribute('aria-haspopup', 'dialog');
  $('btnPeopleSidebar').before(trigger);

  const panel = document.createElement('dialog');
  panel.id = 'recordingStress';
  panel.className = 'recording-stress presentation-dialog';
  panel.setAttribute('aria-labelledby', 'stressTitle');
  panel.innerHTML = `
    <div class="presentation-dialog-heading">
      <h2 id="stressTitle">Recording Stress Test</h2>
      <form method="dialog"><button aria-label="Close stress test">×</button></form>
    </div>
    <p class="small muted">Development only. Test recordings use their own sessions. Set up your camera, mic, and optional screen share in the studio first.</p>
    <div class="row">
      <button type="button" id="stressStart">Start Stress Recording</button>
      <button type="button" id="stressInterrupt">Simulate Recording Interruption</button>
      <button type="button" id="stressFailure">Simulate Storage Failure</button>
      <button type="button" id="stressRecover">Recover Recordings</button>
    </div>
    <p class="small muted">Interruption is simulated. It discards pending video without crashing the browser. Storage failure stops the test after the next chunk tries to save.</p>
    <h3>Storage Inspection</h3>
    <pre id="stressInspection"></pre>
    <p id="stressFeedback" role="status" class="small"></p>
    <div class="row">
      <button type="button" id="stressExport">Export Recovered Recording</button>
      <button type="button" id="stressExportScreen">Download Recovered Slides</button>
      <button type="button" id="stressCopy">Copy Debug Logs</button>
      <button type="button" id="stressClear">Clear Debug Logs</button>
    </div>
    <textarea id="stressReport" class="hidden" aria-label="Debug report" readonly rows="6"></textarea>
    <details>
      <summary>Manual checklist</summary>
      <ol class="small">
        <li>Start a test with camera, mic, and optional screen share. Record for 45–90 minutes and watch the save status.</li>
        <li>After a save, refresh, close the tab, or use Simulate Recording Interruption. Reopen the recorder and choose Recover Recordings.</li>
        <li>Repeat with Simulate Storage Failure, then with the network disconnected while the recorder is open. Try low storage on a test profile if practical.</li>
        <li>Open the recovered recording in the library. Preview it, export the original tracks, and compare their timing.</li>
        <li>Copy the diagnostic report to share the results.</li>
      </ol>
    </details>`;
  document.body.append(panel);

  let lastTest;
  let recoveredTest;
  let interval;
  let busy = false;
  let refreshing = false;
  const status = $('stressFeedback');
  const feedback = text => { status.textContent = text; };

  async function inspect() {
    if (refreshing) return;
    refreshing = true;
    try {
      const sessions = await DB.listSessions();
      const tests = sessions.filter(session => session.stressTest).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      lastTest = tests[0];
      recoveredTest = tests.find(session => session.recovered);
      const capture = S.capture?.id === lastTest?.id ? S.capture : undefined;
      const liveTest = S.recording && S.session?.stressTest;
      const storage = await storageEstimate();
      const chunks = lastTest ? await DB.getChunks(lastTest.id) : [];
      const last = chunks.at(-1);
      $('stressInspection').textContent = [
        'Origin storage: ' + formatBytes(storage.usage) + ' / ' + formatBytes(storage.quota),
        'Recording: ' + (S.recording ? (liveTest ? (S.paused ? 'Test paused' : 'Test recording') : 'Regular recording active')
          : lastTest?.recovered ? 'Recovered' : lastTest?.status === 'complete' ? 'Saved' : lastTest ? 'Unfinished' : 'Idle'),
        'Saved chunks: ' + chunks.length + (lastTest ? ' · ' + (lastTest.storage ?? 'IndexedDB') : ''),
        'Latest commit: ' + (last ? [last.track + ' #' + last.seq, last.savedAt, formatBytes(last.size ?? last.blob?.size)].filter(Boolean).join(' · ') : 'None'),
        ...(capture?.error ? ['Last error: ' + capture.error] : []),
      ].join('\n');
      const inactive = S.recording || S.starting || S.saving || S.countingDown || S.choosingScreen;
      $('stressStart').disabled = busy || inactive || !S.cam || $('view-review').classList.contains('hidden') === false;
      $('stressInterrupt').disabled = busy || !liveTest || S.saving || S.starting;
      $('stressFailure').disabled = busy || !liveTest || S.saving || S.starting || S.paused || S.capture.simulatingFailure;
      $('stressRecover').disabled = busy;
      $('stressExport').disabled = busy || !recoveredTest?.tracks.camera || recoveredTest?.unavailableTracks?.includes('camera');
      $('stressExportScreen').disabled = busy || !recoveredTest?.tracks.screen || recoveredTest?.unavailableTracks?.includes('screen');
      return { storage, lastTest, recoveredTest, chunks, last };
    } finally {
      refreshing = false;
    }
  }

  function refresh() { void inspect().catch(() => feedback('Could not read local storage.')); }
  function action(id, run) {
    $(id).onclick = async () => {
      if (busy) return;
      busy = true;
      try { await run(); }
      catch (error) { feedback('Action failed: ' + errorName(error)); }
      finally { busy = false; refresh(); }
    };
  }

  trigger.onclick = () => {
    panel.showModal();
    refresh();
    interval = setInterval(refresh, 2500);
  };
  panel.addEventListener('close', () => clearInterval(interval));

  action('stressStart', async () => {
    if (S.recording || S.starting || S.saving || S.countingDown || S.choosingScreen) return;
    if (!$('view-studio').classList.contains('hidden')) {
      await startRecording({ stressTest: true });
    } else {
      if ($('btnJoin').disabled || $('view-record').classList.contains('hidden')) return;
      $('btnJoin').click();
      await startRecording({ stressTest: true });
    }
    if (S.recording) {
      panel.close();
      feedback('Test recording started.');
    } else feedback('Allow camera and microphone access before starting a test.');
  });
  action('stressInterrupt', async () => {
    if (!S.recording || !S.session?.stressTest) return;
    await interruptRecording('Simulated interruption. Previously saved chunks are ready for recovery.', true);
    feedback('Simulation complete. Choose Recover Recordings to check the saved video.');
  });
  action('stressFailure', async () => {
    if (!S.recording || !S.session?.stressTest || S.paused) return;
    S.capture.files.simulateWriteFailure();
    S.capture.simulatingFailure = true;
    logRecording('simulated_storage_failure_armed', S.session.id);
    feedback('The next attempted chunk save will fail. Watch the recorder status.');
  });
  action('stressRecover', async () => {
    const sessions = await recoverStressRecordings();
    const count = sessions.filter(session => session.stressTest && session.recovered).length;
    feedback(count ? `${count} recovered recording${count === 1 ? '' : 's'} in the library.` : 'No interrupted recordings with playable video were found.');
  });
  for (const [button, track] of [['stressExport', 'camera'], ['stressExportScreen', 'screen']]) {
    action(button, async () => {
      const session = recoveredTest;
      if (!session?.stressTest || !session.recovered) return;
      const files = await readRecordingFiles(session, await DB.getChunks(session.id));
      downloadLocalTrack(session, track, files[track]?.blob);
      feedback('Requested the recovered WebM download.');
    });
  }
  action('stressCopy', async () => {
    const data = await inspect();
    const report = await recordingReport({
      storage: data?.storage ?? await storageEstimate(),
      session: data?.lastTest?.id,
      state: S.recording ? (S.paused ? 'paused' : 'recording') : 'idle',
      savedChunks: data?.chunks.length,
      latestCommit: data?.last && { track: data.last.track, seq: data.last.seq, savedAt: data.last.savedAt },
      recoveredDurationMs: data?.recoveredTest?.durationMs,
    });
    try {
      await navigator.clipboard.writeText(report);
      $('stressReport').classList.add('hidden');
      feedback('Diagnostic report copied.');
    } catch {
      $('stressReport').value = report;
      $('stressReport').classList.remove('hidden');
      $('stressReport').select();
      feedback('Select and copy the report below.');
    }
  });
  action('stressClear', async () => {
    await clearRecordingLog();
    $('stressReport').value = '';
    $('stressReport').classList.add('hidden');
    feedback('Diagnostic logs cleared. Recordings are preserved.');
  });
}
