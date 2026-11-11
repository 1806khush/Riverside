'use strict';
(() => {
  const { S, recElapsed, canShare, shareScreen, attachSharedStream, updateControls, toast } = window.CPE;
  const $ = id => document.getElementById(id);
  const menu = $('shareMenu'), dialog = $('presentationDialog'), fileInput = $('presentationFile');
  const controls = $('presentationControls'), status = $('presentationStatus');
  const deckPanel = $('presentationDeck'), thumbnails = $('presentationThumbnails');
  let current = null, importing = false, loadingPage = false;

  function showMenu(open, focus = false) {
    menu.classList.toggle('hidden', !open);
    $('btnScreen').setAttribute('aria-expanded', String(open));
    if (open && focus) $('shareDisplay').focus();
  }
  $('btnScreen').onclick = () => { if (canShare()) showMenu(menu.classList.contains('hidden'), true); };
  $('shareDisplay').onclick = () => { showMenu(false); shareScreen(); };
  $('sharePresentation').onclick = () => {
    showMenu(false);
    if (!canShare()) return;
    status.textContent = '';
    status.classList.remove('error'); fileInput.value = '';
    dialog.showModal(); $('choosePresentation').focus();
  };
  $('closePresentation').onclick = () => { if (!importing) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (importing) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!$('btnScreen').classList.contains('hidden')) $('btnScreen').focus(); });
  $('choosePresentation').onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) upload(fileInput.files[0]); };
  const zone = $('choosePresentation');
  zone.addEventListener('dragover', event => { event.preventDefault(); if (!importing) zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => {
    event.preventDefault(); zone.classList.remove('dragging');
    if (!importing && event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]);
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.share-control')) showMenu(false);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { showMenu(false); $('btnScreen').focus(); event.preventDefault(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('button')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + 1) % 2].focus();
    }
    if (event.key === 'Tab') showMenu(false);
  });
  window.addEventListener('studio-view-changed', () => showMenu(false));

  async function responseData(response) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The presentation could not be opened.');
    return data;
  }
  const remove = id => fetch(`/api/presentations/${id}/remove`, { method: 'POST' }).catch(() => {});

  async function loadImage(deck, page) {
    if (deck.images.has(page)) return deck.images.get(page);
    const response = await fetch(`/api/presentations/${deck.id}/pages/${page}.png`);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'This slide could not be opened.');
    }
    const image = await createImageBitmap(await response.blob());
    deck.images.set(page, image);
    // Keep at most four decoded pages, regardless of presentation length.
    if (deck.images.size > 4) {
      const oldest = [...deck.images.keys()].find(number => number !== deck.page && number !== page);
      if (oldest !== undefined) { deck.images.get(oldest).close(); deck.images.delete(oldest); }
    }
    return image;
  }

  function paint(deck) {
    const image = deck.images.get(deck.page);
    if (!image) return;
    const { canvas, context } = deck;
    context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
    const width = image.width * scale, height = image.height * scale;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    if (deck.stream) submitFrame(deck);
  }

  async function submitFrame(deck) {
    if (deck.disposed || deck.writing || !deck.stream) return;
    if (!deck.writer) { deck.stream.getVideoTracks()[0]?.requestFrame?.(); return; }
    deck.writing = true;
    let frame;
    try {
      // Timestamp and deliver every frame directly, including otherwise-static slide holds.
      // This does not depend on a detached canvas being repainted by the browser compositor.
      frame = new VideoFrame(deck.canvas, { timestamp: Math.round(performance.now() * 1000), duration: 33333 });
      await deck.writer.write(frame);
    } catch (error) {
      if (!deck.disposed) {
        toast('The slides video stopped: ' + error.message, true);
        deck.stream.getVideoTracks()[0]?.dispatchEvent(new Event('ended'));
      }
    } finally { frame?.close(); deck.writing = false; }
  }

  function startSlideStream(deck) {
    if (window.MediaStreamTrackGenerator && window.VideoFrame) {
      const track = new MediaStreamTrackGenerator({ kind: 'video' });
      deck.writer = track.writable.getWriter();
      deck.stream = new MediaStream([track]);
    } else {
      deck.stream = deck.canvas.captureStream(30);
    }
    submitFrame(deck);
    deck.timer = setInterval(() => deck.writer ? submitFrame(deck) : paint(deck), 1000 / 30);
  }

  function buildThumbnails(deck) {
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= deck.pages; page++) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'slide-thumbnail'; button.dataset.page = page;
      button.setAttribute('aria-label', 'Slide ' + page + ' of ' + deck.pages);
      const number = document.createElement('span'); number.className = 'slide-number'; number.textContent = page;
      const image = document.createElement('img'); image.alt = ''; image.width = 128; image.height = 72;
      image.dataset.src = `/api/presentations/${deck.id}/pages/${page}.png?thumbnail=1`;
      image.decoding = 'async'; image.fetchPriority = 'low';
      image.onerror = () => image.classList.add('thumbnail-unavailable');
      button.append(number, image); button.onclick = () => goTo(page); fragment.append(button);
    }
    thumbnails.replaceChildren(fragment);
    deck.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target.querySelector('img'); image.src = image.dataset.src;
        deck.observer.unobserve(entry.target);
      }
    }, { root: thumbnails, rootMargin: '0px 160px' });
    for (const button of thumbnails.children) deck.observer.observe(button);
  }

  function rememberPage(deck, initial = false) {
    if (!S.recording || S.paused || !S.session || current !== deck) return;
    S.session.presentation = { name: deck.name, pages: deck.pages, source: deck.format || 'pdf' };
    S.session.events.push({ kind: 'slide', page: deck.page, t: initial ? 0 : Math.round(recElapsed()) });
  }

  async function upload(file) {
    if (importing || !canShare()) return;
    if (!/\.pdf$/i.test(file.name)) return feedback('Choose a PDF file. Export your PowerPoint as a PDF first.', true);
    if (!file.size || file.size > 100 * 1024 * 1024) return feedback('Choose a non-empty file smaller than 100 MB.', true);
    importing = true; S.choosingScreen = true;
    const session = S.recording ? S.session : null;
    $('choosePresentation').disabled = $('closePresentation').disabled = true;
    feedback('Preparing ' + file.name + '…'); updateControls();
    let deck;
    try {
      const metadata = await responseData(await fetch('/api/presentations', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file, signal: AbortSignal.timeout(240000)
      }));
      deck = { ...metadata, page: 1, images: new Map(), canvas: document.createElement('canvas') };
      deck.canvas.width = 1920; deck.canvas.height = 1080;
      deck.canvas.className = 'presentation-canvas';
      deck.canvas.setAttribute('aria-label', 'Current presentation slide');
      deck.context = deck.canvas.getContext('2d', { alpha: false });
      await loadImage(deck, 1); paint(deck);
      $('screenPreview').parentElement.append(deck.canvas);
      $('view-studio').dataset.presentation = 'document';
      startSlideStream(deck);
      S.presentation = deck;
      attachSharedStream(deck.stream, session);
      current = deck;
      rememberPage(deck);
      $('presentationName').textContent = deck.name; $('presentationName').title = deck.name;
      $('slidePage').replaceChildren(...Array.from({ length: deck.pages }, (_, index) => {
        const option = document.createElement('option'); option.value = index + 1; option.textContent = index + 1; return option;
      }));
      $('slideTotal').textContent = '/ ' + deck.pages;
      buildThumbnails(deck); deckPanel.classList.remove('hidden');
      controls.classList.remove('hidden');
      dialog.close(); toast('Your slides are ready to record.');
    } catch (error) {
      if (deck) dispose(deck);
      S.presentation = null;
      feedback(error.name === 'TimeoutError' ? 'Opening this presentation took too long. Try a smaller, unlocked file.' : error.message, true);
    } finally {
      importing = false; S.choosingScreen = false;
      $('choosePresentation').disabled = $('closePresentation').disabled = false;
      fileInput.value = ''; updateControls();
    }
  }
  function feedback(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }

  function syncControls() {
    if (!canShare()) showMenu(false);
    if (!current) return;
    const busy = loadingPage || S.countingDown || S.starting || S.saving || S.paused;
    $('slidePrevious').disabled = busy || current.page <= 1;
    $('slideNext').disabled = busy || current.page >= current.pages;
    $('slidePage').disabled = busy;
    $('slidePage').value = current.page;
    for (const button of thumbnails.children) {
      const selected = Number(button.dataset.page) === current.page;
      button.classList.toggle('selected', selected); button.disabled = busy;
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    controls.setAttribute('aria-busy', String(loadingPage));
  }
  async function goTo(page) {
    const deck = current;
    if (!deck || loadingPage || S.countingDown || S.starting || S.saving || S.paused || !Number.isInteger(page) || page < 1 || page > deck.pages || page === deck.page) return;
    loadingPage = true; syncControls();
    try {
      const image = await loadImage(deck, page);
      if (current !== deck) { image.close(); return; }
      deck.page = page; paint(deck); rememberPage(deck);
      thumbnails.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch (error) { if (current === deck) toast(error.message, true); }
    finally { loadingPage = false; syncControls(); }
  }
  $('slidePrevious').onclick = () => goTo(current?.page - 1);
  $('slideNext').onclick = () => goTo(current?.page + 1);
  $('slidePage').onchange = () => goTo(Number($('slidePage').value));
  controls.addEventListener('keydown', event => {
    if (event.target.tagName === 'SELECT') return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); goTo(current?.page + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  function dispose(deck) {
    deck.disposed = true; deck.observer?.disconnect();
    clearInterval(deck.timer);
    if (deck.writer) deck.writer.abort().catch(() => {}).finally(() => deck.writer.releaseLock());
    deck.stream?.getTracks().forEach(track => track.stop());
    deck.canvas.remove();
    delete $('view-studio').dataset.presentation;
    for (const image of deck.images.values()) image.close();
    deck.images.clear(); remove(deck.id);
  }
  window.addEventListener('shared-stream-ended', event => {
    if (!current || current.stream !== event.detail) return;
    dispose(current); current = null; S.presentation = null; controls.classList.add('hidden');
    deckPanel.classList.add('hidden'); thumbnails.replaceChildren();
    $('presentationName').textContent = ''; $('slidePage').replaceChildren();
  });
  window.addEventListener('sharing-state-changed', syncControls);
  window.addEventListener('recording-started', () => { if (current) { submitFrame(current); rememberPage(current, true); } });
  syncControls();
})();
