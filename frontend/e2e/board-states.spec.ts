import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE } from './fixtures/board'

// Board states and the keyboard move path on the redesigned board (#2276).

test.use({ viewport: { width: 1440, height: 900 } })

const cardFace = (page: Page) => page.locator(`[data-card-id="${CARD.id}"]`)

test.describe('board states', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
  })

  test('loading shows the skeleton announced as Loading board, then the board', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, async (route) => {
      await gate
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) })
    })
    await routeBoard(page)
    // routeBoard registered /full/ last-wins; re-register the gated one on top.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, async (route) => {
      await gate
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('board-skeleton')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Loading board')).toBeAttached()
    release()
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('board-skeleton')).toHaveCount(0)
  })

  test('an empty board says No cards yet and offers Add a card', async ({ page }) => {
    await routeBoard(page, { ...BOARD_FULL, cards: [] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const empty = page.getByTestId('board-empty-state')
    await expect(empty).toBeVisible({ timeout: 10_000 })
    await expect(empty).toContainText('No cards yet')
    await expect(empty.getByRole('button', { name: 'Add a card' })).toBeVisible()
  })

  test('a failed load shows the error and Try again refetches without a page reload', async ({ page }) => {
    let fail = true
    let fullCalls = 0
    await routeBoard(page)
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) => {
      fullCalls += 1
      if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('board-load-error')).toBeVisible({ timeout: 10_000 })
    // A full page reload would clear this marker; a refetch keeps it.
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })
    fail = false
    const before = fullCalls
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('board-load-error')).toHaveCount(0)
    expect(fullCalls).toBeGreaterThan(before)
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  })

  test('filters that match nothing offer Show all cards', async ({ page }) => {
    await routeBoard(page)
    // The text search is server-side: the mock answers a query with no matches.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/?*search=*`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('/')
    const search = page.getByPlaceholder('Search cards on this board…')
    await expect(search).toBeFocused()
    await search.fill('zzz-no-such-card')
    await expect(page.getByText(/No cards match the active filters/)).toBeVisible()
    await page.getByRole('button', { name: 'Show all cards' }).click()
    await expect(page.getByText(/No cards match the active filters/)).toHaveCount(0)
    await expect(search).toHaveValue('')
  })
})

test.describe('keyboard move', () => {
  test('Shift+F10, Move to, a column: the card moves with no pointer', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    for (const path of ['', 'movements/', 'comments/', 'activity/', 'activities/', 'checklist/', 'attachments/', 'relations/', 'blocks/']) {
      await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${path}`, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(path === '' ? CARD : []) })
          : route.fallback(),
      )
    }
    let moved: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/**`, async (route) => {
      moved = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...CARD, column: COLUMN_DONE.id, version: 2 }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
    await cardFace(page).focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: `Card actions: ${CARD.title}` })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Move to/ }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('menuitem', { name: new RegExp(COLUMN_DONE.name) }).first().focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => moved).not.toBeNull()
    expect((moved as { column_id: number }).column_id).toBe(COLUMN_DONE.id)
  })
})
