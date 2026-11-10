// Build-time assets for the existing live camera effects, used by browser WASM.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const folder = path.join(__dirname, '..', 'models');
const assets = {
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'selfie_multiclass_256x256.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'
};
(async () => {
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, url] of Object.entries(assets)) {
    const target = path.join(folder, name);
    if (fs.existsSync(target)) continue;
    const partial = target + '.partial';
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download ${name}.`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
      fs.renameSync(partial, target);
    } finally { fs.rmSync(partial, { force: true }); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
