import { defineConfig, devices } from '@playwright/test'

/**
 * Config for the opt-in marketing-shots spec (#1039).
 *
 * Targets an already-running dev server — there is deliberately no `webServer`
 * block, so start `npm run dev` yourself. It is kept separate from
 * playwright.config.ts (which ignores e2e/marketing/) so a broken product shot
 * can never fail a normal MR pipeline.
 *
 *   npm run shots:marketing
 *   npx playwright test --config=playwright.marketing.config.ts
 *
 * Environment overrides (all optional):
 *   MARKETING_BASE_URL   dev server origin, default http://localhost:5173. Set it
 *                        to your worktree's port when running under scripts/wt
 *                        (e.g. http://localhost:$WT_E2E_PORT).
 *   MARKETING_SHOTS_DIR  output directory, default ~/Downloads.
 *
 * Full procedure: e2e/marketing/README.md.
 */
export default defineConfig({
  testDir: './e2e/marketing',
  testMatch: /marketing-shots\.spec\.ts/,
  // One worker, no parallelism: shot order and output files stay deterministic.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  use: {
    baseURL: process.env.MARKETING_BASE_URL || 'http://localhost:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
