import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config is separate from vite.config.ts because vitest 2.x bundles its own
// copy of vite, which causes type incompatibilities with the top-level vite 7.
// The `as never` cast on the react plugin silences that version skew at the type level;
// at runtime both are identical plugin objects.
export default defineConfig({
  plugins: [react() as never],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'src/vite-env.d.ts'],
    },
  },
})
