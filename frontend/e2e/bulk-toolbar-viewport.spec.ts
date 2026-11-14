import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_DENSE, BOARD_FULL, CARD, CARD_BUSY } from './fixtures/board'

// The bulk toolbar is `fixed` and centered with left-1/2, so without an
// explicit width its shrink-to-fit box is capped near half the viewport (#2071,
// same defect class as the toast fix in #1439). Its menus open upward from
// mid-row triggers once the bar wraps, so they must stay inside the viewport too.
for (const width of [320, 375, 1024]) {
  test(`bulk toolbar fits inside a ${width}px viewport with a gutter, unsqueezed`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 })
    await routeAuth(page)
    await routeBoard(page, BOARD_DENSE as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_DENSE.id}`)
    for (const id of [CARD.id, CARD_BUSY.id]) {
      const face = page.locator(`[data-card-id="${id}"]`)
      await expect(face).toBeVisible({ timeout: 10_000 })
      const checkbox = face.getByRole('checkbox')
      if (width >= 375) {
        await face.hover()
        await checkbox.click()
      } else {
        // Verified at 320 only: the sticky swimlane label is 220px wide, so the
        // card column starts at x=244 and a real hover or click scrolls the
        // card under the label, which then intercepts the pointer. At 375 the
        // real click works. Toggle the checkbox directly here.
        await checkbox.dispatchEvent('click')
      }
    }
    const bar = page.getByText('2 selected').locator('xpath=..')
    await expect(bar).toBeVisible()
    const box = (await bar.boundingBox())!
    console.log(`bulk toolbar @${width}: x=${box.x} w=${box.width} h=${box.height}`)
    if (width < 640) {
      // Not squeezed: it takes the full width between the gutters (w-max
      // capped by max-w). Without w-max it shrink-fits into half the viewport.
      expect(box.width).toBeGreaterThanOrEqual(width - 33)
    } else {
      // Wide screens keep one row; before the fix the bar was 512px wide with
      // its labels broken onto two lines (66px tall) at 1024.
      expect(box.height).toBeLessThanOrEqual(52)
    }
    expect(box.x).toBeGreaterThanOrEqual(15)
    expect(box.x + box.width).toBeLessThanOrEqual(width - 15)
    // Every control stays inside the bar's box (nothing overflows its edge).
    for (const btn of await bar.getByRole('button').all()) {
      const b = (await btn.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1)
    }
    // Each upward menu opens fully inside the viewport, gutter included, even
    // though its trigger sits mid-row after the bar wraps.
    for (const name of ['Move to...', 'Assign to...', 'Priority...']) {
      await bar.getByRole('button', { name }).click()
      const menu = (await bar.getByRole('menu').boundingBox())!
      console.log(`${name} menu @${width}: x=${menu.x} right=${menu.x + menu.width}`)
      expect(menu.x, `${name} menu left`).toBeGreaterThanOrEqual(15)
      expect(menu.x + menu.width, `${name} menu right`).toBeLessThanOrEqual(width - 15)
      await page.keyboard.press('Escape')
      await expect(bar.getByRole('menu')).toHaveCount(0)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

// #2173: when every selected card is one the user may not edit, the toolbar
// says why instead of failing after the click. The button stays focusable
// (aria-disabled, not disabled) and activating it writes the cause into the
// status slot.
test('a refused edit names its cause in the toolbar and keeps focus on the button (#2173)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 })
  await routeAuth(page)
  const others = { ...BOARD_DENSE.cards[0].created_by, id: 987654, username: 'someone-else', display_name: 'Someone Else' }
  const board = {
    ...BOARD_DENSE,
    current_user_role: 'member' as const,
    cards: BOARD_DENSE.cards.map((c) => ({ ...c, created_by: others })),
  }
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_DENSE.id}`)
  for (const id of [CARD.id, CARD_BUSY.id]) {
    const face = page.locator(`[data-card-id="${id}"]`)
    await expect(face).toBeVisible({ timeout: 10_000 })
    await face.hover()
    await face.getByRole('checkbox').click()
  }
  const bar = page.getByText('2 selected').locator('xpath=..')
  const assign = bar.getByRole('button', { name: 'Assign to...' })
  await expect(assign).toHaveAttribute('aria-disabled', 'true')
  await assign.focus()
  await page.keyboard.press('Enter')
  await expect(assign).toBeFocused()
  await expect(bar.getByRole('menu')).toHaveCount(0)
  await expect(bar.getByRole('status')).toContainText('2 of 2 cards could not be assigned — you can only assign cards you created.')
})
