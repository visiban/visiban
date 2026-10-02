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
      // `text` + `cobertura` feed GitLab's coverage regex and coverage_report;
      // `lcov` is the format SonarCloud's JS importer reads (#1370).
      reporter: ['text', 'cobertura', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'src/vite-env.d.ts'],
      // Ratcheted for #1371 (SonarCloud coverage floor). Measured on this
      // branch after extending RichTextEditor.tsx and useBoard.ts coverage:
      // lines 85.03%, statements 82.2%, functions 79.03%, branches 79.69%.
      // Set a couple of points under each so the gate cannot regress but
      // normal test-order/environment variance doesn't flake it red.
      thresholds: {
        lines: 83,
        statements: 80,
        functions: 77,
        branches: 77,
      },
    },
  },
})
