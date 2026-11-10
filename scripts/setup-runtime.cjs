// Build-machine setup only. End users never run this script or install Python.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const build = path.join(root, '.build');
const runtime = path.join(build, 'runtime');
const windows = process.platform === 'win32';
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Build on macOS or Windows.');
fs.mkdirSync(runtime, { recursive: true });
const env = { ...process.env, UV_CACHE_DIR: path.join(build, 'uv-cache'),
  UV_PYTHON_BIN_DIR: path.join(build, 'bin'), HF_HOME: path.join(build, 'hf-cache'),
  HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1', PIP_CACHE_DIR: path.join(build, 'pip-cache') };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
  return result.stdout?.trim();
}
const toolsPython = path.join(build, 'tools', windows ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(toolsPython)) run(windows ? 'py' : 'python3', [ ...(windows ? ['-3.12'] : []), '-m', 'venv', path.join(build, 'tools') ]);
run(toolsPython, ['-m', 'pip', 'install', 'uv==0.13.7']);
const uv = path.join(build, 'tools', windows ? 'Scripts/uv.exe' : 'bin/uv');
run(uv, ['python', 'install', '3.12.16', '--install-dir', runtime, '--no-bin']);
const candidates = fs.readdirSync(runtime, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('cpython-3.12.')).map(entry => entry.name);
// uv's minor-version alias is absolute; it must not point back to the build machine.
for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
  if (entry.isSymbolicLink() && entry.name.startsWith('cpython-')) fs.unlinkSync(path.join(runtime, entry.name));
}
if (candidates.length !== 1) throw new Error('Expected exactly one Python 3.12 runtime. Remove .build/runtime and rerun setup.');
const relative = path.join(candidates[0], windows ? 'python.exe' : 'bin/python3.12');
const python = path.join(runtime, relative);
const lock = path.join(root, 'scripts', `requirements-${process.platform}-${process.arch}.lock`);
if (!fs.existsSync(lock)) run(uv, ['pip', 'compile', 'requirements.txt', '--python', python, '-o', lock]);
run(uv, ['pip', 'sync', lock, '--python', python, '--break-system-packages', '--link-mode', 'copy']);
run(process.execPath, [path.join(root, 'scripts/setup-camera-models.cjs')]);
fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({
  platform: process.platform, arch: process.arch, python: relative.split(path.sep).join('/')
}, null, 2) + '\n');
require('./check-runtime.cjs');
console.log('Bundled runtime is ready. Run npm start.');
