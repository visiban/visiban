import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

// When the host port is remapped (e.g. running two Compose stacks side-by-side),
// the browser connects on FRONTEND_PORT but the container still listens on 5173.
// VITE_HMR_CLIENT_PORT lets us tell Vite which port to inject into the HMR
// client URL so the websocket reaches the right host port.
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT
  ? Number(process.env.VITE_HMR_CLIENT_PORT)
  : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Injected at build time so the version is always in sync with package.json
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    ...(hmrClientPort ? { hmr: { clientPort: hmrClientPort } } : {}),
  },
})
