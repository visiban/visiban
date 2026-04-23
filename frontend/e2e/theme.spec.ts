import { test, expect } from '@playwright/test'
import { routeAuth } from './helpers'

test.describe('theme toggle', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
  })

  test('switching to Dark sets data-theme="dark" on <html>', async ({ page }) => {
    await page.goto('/settings')
    // Wait for the Settings page to finish its initial render. The left-nav
    // tab buttons briefly detach and re-attach as ProfileTab's SelectDropdown
    // children hydrate (React StrictMode double-invokes effects in dev). Wait
    // for network to idle before interacting.
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Appearance' }).click()

    // Radio group is labelled "Theme"; pick the "Dark" option.
    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' })
    await expect(themeGroup).toBeVisible()
    await themeGroup.getByText('Dark', { exact: true }).click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    const stored = await page.evaluate(() => window.localStorage.getItem('visiban-theme'))
    expect(stored).toBe('dark')
  })

  test('dark theme persists across reload', async ({ page }) => {
    // Pre-seed the localStorage key so the ThemeProvider reads it on init.
    await page.addInitScript(() => {
      window.localStorage.setItem('visiban-theme', 'dark')
    })

    await page.goto('/settings')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
