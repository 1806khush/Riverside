'use strict';
/* CPE Studio AI - recording prototype
 * Camera+mic, screen/slides and mic-only audio are recorded as separate synchronized tracks,
 * written to IndexedDB in 4s chunks (crash recovery), then transcribed through a Whisper API.
 *
 * Camera/mic on-off never disables a recorded track: the camera goes through a frame transformer that
 * swaps in black frames, and the mic goes through a gain node. The recorders therefore always get
 * continuous data and cannot stall when a device is switched off. */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pad = n => String(n).padStart(2, '0');
const fmtTime = sec => { const s = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(s / 3600); return (h ? pad(h) + ':' : '') + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const slug = s => (s || 'lecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lecture';
let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 9000 : 3500);
}

/* ---------------- IndexedDB ---------------- */
const DB = (() => {
  let db;
  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open('cpe-studio', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('chunks', { autoIncrement: true }).createIndex('sessionId', 'sessionId');
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  }));
  return {
    putSession: s => run('sessions', 'readwrite', st => st.put(JSON.parse(JSON.stringify(s)))),
    getSession: id => run('sessions', 'readonly', st => st.get(id)),
    listSessions: () => run('sessions', 'readonly', st => st.getAll()),
    putChunk: c => run('chunks', 'readwrite', st => st.add(c)),
    getChunks: id => run('chunks', 'readonly', st => st.index('sessionId').getAll(id)),
    async deleteSession(id) {
      const d = await open();
      await new Promise((res, rej) => {
        const t = d.transaction(['chunks', 'sessions'], 'readwrite');
        const cs = t.objectStore('chunks');
        const rq = cs.index('sessionId').openKeyCursor(IDBKeyRange.only(id));
        rq.onsuccess = () => { const c = rq.result; if (c) { cs.delete(c.primaryKey); c.continue(); } };
        t.objectStore('sessions').delete(id);
        t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error);
      });
    }
  };
})();

/* ---------------- State ---------------- */
const pick = list => (window.MediaRecorder && list.find(m => MediaRecorder.isTypeSupported(m))) || '';
const VMIME = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
const AMIME = pick(['audio/webm;codecs=opus', 'audio/webm']);
const CAN_TRANSFORM = !!(window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.VideoFrame && window.OffscreenCanvas);

const S = {
  raw: null, cam: null, micStream: null, screen: null,
  ac: null, micGain: null, micAn: null, scrAn: null, vFallbackTrack: null,
  recs: [], recording: false, paused: false,
  t0: 0, pausedMs: 0, pauseAt: null, session: null, writes: [],
  captions: [], capStart: 0, capFresh: true, capsOn: false, sr: null,
  timer: null, saveTimer: null, raf: null, camOn: true, micOn: true
};
const recElapsed = () => S.recording ? (S.pauseAt ?? performance.now()) - S.t0 - S.pausedMs : 0;

/* ---------------- Views ---------------- */
function show(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'library') renderLibrary();
  if (name !== 'review' && rv.cam) { rv.cam.pause(); rv.scr.pause(); }
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.view));

/* ---------------- Audio / video pipeline ---------------- */
const stopStream = s => s && s.getTracks().forEach(t => t.stop());
const getAc = () => S.ac || (S.ac = new AudioContext());
document.addEventListener('pointerdown', () => { if (S.ac && S.ac.state === 'suspended') S.ac.resume(); });

function blackoutTrack(v) {   // camera frames pass through; when the camera is "off" they become black frames
  const proc = new MediaStreamTrackProcessor({ track: v });
  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  let black = null, bw = 0, bh = 0;
  const ts = new TransformStream({
    transform(frame, ctrl) {
      if (S.camOn) return ctrl.enqueue(frame);
      const w = frame.displayWidth, h = frame.displayHeight;
      if (!black || bw !== w || bh !== h) { black = new OffscreenCanvas(w, h); black.getContext('2d').fillRect(0, 0, w, h); bw = w; bh = h; }
      const out = new VideoFrame(black, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
      frame.close(); ctrl.enqueue(out);
    }
  });
  proc.readable.pipeThrough(ts).pipeTo(gen.writable).catch(() => {});
  return gen;
}

function teardownPipeline() {
  stopStream(S.raw); stopStream(S.cam); S.raw = S.cam = S.micStream = S.micGain = S.micAn = S.scrAn = null;
  if (S.ac) S.ac.close().catch(() => {}); S.ac = null;
}

function buildPipeline(raw) {
  teardownPipeline();
  S.raw = raw;
  const ac = getAc(), tracks = [];
  const a = raw.getAudioTracks()[0];
  if (a) {
    const src = ac.createMediaStreamSource(new MediaStream([a]));
    S.micGain = ac.createGain(); S.micGain.gain.value = S.micOn ? 1 : 0;
    const dest = ac.createMediaStreamDestination();
    src.connect(S.micGain); S.micGain.connect(dest);
    S.micAn = ac.createAnalyser(); S.micAn.fftSize = 1024; S.micGain.connect(S.micAn);
    S.micStream = dest.stream; tracks.push(dest.stream.getAudioTracks()[0]);
  }
  const v = raw.getVideoTracks()[0];
  if (v) {
    S.vFallbackTrack = CAN_TRANSFORM ? null : v;
    tracks.unshift(CAN_TRANSFORM ? blackoutTrack(v) : v);
  }
  S.cam = new MediaStream(tracks);
  if (S.screen) attachScreenMeter();
  applyToggles();
}

/* ---------------- Devices ---------------- */
async function refreshDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cur = S.raw ? { videoinput: S.raw.getVideoTracks()[0], audioinput: S.raw.getAudioTracks()[0] } : {};
  const fill = (id, kind) => {
    const sel = $(id); sel.textContent = '';
    devs.filter(d => d.kind === kind).forEach((d, i) => { const o = el('option', '', d.label || `${kind} ${i + 1}`); o.value = d.deviceId; sel.append(o); });
    const id2 = cur[kind] && cur[kind].getSettings().deviceId; if (id2) sel.value = id2;
  };
  fill('camSel', 'videoinput'); fill('micSel', 'audioinput');
}

async function openCamera() {
  if (S.recording) return;
  const cam = $('camSel').value, mic = $('micSel').value;
  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({
      video: { ...(cam && { deviceId: { exact: cam } }), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { ...(mic && { deviceId: { exact: mic } }), echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });
  } catch (e) {
    $('noCam').textContent = e.name === 'NotReadableError'
      ? 'The camera is being used by another app or browser tab (Teams, Zoom, Camera app, or another CPE Studio tab). Close it, then click "Retry camera".'
      : e.name === 'NotAllowedError'
        ? 'Camera/microphone permission was blocked. Click the camera icon in the address bar, allow access, then click "Retry camera".'
        : 'Could not open camera or microphone: ' + e.message;
    $('noCam').classList.remove('hidden'); $('btnEnable').classList.remove('hidden');
    return;
  }
  $('btnEnable').classList.add('hidden');
  buildPipeline(raw);
  await refreshDevices();
  $('camPreview').srcObject = S.cam;
  startMeters(); updateControls();
}

function startMeters() {
  cancelAnimationFrame(S.raf);
  const buf = new Uint8Array(1024);
  const level = (an, id) => {
    if (!an) { $(id).style.width = '0'; return; }
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $(id).style.width = Math.min(100, peak / 128 * 140) + '%';
  };
  const tick = () => { level(S.micAn, 'meterBar'); level(S.scrAn, 'scrBar'); S.raf = requestAnimationFrame(tick); };
  tick();
}

/* Camera / microphone on-off */
function applyToggles() {
  if (S.micGain) S.micGain.gain.value = S.micOn ? 1 : 0;
  if (S.vFallbackTrack) S.vFallbackTrack.enabled = S.camOn;
  const c = $('btnCamToggle'), m = $('btnMicToggle');
  c.textContent = 'Camera: ' + (S.camOn ? 'On' : 'Off'); c.classList.toggle('on', S.camOn);
  m.textContent = 'Microphone: ' + (S.micOn ? 'On' : 'Off'); m.classList.toggle('on', S.micOn);
  $('camOff').classList.toggle('hidden', S.camOn);
}
function toggleDevice(kind) {
  S[kind + 'On'] = !S[kind + 'On'];
  applyToggles();
  if (S.recording && S.session) (S.session.events = S.session.events || []).push({ t: Math.round(recElapsed()), kind, on: S[kind + 'On'] });
  if (kind === 'mic' && S.recording && !S.paused) { if (S.micOn) startCaptions(); else stopCaptions(); }
}

/* ---------------- Screen share ---------------- */
async function shareScreen() {
  try {
    S.screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
    });
  } catch (e) { return toast('Screen share cancelled.', true); }
  $('screenPreview').srcObject = S.screen;
  S.screen.getVideoTracks()[0].addEventListener('ended', onScreenEnded);
  attachScreenMeter(true);
  updateControls();
}
function attachScreenMeter(announce) {
  S.scrAn = null;
  const a = S.screen && S.screen.getAudioTracks();
  const label = $('scrLabel');
  if (!S.screen) { label.textContent = 'Screen audio'; return; }
  if (!a.length) {
    label.textContent = 'Screen audio: NOT shared';
    if (announce) toast('The screen was shared without audio. Share again and choose "Entire screen" (or a Chrome tab), then tick "Also share system audio" / "Also share tab audio" in the dialog. Sharing a single window cannot include audio.', true);
    return;
  }
  const ac = getAc();
  const src = ac.createMediaStreamSource(new MediaStream([a[0]]));
  S.scrAn = ac.createAnalyser(); S.scrAn.fftSize = 1024; src.connect(S.scrAn);
  label.textContent = 'Screen audio: connected (play something to see the level)';
  if (announce) toast('Screen audio connected.');
}
function onScreenEnded() {
  const r = S.recs.find(x => x.name === 'screen');
  if (r && r.rec.state !== 'inactive') { r.expected = true; r.rec.stop(); toast('Screen sharing stopped. The camera is still recording.'); }
  stopStream(S.screen); S.screen = null; S.scrAn = null; $('screenPreview').srcObject = null;
  $('scrLabel').textContent = 'Screen audio'; $('scrBar').style.width = '0';
  updateControls();
}

function updateControls() {
  $('noScreen').classList.toggle('hidden', !!S.screen);
  $('noCam').classList.toggle('hidden', !!S.cam);
  $('btnStopScreen').classList.toggle('hidden', !S.screen || S.recording);
  $('btnScreen').classList.toggle('hidden', !!S.screen);
  $('btnScreen').disabled = S.recording;
  $('btnCamToggle').disabled = $('btnMicToggle').disabled = !S.cam;
  $('btnStart').disabled = !S.cam || S.recording;
  $('btnPause').disabled = !S.recording;
  $('btnStop').disabled = !S.recording;
  $('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  $('camSel').disabled = $('micSel').disabled = S.recording;
  const b = $('recBadge'); b.classList.toggle('hidden', !S.recording);
  b.textContent = S.paused ? 'PAUSED' : 'REC'; b.classList.toggle('paused', S.paused);
}

/* ---------------- Recording ---------------- */
async function startRecording() {
  if (S.recording) return;
  if (!S.cam) return toast('Allow the camera and microphone first.', true);
  if (!VMIME) return toast('This browser cannot record WebM. Use Chrome or Edge.', true);
  if (S.ac) { await S.ac.resume(); if (S.ac.state !== 'running') return toast('Audio engine is not running. Click the page and try again.', true); }
  const id = 's_' + Date.now().toString(36);
  S.session = {
    id, title: $('title').value.trim() || 'Untitled lecture', status: 'recording', createdAt: new Date().toISOString(),
    durationMs: 0, tracks: {}, captions: [], transcript: null, events: [], issues: [], app: 'cpe-studio-ai/0.2'
  };
  S.writes = []; S.captions = []; S.recs = [];

  const defs = [{ name: 'camera', stream: S.cam, mime: VMIME, opts: { videoBitsPerSecond: 5e6, audioBitsPerSecond: 128000 } }];
  if (S.screen) defs.push({ name: 'screen', stream: S.screen, mime: VMIME, opts: { videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 } });
  if (S.micStream && AMIME) defs.push({ name: 'mic', stream: S.micStream, mime: AMIME, opts: { audioBitsPerSecond: 40000 } });

  const started = defs.map(d => {
    const rec = new MediaRecorder(d.stream, { mimeType: d.mime, ...d.opts });
    const r = { name: d.name, rec, expected: false };
    const info = { mime: d.mime, hasVideo: d.stream.getVideoTracks().length > 0, hasAudio: d.stream.getAudioTracks().length > 0 };
    S.session.tracks[d.name] = info;
    let seq = 0;
    rec.ondataavailable = e => { if (e.data && e.data.size) S.writes.push(DB.putChunk({ sessionId: id, track: d.name, seq: seq++, blob: e.data })); };
    rec.onerror = e => { S.session.issues.push(`${d.name}: ${e.error && e.error.message}`); toast(`Recorder error on ${d.name}: ${e.error && e.error.message}`, true); };
    rec.addEventListener('stop', () => {
      if (S.recording && !r.expected) {
        const msg = `${d.name} recorder stopped unexpectedly at ${fmtTime(recElapsed() / 1000)}`;
        S.session.issues.push(msg); toast(msg, true);
      }
    });
    r.p = new Promise(res => rec.addEventListener('start', () => { info.startPerf = performance.now(); info.startEpoch = Date.now(); res(); }, { once: true }));
    S.recs.push(r);
    return r;
  });

  S.recording = true; S.paused = false; S.pausedMs = 0; S.pauseAt = null; S.t0 = performance.now();
  started.forEach(r => r.rec.start(4000));   // all tracks start in the same tick
  await Promise.all(started.map(r => r.p));

  const infos = Object.values(S.session.tracks);
  const base = Math.min(...infos.map(t => t.startPerf));
  infos.forEach(t => { t.offsetMs = Math.round(t.startPerf - base); });
  S.session.startEpoch = Math.min(...infos.map(t => t.startEpoch));
  S.t0 = base;
  await DB.putSession(S.session);

  S.timer = setInterval(() => { $('timer').textContent = fmtTime(recElapsed() / 1000); }, 250);
  S.saveTimer = setInterval(saveProgress, 10000);
  if (S.micOn) startCaptions();
  updateControls();
}

function saveProgress() {
  if (!S.session) return;
  S.session.durationMs = Math.round(recElapsed());
  S.session.captions = S.captions;
  return DB.putSession(S.session);
}

function togglePause() {
  if (!S.recording) return;
  if (!S.paused) {
    S.recs.forEach(r => r.rec.state === 'recording' && r.rec.pause());
    S.pauseAt = performance.now(); S.paused = true; stopCaptions();
  } else {
    S.recs.forEach(r => r.rec.state === 'paused' && r.rec.resume());
    S.pausedMs += performance.now() - S.pauseAt; S.pauseAt = null; S.paused = false;
    if (S.micOn) startCaptions();
  }
  updateControls();
}

async function stopRecording() {
  if (!S.recording) return;
  const duration = Math.round(recElapsed());
  stopCaptions();
  S.recs.forEach(r => { r.expected = true; });
  await Promise.all(S.recs.map(r => new Promise(res => {
    if (r.rec.state === 'inactive') return res();
    r.rec.addEventListener('stop', res, { once: true }); r.rec.stop();
  })));
  await Promise.all(S.writes);
  clearInterval(S.timer); clearInterval(S.saveTimer);
  S.session.durationMs = duration; S.session.captions = S.captions; S.session.status = 'complete';
  await DB.putSession(S.session);
  S.recording = false; S.paused = false; S.pauseAt = null;
  $('timer').textContent = '00:00'; $('captions').textContent = 'Live captions appear here while recording.';
  updateControls();
  await openSession(S.session.id);
}

/* ---------------- Live captions (Chrome built-in speech recognition) ---------------- */
function startCaptions() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('captions').textContent = 'Live captions are not supported in this browser (use Chrome or Edge).'; return; }
  stopCaptions();
  S.capsOn = true; S.capStart = recElapsed(); S.capFresh = true;
  const sr = S.sr = new SR();
  sr.continuous = true; sr.interimResults = true; sr.lang = navigator.language || 'en-US';
  sr.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (S.capFresh) { S.capStart = recElapsed(); S.capFresh = false; }
      if (r.isFinal) {
        S.captions.push({ start: S.capStart, end: recElapsed(), text: r[0].transcript.trim() });
        S.capFresh = true;
      } else interim += r[0].transcript;
    }
    const last = S.captions.slice(-2).map(c => c.text).join(' ');
    $('captions').textContent = (last + ' ' + interim).trim() || '...';
  };
  sr.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') $('captions').textContent = 'Caption error: ' + e.error; };
  sr.onend = () => { if (S.capsOn && S.recording && !S.paused) { try { sr.start(); } catch {} } };
  try { sr.start(); } catch {}
}
function stopCaptions() { S.capsOn = false; if (S.sr) { try { S.sr.stop(); } catch {} S.sr = null; } }

/* ---------------- Recordings list ---------------- */
async function renderLibrary() {
  const list = $('sessionList'); list.textContent = '';
  const sessions = (await DB.listSessions()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!sessions.length) { list.append(el('li', 'muted', 'No recordings yet.')); return; }
  for (const s of sessions) {
    const li = el('li'), info = el('div', 'info');
    const title = el('strong', '', s.title);
    if (s.status !== 'complete') title.append(' ', el('span', 'pill', 'interrupted - recovered'));
    info.append(title, el('div', 'muted small', `${new Date(s.createdAt).toLocaleString()} | ${fmtTime(s.durationMs / 1000)}${s.transcript ? ' | transcript' : ''}`));
    const open = el('button', '', 'Open'); open.onclick = () => openSession(s.id);
    const del = el('button', '', 'Delete');
    del.onclick = async () => { if (confirm(`Delete "${s.title}" permanently?`)) { await DB.deleteSession(s.id); renderLibrary(); } };
    li.append(info, open, del); list.append(li);
  }
}

/* ---------------- Review ---------------- */
const rv = { cam: null, scr: null, cur: null, urls: [], delta: 0, words: [], active: null, raf: null };

async function openSession(id) {
  const s = await DB.getSession(id);
  if (!s) return toast('Recording not found.', true);
  const chunks = await DB.getChunks(id);
  const blobs = {};
  for (const name of Object.keys(s.tracks)) {
    const parts = chunks.filter(c => c.track === name).sort((a, b) => a.seq - b.seq).map(c => c.blob);
    blobs[name] = new Blob(parts, { type: s.tracks[name].mime });
  }
  rv.urls.forEach(u => URL.revokeObjectURL(u)); rv.urls = [];
  rv.cur = { s, blobs };
  rv.cam = $('rvCam'); rv.scr = $('rvScreen');
  const url = b => { const u = URL.createObjectURL(b); rv.urls.push(u); return u; };
  rv.cam.src = url(blobs.camera);
  const hasScreen = !!blobs.screen;
  if (hasScreen) rv.scr.src = url(blobs.screen); else rv.scr.removeAttribute('src');
  rv.scr.muted = !(hasScreen && s.tracks.screen.hasAudio);   // play screen/system audio when it was recorded
  setLayout(hasScreen ? 'screen' : 'cam');
  $('layouts').classList.toggle('hidden', !hasScreen);
  rv.delta = hasScreen ? ((s.tracks.screen.offsetMs || 0) - (s.tracks.camera.offsetMs || 0)) / 1000 : 0;

  $('rvTitle').textContent = s.title;
  const screenNote = hasScreen ? (s.tracks.screen.hasAudio ? 'screen audio recorded' : 'screen shared without audio') : 'no screen';
  $('rvMeta').textContent = [new Date(s.createdAt).toLocaleString(), fmtTime(s.durationMs / 1000), screenNote].join(' | ');
  $('trStatus').textContent = '';
  $('btnUseCaps').classList.toggle('hidden', !(s.captions && s.captions.length));
  $('btnTranscribe').disabled = !blobs.mic;
  $('rvWarn').classList.add('hidden');
  show('review');
  await Promise.all([fixDuration(rv.cam), hasScreen ? fixDuration(rv.scr) : null]);
  rv.cam.currentTime = 0; syncScreen();
  renderTranscript(); updateTransport();

  const warns = [...(s.issues || [])];   // problems detected during recording
  const expect = s.durationMs / 1000;
  if (isFinite(rv.cam.duration) && s.status === 'complete' && Math.abs(rv.cam.duration - expect) > 2)
    warns.push(`The camera file is ${fmtTime(rv.cam.duration)} but the session ran ${fmtTime(expect)}.`);
  if (hasScreen && isFinite(rv.scr.duration) && s.status === 'complete' && Math.abs(rv.scr.duration - expect) > 2)
    warns.push(`The screen file is ${fmtTime(rv.scr.duration)} but the session ran ${fmtTime(expect)}.`);
  if (warns.length) { $('rvWarn').textContent = 'Check this recording: ' + warns.join(' '); $('rvWarn').classList.remove('hidden'); }
}

function fixDuration(v) {   // MediaRecorder WebM has no duration header; force the browser to find it
  return new Promise(res => {
    const go = () => {
      if (isFinite(v.duration)) return res();
      const onTU = () => { v.removeEventListener('timeupdate', onTU); v.currentTime = 0; res(); };
      v.addEventListener('timeupdate', onTU); v.currentTime = 1e101;
    };
    v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true });
  });
}
const duration = () => isFinite(rv.cam.duration) ? rv.cam.duration : (rv.cur.s.durationMs / 1000);

function syncScreen(force) {
  if (!rv.scr.getAttribute('src')) return;
  const target = rv.cam.currentTime - rv.delta;
  if (target < 0) { rv.scr.pause(); if (rv.scr.currentTime !== 0) rv.scr.currentTime = 0; return; }
  if (force || Math.abs(rv.scr.currentTime - target) > 0.25) rv.scr.currentTime = target;
  if (!rv.cam.paused && rv.scr.paused) rv.scr.play().catch(() => {});
}
function seekTo(sec) { rv.cam.currentTime = Math.max(0, sec); syncScreen(true); updateTransport(); highlightWord(); }
function updateTransport() {
  const d = duration();
  $('tpSeek').value = d ? Math.round(rv.cam.currentTime / d * 1000) : 0;
  $('tpTime').textContent = `${fmtTime(rv.cam.currentTime)} / ${fmtTime(d)}`;
  $('tpPlay').textContent = rv.cam.paused ? '\u25B6' : '\u275A\u275A';
}
function loop() {
  syncScreen(); updateTransport(); highlightWord();
  rv.raf = rv.cam.paused ? null : requestAnimationFrame(loop);
}
$('tpPlay').onclick = () => {
  if (rv.cam.paused) { rv.cam.play(); syncScreen(); cancelAnimationFrame(rv.raf); rv.raf = requestAnimationFrame(loop); }
  else { rv.cam.pause(); rv.scr.pause(); }
  updateTransport();
};
$('tpSeek').oninput = e => seekTo(e.target.value / 1000 * duration());
['pause', 'ended'].forEach(ev => $('rvCam').addEventListener(ev, () => { rv.scr.pause(); updateTransport(); }));
function setLayout(name) {   // 'cam' = camera only, 'screen' = slides only; hidden video keeps playing its audio
  document.querySelectorAll('.layouts button').forEach(x => x.classList.toggle('active', x.dataset.layout === name));
  $('viewer').className = 'viewer layout-' + name;
}
document.querySelectorAll('.layouts button').forEach(b => b.onclick = () => setLayout(b.dataset.layout));

/* ---------------- Transcript ---------------- */
const PROVIDERS = {
  openai: { url: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  custom: { url: '', model: 'whisper-1' }
};
function setProvider(name) { const p = PROVIDERS[name]; $('provider').value = name; $('baseUrl').value = p.url; $('model').value = p.model; }
function autoProvider() {   // Groq keys start with gsk_, OpenAI keys with sk-
  const k = $('apiKey').value.trim();
  if (k.startsWith('gsk_') && $('provider').value !== 'groq') setProvider('groq');
  else if (k.startsWith('sk-') && $('provider').value === 'groq') setProvider('openai');
}
function loadAiSettings() {
  const saved = JSON.parse(localStorage.getItem('cpe_ai') || '{}');
  setProvider(saved.provider || 'groq');
  if (saved.baseUrl) $('baseUrl').value = saved.baseUrl;
  if (saved.model) $('model').value = saved.model;
  if (saved.apiKey) { $('apiKey').value = saved.apiKey; autoProvider(); }
}
function saveAiSettings() {
  localStorage.setItem('cpe_ai', JSON.stringify({ provider: $('provider').value, baseUrl: $('baseUrl').value, model: $('model').value, apiKey: $('apiKey').value.trim() }));
}
$('provider').onchange = () => setProvider($('provider').value);
$('apiKey').oninput = autoProvider;

async function transcribe() {
  const { s, blobs } = rv.cur;
  autoProvider();
  const key = $('apiKey').value.trim();
  if (!key) return toast('Paste your API key first (or use live captions).', true);
  saveAiSettings();
  if (blobs.mic.size > 24.5e6) return toast('Audio is over the 25 MB API limit. Splitting will be added next.', true);
  const fd = new FormData();
  fd.append('file', blobs.mic, 'mic.webm');
  fd.append('model', $('model').value.trim());
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  $('btnTranscribe').disabled = true; $('trStatus').textContent = `Transcribing ${(blobs.mic.size / 1e6).toFixed(1)} MB of audio...`;
  try {
    const r = await fetch($('baseUrl').value.replace(/\/$/, '') + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const shift = ((s.tracks.mic ? s.tracks.mic.offsetMs : 0) - (s.tracks.camera.offsetMs || 0)) / 1000;  // mic -> camera timeline
    const words = (j.words || []).map(w => ({ start: w.start + shift, end: w.end + shift, word: w.word.trim() }));
    let segments = (j.segments || []).map(g => ({ start: g.start + shift, end: g.end + shift, text: g.text.trim() }));
    if (!segments.length) segments = [{ start: 0, end: j.duration || 0, text: (j.text || '').trim() }];
    s.transcript = { source: 'whisper-api', model: $('model').value.trim(), language: j.language || '', text: j.text || '', words, segments };
    assignRanges(s.transcript);
    await DB.putSession(s);
    $('trStatus').textContent = `Done: ${words.length} words.`;
    renderTranscript();
  } catch (e) {
    $('trStatus').textContent = ''; toast('Transcription failed: ' + e.message, true);
  } finally { $('btnTranscribe').disabled = false; }
}
function useCaptions() {
  const { s } = rv.cur;
  s.transcript = { source: 'live-captions', model: 'chrome-speech-recognition', language: navigator.language || 'en-US', words: [],
    text: s.captions.map(c => c.text).join(' '),
    segments: s.captions.map(c => ({ start: c.start / 1000, end: c.end / 1000, text: c.text })) };
  DB.putSession(s); renderTranscript();
  toast('Using live captions (sentence-level timing, less accurate).');
}
function assignRanges(t) {   // map words to their segments
  let i = 0;
  t.segments.forEach((seg, k) => {
    const a = i, last = k === t.segments.length - 1;
    while (i < t.words.length && (last || t.words[i].start < seg.end - 0.02)) i++;
    seg.range = [a, i];
  });
}
function renderTranscript() {
  const box = $('transcript'); box.textContent = ''; rv.words = []; rv.active = null;
  const t = rv.cur.s.transcript;
  if (!t) { box.append(el('p', 'muted', 'No transcript yet.')); return; }
  rv.words = t.words || [];
  t.segments.forEach(seg => {
    const row = el('div', 'seg'), ts = el('button', 'ts', fmtTime(seg.start));
    ts.onclick = () => seekTo(seg.start);
    const p = el('p');
    if (rv.words.length && seg.range) {
      for (let i = seg.range[0]; i < seg.range[1]; i++) { const w = el('span', 'w', rv.words[i].word); w.dataset.i = i; p.append(w, ' '); }
    } else p.textContent = seg.text;
    row.append(ts, p); box.append(row);
  });
  box.append(el('p', 'muted small', 'Click a word to jump to it. Double-click a word to fix its spelling.'));
}
$('transcript').addEventListener('click', e => {
  const i = e.target.dataset && e.target.dataset.i; if (i != null) seekTo(rv.words[i].start);
});
$('transcript').addEventListener('dblclick', e => {
  const i = e.target.dataset && e.target.dataset.i; if (i == null) return;
  const next = prompt('Correct this word:', rv.words[i].word);
  if (next == null || !next.trim()) return;
  const { s } = rv.cur; rv.words[i].word = next.trim(); e.target.textContent = next.trim();
  s.transcript.segments.forEach(g => { if (g.range && i >= g.range[0] && i < g.range[1]) g.text = rv.words.slice(g.range[0], g.range[1]).map(w => w.word).join(' '); });
  s.transcript.text = s.transcript.segments.map(g => g.text).join(' ');
  DB.putSession(s);
});
function highlightWord() {
  if (!rv.words.length) return;
  const t = rv.cam.currentTime; let lo = 0, hi = rv.words.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rv.words[m].start <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  const node = idx >= 0 && t <= rv.words[idx].end + 0.5 ? $('transcript').querySelector(`[data-i="${idx}"]`) : null;
  if (node === rv.active) return;
  if (rv.active) rv.active.classList.remove('active');
  rv.active = node;
  if (node) { node.classList.add('active'); node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

/* ---------------- Export ---------------- */
function dl(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}
const srtTime = sec => { const ms = Math.round(sec * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms % 3600000 / 60000))}:${pad(Math.floor(ms % 60000 / 1000))},${String(ms % 1000).padStart(3, '0')}`; };
function exportItem(kind, quiet) {
  const { s, blobs } = rv.cur, base = slug(s.title), t = s.transcript;
  const need = () => { if (!t) { if (!quiet) toast('Generate a transcript first.', true); return false; } return true; };
  switch (kind) {
    case 'camera': case 'screen': case 'mic':
      if (!blobs[kind]) { if (!quiet) toast(`No ${kind} track in this recording.`, true); return; }
      return dl(blobs[kind], `${base}_${kind}.webm`);
    case 'srt': if (!need()) return;
      return dl(new Blob([t.segments.map((g, i) => `${i + 1}\n${srtTime(g.start)} --> ${srtTime(g.end)}\n${g.text}\n`).join('\n')], { type: 'text/plain' }), `${base}.srt`);
    case 'txt': if (!need()) return;
      return dl(new Blob([t.segments.map(g => `[${fmtTime(g.start)}] ${g.text}`).join('\n')], { type: 'text/plain' }), `${base}.txt`);
    case 'json': if (!need()) return;
      return dl(new Blob([JSON.stringify({ title: s.title, source: t.source, model: t.model, language: t.language, text: t.text, segments: t.segments.map(({ start, end, text }) => ({ start, end, text })), words: t.words }, null, 2)], { type: 'application/json' }), `${base}_transcript.json`);
    case 'manifest': {
      const files = {}; Object.keys(s.tracks).forEach(k => files[k] = `${base}_${k}.webm`);
      return dl(new Blob([JSON.stringify({ id: s.id, title: s.title, createdAt: s.createdAt, durationMs: s.durationMs,
        timeline: 'seconds from camera track start; track offsetMs = start delay vs. earliest track',
        tracks: Object.fromEntries(Object.entries(s.tracks).map(([k, v]) => [k, { file: files[k], mime: v.mime, offsetMs: v.offsetMs, hasVideo: v.hasVideo, hasAudio: v.hasAudio }])),
        events: s.events || [], transcript: t ? `${base}_transcript.json` : null }, null, 2)], { type: 'application/json' }), `${base}_manifest.json`);
    }
  }
}
function downloadAll() {
  ['camera', 'screen', 'mic', 'manifest', 'json', 'srt'].forEach((k, i) => setTimeout(() => exportItem(k, true), i * 500));
}
document.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => exportItem(b.dataset.dl));
$('btnDownloadAll').onclick = downloadAll;

/* ---------------- Wire up ---------------- */
$('btnEnable').onclick = openCamera;
$('camSel').onchange = $('micSel').onchange = openCamera;
$('btnScreen').onclick = shareScreen;
$('btnStopScreen').onclick = onScreenEnded;
$('btnCamToggle').onclick = () => toggleDevice('cam');
$('btnMicToggle').onclick = () => toggleDevice('mic');
$('btnStart').onclick = startRecording;
$('btnPause').onclick = togglePause;
$('btnStop').onclick = stopRecording;
$('btnTranscribe').onclick = transcribe;
$('btnUseCaps').onclick = useCaptions;
window.addEventListener('beforeunload', e => { if (S.recording) { e.preventDefault(); e.returnValue = ''; } });

loadAiSettings(); updateControls();
if (!navigator.mediaDevices || !window.MediaRecorder) toast('This browser does not support recording. Use Chrome or Edge.', true);
else openCamera();   // ask for camera + microphone as soon as the page opens
window.CPE = { S, rv, buildPipeline, startRecording, stopRecording, openSession, assignRanges, DB, startMeters, updateControls, attachScreenMeter };  // handy for testing
