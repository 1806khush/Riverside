'use strict';

export class CameraEffects {
  constructor(onState) {
    this.onState = onState;
    this.enabled = false;
    this.worker = null;
    this.failed = false;
    this.options = { background: 'none', touchUp: false, touchStrength: 0.28, studioLighting: false, studioLevel: 1 };
    this.sample = new OffscreenCanvas(512, 288);
    this.sampleContext = this.sample.getContext('2d');
    this.scene = new OffscreenCanvas(1, 1);
    this.foreground = new OffscreenCanvas(1, 1);
    this.faceMask = new OffscreenCanvas(1, 1);
    this.detail = new OffscreenCanvas(1, 1);
    this.resetTracking();
  }

  get processing() {
    const o = this.options;
    return o.background !== 'none' || o.touchUp || o.studioLighting;
  }

  resetTracking() {
    this.epoch = (this.epoch || 0) + 1;
    this.face = null;
    this.lastSeen = this.lastSample = this.lastFrame = this.maskAt = 0;
    this.mask?.close();
    this.mask = null;
    this.studio = 1;
    this.framing = { centered: false, message: 'Looking for your face…' };
  }

  assessFraming(face) {
    if (!face) return { centered: false, message: 'Looking for your face…' };
    // Use the unmodified camera coordinates, with directions matching the mirror view.
    const x = 1 - (face.left + face.width / 2);
    const y = face.top + face.height / 2;
    const tolerance = this.framing.centered ? 1.2 : 1;
    let message = '';
    if (Math.abs(x - 0.5) > 0.075 * tolerance) message = x < 0.5 ? 'Move a little to your right.' : 'Move a little to your left.';
    else if (face.height > 0.62 || face.top < 0.02) message = 'Move a little farther from the camera.';
    else if (face.height < 0.22 / tolerance) message = 'Move a little closer to the camera.';
    else if (Math.abs(y - 0.4) > 0.10 * tolerance) message = y < 0.4 ? 'Move a little lower in the frame.' : 'Move a little higher in the frame.';
    return { centered: !message, message: message ? 'You’re a bit out of frame. ' + message : 'Your framing looks good.' };
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.startMonitoring();
    const face = performance.now() - this.lastSeen < 800 ? this.face : null;
    this.onState(this.ready ? (face ? 'tracking' : 'searching') : 'loading', face);
  }

  setOptions(options) {
    Object.assign(this.options, options);
    if (options.background === 'none') {
      this.mask?.close();
      this.mask = null;
    }
    this.startMonitoring();
  }

  startMonitoring() {
    if (this.worker) return;
    const worker = new Worker('/camera-effects-worker.js');
    this.worker = worker;
    this.ready = false;
    this.busy = false;
    this.failed = false;
    const fail = () => {
      if (this.worker !== worker) return;
      clearTimeout(this.loadTimer);
      worker.terminate();
      this.worker = null;
      this.ready = false;
      this.enabled = false;
      // A tracking failure must not discard the presenter's appearance choices.
      this.failed = true;
      this.resetTracking();
      this.onState('error');
    };
    this.loadTimer = setTimeout(fail, 30000);
    worker.onerror = fail;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) { data.mask?.close(); return; }
      if (data.type === 'error') { fail(); return; }
      if (data.type === 'ready') {
        clearTimeout(this.loadTimer);
        this.ready = true;
        this.onState('searching');
        return;
      }
      this.busy = false;
      if (data.epoch !== this.epoch) { data.mask?.close(); return; }
      this.face = data.face;
      this.framing = this.assessFraming(data.face);
      if (data.face) this.lastSeen = performance.now();
      if (data.mask) {
        this.mask?.close();
        if (this.options.background === 'none') { data.mask.close(); this.mask = null; }
        else { this.mask = data.mask; this.maskAt = performance.now(); }
      }
      if (data.backgroundError) {
        this.options.background = 'none';
        this.mask?.close(); this.mask = null;
        this.onState('background-error');
      }
      this.onState(data.face ? 'tracking' : 'searching', data.face);
    };
    worker.postMessage({ type: 'init' });
  }

  observe(frame) {
    const now = performance.now();
    const interval = this.options.background === 'none' ? 150 : 50;
    if (!this.ready || this.busy || now - this.lastSample < interval) return;
    // Preserve the aspect ratio for external cameras and portrait inputs as well.
    const ratio = 512 / Math.max(frame.displayWidth, frame.displayHeight);
    const width = Math.max(1, Math.round(frame.displayWidth * ratio));
    const height = Math.max(1, Math.round(frame.displayHeight * ratio));
    if (this.sample.width !== width || this.sample.height !== height) {
      this.sample.width = width; this.sample.height = height;
    }
    this.sampleContext.drawImage(frame, 0, 0, width, height);
    const bitmap = this.sample.transferToImageBitmap();
    this.busy = true;
    this.lastSample = now;
    this.worker.postMessage({ bitmap, timestamp: now, epoch: this.epoch, background: this.options.background !== 'none' }, [bitmap]);
  }

  drawFaceMask(face, width, height) {
    const context = this.faceMask.getContext('2d');
    context.clearRect(0, 0, width, height);
    const path = points => {
      context.beginPath();
      points.forEach((point, index) => {
        if (index) context.lineTo(point.x * width, point.y * height);
        else context.moveTo(point.x * width, point.y * height);
      });
      context.closePath();
      context.fill();
    };
    context.fillStyle = '#fff';
    context.filter = `blur(${Math.max(2, height / 180)}px)`;
    path(face.outline);
    context.globalCompositeOperation = 'destination-out';
    for (const feature of face.features) path(feature);
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
  }

  draw(frame, context, width, height) {
    const now = performance.now();
    const face = now - this.lastSeen < 800 ? this.face : null;
    const o = this.options;
    const elapsed = this.lastFrame ? Math.min(100, now - this.lastFrame) : 33;
    this.lastFrame = now;
    const target = o.studioLighting ? o.studioLevel : 1;
    this.studio += (target - this.studio) * (1 - Math.exp(-elapsed / 350));
    for (const layer of [this.scene, this.foreground, this.faceMask, this.detail]) {
      if (layer.width !== width || layer.height !== height) { layer.width = width; layer.height = height; }
    }
    // Always retain the original camera view. The framing button is guidance only.
    const scene = this.scene.getContext('2d');
    scene.filter = `brightness(${this.studio})`;
    scene.drawImage(frame, 0, 0, width, height);
    scene.filter = 'none';
    const hasMask = o.background !== 'none' && this.mask && now - this.maskAt < 1000;
    context.clearRect(0, 0, width, height);
    if (hasMask) {
      if (o.background.startsWith('#')) {
        // Keep the chosen background color independent of the camera exposure.
        context.fillStyle = o.background;
        context.fillRect(0, 0, width, height);
      } else {
        const radius = (o.background === 'full' ? 22 : 6) * height / 720;
        context.filter = `blur(${radius}px)`;
        context.drawImage(this.scene, -radius * 2, -radius * 2, width + radius * 4, height + radius * 4);
        context.filter = 'none';
      }
      const foreground = this.foreground.getContext('2d');
      foreground.clearRect(0, 0, width, height);
      foreground.drawImage(this.scene, 0, 0);
      foreground.globalCompositeOperation = 'destination-in';
      foreground.drawImage(this.mask, 0, 0, width, height);
      foreground.globalCompositeOperation = 'source-over';
      context.drawImage(this.foreground, 0, 0);
    } else context.drawImage(this.scene, 0, 0);
    if (face && o.touchUp) {
      this.drawFaceMask(face, width, height);
      const detail = this.detail.getContext('2d');
      detail.clearRect(0, 0, width, height);
      detail.filter = `blur(${Math.max(1, height / 360)}px)`;
      detail.drawImage(context.canvas, 0, 0);
      detail.filter = 'none';
      detail.globalCompositeOperation = 'destination-in';
      detail.drawImage(this.faceMask, 0, 0);
      detail.globalCompositeOperation = 'source-over';
      context.globalAlpha = o.touchStrength;
      context.drawImage(this.detail, 0, 0);
      context.globalAlpha = 1;
    }
  }
}
