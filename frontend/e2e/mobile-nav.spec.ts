import { test, expect } from '@playwright/test'
import { routeAuth } from './helpers'

test.describe('mobile nav drawer', () => {
  // The drawer is the only navigation surface at every width (#2473); this
  // file checks it on a phone, where every target is 44px.
  test.use({ viewport: { width: 375, height: 720 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
  })

  test('the menu button opens the drawer, Close shuts it and refocuses the button', async ({ page }) => {
    await page.goto('/')

    const hamburger = page.getByRole('button', { name: 'Open navigation' })
    await expect(hamburger).toBeVisible()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')

    await hamburger.click()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('dialog', { name: 'Main navigation' })).toBeVisible()

    // The Close button inside the open drawer is the canonical dismiss affordance.
    const closeBtn = page.getByRole('button', { name: 'Close navigation' })
    await expect(closeBtn).toBeVisible({ timeout: 2_000 })

    await closeBtn.click()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')
    await expect(closeBtn).toHaveCount(0)
    await expect(hamburger).toBeFocused()
  })

  test('[ toggles the drawer at desktop width too, and Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    // No permanent sidebar: the drawer is closed until asked for. (Home's own
    // "Needs attention" column is a complementary landmark, so don't count those.)
    const drawer = page.getByRole('dialog', { name: 'Main navigation' })
    // Wait for the signed-in shell before pressing `[` (#2530): NavDrawer attaches its keydown listener only once
    // the shell mounts, and the count-of-0 check below also passes on a page that has not rendered yet. The press
    // can therefore land before the shell mounts and be dropped (the likely cause of the CI flake in #2530;
    // reproduced locally by delaying the auth response by 400ms).
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    await expect(drawer).toHaveCount(0)
    await page.keyboard.press('[')
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  })
})
