'use strict';

let landmarker, segmenter, vision, files;
const sample = new OffscreenCanvas(320, 180);
const context = sample.getContext('2d', { willReadFrequently: true });
const maskCanvas = new OffscreenCanvas(1, 1);
const maskContext = maskCanvas.getContext('2d');
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const FEATURES = [
  [33,160,158,133,153,144], [362,385,387,263,373,380],
  [61,40,37,0,267,270,291,321,314,17,84,91],
  [70,63,105,66,107,55,65,52,53,46], [336,296,334,293,300,276,283,282,295,285]
];

function detectFace(bitmap, timestamp) {
  const points = landmarker.detectForVideo(bitmap, timestamp).faceLandmarks[0];
  if (!points) return null;
  const left = Math.max(0, Math.min(...points.map(point => point.x)));
  const right = Math.min(1, Math.max(...points.map(point => point.x)));
  const top = Math.max(0, Math.min(...points.map(point => point.y)));
  const bottom = Math.min(1, Math.max(...points.map(point => point.y)));
  const width = right - left, height = bottom - top;
  if (width < 0.05 || height < 0.08) return null;
  context.drawImage(bitmap, 0, 0, sample.width, sample.height);
  const x = Math.floor((left + width * 0.2) * sample.width);
  const y = Math.floor((top + height * 0.3) * sample.height);
  const w = Math.max(1, Math.floor(width * 0.6 * sample.width));
  const h = Math.max(1, Math.floor(height * 0.45 * sample.height));
  const pixels = context.getImageData(x, y, w, h).data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    histogram[Math.round(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722)]++;
  }
  let count = 0, brightness = 0;
  while (brightness < 255 && count < pixels.length / 8) count += histogram[brightness++];
  const polygon = indices => indices.map(index => ({ x: points[index].x, y: points[index].y }));
  return { left, top, width, height, brightness, outline: polygon(FACE_OVAL), features: FEATURES.map(polygon) };
}

// Keep the presenter's connected silhouette and reject isolated room fragments.
function portraitRegion(values, width, height, face) {
  const labels = new Int32Array(values.length);
  const queue = new Int32Array(values.length);
  let label = 0, selected = 0, bestScore = 0;
  for (let start = 0; start < values.length; start++) {
    if (labels[start] || values[start] < 0.35) continue;
    label++;
    let head = 0, tail = 1, overlap = 0;
    queue[0] = start;
    labels[start] = label;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width, y = Math.floor(pixel / width);
      if (face && x / width > face.left && x / width < face.left + face.width &&
          y / height > face.top && y / height < face.top + face.height) overlap++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (labels[next] || values[next] < 0.35) continue;
          labels[next] = label;
          queue[tail++] = next;
        }
      }
    }
    const score = overlap * values.length + tail;
    if (score > bestScore) { bestScore = score; selected = label; }
  }
  return { labels, selected };
}

async function segmentPerson(bitmap, timestamp, face) {
  if (!segmenter) {
    const options = {
      baseOptions: { modelAssetPath: '/models/selfie_multiclass_256x256.tflite', delegate: 'GPU' },
      canvas: new OffscreenCanvas(256, 256),
      runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true
    };
    try { segmenter = await vision.ImageSegmenter.createFromOptions(files, options); }
    catch {
      options.baseOptions.delegate = 'CPU';
      segmenter = await vision.ImageSegmenter.createFromOptions(files, options);
    }
  }
  let mask;
  segmenter.segmentForVideo(bitmap, timestamp, result => {
    // Model channels are background, hair, body skin, face skin, clothes and accessories.
    const background = result.confidenceMasks[0];
    const width = background.width, height = background.height;
    const values = Float32Array.from(background.getAsFloat32Array(), probability => 1 - probability);
    const { labels, selected } = portraitRegion(values, width, height, face);
    maskCanvas.width = width;
    maskCanvas.height = height;
    const image = maskContext.createImageData(width, height);
    for (let i = 0; i < values.length; i++) {
      const amount = labels[i] === selected ? Math.max(0, Math.min(1, (values[i] - 0.35) / 0.5)) : 0;
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
      image.data[i * 4 + 3] = Math.round(amount * amount * (3 - 2 * amount) * 255);
    }
    maskContext.putImageData(image, 0, 0);
    mask = maskCanvas.transferToImageBitmap();
  });
  return mask;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      vision = await import('/vendor/mediapipe/vision_bundle.mjs');
      files = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      landmarker = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1,
        minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.6
      });
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    return;
  }
  const { bitmap, timestamp, epoch, background } = data;
  let mask;
  try {
    const face = detectFace(bitmap, timestamp);
    let backgroundError;
    if (background) {
      try { mask = await segmentPerson(bitmap, timestamp, face); }
      catch (error) { backgroundError = error.message; }
    }
    self.postMessage({ type: 'face', epoch, face, mask, backgroundError }, mask ? [mask] : []);
  } catch (error) {
    mask?.close();
    self.postMessage({ type: 'error', message: error.message });
  } finally {
    bitmap.close();
  }
};
