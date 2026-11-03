import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, COLUMN_TODO, SWIMLANE } from './fixtures/board'

/**
 * The dwell overlay in a real browser (#459). jsdom has no paint order, so this is
 * the only check that the tint is visible behind cards that stay readable, and that a
 * socket frame re-shades a cell without a reload.
 */

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

const COLUMN_DOING = { ...COLUMN_TODO, id: 3, uid: 'col0000003w', name: 'Doing', position: 1 }
const COLUMN_FINISHED = { ...COLUMN_DONE, position: 2 }

function card(id: number, column: number, title: string, enteredDaysAgo: number | null) {
  return {
    ...CARD,
    id,
    uid: `card00000${id}x`,
    column,
    title,
    column_entered_at: enteredDaysAgo === null ? null : ago(enteredDaysAgo),
  }
}

const CARDS = [
  card(11, COLUMN_TODO.id, 'Fresh task', 0.4),
  card(12, COLUMN_DOING.id, 'Old task with a longer title that wraps around the card', 12),
  card(13, COLUMN_DOING.id, 'Older task', 30),
  card(14, COLUMN_DOING.id, 'Mid task', 9),
  card(15, COLUMN_FINISHED.id, 'Finished task', null),
]

async function openBoard(page: Page, cards: unknown[] = CARDS) {
  await routeAuth(page)
  const board = { ...BOARD_FULL, columns: [COLUMN_TODO, COLUMN_DOING, COLUMN_FINISHED], swimlanes: [SWIMLANE], cards }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: cards.length, results: cards }) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  let send: (frame: unknown) => void = () => {}
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
    send = (frame) => ws.send(JSON.stringify(frame))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText('Fresh task').first()).toBeVisible({ timeout: 10_000 })
  return { sendFrame: (frame: unknown) => send(frame) }
}

async function selectDwell(page: Page) {
  await page.getByRole('button', { name: /^Overlay$/ }).click()
  await page.getByRole('menuitem', { name: 'Dwell time' }).click()
}

const cellOf = (page: Page, title: string) =>
  page.getByText(title).first().locator('xpath=ancestor::*[@data-board-cell][1]')

test.describe('dwell time overlay', () => {
  test('shades the hottest cell, badges the fresh one, and leaves done alone', async ({ page }) => {
    await openBoard(page)
    await selectDwell(page)

    const hot = cellOf(page, 'Older task')
    await expect(hot.getByRole('img', { name: 'Dwell time: median dwell 12.0 days, level 4 of 4' })).toHaveText('12.0d')
    await expect(hot.locator('.bg-primary-emphasis\\/40')).toHaveCount(1)
    await expect(hot.locator('.h-1')).toHaveCount(1)

    const fresh = cellOf(page, 'Fresh task')
    await expect(fresh.getByRole('img', { name: 'Dwell time: median dwell 0.4 days, below level 1' })).toHaveText('0.4d')
    await expect(fresh.locator('[class*="bg-primary-emphasis/"]')).toHaveCount(0)

    const done = cellOf(page, 'Finished task')
    await expect(done.getByRole('img', { name: /Dwell time/ })).toHaveCount(0)
    await expect(done.locator('[class*="bg-primary-emphasis/"]')).toHaveCount(0)

    const legend = page.getByRole('group', { name: 'Dwell time overlay scale' })
    await expect(legend).toContainText('8d+')
    await expect(legend).toContainText('12.0d')
    await expect(legend).toContainText('Under 1d')
    await expect(legend).toContainText('—')
  })

  test('paints the tint under the cards: titles stay on top and readable', async ({ page }) => {
    await openBoard(page)
    await selectDwell(page)
    const title = page.getByText('Older task').first()
    await expect(title).toBeVisible()
    // What is actually on top at the title's center is the card, not the tint layer.
    const onTop = await title.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit?.closest('[data-card-id]')
    })
    expect(onTop).toBe(true)
  })

  test('a selected first card lifts above the value badge, so its checkbox shows', async ({ page }) => {
    await openBoard(page)
    await selectDwell(page)
    const cell = cellOf(page, 'Fresh task')
    const zOf = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => getComputedStyle(el).zIndex)
    const firstCard = cell.locator('[data-card-id]').first()
    await expect.poll(() => zOf(firstCard)).toBe('0')

    await firstCard.hover()
    const checkbox = firstCard.getByRole('checkbox')
    await checkbox.click()
    await page.mouse.move(0, 0)
    await expect(checkbox).toHaveAttribute('aria-checked', 'true')

    // Equal to the badge's z, and the card is later in DOM order, so it paints on top.
    await expect.poll(() => zOf(firstCard)).toBe('5')
    await expect.poll(() => zOf(cell.getByRole('img', { name: /Dwell time/ }))).toBe('5')
  })

  test('toggling off returns the board to normal', async ({ page }) => {
    await openBoard(page)
    await selectDwell(page)
    await expect(page.getByRole('group', { name: 'Dwell time overlay scale' })).toBeVisible()
    await page.getByRole('button', { name: 'Dwell time' }).click()
    await page.getByRole('menuitem', { name: 'None' }).click()
    await expect(page.getByRole('group', { name: /overlay scale/ })).toHaveCount(0)
    await expect(page.locator('[data-board-cell] [class*="bg-primary-emphasis/"]')).toHaveCount(0)
  })

  test('a socket frame re-shades the cell without a reload', async ({ page }) => {
    const { sendFrame } = await openBoard(page)
    await selectDwell(page)
    const fresh = cellOf(page, 'Fresh task')
    await expect(fresh.getByRole('img', { name: /Dwell time/ })).toHaveText('0.4d')

    sendFrame({ event: 'card.updated', data: { ...card(11, COLUMN_TODO.id, 'Fresh task', 6), version: 2 } })

    await expect(fresh.getByRole('img', { name: /Dwell time/ })).toHaveText('6.0d')
    await expect(fresh.locator('.bg-primary-emphasis\\/30')).toHaveCount(1)
  })

  test('says no values when no card has a measured visit', async ({ page }) => {
    await openBoard(page, [card(11, COLUMN_TODO.id, 'Fresh task', null)])
    await selectDwell(page)
    await expect(page.getByRole('group', { name: 'Dwell time overlay scale' })).toContainText('No values on this board yet.')
  })

  test('remembers the choice across a reload', async ({ page }) => {
    await openBoard(page)
    await selectDwell(page)
    await page.reload()
    await expect(page.getByRole('group', { name: 'Dwell time overlay scale' })).toBeVisible({ timeout: 10_000 })
  })
})
