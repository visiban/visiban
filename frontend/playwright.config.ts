import { defineConfig, devices } from '@playwright/test'

// All API calls in tests are intercepted via page.route() so no real backend
// is required.  The webServer below starts the Vite dev server and the tests
// set VITE_API_URL so requests target localhost:8000, which is then mocked.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Retry on CI to tolerate transient timing issues; no retries locally.
  retries: process.env.CI ? 2 : 0,
  // Run tests serially in CI to stay within the 2 GB runner memory budget
  // (one Chromium instance + Vite dev server already consumes ~1 GB).
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    process.env.CI ? ['gitlab', {}] : ['list', {}],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Use vite dev (not vite preview) to avoid a build step prerequisite.
    // VITE_API_URL tells the axios client where to send API requests; all
    // those requests are intercepted by page.route() so the backend never
    // actually receives them.
    command: 'VITE_API_URL=http://localhost:8000 npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
