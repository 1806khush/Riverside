'use strict';
/* CPE Studio - local recording app
 * Camera+mic and screen/slides are recorded as separate synchronized tracks
 * and written to IndexedDB in 4s chunks.
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
    putChunk: c => run('chunks', 'readwrite', st => st.add(c)),
    getChunks: id => run('chunks', 'readonly', st => st.index('sessionId').getAll(id))
  };
})();

/* ---------------- State ---------------- */
const pick = list => (window.MediaRecorder && list.find(m => MediaRecorder.isTypeSupported(m))) || '';
const VMIME = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
const CAN_TRANSFORM = !!(window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.VideoFrame && window.OffscreenCanvas);

const S = {
  raw: null, cam: null, micStream: null, screen: null,
  ac: null, micGain: null, micAn: null, scrAn: null, vFallbackTrack: null,
  recs: [], recording: false, paused: false,
  t0: 0, pausedMs: 0, pauseAt: null, session: null, writes: [],
  timer: null, saveTimer: null, raf: null, camOn: true, micOn: true
};
const recElapsed = () => S.recording ? (S.pauseAt ?? performance.now()) - S.t0 - S.pausedMs : 0;

/* ---------------- Views ---------------- */
function show(name) {
  if (name === 'record' && $('stageWorkspace').firstElementChild) name = 'studio';
  if ((S.recording || S.countingDown) && name !== 'studio') return toast('Stop and save before leaving the studio.', true);
  closeDeviceMenus();
  hideCameraControlTooltip();
  if (name !== 'record' && name !== 'studio') window.dispatchEvent(new Event('close-camera-effects'));
  document.body.classList.toggle('in-studio', name === 'studio');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === (name === 'studio' ? 'record' : name)));
  if (name !== 'review' && rv.cam) { rv.cam.pause(); rv.scr.pause(); }
  window.dispatchEvent(new CustomEvent('studio-view-changed', { detail: name }));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.view));

/* ---------------- Audio / video pipeline ---------------- */
const stopStream = s => s && s.getTracks().forEach(t => t.stop());
const getAc = () => S.ac || (S.ac = new AudioContext());

function resumeCameraPreview() {
  if (!S.cam) return;
  const preview = $('camPreview');
  if (preview.srcObject !== S.cam) preview.srcObject = S.cam;
  preview.play().catch(error => toast('Camera preview could not resume: ' + error.message, true));
  if (S.screen) $('screenPreview').play().catch(error => toast('Screen preview could not resume: ' + error.message, true));
}

document.addEventListener('pointerdown', () => { if (S.ac && S.ac.state === 'suspended') S.ac.resume(); });

const cameraEffects = CAN_TRANSFORM ? new CameraEffects((state, face) => {
  const button = $('btnCameraEffects');
  const status = $('cameraEffectsStatus');
  const guide = $('faceGuide');
  const grid = $('framingGrid');
  const enabled = cameraEffects.enabled;
  const setupVisible = !$('view-record').classList.contains('hidden');
  const visible = enabled && S.camOn && setupVisible;
  const centered = !!face && cameraEffects.framing.centered;
  button.setAttribute('aria-pressed', String(enabled));
  status.classList.toggle('hidden', !visible);
  guide.classList.toggle('hidden', !visible);
  grid.classList.toggle('hidden', !visible);
  guide.classList.toggle('centered', centered);
  status.classList.toggle('centered', centered);
  if (state === 'error') toast('Camera effects could not load. Restart CPE Studio and try again.', true);
  if (state === 'background-error') toast('The background effect could not load. Restart CPE Studio and try again.', true);
  const message = state === 'loading' ? 'Checking your framing…' : cameraEffects.framing.message;
  if (status.textContent !== message) status.textContent = message;
  if (visible) {
    const preview = $('camPreview');
    if (preview.videoWidth && preview.videoHeight) {
      const fit = Math.min(preview.clientWidth / preview.videoWidth, preview.clientHeight / preview.videoHeight);
      const width = preview.videoWidth * fit, height = preview.videoHeight * fit;
      const left = (preview.clientWidth - width) / 2, top = (preview.clientHeight - height) / 2;
      const guideHeight = height * 0.55;
      const guideWidth = Math.min(width * 0.48, guideHeight * 0.85);
      // This target stays fixed. The presenter moves into position.
      guide.style.left = left + (width - guideWidth) / 2 + 'px';
      guide.style.top = top + height * 0.125 + 'px';
      guide.style.width = guideWidth + 'px';
      guide.style.height = guideHeight + 'px';
      Object.assign(grid.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    }
  }
  window.dispatchEvent(new CustomEvent('camera-effects-state', { detail: { state, face, centered: visible && centered } }));
}) : null;

function blackoutTrack(v) {
  const proc = new MediaStreamTrackProcessor({ track: v });
  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  let canvas, context;
  const ts = new TransformStream({
    transform(frame, ctrl) {
      if (S.camOn) cameraEffects?.observe(frame);
      if (S.camOn && !cameraEffects?.processing) return ctrl.enqueue(frame);
      const w = frame.displayWidth, h = frame.displayHeight;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        context = canvas.getContext('2d');
      }
      if (S.camOn) cameraEffects.draw(frame, context, w, h);
      else {
        context.fillStyle = '#000';
        context.fillRect(0, 0, w, h);
      }
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
      frame.close(); ctrl.enqueue(out);
    }
  });
  proc.readable.pipeThrough(ts).pipeTo(gen.writable).catch(() => {});
  return gen;
}

$('btnCameraEffects').onclick = () => cameraEffects?.setEnabled(!cameraEffects.enabled);

let tooltipControl = null;
function hideCameraControlTooltip() {
  tooltipControl?.removeAttribute('aria-describedby');
  tooltipControl = null;
  $('cameraControlTooltip').classList.add('hidden');
}
function positionCameraControlTooltip() {
  if (!tooltipControl) return;
  const bounds = tooltipControl.getBoundingClientRect();
  const tooltip = $('cameraControlTooltip');
  const size = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(8, Math.min(innerWidth - size.width - 8, bounds.left + (bounds.width - size.width) / 2)) + 'px';
  tooltip.style.top = (bounds.top >= size.height + 16 ? bounds.top - size.height - 8 : bounds.bottom + 8) + 'px';
}
for (const control of [$('btnCameraEffects'), $('btnBackgroundEffects')]) {
  const reveal = () => {
    if (control.disabled) return;
    hideCameraControlTooltip();
    tooltipControl = control;
    const tooltip = $('cameraControlTooltip');
    tooltip.textContent = control.getAttribute('aria-label');
    control.setAttribute('aria-describedby', tooltip.id);
    tooltip.classList.remove('hidden');
    positionCameraControlTooltip();
  };
  control.addEventListener('pointerenter', reveal);
  control.addEventListener('focus', reveal);
  control.addEventListener('pointerleave', hideCameraControlTooltip);
  control.addEventListener('blur', hideCameraControlTooltip);
  control.addEventListener('click', hideCameraControlTooltip);
}
window.addEventListener('resize', positionCameraControlTooltip);
window.addEventListener('scroll', hideCameraControlTooltip, true);

function teardownPipeline() {
  cameraEffects?.resetTracking();
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
  if (v) cameraEffects?.startMonitoring();
  if (S.screen) attachScreenMeter();
  applyToggles();
}

/* ---------------- Devices ---------------- */
const toolbarDeviceMenus = [
  { select: $('camSel'), trigger: $('btnCameraMenu'), menu: $('cameraDeviceMenu'), label: 'Camera' },
  { select: $('micSel'), trigger: $('btnMicrophoneMenu'), menu: $('microphoneDeviceMenu'), label: 'Microphone' }
];
function closeDeviceMenus() {
  for (const { trigger, menu } of toolbarDeviceMenus) {
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  }
}
function refreshToolbarDeviceMenus() {
  for (const config of toolbarDeviceMenus) {
    const { select, trigger, menu, label } = config;
    trigger.disabled = S.switchingDevices || !select.options.length;
    if (menu.classList.contains('hidden')) continue;
    const signature = JSON.stringify([select.disabled, select.value, Array.from(select.options, option => [option.value, option.text])]);
    if (menu.dataset.signature === signature) continue;
    menu.dataset.signature = signature;
    const focusedValue = menu.contains(document.activeElement) ? document.activeElement.dataset.deviceId : null;
    menu.replaceChildren(el('div', 'device-menu-heading', label));
    for (const option of select.options) {
      const choice = el('button', 'device-menu-option', option.text);
      choice.type = 'button';
      choice.setAttribute('role', 'menuitemradio');
      choice.setAttribute('aria-checked', String(option.selected));
      choice.dataset.deviceId = option.value;
      choice.tabIndex = -1;
      choice.disabled = select.disabled;
      choice.onclick = () => {
        if (select.disabled) return;
        const changed = select.value !== option.value;
        select.value = option.value;
        closeDeviceMenus();
        trigger.focus();
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      menu.append(choice);
      if (focusedValue === option.value) choice.focus();
    }
    if (select.disabled) menu.append(el('p', 'device-menu-note', S.switchingDevices ? 'Switching devices…' : 'Stop recording to change devices.'));
  }
}
for (const config of toolbarDeviceMenus) {
  const { trigger, menu } = config;
  const open = (last = false) => {
    if (trigger.disabled) return;
    closeDeviceMenus();
    menu.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    refreshToolbarDeviceMenus();
    const choices = Array.from(menu.querySelectorAll('button:not(:disabled)'));
    (last ? choices.at(-1) : choices.find(choice => choice.getAttribute('aria-checked') === 'true') || choices[0])?.focus();
    if (!choices.length) menu.focus();
    refreshDevices().catch(error => toast('Could not refresh devices: ' + error.message, true));
  };
  trigger.onclick = () => menu.classList.contains('hidden') ? open() : closeDeviceMenus();
  trigger.onkeydown = event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      open(event.key === 'ArrowUp');
    }
  };
  menu.onkeydown = event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const choices = Array.from(menu.querySelectorAll('button:not(:disabled)'));
    if (!choices.length) return;
    const current = choices.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next].focus();
  };
}
for (const eventName of ['pointerdown', 'focusin']) {
  document.addEventListener(eventName, event => {
    for (const { trigger, menu } of toolbarDeviceMenus) {
      if (!trigger.parentElement.contains(event.target)) {
        menu.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
      }
    }
  });
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  hideCameraControlTooltip();
  const open = toolbarDeviceMenus.find(({ menu }) => !menu.classList.contains('hidden'));
  if (!open) return;
  event.preventDefault();
  event.stopPropagation();
  closeDeviceMenus();
  open.trigger.focus();
}, true);

let deviceRefreshRevision = 0;
async function refreshDevices() {
  const revision = ++deviceRefreshRevision;
  const devs = await navigator.mediaDevices.enumerateDevices();
  if (revision !== deviceRefreshRevision) return;
  const cur = S.raw ? { videoinput: S.raw.getVideoTracks()[0], audioinput: S.raw.getAudioTracks()[0] } : {};
  const fill = (id, kind) => {
    const sel = $(id);
    const previous = sel.value;
    const active = cur[kind]?.readyState === 'live' ? cur[kind].getSettings().deviceId : '';
    const devices = devs.filter(device => device.kind === kind && !/iphone|continuity camera/i.test(device.label));
    const options = devices.map((device, index) => {
      const label = device.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
      return new Option(label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${index + 1}`, device.deviceId);
    });
    const preferred = S.switchingDevices ? [previous, active] : [active, previous];
    const selected = preferred.find(value => value && devices.some(device => device.deviceId === value));
    // Avoid rebuilding an open native menu when the devices have not changed.
    const unchanged = options.length === sel.options.length && options.every((option, index) =>
      option.value === sel.options[index].value && option.text === sel.options[index].text);
    if (!unchanged) sel.replaceChildren(...options);
    if (selected) sel.value = selected;
  };
  fill('camSel', 'videoinput'); fill('micSel', 'audioinput');
  const speakers = $('speakerSel');
  const previous = speakers.value;
  const speakerOptions = [new Option('Default speaker', '')];
  if (typeof HTMLMediaElement.prototype.setSinkId === 'function') {
    for (const device of devs.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')) {
      speakerOptions.push(new Option(device.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') || 'Speaker', device.deviceId));
    }
  }
  const speakersUnchanged = speakerOptions.length === speakers.options.length && speakerOptions.every((option, index) =>
    option.value === speakers.options[index].value && option.text === speakers.options[index].text);
  if (!speakersUnchanged) speakers.replaceChildren(...speakerOptions);
  if (speakerOptions.some(option => option.value === previous)) speakers.value = previous;
  refreshToolbarDeviceMenus();
}

async function openCamera() {
  if (S.recording || S.countingDown || S.switchingDevices) return;
  S.switchingDevices = true;
  updateControls();
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
        ? 'Camera/microphone permission was blocked. Allow access in your system or browser privacy settings, reopen CPE Studio if required, then click "Retry camera".'
        : 'Could not open camera or microphone: ' + e.message;
    $('noCam').classList.remove('hidden'); $('btnEnable').classList.remove('hidden');
    S.switchingDevices = false;
    await refreshDevices();
    updateControls();
    return;
  }
  $('btnEnable').classList.add('hidden');
  buildPipeline(raw);
  try { await refreshDevices(); } finally { S.switchingDevices = false; }
  resumeCameraPreview();
  if (!$('backgroundEffectsPanel').classList.contains('hidden')) $('effectsPreview').srcObject = S.cam;
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
  const tick = () => { level(S.micAn, 'meterBar'); level(S.micAn, 'micTestMeter'); level(S.scrAn, 'scrBar'); S.raf = requestAnimationFrame(tick); };
  tick();
}

/* Camera / microphone on-off */
function applyToggles() {
  if (!S.camOn) {
    cameraEffects?.resetTracking();
    $('faceGuide').classList.add('hidden');
    $('framingGrid').classList.add('hidden');
    $('cameraEffectsStatus').classList.add('hidden');
    $('lowLightTip').classList.add('hidden');
    if (cameraEffects?.enabled) $('cameraEffectsStatus').textContent = 'Camera is off';
  }
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
}

/* ---------------- Screen share ---------------- */
function canShare() {
  return !S.screen && !S.choosingScreen && !S.countingDown && !S.starting && !S.saving &&
    !(S.recording && (S.paused || S.session.tracks.screen));
}

function attachSharedStream(stream, session) {
  if (S.screen || (session && (!S.recording || S.session !== session || S.saving || S.paused))) {
    throw new Error('Sharing was cancelled because the recording changed.');
  }
  if (session) {
    const recorder = createTrackRecorder('screen', stream, { videoBitsPerSecond: 6e6 });
    session.tracks.screen.offsetMs = Math.round(recElapsed());
    try { recorder.rec.start(4000); }
    catch (error) { delete session.tracks.screen; S.recs.pop(); throw error; }
  }
  S.screen = stream;
  $('screenPreview').srcObject = stream;
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (S.screen === stream) onScreenEnded();
  });
  if ($('view-studio').dataset.layout === 'camera') document.querySelector('[data-stage-layout="focus"]').click();
  attachScreenMeter();
}

async function shareScreen() {
  if (!canShare()) return;
  const session = S.recording ? S.session : null;
  let stream;
  S.choosingScreen = true;
  updateControls();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 } },
      audio: false,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
    });
    attachSharedStream(stream, session);
  } catch (error) {
    if (stream && S.screen !== stream) stopStream(stream);
    toast(stream ? 'Could not record the screen: ' + error.message : 'Screen share cancelled.', true);
  } finally {
    S.choosingScreen = false;
    updateControls();
  }
}
function attachScreenMeter(announce) {
  S.scrAn = null;
  const a = S.screen && S.screen.getAudioTracks();
  const label = $('scrLabel');
  if (!S.screen) { label.textContent = 'Screen audio'; return; }
  if (S.presentation) { label.textContent = 'Presentation · muted slides'; return; }
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
  closeSharedContentMenu();
  const stream = S.screen;
  const r = S.recs.find(x => x.name === 'screen');
  if (S.recording && r) {
    r.expected = true;
    S.session.tracks.screen.endedAtMs = Math.round(recElapsed());
  }
  if (r && r.rec.state !== 'inactive') { r.expected = true; r.rec.stop(); toast('Screen sharing stopped. The camera is still recording.'); }
  stopStream(S.screen); S.screen = null; S.scrAn = null; $('screenPreview').srcObject = null;
  $('scrLabel').textContent = 'Screen audio'; $('scrBar').style.width = '0';
  window.dispatchEvent(new CustomEvent('shared-stream-ended', { detail: stream }));
  document.querySelector('[data-stage-layout="camera"]').click();
  updateControls();
}

function closeSharedContentMenu(restoreFocus = false) {
  const menu = $('sharedContentMenu');
  const hadFocus = menu.contains(document.activeElement);
  menu.classList.add('hidden');
  $('btnSharedContentMenu').setAttribute('aria-expanded', 'false');
  $('sharedContentActions').classList.remove('menu-open');
  if (restoreFocus || hadFocus) {
    (S.screen ? $('btnSharedContentMenu') : $('btnScreen')).focus();
  }
}
function openSharedContentMenu() {
  if (!S.screen || $('btnStopScreen').disabled) return;
  $('sharedContentMenu').classList.remove('hidden');
  $('btnSharedContentMenu').setAttribute('aria-expanded', 'true');
  $('sharedContentActions').classList.add('menu-open');
  $('btnStopSharedContent').focus();
}
$('btnSharedContentMenu').onclick = () => {
  if ($('sharedContentMenu').classList.contains('hidden')) openSharedContentMenu();
  else closeSharedContentMenu(true);
};
$('btnSharedContentMenu').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); openSharedContentMenu();
  }
};
$('btnStopSharedContent').onclick = () => {
  if (!S.screen || $('btnStopScreen').disabled) return;
  // End only the shared stream/recorder. Camera, microphone, and the session keep running.
  closeSharedContentMenu(); onScreenEnded(); $('btnScreen').focus();
};
$('sharedContentActions').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); closeSharedContentMenu(true);
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !$('sharedContentMenu').classList.contains('hidden')) {
    event.preventDefault(); $('btnStopSharedContent').focus();
  } else if (event.key === 'Tab') closeSharedContentMenu();
});
$('sharedContentActions').addEventListener('focusout', event => {
  if (!$('sharedContentActions').contains(event.relatedTarget)) closeSharedContentMenu();
});
document.addEventListener('pointerdown', event => {
  if (!$('sharedContentActions').contains(event.target)) closeSharedContentMenu();
});
window.addEventListener('studio-view-changed', () => closeSharedContentMenu());

function updateControls() {
  $('view-studio').classList.toggle('is-sharing', !!S.screen);
  $('btnCameraEffects').disabled = $('btnBackgroundEffects').disabled = !CAN_TRANSFORM || !S.cam || !S.camOn || S.switchingDevices;
  $('btnLeave').disabled = S.recording || S.countingDown;
  $('noScreen').classList.toggle('hidden', !!S.screen);
  $('noCam').classList.toggle('hidden', !!S.cam);
  $('btnStopScreen').classList.toggle('hidden', !S.screen);
  $('btnScreen').classList.toggle('hidden', !!S.screen);
  $('btnScreen').disabled = S.choosingScreen || S.countingDown || S.starting || S.saving ||
    (S.recording && (S.paused || !!S.session.tracks.screen));
  $('btnScreen').title = S.recording && S.session.tracks.screen ? 'This recording already has a screen track.' : '';

  $('btnStopScreen').disabled = S.countingDown || S.starting || S.saving;
  $('sharedContentActions').classList.toggle('hidden', !S.screen);
  $('btnSharedContentMenu').disabled = $('btnStopSharedContent').disabled = $('btnStopScreen').disabled;
  if (!S.screen || $('btnStopScreen').disabled) closeSharedContentMenu();
  $('btnCamToggle').disabled = $('btnMicToggle').disabled = !S.cam;
  $('btnStart').disabled = !S.cam || S.recording || S.countingDown || S.switchingDevices || S.choosingScreen;
  $('btnJoin').disabled = !S.cam || S.switchingDevices;
  $('btnTestCamera').disabled = !S.cam?.getVideoTracks().some(track => track.readyState === 'live') || S.recording || S.switchingDevices;
  $('btnTestMic').disabled = !S.micStream || S.recording || S.switchingDevices;
  $('btnPause').disabled = !S.recording || S.starting || S.saving;
  $('btnStop').disabled = !S.recording || S.starting || S.saving;
  $('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  $('camSel').disabled = $('micSel').disabled = S.recording || S.countingDown || S.switchingDevices;
  refreshToolbarDeviceMenus();
  const b = $('recBadge'); b.classList.toggle('hidden', !S.recording || S.starting);
  b.textContent = S.paused ? 'PAUSED' : 'REC'; b.classList.toggle('paused', S.paused);
  window.dispatchEvent(new Event('sharing-state-changed'));
}

/* ---------------- Recording ---------------- */
function createTrackRecorder(name, stream, opts) {
  const sessionId = S.session.id;
  const rec = new MediaRecorder(stream, { mimeType: VMIME, ...opts });
  const r = { name: name, rec, expected: false };
  const info = { mime: VMIME, hasVideo: stream.getVideoTracks().length > 0, hasAudio: stream.getAudioTracks().length > 0 };
  S.session.tracks[name] = info;
  let seq = 0;
  rec.ondataavailable = e => { if (e.data && e.data.size) S.writes.push(DB.putChunk({ sessionId: sessionId, track: name, seq: seq++, blob: e.data })); };
  rec.onerror = e => { S.session.issues.push(`${name}: ${e.error && e.error.message}`); toast(`Recorder error on ${name}: ${e.error && e.error.message}`, true); };
  rec.addEventListener('stop', () => {
    if (S.recording && !r.expected) {
      const msg = `${name} recorder stopped unexpectedly at ${fmtTime(recElapsed() / 1000)}`;
      S.session.issues.push(msg); toast(msg, true);
    }
  });
  r.p = new Promise(res => rec.addEventListener('start', () => { info.startPerf = performance.now(); info.startEpoch = Date.now(); res(); }, { once: true }));
  S.recs.push(r);
  r.stopped = new Promise(resolve => rec.addEventListener('stop', resolve, { once: true }));
  return r;
}

async function startRecording() {
  if (S.recording) return;
  if (!S.cam?.getVideoTracks().length || !S.cam.getAudioTracks().length) return toast('Allow the camera and microphone first.', true);
  if (!VMIME) return toast('This browser cannot record WebM. Use Chrome or Edge.', true);
  if (S.ac) { await S.ac.resume(); if (S.ac.state !== 'running') return toast('Audio engine is not running. Click the page and try again.', true); }
  const id = 's_' + Date.now().toString(36);
  S.session = {
    id, title: $('title').value.trim() || 'Untitled lecture', status: 'recording', createdAt: new Date().toISOString(),
    durationMs: 0, tracks: {}, events: [], issues: [], app: 'cpe-studio/1.4'
  };
  S.writes = []; S.recs = [];

  const defs = [{ name: 'camera', stream: S.cam, mime: VMIME, opts: { videoBitsPerSecond: 5e6, audioBitsPerSecond: 128000 } }];
  if (S.screen?.getVideoTracks().some(track => track.readyState === 'live')) defs.push({ name: 'screen', stream: new MediaStream(S.screen.getVideoTracks()), mime: VMIME, opts: { videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 } });

  const started = defs.map(({ name, stream, opts }) => createTrackRecorder(name, stream, opts));

  S.starting = true;
  S.recording = true; S.paused = false; S.pausedMs = 0; S.pauseAt = null; S.t0 = performance.now();
  applyToggles(); updateControls();
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
  S.starting = false;
  window.dispatchEvent(new Event('recording-started'));
  updateControls();
}

function saveProgress() {
  if (!S.session) return;
  S.session.durationMs = Math.round(recElapsed());
  return DB.putSession(S.session);
}

function togglePause() {
  if (!S.recording || S.starting || S.saving) return;
  if (!S.paused) {
    S.recs.forEach(r => r.rec.state === 'recording' && r.rec.pause());
    S.pauseAt = performance.now(); S.paused = true;
  } else {
    S.recs.forEach(r => r.rec.state === 'paused' && r.rec.resume());
    S.pausedMs += performance.now() - S.pauseAt; S.pauseAt = null; S.paused = false;
  }
  updateControls();
}

async function stopRecording() {
  if (!S.recording || S.starting || S.saving) return;
  const duration = Math.round(recElapsed());
  S.saving = true;
  clearInterval(S.timer);
  clearInterval(S.saveTimer);
  updateControls();
  window.dispatchEvent(new Event('recording-stopped'));
  try {
    S.recs.forEach(r => { r.expected = true; });
    await Promise.all(S.recs.map(r => {
      if (r.rec.state !== 'inactive') r.rec.stop();
      return r.stopped;
    }));
    // MediaRecorder emits its final dataavailable event before stop.
    await Promise.all(S.writes);
    S.session.durationMs = duration;
    S.session.status = 'complete';
    await DB.putSession(S.session);
  } catch (error) {
    toast('Could not save recording: ' + error.message, true);
    return;
  } finally {
    S.saving = false;
    S.recording = false;
    S.paused = false;
    S.pauseAt = null;
    $('timer').textContent = '00:00';
    updateControls();
  }
  await openSession(S.session.id);
}

/* ---------------- Review ---------------- */
const rv = { cam: null, scr: null, cur: null, urls: [], delta: 0, raf: null };

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
  rv.scr.style.visibility = '';
  const hasScreen = !!blobs.screen?.size;
  $('btnDownloadSlides').classList.toggle('hidden', !hasScreen);
  if (hasScreen) rv.scr.src = url(blobs.screen); else rv.scr.removeAttribute('src');
  rv.scr.muted = true;
  setLayout(hasScreen ? 'screen' : 'cam');
  $('layouts').classList.toggle('hidden', !hasScreen);
  rv.delta = hasScreen ? ((s.tracks.screen?.offsetMs || 0) - (s.tracks.camera?.offsetMs || 0)) / 1000 : 0;

  $('rvTitle').textContent = s.title;
  const screenNote = hasScreen ? 'Muted slides' : 'No slides';
  $('rvMeta').textContent = [new Date(s.createdAt).toLocaleString(), fmtTime(s.durationMs / 1000), screenNote].join(' | ');
  $('rvWarn').classList.add('hidden');
  show('review');
  await Promise.all([fixDuration(rv.cam), hasScreen ? fixDuration(rv.scr) : null]);
  seekTo(0);
  updateTransport();

  const warns = [...(s.issues || [])];   // problems detected during recording
  const expect = s.durationMs / 1000;
  if (isFinite(rv.cam.duration) && s.status === 'complete' && Math.abs(rv.cam.duration - expect) > 2)
    warns.push(`The camera file is ${fmtTime(rv.cam.duration)} but the session ran ${fmtTime(expect)}.`);
  if (hasScreen && isFinite(rv.scr.duration) && s.status === 'complete' && Math.abs(rv.scr.duration - ((s.tracks.screen.endedAtMs ?? s.durationMs) - (s.tracks.screen.offsetMs || 0)) / 1000) > 2)
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
  const track = rv.cur.s.tracks.screen;
  const shareDuration = ((track.endedAtMs ?? rv.cur.s.durationMs) - (track.offsetMs || 0)) / 1000;
  const outsideShare = target < 0 || target >= shareDuration;
  rv.scr.style.visibility = outsideShare ? 'hidden' : '';
  if (outsideShare) { rv.scr.pause(); return; }
  if (force || (!rv.scr.seeking && Math.abs(rv.scr.currentTime - target) > 0.5)) rv.scr.currentTime = target;
  if (!rv.cam.paused && rv.scr.paused) rv.scr.play().catch(() => {});
}
function seekTo(sec) { rv.cam.currentTime = Math.max(0, sec); syncScreen(true); updateTransport(); }
function updateTransport() {
  const d = duration();
  $('tpSeek').value = d ? Math.round(rv.cam.currentTime / d * 1000) : 0;
  $('tpTime').textContent = `${fmtTime(rv.cam.currentTime)} / ${fmtTime(d)}`;
  $('tpPlay').textContent = rv.cam.paused ? '\u25B6' : '\u275A\u275A';
}
function loop() {
  syncScreen(); updateTransport();
  rv.raf = rv.cam.paused ? null : requestAnimationFrame(loop);
}
$('tpPlay').onclick = async () => {
  if (rv.cam.paused) {
    try { await rv.cam.play(); }
    catch (error) { return toast('Playback could not start: ' + error.message, true); }
    syncScreen(true); cancelAnimationFrame(rv.raf); rv.raf = requestAnimationFrame(loop);
  }
  else { rv.cam.pause(); rv.scr.pause(); }
  updateTransport();
};
$('tpSeek').oninput = e => seekTo(e.target.value / 1000 * duration());
['pause', 'ended'].forEach(ev => $('rvCam').addEventListener(ev, () => { rv.scr.pause(); updateTransport(); }));
$('rvCam').addEventListener('seeked', () => { if (rv.cur) syncScreen(true); });
function setLayout(name) {   // 'cam' = camera only, 'screen' = slides only; hidden video keeps playing its audio
  document.querySelectorAll('.layouts button').forEach(x => x.classList.toggle('active', x.dataset.layout === name));
  $('viewer').className = 'viewer layout-' + name;
}
document.querySelectorAll('.layouts button').forEach(b => b.onclick = () => setLayout(b.dataset.layout));

/* ---------------- Export ---------------- */
function dl(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}
async function downloadRecording(kind, button) {
  const session = rv.cur;
  const { s, blobs } = session;
  const base = slug(s.title);
  const camera = kind === 'screen' ? null : blobs.camera;
  const screen = kind === 'camera' ? null : blobs.screen;
  if ((kind !== 'screen' && !camera?.size) || (kind === 'screen' && !screen?.size))
    return toast('The required recording track is missing.', true);
  if (s.status !== 'complete' || s.issues?.length) return toast('This recording was interrupted. Make a complete recording before exporting.', true);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  const metadata = {
    kind, cameraBytes: camera?.size || 0, screenBytes: screen?.size || 0,
    durationMs: Math.max(s.durationMs,
      Number.isFinite(rv.cam.duration) ? Math.ceil(rv.cam.duration * 1000) + (s.tracks.camera?.offsetMs || 0) : 0,
      Number.isFinite(rv.scr.duration) ? Math.ceil(rv.scr.duration * 1000) + (s.tracks.screen?.offsetMs || 0) : 0),
    cameraOffset: s.tracks.camera?.offsetMs || 0,
    screenOffset: s.tracks.screen?.offsetMs || 0
  };
  try {
    const response = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([JSON.stringify(metadata), '\n', ...[camera, screen].filter(Boolean)])
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const file = await response.blob();
    const extension = { all: '.zip', camera: '-camera-mic.mp4', screen: '-slides-muted.mp4' }[kind];
    dl(file, base + extension);
  } catch (error) {
    toast('Export failed: ' + error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
for (const [id, kind] of [
  ['btnDownloadCamera', 'camera'], ['btnDownloadSlides', 'screen'],
  ['btnDownloadAll', 'all']
]) {
  const button = $(id);
  button.onclick = () => downloadRecording(kind, button);
}

const stage = $('view-studio');
const setup = $('view-record');
const stageMain = setup.querySelector('.studio-main');
stage.dataset.layout = 'camera';
const studioDevices = [
  ['micSel', 'studioMicSlot'],
  ['camSel', 'studioCameraSlot'],
  ['speakerSel', 'studioSpeakerSlot']
].map(([id, slot]) => ({
  select: $(id),
  setupRow: $(id).parentElement,
  studioSlot: $(slot)
}));

function showPeople(open) {
  $('peoplePanel').classList.toggle('hidden', !open);
  $('btnPeople').setAttribute('aria-expanded', String(open));
}
function showStageLayouts(open) {
  $('stageLayouts').classList.toggle('hidden', !open);
  $('btnLayout').setAttribute('aria-expanded', String(open));
}

function moveStudioMain(container, before = null) {
  // An atomic move preserves the live media element's state where supported.
  if (typeof container.moveBefore === 'function') container.moveBefore(stageMain, before);
  else container.insertBefore(stageMain, before);
}

$('btnJoin').onclick = () => {
  const name = $('hostName').value.trim() || 'Host';
  $('hostInitial').textContent = Array.from(name)[0].toUpperCase();
  $('studioHostName').textContent = name;
  for (const device of studioDevices) device.studioSlot.append(device.select);
  moveStudioMain($('stageWorkspace'));
  $('studioTitleSlot').append($('title'));
  show('studio');
  cameraEffects?.startMonitoring();
  resumeCameraPreview();
  window.dispatchEvent(new Event('studio-joined'));
  updateControls();
  $('title').focus();
};
$('btnLeave').onclick = () => {
  if (S.recording) return;
  if (S.screen) onScreenEnded();
  showPeople(false);
  $('peoplePanel').querySelector('details').open = false;
  for (const device of studioDevices) device.setupRow.prepend(device.select);
  showStageLayouts(false);
  stageMain.querySelector('.session-heading').prepend($('title'));
  const setupLayout = setup.querySelector('.studio-layout');
  moveStudioMain(setupLayout, setupLayout.firstElementChild);
  show('record');
  resumeCameraPreview();
  window.dispatchEvent(new Event('studio-left'));
  $('btnJoin').focus();
};
$('btnPeopleSidebar').onclick = () => {
  const visible = $('studioRail').classList.contains('hidden');
  $('studioRail').classList.toggle('hidden', !visible);
  if (!visible) showPeople(false);
  const button = $('btnPeopleSidebar');
  const label = visible ? 'Hide People sidebar' : 'Show People sidebar';
  button.setAttribute('aria-expanded', String(visible));
  button.setAttribute('aria-label', label);
  button.title = label;
};
$('btnPeople').onclick = () => showPeople($('peoplePanel').classList.contains('hidden'));
$('btnClosePeople').onclick = () => { showPeople(false); $('btnPeople').focus(); };
$('btnLayout').onclick = () => showStageLayouts($('stageLayouts').classList.contains('hidden'));
for (const option of document.querySelectorAll('[data-stage-layout]')) {
  option.onclick = () => {
    stage.dataset.layout = option.dataset.stageLayout;
    for (const button of $('stageLayouts').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button === option));
    }
  };
}
stage.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('stageLayouts').classList.contains('hidden')) {
    showStageLayouts(false);
    $('btnLayout').focus();
  } else if (!$('peoplePanel').classList.contains('hidden')) {
    showPeople(false);
    $('btnPeople').focus();
  }
});

let headphones = false;
for (const [id, value] of [['headphonesYes', true], ['headphonesNo', false]]) {
  $(id).onclick = () => {
    headphones = value;
    $('headphonesYes').setAttribute('aria-pressed', String(value));
    $('headphonesNo').setAttribute('aria-pressed', String(!value));
    $('headphonesHint').textContent = value ? 'Test audio plays through the selected output.' : 'Speaker tests play at a lower volume.';
  };
}

async function routeTestAudio(player) {
  if (typeof player.setSinkId === 'function') await player.setSinkId($('speakerSel').value);
}

async function playTestTone() {
  const context = getAc();
  await context.resume();
  const output = context.createMediaStreamDestination();
  const player = new Audio();
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  player.srcObject = output.stream;
  oscillator.connect(volume).connect(output);
  try {
    await routeTestAudio(player);
    const playing = player.play();
    const now = context.currentTime;
    oscillator.frequency.value = 660;
    volume.gain.setValueAtTime(0, now);
    volume.gain.linearRampToValueAtTime(headphones ? 0.09 : 0.04, now + 0.03);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    const ended = new Promise(resolve => oscillator.addEventListener('ended', resolve, { once: true }));
    oscillator.start(now);
    oscillator.stop(now + 0.36);
    await Promise.all([playing, ended]);
  } finally {
    player.pause();
    player.srcObject = null;
    oscillator.disconnect();
    volume.disconnect();
    output.stream.getTracks().forEach(track => track.stop());
  }
}

function testTone() {
  playTestTone().catch(error => toast('Test sound could not play: ' + error.message, true));
}

$('btnTestSpeaker').onclick = testTone;

const cameraTest = $('cameraTest');
const cameraTestPreview = $('cameraTestPreview');
$('btnTestCamera').onclick = () => {
  if (!S.camOn) return toast('Turn on your camera to preview it.', true);
  cameraTestPreview.srcObject = new MediaStream(S.cam.getVideoTracks());
  cameraTest.showModal();
  testTone();
};
cameraTest.addEventListener('close', () => { cameraTestPreview.srcObject = null; });

async function testMic() {
  if (!S.micOn) return toast('Unmute your microphone to test it.', true);
  const dialog = $('micTest');
  const player = $('micTestPlayback');
  const status = $('micTestStatus');
  const stop = $('btnStopMicTest');
  const chunks = [];
  const recorder = new MediaRecorder(S.micStream);
  let url;
  let closed = false;
  let failed = false;
  stop.onclick = () => {
    stop.disabled = true;
    if (recorder.state !== 'inactive') recorder.stop();
  };
  dialog.addEventListener('close', () => {
    closed = true;
    if (recorder.state !== 'inactive') recorder.stop();
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (url) URL.revokeObjectURL(url);
  }, { once: true });
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => {
    failed = true;
    stop.disabled = true;
    status.textContent = 'Could not record from this microphone. Close the test and try again.';
  };
  recorder.onstop = () => {
    if (closed || failed) return;
    stop.disabled = true;
    if (!chunks.length) {
      status.textContent = 'No audio was captured. Close the test and try again.';
      return;
    }
    url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
    player.src = url;
    player.classList.remove('hidden');
    status.textContent = 'Listen to your microphone sample.';
    routeTestAudio(player).then(() => { if (!closed) return player.play(); }).catch(() => { if (!closed) status.textContent = 'Press Play to hear your microphone sample.'; });
  };
  player.classList.add('hidden');
  dialog.showModal();
  status.textContent = 'Starting microphone…';
  stop.disabled = true;
  recorder.onstart = () => {
    if (closed) return;
    status.textContent = 'Speak into the microphone, then click Stop and listen.';
    stop.disabled = false;
  };
  try {
    await getAc().resume();
    if (!closed) recorder.start(1000);
  } catch (error) {
    stop.disabled = true;
    status.textContent = 'Device test failed: ' + error.message;
  }
}
$('btnTestMic').onclick = () => {
  testMic().catch(error => toast(error.message, true));
};

/* ---------------- Wire up ---------------- */
$('btnEnable').onclick = openCamera;
$('camSel').onchange = $('micSel').onchange = openCamera;
$('btnStopScreen').onclick = onScreenEnded;
$('btnCamToggle').onclick = () => toggleDevice('cam');
$('btnMicToggle').onclick = () => toggleDevice('mic');
$('btnStart').onclick = async () => {
  if (S.recording || S.countingDown || S.switchingDevices || S.choosingScreen || !S.cam) return;
  const overlay = $('recordCountdown');
  const screen = S.screen;
  S.countingDown = true;
  updateControls();
  overlay.classList.remove('hidden');
  try {
    for (let seconds = 5; seconds > 0; seconds--) {
      overlay.textContent = seconds;
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (screen && (S.screen !== screen || !screen.getVideoTracks().some(track => track.readyState === 'live'))) {
        toast('Screen sharing ended. Click Start recording to try again.', true);
        return;
      }
    }
    overlay.classList.add('hidden');
    await startRecording();
  } catch (error) {
    toast('Could not start recording: ' + error.message, true);
  } finally {
    overlay.classList.add('hidden');
    S.countingDown = false;
    updateControls();
  }
};
$('btnPause').onclick = togglePause;
$('btnStop').onclick = stopRecording;
window.addEventListener('beforeunload', e => { if (S.recording) { e.preventDefault(); e.returnValue = ''; } });

updateControls();
if (!navigator.mediaDevices || !window.MediaRecorder) toast('This browser does not support recording. Use Chrome or Edge.', true);
else {
  const refreshDeviceList = () => {
    refreshDevices().catch(error => toast('Could not refresh devices: ' + error.message, true));
  };
  navigator.mediaDevices.addEventListener('devicechange', refreshDeviceList);
  // Also refresh when returning to the page or opening a device selector.
  // This covers browsers that do not reliably emit devicechange events.
  window.addEventListener('focus', refreshDeviceList);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDeviceList();
  });
  for (const id of ['camSel', 'micSel', 'speakerSel']) {
    $(id).addEventListener('focus', refreshDeviceList);
    $(id).addEventListener('pointerdown', refreshDeviceList);
  }
  openCamera();
}
window.CPE = { S, rv, buildPipeline, startRecording, stopRecording, openSession, DB, startMeters, updateControls, attachScreenMeter, recElapsed,
  canShare, shareScreen, attachSharedStream, toast };
