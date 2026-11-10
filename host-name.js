'use strict';

// This label is DOM-only. It is never drawn into the captured camera stream.
(() => {
  const label = document.getElementById('cameraLabel');
  const originalInput = document.getElementById('hostName');
  const sizes = { small: 14, medium: 18, large: 24 };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('cpe-host-appearance') || '{}') || {}; } catch {}
  const state = {
    name: typeof saved.name === 'string' ? saved.name.slice(0, 100) : '',
    size: Object.hasOwn(sizes, saved.size) ? saved.size : 'medium',
    color: /^#[0-9a-f]{6}$/i.test(saved.color || '') ? saved.color : '#ffffff'
  };
  const panel = document.createElement('section');
  panel.id = 'hostAppearancePanel';
  panel.className = 'host-appearance-panel hidden';
  panel.setAttribute('aria-label', 'Host name appearance');
  panel.innerHTML = `<div class="name-panel-heading"><strong>Host name</strong><button type="button" data-close aria-label="Close name settings">×</button></div>
    <label>Name<input id="hostDisplayName" maxlength="100" placeholder="Your name" autocomplete="name"></label>
    <fieldset><legend>Text size</legend><div class="name-size-options">
      <button type="button" data-size="small">Small</button><button type="button" data-size="medium">Medium</button><button type="button" data-size="large">Large</button>
    </div></fieldset>
    <label class="name-color-label">Text color<input id="hostTextColor" type="color" aria-label="Host name text color"></label>
    <p>Shown in your camera preview.</p>`;
  document.body.append(panel);
  const nameInput = panel.querySelector('#hostDisplayName');
  const colorInput = panel.querySelector('#hostTextColor');
  originalInput.maxLength = 100;

  function update() {
    const name = state.name.trim() || 'Host';
    label.textContent = name;
    label.style.setProperty('--host-name-size', `${sizes[state.size]}px`);
    label.style.color = state.color;
    originalInput.value = state.name;
    nameInput.value = state.name;
    colorInput.value = state.color;
    document.getElementById('studioHostName').textContent = name;
    document.getElementById('hostInitial').textContent = Array.from(name)[0].toUpperCase();
    panel.querySelectorAll('[data-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.size === state.size)));
    try { localStorage.setItem('cpe-host-appearance', JSON.stringify(state)); } catch {}
  }
  function close(focus = false) {
    panel.classList.add('hidden');
    label.setAttribute('aria-expanded', 'false');
    if (focus) label.focus();
  }
  function position() {
    if (panel.classList.contains('hidden')) return;
    const box = label.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(innerWidth - bounds.width - 12, box.left))}px`;
    panel.style.top = `${Math.max(12, Math.min(innerHeight - bounds.height - 12, box.top - bounds.height - 10))}px`;
  }
  label.addEventListener('click', () => {
    const open = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    label.setAttribute('aria-expanded', String(open));
    if (open) { position(); nameInput.focus(); } else label.focus();
  });
  [originalInput, nameInput].forEach(input => input.addEventListener('input', () => { state.name = input.value.slice(0, 100); update(); }));
  colorInput.addEventListener('input', () => { state.color = colorInput.value; update(); });
  panel.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => { state.size = button.dataset.size; update(); }));
  panel.querySelector('[data-close]').addEventListener('click', () => close(true));
  document.addEventListener('pointerdown', event => { if (!panel.contains(event.target) && !label.contains(event.target)) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.classList.contains('hidden')) { event.stopPropagation(); close(true); } }, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.addEventListener('studio-view-changed', () => close());
  update();
})();
