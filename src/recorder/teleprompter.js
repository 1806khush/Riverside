'use strict';

(() => {
  const dock = document.getElementById('teleprompterDock');
  const previews = document.querySelector('.studio-main .previews');
  const toggle = document.getElementById('btnTeleprompter');
  const storageKey = 'cpe-teleprompter';
  const icon = paths => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const playIcon = icon('<path d="m8 4 12 8-12 8V4Z"/>');
  const pauseIcon = icon('<path d="M8 5v14M16 5v14"/>');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch {}
  const state = {
    script: typeof saved.script === 'string' ? saved.script : '',
    fontSize: Number.isFinite(saved.fontSize) ? Math.max(24, Math.min(80, saved.fontSize)) : 44,
    speed: Number.isFinite(saved.speed) ? Math.max(.25, Math.min(2, saved.speed)) : 1,
    bold: saved.bold === true, italic: saved.italic === true, underline: saved.underline === true,
    flipX: saved.flipX === true, flipY: saved.flipY === true, autoStart: saved.autoStart === true
  };
  let isOpen = false, playing = false, mode = 'in', popup = null, openingPopup = false;
  let frame = null, frameWindow = window, lastTime = null, position = 0, idleTimer;
  let storageWarning = false;
  const panel = document.createElement('section');
  panel.id = 'teleprompterPanel';
  panel.className = 'teleprompter-panel hidden';
  panel.setAttribute('aria-label', 'Teleprompter');
  panel.innerHTML = `<div class="teleprompter-header">
    <span class="teleprompter-title">Teleprompter</span>
    <div class="teleprompter-header-actions"><select aria-label="Teleprompter view"><option value="in">Popped in</option><option value="out">Popped out</option><option value="overlay">Overlay</option></select><button type="button" data-action="close" aria-label="Close teleprompter">×</button></div>
  </div>
  <div class="teleprompter-reading-area">
    <svg class="teleprompter-reading-marker" aria-hidden="true" viewBox="0 0 12 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m2 2 8 6-8 6V2Z"/></svg>
    <div class="teleprompter-viewport" tabindex="-1"><div class="teleprompter-script-wrap"><div class="teleprompter-editor" contenteditable="plaintext-only" role="textbox" aria-label="Teleprompter script" aria-multiline="true" spellcheck="true" data-placeholder="Write or paste your script&#10;Use [ ] for notes and cues"></div></div></div>
  </div>
  <div class="teleprompter-footer">
    <div class="teleprompter-format"><button type="button" data-action="smaller" aria-label="Decrease script text size" title="Smaller text">A⁻</button><button type="button" data-action="larger" aria-label="Increase script text size" title="Larger text">A⁺</button><button type="button" data-action="bold" aria-label="Bold script" aria-pressed="false">B</button><button type="button" data-action="italic" aria-label="Italic script" aria-pressed="false">I</button><button type="button" data-action="underline" aria-label="Underline script" aria-pressed="false">U</button></div>
    <div class="teleprompter-playback"><button type="button" data-action="play" aria-label="Play teleprompter" title="Play / pause (Space)">${playIcon}</button><button type="button" data-action="restart" aria-label="Restart script" title="Restart">${icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>')}</button></div>
    <div class="teleprompter-speed"><label title="Scroll speed">${icon('<path d="M4 18a9 9 0 1 1 16 0M12 13l5-6"/>')}<input type="range" min="0.25" max="2" step="0.05" aria-label="Teleprompter scroll speed"></label><output aria-label="Current scroll speed"></output><button type="button" data-action="settings" aria-label="Teleprompter settings" aria-expanded="false">${icon('<path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 1 2 4h4l2-3 4-1v-4l2-3-3-2-1-4-4 1-3-1Z"/><circle cx="12" cy="12" r="3"/>')}</button></div>
  </div>
  <div class="teleprompter-settings" hidden><label>Flip horizontal<input type="checkbox" data-setting="flipX"></label><label>Flip vertical<input type="checkbox" data-setting="flipY"></label><label>Start when recording starts<input type="checkbox" data-setting="autoStart"></label></div>
  <div class="teleprompter-progress" role="progressbar" aria-label="Script reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>`;
  dock.append(panel);
  const editor = panel.querySelector('.teleprompter-editor');
  const viewport = panel.querySelector('.teleprompter-viewport');
  const select = panel.querySelector('select');
  const speed = panel.querySelector('input[type="range"]');
  const progress = panel.querySelector('.teleprompter-progress');
  const settings = panel.querySelector('.teleprompter-settings');
  const button = name => panel.querySelector(`[data-action="${name}"]`);
  editor.textContent = state.script;

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch {
      if (!storageWarning) { toast('Your script could not be saved locally. Copy it before closing the app.', true); storageWarning = true; }
    }
  }
  function updateAppearance() {
    panel.style.setProperty('--prompt-font-size', `${state.fontSize}px`);
    panel.style.setProperty('--prompt-flip-x', state.flipX ? '-1' : '1');
    panel.style.setProperty('--prompt-flip-y', state.flipY ? '-1' : '1');
    editor.style.fontWeight = state.bold ? '650' : '400';
    editor.style.fontStyle = state.italic ? 'italic' : 'normal';
    editor.style.textDecoration = state.underline ? 'underline' : 'none';
    for (const name of ['bold', 'italic', 'underline']) button(name).setAttribute('aria-pressed', String(state[name]));
    for (const input of settings.querySelectorAll('input')) input.checked = state[input.dataset.setting];
    button('smaller').disabled = state.fontSize <= 24;
    button('larger').disabled = state.fontSize >= 80;
    speed.value = state.speed;
    panel.querySelector('output').textContent = `${Number(state.speed.toFixed(2))}×`;
    button('play').disabled = !state.script.trim();
    updateProgress();
  }
  function updateProgress() {
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const percent = max ? Math.min(100, Math.max(0, viewport.scrollTop / max * 100)) : 0;
    progress.firstElementChild.style.width = `${percent}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  function revealControls() {
    panel.classList.remove('controls-hidden');
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(() => {
      if (settings.hidden && !editor.matches(':focus') && !select.matches(':focus')) panel.classList.add('controls-hidden');
    }, 1600);
  }
  function cancelFrame() {
    if (frame !== null) frameWindow.cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
  }
  function tick(time) {
    if (!playing || !isOpen) return;
    if (lastTime !== null) position += Math.min((time - lastTime) / 1000, .06) * 28 * state.speed;
    lastTime = time;
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.min(position, max);
    updateProgress();
    if (position >= max) { setPlaying(false); return; }
    frame = frameWindow.requestAnimationFrame(tick);
  }
  function setPlaying(next) {
    cancelFrame();
    playing = Boolean(next && isOpen && state.script.trim());
    editor.contentEditable = playing ? 'false' : 'plaintext-only';
    button('play').innerHTML = playing ? pauseIcon : playIcon;
    button('play').setAttribute('aria-label', playing ? 'Pause teleprompter' : 'Play teleprompter');
    panel.classList.toggle('is-playing', playing);
    if (playing) {
      const max = viewport.scrollHeight - viewport.clientHeight;
      if (viewport.scrollTop >= max - 1) viewport.scrollTop = 0;
      position = viewport.scrollTop;
      frameWindow = panel.ownerDocument.defaultView;
      frame = frameWindow.requestAnimationFrame(tick);
    }
    revealControls();
  }
  function mount(next, container) {
    const offset = viewport.scrollTop;
    cancelFrame();
    container.append(panel);
    mode = next;
    panel.dataset.mode = mode;
    select.value = mode;
    panel.classList.toggle('hidden', !isOpen);
    dock.classList.toggle('hidden', !isOpen || mode !== 'in');
    viewport.scrollTop = offset;
    position = viewport.scrollTop;
    frameWindow = panel.ownerDocument.defaultView;
    if (playing) frame = frameWindow.requestAnimationFrame(tick);
    updateProgress();
  }
  function returnFromPopup(next = 'in') {
    const old = popup;
    popup = null;
    mount(next, next === 'overlay' ? previews : dock);
    if (old && !old.closed) old.close();
  }
  async function setMode(next) {
    if (openingPopup) return;
    if (next !== 'out') { returnFromPopup(next); return; }
    if (popup && !popup.closed) { popup.focus(); return; }
    // Open synchronously in the user's click handler so browser popup rules allow it.
    const child = window.open('/teleprompter.html', 'cpe-teleprompter', 'popup,width=900,height=520');
    if (!child) { select.value = mode; toast('Allow the teleprompter window to open, then choose Popped out again.', true); return; }
    openingPopup = true;
    select.disabled = true;
    popup = child;
    let timer, poll;
    try {
      await new Promise((resolve, reject) => {
        const check = () => {
          if (child.closed) return reject(new Error('The teleprompter window was closed.'));
          try { if (child.location.pathname === '/teleprompter.html' && child.document.readyState === 'complete') resolve(); } catch {}
        };
        poll = setInterval(check, 40);
        timer = setTimeout(() => reject(new Error('The teleprompter window could not load.')), 8000);
        check();
      });
      if (!isOpen || popup !== child) return;
      child.addEventListener('beforeunload', () => {
        if (popup !== child) return;
        setPlaying(false);
        popup = null;
        mount('in', dock);
      });
      mount('out', child.document.body);
      child.focus();
    } catch (error) {
      if (popup === child) returnFromPopup('in');
      toast(error.message, true);
    } finally {
      clearTimeout(timer); clearInterval(poll);
      openingPopup = false;
      select.disabled = false;
    }
  }
  function close() {
    setPlaying(false);
    isOpen = false;
    returnFromPopup('in');
    settings.hidden = true;
    button('settings').setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-pressed', 'false');
  }
  function open() {
    isOpen = true;
    toggle.setAttribute('aria-pressed', 'true');
    mount(mode === 'overlay' ? 'overlay' : 'in', mode === 'overlay' ? previews : dock);
    editor.focus({ preventScroll: true });
  }

  toggle.addEventListener('click', () => { if (isOpen) close(); else open(); });
  select.addEventListener('change', () => setMode(select.value));
  button('close').addEventListener('click', () => { close(); toggle.focus(); });
  button('play').addEventListener('click', () => setPlaying(!playing));
  button('restart').addEventListener('click', () => { viewport.scrollTop = position = 0; lastTime = null; updateProgress(); revealControls(); });
  button('smaller').addEventListener('click', () => { state.fontSize = Math.max(24, state.fontSize - 4); updateAppearance(); persist(); });
  button('larger').addEventListener('click', () => { state.fontSize = Math.min(80, state.fontSize + 4); updateAppearance(); persist(); });
  for (const name of ['bold', 'italic', 'underline']) button(name).addEventListener('click', () => { state[name] = !state[name]; updateAppearance(); persist(); });
  button('settings').addEventListener('click', () => {
    settings.hidden = !settings.hidden;
    button('settings').setAttribute('aria-expanded', String(!settings.hidden));
    revealControls();
  });
  settings.addEventListener('change', event => { if (event.target.dataset.setting) { state[event.target.dataset.setting] = event.target.checked; updateAppearance(); persist(); } });
  speed.addEventListener('input', () => { state.speed = Number(speed.value); updateAppearance(); persist(); revealControls(); });
  editor.addEventListener('input', () => {
    // innerText retains line breaks created by contenteditable. Save plain text only.
    state.script = editor.innerText.replace(/\r/g, '');
    if (!state.script.trim()) editor.textContent = state.script = '';
    updateAppearance(); persist();
  });
  editor.addEventListener('focus', revealControls);
  editor.addEventListener('blur', revealControls);
  viewport.addEventListener('scroll', () => { if (Math.abs(viewport.scrollTop - position) > 2) position = viewport.scrollTop; updateProgress(); });
  panel.addEventListener('pointermove', revealControls);
  panel.addEventListener('focusin', revealControls);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); settings.hidden = true; button('settings').setAttribute('aria-expanded', 'false'); revealControls(); button('play').focus(); return; }
    if (event.target.isContentEditable || event.target.matches('input, select')) return;
    if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); state.speed = Math.max(.25, Math.min(2, state.speed + (event.key === 'ArrowRight' ? .05 : -.05))); updateAppearance(); persist(); revealControls();
    }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); viewport.scrollTop += (event.key === 'ArrowDown' ? 1 : -1) * state.fontSize * 1.5; position = viewport.scrollTop; updateProgress(); }
  });
  window.addEventListener('studio-view-changed', event => { if (event.detail !== 'studio') close(); });
  window.addEventListener('studio-left', close);
  window.addEventListener('recording-started', () => { if (isOpen && state.autoStart) setPlaying(true); });
  window.addEventListener('recording-stopped', () => setPlaying(false));
  window.addEventListener('pagehide', () => { if (popup && !popup.closed) popup.close(); });
  new ResizeObserver(updateProgress).observe(viewport);
  updateAppearance();
})();
