import { test, expect } from '@playwright/test'
import { USER, SITE_CONFIG, AUTH_PROVIDERS } from './fixtures/board'

test.describe('login flow', () => {
  test.beforeEach(async ({ page }) => {
    // Unauthenticated state: auth/user returns 401 so the app shows the login page.
    await page.route('**/api/v1/auth/user/', (route) => route.fulfill({ status: 401 }))
    await page.route('**/api/v1/auth/site-config/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SITE_CONFIG) }),
    )
    await page.route('**/api/v1/auth/providers/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_PROVIDERS) }),
    )
    await page.route('**/api/v1/version/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '1.1.0' }) }),
    )
    // After login succeeds the app fetches the user profile.
    // We intercept login first; on success, subsequent auth/user calls return the user.
    let loggedIn = false
    await page.route('**/api/v1/auth/login/', (route) => {
      loggedIn = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'fake-session-key' }) })
    })
    await page.route('**/api/v1/auth/user/', async (route) => {
      if (loggedIn) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) })
      }
      return route.fulfill({ status: 401 })
    })
    await page.route('**/api/v1/notifications/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route('**/api/v1/boards/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route('**/api/v1/groups/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
  })

  test('shows the login form when unauthenticated', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /sign in|log in|welcome/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByLabel(/username/i)).toBeVisible()
    await expect(page.getByLabel(/password/i)).toBeVisible()
  })

  test('logs in with valid credentials and reaches the dashboard', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel(/username/i).fill('testuser')
    await page.getByLabel(/password/i).fill('testpass123')
    await page.getByRole('button', { name: /sign in|log in/i }).click()
    // After login the app renders the authenticated shell (sidebar + dashboard).
    await expect(page).toHaveURL('/', { timeout: 10_000 })
    // The sidebar contains the user's display name or a board/groups section.
    await expect(page.getByText(/my boards|test user|boards/i).first()).toBeVisible({ timeout: 10_000 })
  })

  test('shows an error message on invalid credentials', async ({ page }) => {
    await page.route('**/api/v1/auth/login/', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ non_field_errors: ['Unable to log in with provided credentials.'] }),
      }),
    )
    await page.goto('/')
    await page.getByLabel(/username/i).fill('testuser')
    await page.getByLabel(/password/i).fill('wrongpassword')
    await page.getByRole('button', { name: /sign in|log in/i }).click()
    await expect(page.getByText(/unable to log in|invalid credentials|incorrect/i)).toBeVisible({ timeout: 5_000 })
  })
})
