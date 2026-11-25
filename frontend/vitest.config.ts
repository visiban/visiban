import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // One CI retry absorbs a one-off scheduler hiccup and nothing more. Every
    // root-caused occurrence of #1319 (3: a leaked post-save timer; 4: an
    // effect-seeded input buffer racing the first edit; 1 most likely the
    // same race) was a component defect that failed on both attempts. A red
    // job with "(retry x1)" therefore means a real bug: investigate, don't
    // re-run. Do not raise this to 2, which would have saved none of them and
    // would hide the next one. Local runs stay strict (no retry) so a flake
    // surfaces for the dev who introduced it. (#1304, #1319)
    retry: process.env.CI ? 1 : 0,
    // Shared CI runners can run the suite almost 3x slower than at their best,
    // and tests that take 2-3s in a green job then cross Vitest's 5s default
    // (#2610). Only the CI budget is larger: a hang still fails, and local runs
    // keep the default so a slow test is still noticed.
    testTimeout: process.env.CI ? 15_000 : 5_000,
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
