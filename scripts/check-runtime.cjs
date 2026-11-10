const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.build/runtime');
if (!fs.existsSync(path.join(runtime, 'runtime.json'))) throw new Error('Run npm run setup first.');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json')));
if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Build the runtime on the target OS and architecture.');
for (const file of ['face_landmarker.task', 'selfie_multiclass_256x256.tflite']) {
  if (!fs.existsSync(path.join(root, 'models', file))) throw new Error(`Missing ${file}. Run npm run setup.`);
}
const result = spawnSync(path.join(runtime, manifest.python), ['-c',
  "import imageio_ffmpeg, pypdfium2, PIL; print('Python libraries and FFmpeg:', imageio_ffmpeg.get_ffmpeg_exe())"],
{ cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } });
if (result.error || result.status !== 0) throw new Error('Bundled runtime check failed.');
