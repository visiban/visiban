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
    // LoginPage has no heading element — use the submit button as the page-load signal.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 })
    // Inputs are identified by placeholder; the form has no <label> elements.
    await expect(page.getByPlaceholder('Username or email')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
  })

  test('logs in with valid credentials and reaches the dashboard', async ({ page }) => {
    // Observe the request rather than re-routing it: the beforeEach's own
    // login handler already drives the unauthenticated → authenticated
    // transition (it flips `loggedIn`, which the auth/user handler checks).
    // Re-registering a competing page.route for the same URL would take
    // priority over that handler and short-circuit it — e.g. a route that
    // always answers auth/user with USER would skip the login form entirely
    // (the app loads already "authenticated") and this test would never
    // find the username field to fill in.
    let loginRequestBody: unknown = null
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/v1/auth/login/')) {
        loginRequestBody = JSON.parse(req.postData() ?? '{}')
      }
    })

    await page.goto('/')
    await page.getByPlaceholder('Username or email').fill('testuser')
    await page.getByPlaceholder('Password').fill('testpass123')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Assert the actual login POST body (api/auth.ts login) rather than only
    // the resulting navigation — a form that silently dropped or mis-keyed a
    // field would otherwise still pass this test as long as the mocked
    // response made the app proceed to the dashboard.
    await expect.poll(() => loginRequestBody, { timeout: 5_000 }).toEqual({
      username: 'testuser',
      password: 'testpass123',
    })

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
    await page.getByPlaceholder('Username or email').fill('testuser')
    await page.getByPlaceholder('Password').fill('wrongpassword')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText(/unable to log in|invalid credentials|incorrect/i)).toBeVisible({ timeout: 5_000 })
  })
})
