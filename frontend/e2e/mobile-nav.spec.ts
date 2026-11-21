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
    await expect(page.getByRole('complementary')).toHaveCount(0)
    await page.keyboard.press('[')
    const drawer = page.getByRole('dialog', { name: 'Main navigation' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  })
})
