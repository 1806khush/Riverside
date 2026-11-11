import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const python = process.env.CPE_PYTHON || join(
  '.build', 'web-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
const entry = mode === 'start' ? '.output/server/index.mjs' : 'node_modules/vite/bin/vite.js'
const host = process.env.HOST || 'localhost'
const port = process.env.PORT || '3200'

if (!process.env.CPE_PYTHON && !existsSync(python)) {
  console.error('Run npm run setup to prepare the media service.')
  process.exit(1)
}

if (mode === 'test') {
  const test = spawn(python, ['scripts/verify-backend.py'], { stdio: 'inherit', env: {
    ...process.env, PYTHONDONTWRITEBYTECODE: '1',
  } })
  test.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  test.on('exit', (code) => { process.exitCode = code ?? 1 })
} else {
  if (!['dev', 'start'].includes(mode) || !existsSync(entry)) {
    console.error(mode === 'start' ? 'Run npm run build before npm start.' : 'Run npm ci before npm run dev.')
    process.exit(1)
  }

  const token = randomBytes(32).toString('hex')
  const media = spawn(python, ['-u', 'server.py', '--port', '0', '--watch-parent'], {
    env: { ...process.env, CPE_MEDIA_TOKEN: token, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  media.stdin.on('error', () => {})
  let web
  let stopping = false
  const startupTimeout = setTimeout(() => stop(1, 'The media service did not start.'), 10_000)

  function stop(code, message) {
    if (stopping) return
    stopping = true
    clearTimeout(startupTimeout)
    if (message) console.error(message)
    process.exitCode = code
    web?.kill()
    media.stdin.end()
  }

  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  media.on('error', (error) => stop(1, error.message))
  media.on('exit', () => stop(1, 'The media service stopped.'))
  createInterface({ input: media.stdout }).on('line', (line) => {
    const match = /^CPE media service listening on (\d+)$/.exec(line)
    if (!match || web || stopping) return
    clearTimeout(startupTimeout)
    const args = mode === 'dev' ? [entry, 'dev', '--host', host, '--port', port] : [entry]
    web = spawn(process.execPath, args, {
      env: { ...process.env, HOST: host, PORT: port, CPE_MEDIA_PORT: match[1], CPE_MEDIA_TOKEN: token },
      stdio: 'inherit',
    })
    web.on('error', (error) => stop(1, error.message))
    web.on('exit', (code) => stop(code ?? 1))
  })
}
