import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, COLUMN_TODO } from './fixtures/board'

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

  // #2324 — the panel sits below the column headers; Import cards links to the group import.
  test('an empty board in a group offers Import cards below the column headers', async ({ page }) => {
    await routeBoard(page, { ...BOARD_FULL, cards: [], group: 7, group_name: 'Sales' } as unknown as typeof BOARD_FULL)
    await page.route('**/api/v1/groups/7/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 7, name: 'Sales', can_place_boards: true }) }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const empty = page.getByTestId('board-empty-state')
    await expect(empty).toBeVisible({ timeout: 10_000 })
    await expect(empty).toContainText('or import cards from a file.')
    await expect(empty.getByRole('link', { name: 'Import cards' })).toHaveAttribute('href', '/groups/7?import=1')
    const header = await page.getByTestId('board-header-row').boundingBox()
    const panel = await empty.boundingBox()
    expect(panel!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
  })

  // #2324 / #2214 — a chip matching nothing shrinks lanes to bands; hideUnmatched hides them.
  test('a chip matching nothing leaves lane bands reading No matching cards; hide option hides them', async ({ page }) => {
    await routeBoard(page, { ...BOARD_FULL, cards: BOARD_FULL.cards.map((c) => ({ ...c, due_date: null })) })
    await page.goto(`/boards/${BOARD_FULL.id}?show=due_soon`)
    await expect(page.getByTestId('board-no-match')).toContainText('No cards are due soon', { timeout: 10_000 })
    await expect(page.getByTestId('swimlane-no-match').first()).toBeVisible()
    await expect(page.locator('[data-board-cell]')).toHaveCount(0)
    await page.goto(`/boards/${BOARD_FULL.id}?show=due_soon&f_hide_unmatched=1`)
    await expect(page.getByTestId('board-no-match')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('swimlane-band')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show all cards' }).click()
    await expect(cardFace(page)).toBeVisible()
    await expect(page.locator('[data-show-chip="all"]')).toBeFocused()
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

  test('Shift+F10, Move to, Move earlier in this cell: the card reorders with no pointer (#2327)', async ({ page }) => {
    await routeAuth(page)
    const second = { ...CARD, id: CARD.id + 1000, uid: 'e2ereorder0001', title: 'Second in the cell', position: CARD.position + 1 }
    await routeBoard(page, { ...BOARD_FULL, cards: [CARD, second] })
    let moved: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${second.id}/move/**`, async (route) => {
      moved = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...second, position: CARD.position, version: 2 } }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const face = page.locator(`[data-card-id="${second.id}"]`)
    await expect(face).toBeVisible({ timeout: 10_000 })
    const cell = page.locator('[data-board-cell]').filter({ has: face })
    const order = () => cell.locator('[data-card-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id')))
    await expect.poll(order).toEqual([String(CARD.id), String(second.id)])
    await face.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: `Card actions: ${second.title}` })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Move to/ }).focus()
    await page.keyboard.press('ArrowRight')
    const sub = page.getByRole('menu', { name: 'Move within this cell or to a column' })
    // The last card can only step earlier, and that step is the submenu's first item.
    await expect(sub.getByRole('menuitem', { name: 'Move earlier in this cell' })).toBeFocused()
    await expect(sub.getByRole('menuitem', { name: 'Move later in this cell' })).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => moved).not.toBeNull()
    // Same cell, the previous card's slot: it lands right before it.
    expect(moved).toMatchObject({ column_id: CARD.column, swimlane_id: CARD.swimlane, position: CARD.position })
    await expect.poll(order).toEqual([String(second.id), String(CARD.id)])
  })

  test('Shift+F10, Move on to the next sub-column: a split stage card advances with no pointer (#2278, #2327)', async ({ page }) => {
    await routeAuth(page)
    // The smallest split-stage board: To Do gets two ordered sub-columns, the card starts in the first.
    const split = { ...COLUMN_TODO, sub_columns: [{ id: 1, uid: 'sub00000001', position: 0, name: 'Doing' }, { id: 2, uid: 'sub00000002', position: 1, name: 'Ready' }], tracks: [] }
    const card = { ...CARD, gates_passed: 0 }
    await routeBoard(page, { ...BOARD_FULL, columns: BOARD_FULL.columns.map((c) => (c.id === split.id ? split : c)), cards: [card] })
    let moved: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/**`, async (route) => {
      moved = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...card, gates_passed: 1, version: 2 } }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
    await cardFace(page).focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: `Card actions: ${CARD.title}` })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Move to/ }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('menuitem', { name: 'Move on to Ready' }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => moved).not.toBeNull()
    expect(moved).toMatchObject({ column_id: COLUMN_TODO.id, gates_passed: 1 })
    await expect(page.locator('[data-sub-column]').or(page.getByRole('group', { name: 'To Do: Ready' })).first()).toBeVisible()
  })
})
