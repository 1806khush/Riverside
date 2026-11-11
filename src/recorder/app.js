import { CameraEffects } from './camera-effects.js';
import { DB } from './storage';
import { CHUNK_MS, createRecordingFiles, lockRecording, readRecordingFiles } from './recording-files';
import { recoverRecordings } from './recording-recovery';
import { errorName, heapUsed, logRecording, storageEstimate } from './recording-log';
/* Mosaic Web - local recording app
 * Camera+mic and screen/slides are recorded as separate synchronized tracks
 * and committed to local storage about every five seconds.
 *
 * Camera/mic on-off never disables a recorded track: the camera goes through a frame transformer that
 * swaps in black frames, and the mic goes through a gain node. The recorders therefore always get
 * continuous data and cannot stall when a device is switched off. */

export const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pad = n => String(n).padStart(2, '0');
const fmtTime = sec => { const s = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(s / 3600); return (h ? pad(h) + ':' : '') + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const slug = s => (s || 'lecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lecture';
let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 9000 : 3500);
}

/* ---------------- State ---------------- */
const pick = list => (window.MediaRecorder && list.find(m => MediaRecorder.isTypeSupported(m))) || '';
const VMIME = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
const CAN_TRANSFORM = !!(window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.VideoFrame && window.OffscreenCanvas);

export const S = {
  raw: null, cam: null, micStream: null, screen: null,
  ac: null, micGain: null, micAn: null, scrAn: null, vFallbackTrack: null,
  recs: [], recording: false, paused: false,
  t0: 0, pausedMs: 0, pauseAt: null, session: null, capture: null,
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

export const cameraEffects = CAN_TRANSFORM ? new CameraEffects((state, face) => {
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
  if (state === 'error') toast('Camera effects could not load. Reload the page and try again.', true);
  if (state === 'background-error') toast('The background effect could not load. Reload the page and try again.', true);
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
  if (S.recording || S.starting || S.saving || S.countingDown || S.switchingDevices) return;
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
      ? 'The camera is being used by another app or browser tab (Teams, Zoom, Camera app, or another Mosaic Web tab). Close it, then click "Retry camera".'
      : e.name === 'NotAllowedError'
        ? 'Camera/microphone permission was blocked. Allow access in your system or browser privacy settings, reload the page if required, then click "Retry camera".'
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
    try { startTrack(recorder); }
    catch (error) { delete session.tracks.screen; S.recs.pop(); throw error; }
  }
  S.screen = stream;
  $('screenPreview').srcObject = stream;
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (S.screen === stream) {
      if (S.recording && S.session.tracks.screen) logRecording('screen_sharing_ended', S.session.id, { elapsedMs: Math.round(recElapsed()) });
      onScreenEnded();
    }
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
    logRecording('screen_recording_ended', S.session.id, { elapsedMs: Math.round(recElapsed()) });
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
  $('btnStart').disabled = !S.cam || S.recording || S.starting || S.saving || S.countingDown || S.switchingDevices || S.choosingScreen;
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
function createTrackRecorder(name, stream, opts, source = stream) {
  const rec = new MediaRecorder(stream, { mimeType: VMIME, ...opts });
  const info = { mime: rec.mimeType || VMIME, hasVideo: stream.getVideoTracks().length > 0, hasAudio: stream.getAudioTracks().length > 0 };
  S.session.tracks[name] = info;
  const capture = S.capture;
  const r = { name, rec, info, expected: false };
  r.stopped = new Promise(resolve => rec.addEventListener('stop', resolve, { once: true }));
  rec.ondataavailable = event => queueChunk(capture, r, event);
  rec.onerror = event => {
    logRecording('media_recorder_error', capture.id, { track: name, error: errorName(event.error) });
    if (S.capture === capture && !S.saving) void interruptRecording('The ' + name + ' recorder reported an error.');
  };
  rec.addEventListener('stop', () => {
    if (S.capture !== capture || r.expected) return;
    logRecording('recorder_stopped_unexpectedly', capture.id, { track: name });
    if (name === 'camera') {
      if (!S.saving) void interruptRecording('The camera recorder stopped unexpectedly.');
    } else {
      info.endedAtMs = Math.round(recElapsed());
      S.session.issues.push('Screen recording stopped unexpectedly.');
      if (S.screen === source) onScreenEnded();
      toast('Screen recording stopped. The camera is still recording.', true);
    }
  });
  for (const track of source.getTracks()) {
    const onEnded = () => {
      if (S.capture !== capture || r.expected) return;
      logRecording('media_track_ended', capture.id, { track: name, kind: track.kind });
      if (name === 'camera' && !S.saving) void interruptRecording('The ' + (track.kind === 'audio' ? 'microphone' : 'camera') + ' disconnected.');
    };
    track.addEventListener('ended', onEnded);
    capture.listeners.push(() => track.removeEventListener('ended', onEnded));
  }
  S.recs.push(r);
  const { width, height, frameRate } = source.getVideoTracks()[0]?.getSettings() ?? {};
  logRecording('recorder_configured', capture.id, { track: name, mime: info.mime, width, height, frameRate, hasAudio: info.hasAudio });
  return r;
}

function queueChunk(capture, recorder, event) {
  if (!capture.accepting || capture.failed || !event.data.size) return;
  const { name } = recorder;
  const seq = recorder.nextSeq ?? 0;
  recorder.nextSeq = seq + 1;
  const size = event.data.size;
  const endMs = Math.round(recElapsed());
  const details = { track: name, seq, size, endMs, timecodeMs: event.timecode };
  logRecording('chunk_received', capture.id, details);
  if (capture.queued >= 8 || capture.queuedBytes + size > 64 * 1024 * 1024) {
    recordingWriteFailed(capture, new DOMException('Local storage is not keeping up.', 'TimeoutError'));
    return;
  }
  capture.queued++;
  capture.queuedBytes += size;
  capture.pending = capture.pending.then(async () => {
    if (capture.failed || capture.discardPending) return;
    const checkpoint = { ...S.session, durationMs: Math.max(S.session.durationMs, endMs) };
    logRecording('chunk_write_started', capture.id, details);
    try {
      const savedAt = await capture.files.write({ sessionId: capture.id, track: name, seq, size, endMs, blob: event.data }, structuredClone(checkpoint));
      S.session.lastSavedAt = savedAt;
      S.session.durationMs = checkpoint.durationMs;
      capture.committed++;
      capture.last = { ...details, savedAt: S.session.lastSavedAt };
      logRecording('chunk_write_completed', capture.id, { ...details, savedAt: capture.last.savedAt });
      renderStorageStatus();
    } catch (error) {
      logRecording('chunk_write_failed', capture.id, { ...details, error: errorName(error) });
      recordingWriteFailed(capture, error);
    }
  }).finally(() => {
    capture.queued--;
    capture.queuedBytes -= size;
  });
}

function recordingWriteFailed(capture, error) {
  if (capture.failed) return;
  capture.failed = true;
  capture.error = errorName(error) === 'QuotaExceededError'
    ? 'Local storage is full or unavailable. Free space before recording again.'
    : 'Mosaic Web could not save video fast enough.';
  if (import.meta.env.DEV && capture.simulatingFailure) capture.error = 'Simulated storage write failed as expected.';
  logRecording('recording_storage_error', capture.id, { error: errorName(error) });
  if (S.capture === capture && !S.saving && !S.starting) void interruptRecording(capture.error);
}

let storageInfo = {};
function renderStorageStatus() {
  const capture = S.capture;
  const status = $('recordingStorageStatus');
  status.classList.toggle('hidden', !S.recording && !capture?.error);
  const saved = capture?.last?.savedAt;
  const storage = storageInfo.usage === undefined ? 'Storage usage unavailable' : formatBytes(storageInfo.usage) + ' used locally';
  $('recordingStorageDetails').textContent = [
    saved ? 'Saved ' + new Date(saved).toLocaleTimeString() : 'Waiting for first save',
    storage,
  ].join(' · ');
  $('recordingStorageError').textContent = capture?.error || '';
}

function formatBytes(bytes) {
  if (bytes === undefined) return 'Unavailable';
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
}

async function updateStorageEstimate(capture) {
  storageInfo = await storageEstimate();
  if (S.capture !== capture) return;
  logRecording('storage_sample', capture.id, { ...storageInfo, heapBytes: heapUsed() });
  renderStorageStatus();
}

function startTrack(r) {
  r.info.offsetMs = Math.max(0, Math.round(recElapsed()));
  r.rec.start(CHUNK_MS);
}

async function startRecording({ stressTest = false } = {}) {
  if (S.recording || S.starting || S.saving) return;
  if (!S.cam?.getVideoTracks().length || !S.cam.getAudioTracks().length
    || !S.raw?.getVideoTracks().some(track => track.readyState === 'live')
    || !S.raw.getAudioTracks().some(track => track.readyState === 'live'))
    return toast('Allow the camera and microphone first.', true);
  if (!VMIME || !navigator.locks) return toast('Use a current version of Chrome or Edge to record and recover lectures.', true);
  const id = crypto.randomUUID();
  const capture = { id, pending: Promise.resolve(), queued: 0, queuedBytes: 0, committed: 0, accepting: true, listeners: [] };
  S.capture = capture;
  S.starting = true;
  S.recs = [];
  updateControls();
  void navigator.storage?.persist?.().then(granted => logRecording('storage_persistence_requested', id, { granted }))
    .catch(error => logRecording('storage_persistence_failed', id, { error: errorName(error) }));
  try {
    if (S.ac) { await S.ac.resume(); if (S.ac.state !== 'running') throw new Error('Audio engine is not running. Click the page and try again.'); }
    capture.release = await lockRecording(id);
    capture.files = await createRecordingFiles();
    S.session = {
      id, title: stressTest ? 'Stress recording' : $('title').value.trim() || 'Untitled lecture',
      status: 'recording', createdAt: new Date().toISOString(), storage: capture.files.storage,
      durationMs: 0, tracks: {}, events: [], issues: [], app: 'mosaic-web', stressTest,
    };
    createTrackRecorder('camera', S.cam, { videoBitsPerSecond: 5e6, audioBitsPerSecond: 128000 }, S.raw);
    if (S.screen?.getVideoTracks().some(track => track.readyState === 'live')) {
      createTrackRecorder('screen', new MediaStream(S.screen.getVideoTracks()), { videoBitsPerSecond: 6e6 }, S.screen);
    }
    // Write session metadata before any chunk can be emitted.
    await DB.putSession(S.session);
    S.recording = true; S.paused = false; S.pausedMs = 0; S.pauseAt = null; S.t0 = performance.now();
    S.recs.forEach(startTrack);
    logRecording('recording_started', id, {
      browser: navigator.userAgent, platform: navigator.platform, storage: capture.files.storage, stressTest,
    });
    S.timer = setInterval(() => { $('timer').textContent = fmtTime(recElapsed() / 1000); }, 250);
    S.saveTimer = setInterval(() => void updateStorageEstimate(capture), 10000);
    void updateStorageEstimate(capture);
    window.dispatchEvent(new Event('recording-started'));
  } catch (error) {
    capture.accepting = false;
    stopTrackRecorders();
    closeCapture(capture);
    logRecording('recording_start_failed', id, { error: errorName(error) });
    throw error;
  } finally {
    S.starting = false;
    applyToggles(); updateControls(); renderStorageStatus();
  }
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
  logRecording(S.paused ? 'recording_paused' : 'recording_resumed', S.session.id, { elapsedMs: Math.round(recElapsed()) });
  updateControls();
}

function stopTrackRecorders() {
  for (const r of S.recs) {
    r.expected = true;
    if (r.rec.state !== 'inactive') r.rec.stop();
  }
}

function closeCapture(capture) {
  clearInterval(S.timer);
  clearInterval(S.saveTimer);
  capture.accepting = false;
  capture.listeners.forEach(remove => remove());
  capture.files?.close();
  capture.release?.();
  S.saving = false;
  S.recording = false;
  S.paused = false;
  S.pauseAt = null;
  $('timer').textContent = '00:00';
  updateControls(); renderStorageStatus();
}

async function waitForTrackStop() {
  let timer;
  try {
    await Promise.race([
      Promise.all(S.recs.map(r => r.stopped)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('The recorder did not finish.', 'TimeoutError')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopRecording() {
  if (!S.recording || S.starting || S.saving) return;
  const capture = S.capture;
  const duration = Math.round(recElapsed());
  S.saving = true;
  clearInterval(S.timer);
  clearInterval(S.saveTimer);
  updateControls();
  logRecording('recording_stopping', capture.id, { durationMs: duration });
  window.dispatchEvent(new Event('recording-stopped'));
  let saved = false;
  try {
    stopTrackRecorders();
    // MediaRecorder delivers final chunks before the stop events.
    await waitForTrackStop();
    await capture.pending;
    if (capture.failed) throw new Error(capture.error);
    if (!capture.committed) throw new Error('No playable recording was saved.');
    const complete = { ...S.session, status: 'complete', durationMs: duration, poster: recordingPoster() };
    await DB.putSession(complete);
    S.session = complete;
    saved = true;
    logRecording('recording_completed', capture.id, { durationMs: duration, savedChunks: capture.committed });
  } catch (error) {
    capture.accepting = false;
    await capture.pending;
    capture.error ||= 'Could not finish saving the recording.';
    toast(capture.error, true);
    logRecording('recording_finalize_failed', capture.id, { error: errorName(error) });
  } finally {
    closeCapture(capture);
  }
  if (saved) {
    try {
      if (!await openSession(capture.id)) toast('The saved recording is unavailable for preview.', true);
    } catch (error) {
      logRecording('recording_preview_failed', capture.id, { error: errorName(error) });
      toast('The recording was saved but could not be previewed.', true);
    }
  }
  else await showRecoveryNotice(capture.id);
}

async function interruptRecording(reason, simulation = false) {
  if (!S.recording || S.saving) return;
  const capture = S.capture;
  capture.accepting = false;
  capture.discardPending = true;
  capture.error = reason;
  S.saving = true;
  updateControls();
  logRecording(simulation ? 'simulated_recording_interruption' : 'recording_interrupted', capture.id, { elapsedMs: Math.round(recElapsed()) });
  window.dispatchEvent(new Event('recording-stopped'));
  // Release the encoders, but discard their final data and leave the session unfinished.
  stopTrackRecorders();
  await capture.pending;
  closeCapture(capture);
  toast(reason, true);
  if (!simulation) await showRecoveryNotice(capture.id);
}

async function showRecoveryNotice(id) {
  try {
    const sessions = await recoverRecordings();
    const recovered = sessions.filter(s => s.recovered && (import.meta.env.DEV || !s.stressTest));
    if (id && !recovered.some(s => s.id === id)) return;
    if (recovered.length) $('recoveryNotice').classList.remove('hidden');
  } catch (error) {
    logRecording('recovery_scan_failed', id, { error: errorName(error) });
  }
}

function recordingPoster() {
  const video = $('camPreview');
  if (!S.camOn || !video.videoWidth || !video.videoHeight) return undefined;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.76);
  } catch {
    return undefined;
  }
}

/* ---------------- Review ---------------- */
const rv = { cam: null, scr: null, primary: null, cur: null, urls: [], delta: 0, raf: null };

async function openSession(id) {
  const s = await DB.getSession(id);
  if (s?.status !== 'complete' || (s.stressTest && !import.meta.env.DEV)) return false;
  const files = await readRecordingFiles(s, await DB.getChunks(id));
  const blobs = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.blob]));
  const hasCamera = !!blobs.camera?.size;
  const hasScreen = !!blobs.screen?.size;
  if (!hasCamera && !hasScreen) return false;
  rv.urls.forEach(u => URL.revokeObjectURL(u)); rv.urls = [];
  rv.cur = { s, blobs };
  rv.cam = $('rvCam'); rv.scr = $('rvScreen');
  const url = b => { const u = URL.createObjectURL(b); rv.urls.push(u); return u; };
  rv.primary = hasCamera ? rv.cam : rv.scr;
  if (hasCamera) rv.cam.src = url(blobs.camera); else rv.cam.removeAttribute('src');
  rv.scr.style.visibility = '';
  for (const id of ['btnDownloadCamera', 'btnDownloadAll', 'btnLocalCamera']) $(id).classList.toggle('hidden', !hasCamera);
  $('btnDownloadSlides').classList.toggle('hidden', !hasScreen);
  $('btnLocalSlides').classList.toggle('hidden', !hasScreen);
  if (hasScreen) rv.scr.src = url(blobs.screen); else rv.scr.removeAttribute('src');
  rv.scr.muted = true;
  setLayout(hasScreen ? 'screen' : 'cam');
  $('layouts').classList.toggle('hidden', !hasCamera || !hasScreen);
  rv.delta = hasScreen ? ((s.tracks.screen?.offsetMs || 0) - (s.tracks.camera?.offsetMs || 0)) / 1000 : 0;

  $('rvTitle').textContent = s.title;
  const screenNote = [hasScreen ? 'Muted slides' : 'No slides', s.recovered ? 'Recovered' : ''].filter(Boolean).join(' · ');
  $('rvMeta').textContent = [new Date(s.createdAt).toLocaleString(), fmtTime(s.durationMs / 1000), screenNote].join(' | ');
  $('rvWarn').classList.add('hidden');
  show('review');
  await Promise.all([hasCamera ? fixDuration(rv.cam) : null, hasScreen ? fixDuration(rv.scr) : null]);
  seekTo(0);
  updateTransport();

  const warns = [...(s.issues || [])];   // problems detected during recording
  const expect = s.durationMs / 1000;
  if (!s.recovered && isFinite(rv.cam.duration) && s.status === 'complete' && Math.abs(rv.cam.duration - expect) > 2)
    warns.push(`The camera file is ${fmtTime(rv.cam.duration)} but the session ran ${fmtTime(expect)}.`);
  if (!s.recovered && hasScreen && isFinite(rv.scr.duration) && s.status === 'complete' && Math.abs(rv.scr.duration - ((s.tracks.screen.endedAtMs ?? s.durationMs) - (s.tracks.screen.offsetMs || 0)) / 1000) > 2)
    warns.push(`The screen file is ${fmtTime(rv.scr.duration)} but the session ran ${fmtTime(expect)}.`);
  if (warns.length) { $('rvWarn').textContent = 'Check this recording: ' + warns.join(' '); $('rvWarn').classList.remove('hidden'); }
  return true;
}

function fixDuration(video) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', seekToEnd);
      video.removeEventListener('seeked', finish);
      video.removeEventListener('error', finish);
      resolve();
    };
    const seekToEnd = () => {
      if (Number.isFinite(video.duration)) return finish();
      video.addEventListener('seeked', finish, { once: true });
      video.currentTime = 1e101;
    };
    const timeout = setTimeout(finish, 4500);
    video.addEventListener('error', finish, { once: true });
    if (video.readyState >= 1) seekToEnd();
    else video.addEventListener('loadedmetadata', seekToEnd, { once: true });
  });
}
function duration() {
  if (Number.isFinite(rv.primary.duration)) return rv.primary.duration;
  const offset = rv.primary === rv.scr ? rv.cur.s.tracks.screen.offsetMs || 0 : 0;
  return Math.max(0, rv.cur.s.durationMs - offset) / 1000;
}

function syncScreen(force) {
  if (rv.primary !== rv.cam || !rv.scr.getAttribute('src')) return;
  const target = rv.cam.currentTime - rv.delta;
  const track = rv.cur.s.tracks.screen;
  const shareDuration = ((track.endedAtMs ?? rv.cur.s.durationMs) - (track.offsetMs || 0)) / 1000;
  const outsideShare = target < 0 || target >= shareDuration;
  rv.scr.style.visibility = outsideShare ? 'hidden' : '';
  if (outsideShare) { rv.scr.pause(); return; }
  if (force || (!rv.scr.seeking && Math.abs(rv.scr.currentTime - target) > 0.5)) rv.scr.currentTime = target;
  if (!rv.cam.paused && rv.scr.paused) rv.scr.play().catch(() => {});
}
function seekTo(sec) { rv.primary.currentTime = Math.max(0, sec); syncScreen(true); updateTransport(); }
function updateTransport() {
  const d = duration();
  $('tpSeek').value = d ? Math.round(rv.primary.currentTime / d * 1000) : 0;
  $('tpTime').textContent = `${fmtTime(rv.primary.currentTime)} / ${fmtTime(d)}`;
  $('tpPlay').textContent = rv.primary.paused ? '\u25B6' : '\u275A\u275A';
}
function loop() {
  syncScreen(); updateTransport();
  rv.raf = rv.primary.paused ? null : requestAnimationFrame(loop);
}
$('tpPlay').onclick = async () => {
  if (rv.primary.paused) {
    try { await rv.primary.play(); }
    catch (error) { return toast('Playback could not start: ' + error.message, true); }
    syncScreen(true); cancelAnimationFrame(rv.raf); rv.raf = requestAnimationFrame(loop);
  }
  else { rv.primary.pause(); }
  updateTransport();
};
$('tpSeek').oninput = e => seekTo(e.target.value / 1000 * duration());
for (const video of [$('rvCam'), $('rvScreen')]) {
  for (const event of ['pause', 'ended']) {
    video.addEventListener(event, () => {
      if (video !== rv.primary) return;
      if (video === rv.cam) rv.scr.pause();
      updateTransport();
    });
  }
  video.addEventListener('seeked', () => { if (video === rv.primary) syncScreen(true); });
}
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
  if (s.status !== 'complete') return toast('Open a saved recording before exporting.', true);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  logRecording('export_started', s.id, { format: kind === 'all' ? 'zip' : 'mp4', track: kind });
  const metadata = {
    kind, cameraBytes: camera?.size || 0, screenBytes: screen?.size || 0,
    durationMs: Math.max(s.durationMs,
      Number.isFinite(rv.cam.duration) ? Math.ceil(rv.cam.duration * 1000) + (s.tracks.camera?.offsetMs || 0) : 0,
      Number.isFinite(rv.scr.duration) ? Math.ceil(rv.scr.duration * 1000) + (s.tracks.screen?.offsetMs || 0) : 0),
    cameraOffset: camera ? s.tracks.camera?.offsetMs || 0 : 0,
    screenOffset: screen ? s.tracks.screen?.offsetMs || 0 : 0
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
    logRecording('export_completed', s.id, { track: kind, bytes: file.size });
  } catch (error) {
    logRecording('export_failed', s.id, { track: kind, error: errorName(error) });
    toast('Export failed. You can still download the original WebM tracks.', true);
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

function downloadLocalTrack(session, track, blob) {
  if (!blob?.size) return toast('The saved track could not be downloaded.', true);
  try {
    dl(blob, slug(session.title) + (track === 'camera' ? '-camera-mic' : '-slides-muted') + '.webm');
    logRecording('local_download_requested', session.id, { track, bytes: blob.size, recovered: !!session.recovered });
  } catch (error) {
    logRecording('export_failed', session.id, { track, error: errorName(error) });
    toast('Could not download the local track.', true);
  }
}
$('btnLocalCamera').onclick = () => downloadLocalTrack(rv.cur.s, 'camera', rv.cur.blobs.camera);
$('btnLocalSlides').onclick = () => downloadLocalTrack(rv.cur.s, 'screen', rv.cur.blobs.screen);

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
  if (S.recording || S.starting || S.saving || S.countingDown || S.switchingDevices || S.choosingScreen || !S.cam) return;
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
window.addEventListener('beforeunload', e => { if (S.recording && !S.capture?.discardPending) { e.preventDefault(); e.returnValue = ''; } });

updateControls();
const reviewId = new URLSearchParams(location.search).get('session');
if (reviewId) {
  const reviewError = () => {
    show('unavailable');
  };
  $('view-record').classList.add('hidden');
  recoverRecordings().then(() => openSession(reviewId)).then(found => { if (!found) reviewError(); }).catch(reviewError);
} else if (!navigator.mediaDevices || !window.MediaRecorder) toast('This browser does not support recording. Use Chrome or Edge.', true);
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
  void showRecoveryNotice();
}
window.CPE = { S, rv, buildPipeline, startRecording, stopRecording, openSession, DB, startMeters, updateControls, attachScreenMeter, recElapsed,
  canShare, shareScreen, attachSharedStream, toast };
if (import.meta.env.DEV) {
  void import('./recording-stress.js').then(({ addStressPanel }) => addStressPanel({
    $, S, startRecording, interruptRecording, formatBytes, downloadLocalTrack,
  }));
}
