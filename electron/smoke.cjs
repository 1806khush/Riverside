// Integration checks use generated video/audio, never the user's devices.
module.exports = async function smoke(window) {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const screenshots = app.getPath('userData');
  const capture = async (name, target = window) => {
    await wait(180); // Allow layout/compositing to paint after switching views.
    const filename = path.join(screenshots, name + '.png');
    fs.writeFileSync(filename, (await target.webContents.capturePage()).toPNG());
    console.log('Screenshot: ' + filename);
  };
  await run(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    check(typeof window.require === 'undefined', 'Renderer has Node access');
    check(window.CPE && CAN_TRANSFORM, 'Recording APIs missing');
    check(!document.getElementById('btnTranscribe') && !document.getElementById('transcript'), 'Removed UI still present');
    await wait(500);
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    const paint = () => { context.fillStyle = '#334477'; context.fillRect(0, 0, 640, 360); context.fillStyle = 'white'; context.fillText('CPE Studio recording test', 20, 40); };
    paint(); const animation = setInterval(paint, 33);
    const audio = new AudioContext(); await audio.resume();
    const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    const raw = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...destination.stream.getAudioTracks()]);
    CPE.buildPipeline(raw); CPE.startMeters(); CPE.updateControls();
    document.getElementById('btnEnable').classList.add('hidden');
    window.CPE_TEST = { canvas, animation, audio, oscillator };
    const name = document.getElementById('hostName');
    name.value = 'Professor Taylor'; name.dispatchEvent(new Event('input'));
    document.getElementById('btnJoin').click();
    const label = document.getElementById('cameraLabel');
    check(label.textContent === 'Professor Taylor', 'Host name did not update');
    label.click();
    const settings = document.getElementById('hostAppearancePanel');
    settings.querySelector('[data-size="large"]').click();
    check(getComputedStyle(label).fontSize === '24px', 'Large host name failed');
    settings.querySelector('[data-size="small"]').click();
    check(getComputedStyle(label).fontSize === '14px', 'Small host name failed');
    settings.querySelector('[data-size="medium"]').click();
    const color = document.getElementById('hostTextColor'); color.value = '#c7b5ff'; color.dispatchEvent(new Event('input'));
    check(getComputedStyle(label).color === 'rgb(199, 181, 255)', 'Host color failed');
    check(label.getBoundingClientRect().bottom <= label.parentElement.getBoundingClientRect().bottom, 'Host label is outside camera');
    settings.querySelector('[data-close]').click();
    document.getElementById('btnTeleprompter').click();
    const panel = document.getElementById('teleprompterPanel');
    const editor = panel.querySelector('.teleprompter-editor');
    editor.innerText = 'Welcome to today’s lecture.\n\nWe will explore how a clear idea becomes a useful experiment.\n\nFirst, define the question. Then choose the evidence that will help you answer it.\n\n[Pause and show the first slide]\n\nThink about what you expect to observe, and why.\n\nA good explanation connects the result to the original question.\n\nLet’s work through an example together.\n\nThank you for joining today’s lecture.';
    editor.dispatchEvent(new Event('input'));
    check(panel.parentElement.id === 'teleprompterDock', 'Dock mode failed');
    check(JSON.parse(localStorage.getItem('cpe-teleprompter')).script.includes('Welcome'), 'Script was not saved');
    const viewport = panel.querySelector('.teleprompter-viewport');
    const play = panel.querySelector('[data-action="play"]');
    play.focus(); play.click();
    await wait(350); const first = viewport.scrollTop;
    await wait(350); const second = viewport.scrollTop;
    check(first > 0 && second > first && second - first < 30, 'Auto-scroll is not smooth');
    play.click(); const paused = viewport.scrollTop;
    await wait(200); check(Math.abs(viewport.scrollTop - paused) <= 1, 'Pause did not hold position');
    panel.querySelector('[data-action="restart"]').click();
    check(viewport.scrollTop === 0, 'Restart did not return to the top');
    const select = panel.querySelector('select'); select.value = 'overlay'; select.dispatchEvent(new Event('change'));
    check(panel.parentElement.classList.contains('previews') && panel.dataset.mode === 'overlay', 'Overlay mode failed');
    panel.querySelector('[data-action="larger"]').click();
    check(getComputedStyle(editor).fontSize === '48px', 'Script text size failed');
    viewport.scrollTop = 80;
  });
  await capture('smoke-teleprompter-overlay');

  const createPopup = async () => {
    await run(() => {
      const select = document.querySelector('#teleprompterPanel select');
      select.value = 'out'; select.dispatchEvent(new Event('change'));
    });
    for (let i = 0; i < 100; i++) {
      const child = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
      if (child && !child.webContents.isLoading()) {
        const ready = await child.webContents.executeJavaScript('Boolean(document.getElementById("teleprompterPanel"))');
        if (ready) return child;
      }
      await wait(80);
    }
    throw new Error('Teleprompter pop-out did not open');
  };
  const child = await createPopup();
  check(child.webContents.getLastWebPreferences().nodeIntegration === false, 'Pop-out has Node access');
  check(child.webContents.getLastWebPreferences().sandbox === true, 'Pop-out is not sandboxed');
  const popupState = await child.webContents.executeJavaScript(`({ script: document.querySelector('.teleprompter-editor').innerText, offset: document.querySelector('.teleprompter-viewport').scrollTop, mode: document.getElementById('teleprompterPanel').dataset.mode, node: typeof window.require })`);
  check(popupState.script.includes('Welcome') && popupState.offset > 0 && popupState.mode === 'out' && popupState.node === 'undefined', 'Pop-out lost script, position, or isolation');
  await capture('smoke-teleprompter-popped-out', child);
  // Changing mode inside the pop-out must return the same panel to the studio.
  await child.webContents.executeJavaScript(`setTimeout(() => { const select = document.querySelector('select'); select.value = 'in'; select.dispatchEvent(new Event('change')); }, 30)`);
  await wait(250);
  check(await run(() => document.getElementById('teleprompterPanel')?.parentElement.id === 'teleprompterDock'), 'Pop-in from the child failed');
  const childAgain = await createPopup();
  childAgain.close(); await wait(250);
  check(await run(() => document.getElementById('teleprompterPanel')?.parentElement.id === 'teleprompterDock'), 'Native pop-out close did not restore script');
  check(await run(() => window.open('https://example.com', 'untrusted') === null), 'Untrusted popup was allowed');
  await capture('smoke-teleprompter-popped-in');
  const originalSize = window.getContentSize();
  window.setContentSize(850, 650);
  await wait(200);
  check(await run(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Studio overflows horizontally at minimum width');
  await capture('smoke-teleprompter-compact');
  window.setContentSize(...originalSize);

  const result = await run(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const panel = document.getElementById('teleprompterPanel');
    panel.querySelector('[data-setting="autoStart"]').checked = true;
    panel.querySelector('[data-setting="autoStart"]').dispatchEvent(new Event('change', { bubbles: true }));
    CPE.S.screen = CPE_TEST.canvas.captureStream(30);
    await CPE.startRecording(); await wait(1300);
    check(panel.classList.contains('is-playing'), 'Teleprompter did not auto-start with recording');
    const select = panel.querySelector('select');
    select.value = 'out'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 100 && panel.ownerDocument === document; i++) await wait(50);
    check(panel.ownerDocument !== document && CPE.S.recording, 'Pop-out interrupted active recording');
    const popupPosition = panel.querySelector('.teleprompter-viewport').scrollTop;
    await wait(350);
    check(panel.querySelector('.teleprompter-viewport').scrollTop > popupPosition, 'Scrolling did not continue inside the pop-out');
    select.value = 'overlay'; select.dispatchEvent(new Event('change'));
    check(panel.ownerDocument === document && CPE.S.recording && panel.classList.contains('is-playing'), 'Returning from pop-out interrupted recording or scrolling');
    document.getElementById('btnPause').click(); await wait(300);
    check(CPE.S.paused, 'Pause recording failed');
    document.getElementById('btnPause').click(); await wait(1300);
    await CPE.stopRecording();
    check(CPE.rv.cur.s.status === 'complete', 'Recording did not finish');
    check(!panel.classList.contains('is-playing') && panel.classList.contains('hidden'), 'Teleprompter did not stop/hide for review');
    check(CPE.rv.cur.blobs.camera.size > 1000 && CPE.rv.cur.blobs.screen.size > 1000, 'Tracks missing');
    const { s, blobs } = CPE.rv.cur;
    const exportTrack = async (kind, options = {}) => {
      const camera = kind === 'screen' ? null : blobs.camera;
      const screen = kind === 'camera' ? null : blobs.screen;
      const metadata = { kind, cameraBytes: camera?.size || 0, screenBytes: screen?.size || 0,
        durationMs: s.durationMs, cameraOffset: s.tracks.camera.offsetMs, screenOffset: s.tracks.screen.offsetMs, ...options };
      const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: new Blob([JSON.stringify(metadata), '\n', ...[camera, screen].filter(Boolean)]) });
      if (!response.ok) throw new Error(await response.text());
      const data = new Uint8Array(await response.arrayBuffer());
      check(data.length > 500, 'Empty export');
      check(kind === 'all' ? data[0] === 80 && data[1] === 75 : new TextDecoder().decode(data.slice(4, 8)) === 'ftyp', 'Bad file format');
      return data.length;
    };
    const cameraBytes = await exportTrack('camera');
    const screenBytes = await exportTrack('screen');
    const zipBytes = await exportTrack('all');
    for (let i = 0; i < 100 && !cameraEffects.ready && !cameraEffects.failed; i++) await wait(100);
    check(cameraEffects.ready, 'Camera effects model failed to initialize');
    cameraEffects.setOptions({ background: 'slight', touchUp: true, studioLighting: true });
    for (let i = 0; i < 100 && !cameraEffects.mask && !cameraEffects.failed; i++) await wait(100);
    check(cameraEffects.mask && !cameraEffects.failed, 'Background segmentation failed');
    const saved = await CPE.DB.getSession(s.id);
    check(saved.status === 'complete', 'IndexedDB persistence failed');
    clearInterval(CPE_TEST.animation); CPE_TEST.oscillator.stop(); await CPE_TEST.audio.close();
    CPE.S.screen.getTracks().forEach(track => track.stop());
    CPE.S.raw.getTracks().forEach(track => track.stop());
    return { cameraBytes, screenBytes, zipBytes, effects: true, storage: true, pauseResume: true, nameAppearance: true, teleprompterModes: true, smoothScroll: true };
  });
  console.log(JSON.stringify(result));
  const downloadPath = path.join(screenshots, 'smoke-recording.zip');
  const download = new Promise((resolve, reject) => {
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(downloadPath);
      item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error('Download failed: ' + state)));
    });
  });
  await run(() => document.getElementById('btnDownloadAll').click());
  await download;
  const bytes = fs.readFileSync(downloadPath);
  check(bytes[0] === 80 && bytes[1] === 75, 'Downloaded ZIP did not match');
  await capture('smoke-review');
  console.log('Video-only ZIP download passed');
};
