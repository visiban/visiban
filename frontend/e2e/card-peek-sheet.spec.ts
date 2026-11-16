import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The card peek sheet (#2273): Shift+click (or Show summary) on a board card opens a read-only
// side sheet; a plain click opens the detail panel (#2358).
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

  test('opens on Shift+click without resizing the grid, marks the card, and Escape returns focus', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    const scroll = page.locator('[data-board-scroll]')
    const before = await scroll.boundingBox()
    await card.click({ modifiers: ['Shift'] })
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open card' })).toBeFocused()
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
    await page.locator(`[data-card-id="${CARD.id}"]`).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Open card' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
  })

  test('Shift+Enter on the focused card opens the peek; Enter opens the detail panel', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.focus()
    await page.keyboard.press('Shift+Enter')
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
  })

  test('a plain click opens the detail panel; the Show summary button and the menu open the peek', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
    await page.keyboard.press('Escape')
    await card.hover()
    await card.getByRole('button', { name: 'Show summary' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Show summary/ }).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
  })

  test('a click on "+ Add card" closes the peek and does not also open the editor', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.locator('[data-board-cell]').getByRole('button', { name: /^Add card to / }).first().click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByPlaceholder(/title/i)).toHaveCount(0)
  })

  test('Open card then Escape closes the detail sheet and returns focus to the board card', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click({ modifiers: ['Shift'] })
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
      await page.locator(`[data-card-id="${CARD.id}"]`).click({ modifiers: ['Shift'] })
      const box = await page.getByTestId('card-peek-sheet').boundingBox()
      expect(Math.round(box?.width ?? 0)).toBe(640)
    })
  })

  test.describe('at 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('Show summary in the More actions menu opens a full-screen peek with 44px targets; Escape closes it', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      const card = page.locator(`[data-card-id="${CARD.id}"]`)
      await expect(card).toBeVisible({ timeout: 10_000 })
      await card.focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: /Show summary/ }).click()
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

  test.describe('touch at 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('Show summary on the face and in the More actions menu both open the peek with 44px targets (#2358)', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      const card = page.locator(`[data-card-id="${CARD.id}"]`)
      await expect(card).toBeVisible({ timeout: 10_000 })
      await card.focus()
      const summary = page.getByTestId('card-show-summary')
      const more = page.getByTestId('card-more-actions')
      await expect(summary).toBeVisible()
      await expect(more).toBeVisible()
      const s = await summary.boundingBox()
      const m = await more.boundingBox()
      expect(s?.height).toBeGreaterThanOrEqual(44)
      expect(s?.width).toBeGreaterThanOrEqual(44)
      expect((s!.x + s!.width <= m!.x + 0.5) || (m!.x + m!.width <= s!.x + 0.5)).toBe(true)
      await summary.tap()
      const sheet = page.getByTestId('card-peek-sheet')
      await expect(sheet).toBeVisible()
      await page.getByRole('button', { name: 'Close card peek' }).tap()
      await expect(sheet).toHaveCount(0)
      await card.focus()
      await more.tap()
      await page.getByRole('menuitem', { name: /Show summary/ }).tap()
      await expect(sheet).toBeVisible()
    })
  })
})
