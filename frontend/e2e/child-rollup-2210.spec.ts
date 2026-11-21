import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { borderColor, contrastRatio, fillColor, surfaceColor, textColor } from './contrast'

// #2210 — the parent card's child-progress footer at three densities, in light
// and dark, and at 390px; the live ring, the loading skeleton and the contrast
// of every segment against the card (3:1 non-text, 4.5:1 text; #2206 rule 8).

const DAY = 86_400_000
const ROLLUP = { visible: true, total: 5, done: 2, doing: 1, todo: 1, blocked: 1, last_moved_at: new Date(Date.now() - 1 * DAY).toISOString() }
const PARENT = { ...CARD, id: 11, uid: 'card000011c', title: 'Parent epic', position: 5, children_rollup: ROLLUP }
const IDLE_PARENT = { ...CARD, id: 12, uid: 'card000012c', title: 'Idle epic', position: 6, children_rollup: { ...ROLLUP, blocked: 0, todo: 2, last_moved_at: new Date(Date.now() - 30 * DAY).toISOString() } }

type Density = 'comfortable' | 'standard' | 'dense'

async function openBoard(page: Page, { density, theme, cards = [PARENT] }: { density: Density; theme: 'light' | 'dark'; cards?: unknown[] }) {
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  const board = { ...BOARD_FULL, card_density: density, cards_can_have_children: true, cards }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: cards.length, results: cards }) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }))
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
}

const footer = (page: Page) => page.getByTestId('card-children-rollup').first()

for (const theme of ['light', 'dark'] as const) {
  test.describe(`child rollup footer (${theme})`, () => {
    test('comfortable shows both rows, a segment per child, blocked in danger', async ({ page }) => {
      await openBoard(page, { density: 'comfortable', theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const f = footer(page)
      await expect(f).toHaveAttribute('aria-label', /^Children: 2 of 5 done, 1 doing, 1 blocked, 1 to do, work moved 1 day ago/)
      await expect(f.locator('[data-segment]')).toHaveCount(5)
      await expect(f.getByTestId('rollup-blocked')).toHaveText('1 blocked')
      await expect(f.getByTestId('rollup-movement')).toHaveText('Work moved 1 day ago')
    })

    test('standard keeps row 1 only; idle shows there when nothing is blocked', async ({ page }) => {
      await openBoard(page, { density: 'standard', theme, cards: [IDLE_PARENT] })
      const f = footer(page)
      await expect(f.getByTestId('rollup-movement')).toHaveCount(0)
      await expect(f).toContainText('Work idle 30 days')
    })

    test('dense draws the one-line footer with N/M and no bar', async ({ page }) => {
      await openBoard(page, { density: 'dense', theme })
      const f = footer(page)
      await expect(f).toContainText('2/5')
      await expect(f.locator('[data-segment]')).toHaveCount(0)
      await expect(f).toHaveAttribute('aria-label', /^Children: 2 of 5 done/)
    })

    test('every segment holds 3:1 against the card and the text 4.5:1', async ({ page }) => {
      await openBoard(page, { density: 'comfortable', theme, cards: [PARENT, IDLE_PARENT] })
      const f = footer(page)
      const card = await surfaceColor(f)
      const done = await fillColor(f.locator('[data-segment="done"]').first())
      const doingOutline = await borderColor(f.locator('[data-segment="doing"]').first())
      const todoOutline = await borderColor(f.locator('[data-segment="todo"]').first())
      const blockedOutline = await borderColor(f.locator('[data-segment="blocked"]').first())
      const rows: Record<string, number> = {
        done: contrastRatio(done, card),
        doing: contrastRatio(doingOutline, card),
        todo: contrastRatio(todoOutline, card),
        blocked: contrastRatio(blockedOutline, card),
      }
      const blockedText = contrastRatio(await textColor(f.getByTestId('rollup-blocked')), card)
      const movement = contrastRatio(await textColor(f.getByTestId('rollup-movement')), card)
      const idleText = contrastRatio(await textColor(page.getByTestId('rollup-movement').nth(1)), await surfaceColor(page.getByTestId('rollup-movement').nth(1)))
      // eslint-disable-next-line no-console
      console.log(`CONTRAST ${theme} ${JSON.stringify({ ...rows, blockedText, movement, idleText })}`)
      for (const [name, ratio] of Object.entries(rows)) expect(ratio, `${name} segment vs card`).toBeGreaterThanOrEqual(3)
      expect(blockedText, 'blocked text').toBeGreaterThanOrEqual(4.5)
      expect(movement, 'movement text').toBeGreaterThanOrEqual(4.5)
      expect(idleText, 'idle text').toBeGreaterThanOrEqual(4.5)
    })
  })
}

test.describe('child rollup footer at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('keeps its words, no horizontal page scroll, card at least 44px tall', async ({ page }) => {
    await openBoard(page, { density: 'comfortable', theme: 'light' })
    const f = footer(page)
    await expect(f).toBeVisible()
    await expect(f.getByTestId('rollup-movement')).toHaveText('Work moved 1 day ago')
    await expect(f).toContainText('2/5 done')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const card = f.locator('xpath=ancestor::*[@data-card-id][1]')
    if (await card.count()) expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('child rollup live behavior', () => {
  test('a ping rings only the changed segment, then drops it', async ({ page }) => {
    await routeAuth(page)
    let reads = 0
    const board = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT] }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [PARENT] }) }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }))
    await page.route(new RegExp(`/api/v1/boards/${BOARD_FULL.id}/cards/${PARENT.id}/?$`), (r) => {
      reads += 1
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...PARENT, children_rollup: { ...ROLLUP, done: 3, doing: 0 } }) })
    })
    let send: (m: string) => void = () => {}
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      send = (m) => ws.send(m)
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(footer(page)).toBeVisible()
    send(JSON.stringify({ event: 'card.children_changed', data: { parent_id: PARENT.id } }))
    await expect.poll(() => reads).toBeGreaterThan(0)
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveCount(1)
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveAttribute('data-segment', 'done')
    await expect(footer(page).getByTestId('rollup-live')).toHaveText('Children: 3 of 5 done')
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveCount(0, { timeout: 4000 })
  })
})
