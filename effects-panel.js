'use strict';

const effectsPanel = $('backgroundEffectsPanel');
let lowLightSince = 0;
let lightRecoveredSince = 0;
let isLowLight = false;

function selectEffectsTab(appearance) {
  for (const [id, selected] of [['backgroundTab', !appearance], ['appearanceTab', appearance]]) {
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
  $('backgroundOptions').classList.toggle('hidden', appearance);
  $('appearanceOptions').classList.toggle('hidden', !appearance);
}

function openEffects(appearance = false) {
  cameraEffects?.startMonitoring();
  selectEffectsTab(appearance);
  effectsPanel.classList.remove('hidden');
  effectsPanel.scrollTop = 0;
  document.body.classList.add('effects-panel-open');
  $('btnBackgroundEffects').setAttribute('aria-expanded', 'true');
  $('effectsPreview').srcObject = S.cam;
  $(appearance ? 'appearanceTab' : 'backgroundTab').focus();
  syncAppearanceControls();
  updateScreenGlowBounds();
}

function closeEffects() {
  effectsPanel.classList.add('hidden');
  document.body.classList.remove('effects-panel-open');
  $('btnBackgroundEffects').setAttribute('aria-expanded', 'false');
  $('effectsPreview').srcObject = null;
  updateScreenGlowBounds();
}

function syncAppearanceControls() {
  if (!cameraEffects) return;
  const options = cameraEffects.options;
  for (const key of ['touchUp', 'studioLighting']) $(key).checked = options[key];
  $('touchStrength').value = String(options.touchStrength);
  $('studioLevel').value = String(Math.round(options.studioLevel * 100));
  const failure = cameraEffects.failed && (options.touchUp || options.background !== 'none');
  $('cameraProcessingStatus').classList.toggle('hidden', !failure);
  $('cameraProcessingStatus').textContent = failure ? 'Camera effects are temporarily unavailable. Reopen this panel to retry.' : '';
  $('touchUpControls').classList.toggle('hidden', !options.touchUp);
  $('studioLightingControls').classList.toggle('hidden', !options.studioLighting);
  $('screenGlowControls').classList.toggle('hidden', !$('screenGlow').checked);
  const blur = ['slight', 'full'].includes(options.background) ? options.background : 'none';
  const color = options.background.startsWith('#') ? options.background : 'none';
  for (const button of document.querySelectorAll('[data-blur]')) {
    button.setAttribute('aria-pressed', String(button.dataset.blur === blur));
  }
  for (const button of document.querySelectorAll('[data-color]')) {
    button.setAttribute('aria-pressed', String(button.dataset.color === color));
  }
  const message = !cameraEffects.failed && options.background !== 'none' && !cameraEffects.mask ? 'Preparing background effect…' : '';
  if ($('backgroundEffectStatus').textContent !== message) $('backgroundEffectStatus').textContent = message;
}

function updateScreenGlow() {
  const enabled = $('screenGlow').checked;
  const cool = Number($('glowWarmth').value) / 100;
  const color = [255 - 17 * cool, 226 + 22 * cool, 185 + 70 * cool].map(Math.round);
  document.body.style.setProperty('--screen-glow', `rgb(${color.join(',')})`);
  document.body.style.setProperty('--glow-opacity', String(Number($('glowBrightness').value) / 100));
  document.body.classList.toggle('screen-glow-on', enabled);
  $('screenGlowControls').classList.toggle('hidden', !enabled);
  if (enabled) $('lowLightTip').classList.add('hidden');
  updateScreenGlowBounds();
}

function updateScreenGlowBounds() {
  const studioVisible = !$('view-studio').classList.contains('hidden');
  const setupVisible = !$('view-record').classList.contains('hidden');
  const ring = $('screenGlowRing');
  const enabled = $('screenGlow').checked && (studioVisible || setupVisible);
  const shared = $('screenPreview').closest('.screen-tile');
  const surroundsShared = !!(enabled && studioVisible && S.screen && shared.getClientRects().length);
  document.body.classList.toggle('screen-glow-sharing', surroundsShared);
  ring.classList.toggle('surrounds-shared-content', surroundsShared);
  ring.classList.toggle('hidden', !enabled);
  if (ring.classList.contains('hidden')) {
    ring.classList.remove('is-dimmed');
    return;
  }
  const target = surroundsShared ? shared : studioVisible ? $('stageWorkspace').querySelector('.previews') : $('view-record').querySelector('.studio-layout');
  if (!target) return;
  let outside = 0;
  if (surroundsShared) {
    const slot = $('sharedContentSlot');
    const space = slot.getBoundingClientRect();
    // Scale the light down on small layouts, and reserve its entire border + shadow.
    const scale = Math.min(1, space.width / 560, space.height / 340);
    const thickness = Math.max(4, Math.min(42, Math.max(18, innerWidth * 0.028)) * scale);
    const gap = Math.max(3, 12 * scale);
    const shadow = Math.max(4, 14 * scale);
    outside = thickness + gap;
    slot.style.setProperty('--shared-glow-clearance', outside + shadow + 'px');
    ring.style.setProperty('--shared-glow-border-width', thickness + 'px');
    ring.style.setProperty('--shared-glow-shadow', shadow + 'px');
    const radius = parseFloat(getComputedStyle(shared).borderTopLeftRadius) || 0;
    ring.style.setProperty('--shared-glow-radius', radius + outside + 'px');
  }
  const bounds = target.getBoundingClientRect();
  Object.assign(ring.style, {
    left: bounds.left - outside + 'px', top: bounds.top - outside + 'px',
    width: bounds.width + outside * 2 + 'px', height: bounds.height + outside * 2 + 'px'
  });
  updateGlowHover();
}

let glowPointer = null;
let glowHoverFrame = null;
function updateGlowHover() {
  if (glowHoverFrame !== null) cancelAnimationFrame(glowHoverFrame);
  glowHoverFrame = null;
  const ring = $('screenGlowRing');
  if (!glowPointer || ring.classList.contains('hidden')) {
    ring.classList.remove('is-dimmed');
    return;
  }
  const bounds = ring.getBoundingClientRect();
  const x = glowPointer.x - bounds.left, y = glowPointer.y - bounds.top;
  const band = parseFloat(getComputedStyle(ring, '::before').borderTopWidth) + 24;
  const inside = x >= -24 && y >= -24 && x <= bounds.width + 24 && y <= bounds.height + 24;
  const nearBorder = inside && Math.min(x, y, bounds.width - x, bounds.height - y) <= band;
  // Only dim the light near the pointer, while clicks still reach the controls below.
  ring.style.setProperty('--glow-pointer-x', x + 'px');
  ring.style.setProperty('--glow-pointer-y', y + 'px');
  ring.classList.toggle('is-dimmed', nearBorder);
}
document.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' || !$('screenGlow').checked) return;
  glowPointer = { x: event.clientX, y: event.clientY };
  if (glowHoverFrame === null) glowHoverFrame = requestAnimationFrame(updateGlowHover);
}, { passive: true });
function clearGlowHover() {
  glowPointer = null;
  $('screenGlowRing').classList.remove('is-dimmed');
}
document.addEventListener('pointerout', event => { if (!event.relatedTarget) clearGlowHover(); });
window.addEventListener('blur', clearGlowHover);

let glowBoundsFrame = null;
function scheduleScreenGlowBounds() {
  if (glowBoundsFrame !== null) return;
  glowBoundsFrame = requestAnimationFrame(() => { glowBoundsFrame = null; updateScreenGlowBounds(); });
}
const glowResizeObserver = new ResizeObserver(scheduleScreenGlowBounds);
glowResizeObserver.observe($('view-record').querySelector('.studio-layout'));
glowResizeObserver.observe($('camPreview').closest('.previews'));
glowResizeObserver.observe($('sharedContentSlot'));
glowResizeObserver.observe($('screenPreview').closest('.screen-tile'));
glowResizeObserver.observe($('teleprompterDock'));
const glowLayoutObserver = new MutationObserver(scheduleScreenGlowBounds);
glowLayoutObserver.observe($('view-studio'), { attributes: true, attributeFilter: ['class', 'data-layout', 'data-presentation'] });
window.addEventListener('sharing-state-changed', scheduleScreenGlowBounds);
window.addEventListener('studio-view-changed', scheduleScreenGlowBounds);
window.addEventListener('resize', updateScreenGlowBounds);
window.addEventListener('scroll', updateScreenGlowBounds, { passive: true });
window.addEventListener('studio-joined', () => {
  closeEffects();
  syncAppearanceControls();
  updateScreenGlow();
  for (const id of ['lowLightTip', 'faceGuide', 'framingGrid', 'cameraEffectsStatus']) $(id).classList.add('hidden');
});
window.addEventListener('studio-left', updateScreenGlowBounds);

$('btnBackgroundEffects').onclick = () => {
  if (effectsPanel.classList.contains('hidden')) openEffects();
  else closeEffects();
};
$('btnCloseEffects').onclick = () => { closeEffects(); $('btnBackgroundEffects').focus(); };
$('btnImproveLighting').onclick = () => openEffects(true);
$('backgroundTab').onclick = () => selectEffectsTab(false);
$('appearanceTab').onclick = () => selectEffectsTab(true);
for (const tab of [$('backgroundTab'), $('appearanceTab')]) {
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const appearance = event.key === 'End' || (event.key !== 'Home' && tab.id === 'backgroundTab');
    selectEffectsTab(appearance);
    $(appearance ? 'appearanceTab' : 'backgroundTab').focus();
  };
}
for (const button of document.querySelectorAll('[data-blur], [data-color]')) {
  button.onclick = () => {
    if (!cameraEffects) return;
    const current = cameraEffects.options.background;
    const value = button.dataset.blur ?? button.dataset.color;
    const clearingCurrent = button.dataset.blur ? ['slight', 'full'].includes(current) : current.startsWith('#');
    if (value !== 'none' || clearingCurrent) cameraEffects.setOptions({ background: value });
    syncAppearanceControls();
  };
}
for (const id of ['touchUp', 'studioLighting']) {
  $(id).onchange = () => {
    cameraEffects?.setOptions({ [id]: $(id).checked });
    syncAppearanceControls();
  };
}
$('touchStrength').onchange = () => cameraEffects?.setOptions({ touchStrength: Number($('touchStrength').value) });
$('studioLevel').oninput = () => cameraEffects?.setOptions({ studioLevel: Number($('studioLevel').value) / 100 });
for (const id of ['screenGlow', 'glowBrightness', 'glowWarmth']) $(id).oninput = updateScreenGlow;
window.addEventListener('close-camera-effects', () => {
  closeEffects();
  requestAnimationFrame(updateScreenGlowBounds);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || effectsPanel.classList.contains('hidden')) return;
  event.preventDefault();
  closeEffects();
  $('btnBackgroundEffects').focus();
});
window.addEventListener('camera-effects-state', ({ detail }) => {
  syncAppearanceControls();
  const now = performance.now();
  const face = S.camOn && detail.centered ? detail.face : null;
  const studio = cameraEffects?.options.studioLighting ? cameraEffects.studio : 1;
  const brightness = face ? Math.min(255, face.brightness * studio) : 0;
  if (!face) {
    lowLightSince = lightRecoveredSince = 0;
    isLowLight = false;
  } else if (brightness < 95) {
    lightRecoveredSince = 0;
    if (!lowLightSince) lowLightSince = now;
    if (now - lowLightSince > 1500) isLowLight = true;
  } else if (brightness > 112) {
    lowLightSince = 0;
    if (!lightRecoveredSince) lightRecoveredSince = now;
    if (now - lightRecoveredSince > 2000) isLowLight = false;
  } else {
    lowLightSince = lightRecoveredSince = 0;
  }
  const setupVisible = !$('view-record').classList.contains('hidden');
  $('lowLightTip').classList.toggle('hidden', !face || !isLowLight || !setupVisible || $('screenGlow').checked);
});
syncAppearanceControls();
