import { test, expect } from '@playwright/test'
import { routeAuth } from './helpers'

test.describe('mobile nav drawer', () => {
  // The hamburger button and closed-by-default sidebar are only visible below
  // the `lg` Tailwind breakpoint (1024 px). Run this file at a narrow viewport.
  test.use({ viewport: { width: 375, height: 720 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
  })

  test('hamburger opens the sidebar, close button shuts it', async ({ page }) => {
    await page.goto('/')

    const hamburger = page.getByRole('button', { name: 'Open navigation menu' })
    await expect(hamburger).toBeVisible()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')

    await hamburger.click()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'true')

    // The Close button inside the open drawer is the canonical dismiss affordance.
    const closeBtn = page.getByRole('button', { name: 'Close navigation menu' })
    await expect(closeBtn).toBeVisible({ timeout: 2_000 })

    await closeBtn.click()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')
    await expect(closeBtn).toHaveCount(0)
  })
})
