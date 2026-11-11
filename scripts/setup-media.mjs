import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const envPath = '.build/web-python'
const python = join(envPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const lock = `scripts/requirements-${process.platform}-${process.arch}.lock`

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT' && command === 'uv') {
    throw new Error('Install uv before running npm run setup.')
  }
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`)
}

if (!existsSync(python)) run('uv', ['venv', '--python', '3.12', envPath])
run('uv', ['pip', 'sync', existsSync(lock) ? lock : 'requirements.txt', '--python', python])
run(process.execPath, ['scripts/setup-camera-models.cjs'])
