import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The card peek sheet (#2273): a board click opens a read-only side sheet.
async function setup(page: import('@playwright/test').Page) {
  await routeAuth(page)
  await routeBoard(page)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
}

test.describe('card peek sheet', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('opens on click without resizing the grid, marks the card, and Escape returns focus', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    const scroll = page.locator('[data-board-scroll]')
    const before = await scroll.boundingBox()
    await card.click()
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close card peek' })).toBeFocused()
    await expect(card).toHaveAttribute('aria-current', 'true')
    const after = await scroll.boundingBox()
    expect(after?.width).toBe(before?.width)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(card).toBeFocused()
  })

  test('Open card hands off to the detail sheet', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    await page.getByRole('button', { name: 'Open card' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
  })

  test('Enter on the focused card opens the peek', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
  })

  test('a click on "+ Add card" closes the peek and does not also open the editor', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.locator('[data-board-cell]').getByRole('button', { name: /^Add card to / }).first().click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByPlaceholder(/title/i)).toHaveCount(0)
  })

  test('Open card then Escape closes the detail sheet and returns focus to the board card', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click()
    await page.getByRole('button', { name: 'Open card' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /./ })).toHaveCount(0)
    await expect(card).toBeFocused()
  })

  test.describe('at 640px', () => {
    test.use({ viewport: { width: 640, height: 800 } })

    test('is full-screen at exactly 640px', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      await page.locator(`[data-card-id="${CARD.id}"]`).click()
      const box = await page.getByTestId('card-peek-sheet').boundingBox()
      expect(Math.round(box?.width ?? 0)).toBe(640)
    })
  })

  test.describe('at 390px', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('fills the screen, has 44px targets, and Escape closes it', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      await page.locator(`[data-card-id="${CARD.id}"]`).click()
      const sheet = page.getByTestId('card-peek-sheet')
      await expect(sheet).toBeVisible()
      const box = await sheet.boundingBox()
      expect(Math.round(box?.width ?? 0)).toBe(390)
      const close = await page.getByRole('button', { name: 'Close card peek' }).boundingBox()
      expect(close?.height).toBeGreaterThanOrEqual(44)
      const open = await page.getByRole('button', { name: 'Open card' }).boundingBox()
      expect(open?.height).toBeGreaterThanOrEqual(44)
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
    })
  })
})
