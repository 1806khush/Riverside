import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: 'localhost', port: 3200, strictPort: true },
  plugins: [tanstackStart(), nitro({ preset: 'node-server' }), viteReact()],
})
