import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_DENSE, CARD, CARD_BUSY } from './fixtures/board'

// Hovering a card wraps its clipped metadata row so every chip is readable.
// That expansion is an overlay inside the cell: the cell (and so the swimlane
// row and every other cell in it) must not change height, and the expanded
// card must stay within the cell's bounds. Covering the cell-mate below is
// the intended behavior; shoving it down is the bug this guards against.

test.describe('card hover expansion', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, BOARD_DENSE)
  })

  test('expands over the cell without growing it, and stays inside the cell', async ({ page }) => {
    await page.goto(`/boards/${BOARD_DENSE.id}`)
    const busy = page.locator('[data-card-id]').filter({ hasText: CARD_BUSY.title })
    await expect(busy).toBeVisible({ timeout: 10_000 })
    const mate = page.locator('[data-card-id]').filter({ hasText: CARD.title })
    const cell = page.locator('[data-board-cell]').filter({ has: busy })
    const row = busy.getByTestId('card-metadata-row')

    // At rest the row clips to a single line.
    await expect(row).toHaveClass(/overflow-hidden/)
    const cellBefore = (await cell.boundingBox())!
    const busyBefore = (await busy.boundingBox())!
    const mateBefore = (await mate.boundingBox())!

    await busy.hover()
    await expect(row).toHaveClass(/flex-wrap/)
    // The expansion is real: the card is taller than at rest.
    await expect.poll(async () => (await busy.boundingBox())!.height).toBeGreaterThan(busyBefore.height + 10)

    const cellAfter = (await cell.boundingBox())!
    const busyAfter = (await busy.boundingBox())!
    const mateAfter = (await mate.boundingBox())!
    // The cell did not grow and the cell-mate did not move.
    expect(cellAfter.height).toBe(cellBefore.height)
    expect(mateAfter.y).toBe(mateBefore.y)
    // The cell-mate is dimmed to near-invisible (and blurred) under the
    // expanded card; the hovered card itself is not.
    const mateWrapper = mate.locator('xpath=..')
    await expect.poll(() => mateWrapper.evaluate((el) => parseFloat(getComputedStyle(el).opacity))).toBeLessThan(0.1)
    expect(await mateWrapper.evaluate((el) => getComputedStyle(el).filter)).toContain('blur')
    expect(await busy.locator('xpath=..').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    // The overlay stays inside the cell on every edge. The hover lift
    // translates the card up 2px, hence the 2px slack at the top.
    expect(busyAfter.x).toBeGreaterThanOrEqual(cellAfter.x)
    expect(busyAfter.x + busyAfter.width).toBeLessThanOrEqual(cellAfter.x + cellAfter.width + 0.5)
    expect(busyAfter.y).toBeGreaterThanOrEqual(cellAfter.y - 2)
    expect(busyAfter.y + busyAfter.height).toBeLessThanOrEqual(cellAfter.y + cellAfter.height + 0.5)

    // Leaving restores the at-rest layout.
    await page.mouse.move(0, 0)
    await expect(row).toHaveClass(/overflow-hidden/)
    await expect.poll(async () => (await busy.boundingBox())!.height).toBe(busyBefore.height)
    expect((await cell.boundingBox())!.height).toBe(cellBefore.height)
    await expect.poll(() => mateWrapper.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  })

  // #1414: keyboard focus on the card itself is the twin of hover, so a keyboard user reaches the
  // expansion even when the row's overflow is non-interactive. Pointer-click focus does not count.
  test('keyboard focus on the card expands it the same way, and blur collapses it', async ({ page }) => {
    await page.goto(`/boards/${BOARD_DENSE.id}`)
    const busy = page.locator('[data-card-id]').filter({ hasText: CARD_BUSY.title })
    await expect(busy).toBeVisible({ timeout: 10_000 })
    const cell = page.locator('[data-board-cell]').filter({ has: busy })
    const row = busy.getByTestId('card-metadata-row')
    await expect(row).toHaveClass(/overflow-hidden/)
    const cellBefore = (await cell.boundingBox())!

    // A key press first, so the scripted focus counts as keyboard (:focus-visible).
    await page.keyboard.press('Shift')
    await busy.focus()
    expect(await busy.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    await expect(row).toHaveClass(/flex-wrap/)
    expect((await cell.boundingBox())!.height).toBe(cellBefore.height)

    await busy.evaluate((el) => (el as HTMLElement).blur())
    await expect(row).toHaveClass(/overflow-hidden/)
  })
})
