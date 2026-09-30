import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // CI runners are resource-constrained enough that a genuine one-off flake
    // (e.g. a waitFor timing out under GC pressure) shouldn't fail the whole
    // pipeline — a real regression still fails on every retry attempt. Local
    // runs stay strict (no retry) so a flake surfaces immediately for the dev
    // who introduced it, instead of quietly passing on attempt 2. (#1304)
    retry: process.env.CI ? 1 : 0,
    // Restrict test discovery to this project's src/ so agent worktrees in
    // .claude/worktrees/ are not picked up when Vitest is run from the repo root.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 60,
        branches: 60,
      },
    },
  },
})
