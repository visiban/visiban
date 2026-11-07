import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_DENSE, BOARD_FULL, CARD, CARD_BUSY } from './fixtures/board'

// The bulk toolbar is `fixed` and centered with left-1/2, so without an
// explicit width its shrink-to-fit box is capped near half the viewport (#2071,
// same defect class as the toast fix in #1439).
for (const width of [320, 375]) {
  test(`bulk toolbar fits inside a ${width}px viewport with a gutter`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 })
    await routeAuth(page)
    await routeBoard(page, BOARD_DENSE as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_DENSE.id}`)
    for (const id of [CARD.id, CARD_BUSY.id]) {
      const face = page.locator(`[data-card-id="${id}"]`)
      await expect(face).toBeVisible({ timeout: 10_000 })
      // At phone width the sticky swimlane label overlaps the card, so toggle
      // the checkbox without a pointer hit-test.
      await face.getByRole('checkbox').dispatchEvent('click')
    }
    const bar = page.getByText('2 selected').locator('xpath=..')
    await expect(bar).toBeVisible()
    const box = (await bar.boundingBox())!
    console.log(`bulk toolbar @${width}: x=${box.x} w=${box.width} h=${box.height}`)
    expect(box.x).toBeGreaterThanOrEqual(15)
    expect(box.x + box.width).toBeLessThanOrEqual(width - 15)
    // Every control stays inside the bar's box (nothing overflows its edge).
    for (const btn of await bar.getByRole('button').all()) {
      const b = (await btn.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
