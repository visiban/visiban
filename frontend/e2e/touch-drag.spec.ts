import { test, expect, devices, type Page, type CDPSession } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, SWIMLANE } from './fixtures/board'

// Touch drag-and-drop on an emulated Android tablet (#1287).
//
// Touches go through CDP Input.dispatchTouchEvent rather than synthetic DOM
// events, so they run through Chromium's real input pipeline: the same
// touch-vs-scroll arbitration (pointercancel on pan, long-press contextmenu)
// that broke card dragging on real tablets. A DOM-dispatched TouchEvent would
// skip all of that and pass whether or not the bug exists.
const { defaultBrowserType: _ignored, ...galaxyTab } = devices['Galaxy Tab S4']
test.use({ ...galaxyTab })

async function touchDrag(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  holdMs: number,
) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  await new Promise((r) => setTimeout(r, holdMs))
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const point = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
    await new Promise((r) => setTimeout(r, 16))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function setup(page: Page) {
  const moves: unknown[] = []
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/`, async (route) => {
    moves.push(JSON.parse(route.request().postData() ?? '{}'))
    // The real move endpoint responds with { card, movement? } (see
    // board.spec.ts's move test) — matching that shape here, rather than the
    // flat card this used to return, keeps useBoard's `const { card } = ...`
    // destructure from silently resolving to undefined.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ card: { ...CARD, column: COLUMN_DONE.id, swimlane: SWIMLANE.id, position: 0 } }),
    })
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
  // Scoped to the actual CardItem element, not plain getByText(CARD.title) —
  // see board.spec.ts's move test for why: the sr-only dnd announcement
  // region also contains the card's title as a substring once a move
  // completes, and getByText.first() would resolve to it instead.
  const cardEl = page.locator('[data-tour-step="card"]').filter({ hasText: CARD.title }).first()
  await expect(cardEl).toBeVisible({ timeout: 10_000 })
  const cardBox = await cardEl.boundingBox()
  const doneBox = await page.getByText('Done').first().boundingBox()
  if (!cardBox || !doneBox) throw new Error('Could not locate card or Done column')
  return {
    moves,
    cardEl,
    cardBox,
    doneBox,
    cdp: await page.context().newCDPSession(page),
    from: { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 },
    to: { x: doneBox.x + doneBox.width / 2, y: doneBox.y + doneBox.height / 2 },
  }
}

test.describe('touch drag-and-drop (#1287)', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('press-and-hold then drag moves the card', async ({ page }) => {
    const { moves, cardEl, cardBox, doneBox, cdp, from, to } = await setup(page)
    await touchDrag(cdp, from, to, 400)

    // Assert the actual move payload, not just that *a* move request fired —
    // same field names and target as board.spec.ts's mouse-drag test.
    await expect.poll(() => moves.length, { timeout: 5_000 }).toBe(1)
    expect(moves[0]).toEqual({
      column_id: COLUMN_DONE.id,
      swimlane_id: SWIMLANE.id,
      position: 0,
      version: CARD.version,
    })

    // And assert the card actually renders under the Done column afterward.
    await expect.poll(async () => {
      const box = await cardEl.boundingBox()
      return box ? box.x : null
    }, { timeout: 5_000 }).not.toBeNull()
    const movedCardBox = await cardEl.boundingBox()
    if (!movedCardBox) throw new Error('Could not locate card after the move')
    expect(movedCardBox.x).toBeGreaterThan(cardBox.x + 50)
    expect(Math.abs(movedCardBox.x - doneBox.x)).toBeLessThan(150)
  })

  test('a quick swipe does not pick up the card', async ({ page }) => {
    const { moves, cdp, from, to } = await setup(page)
    await touchDrag(cdp, from, to, 0)
    // Give a (wrong) drop time to reach the network before asserting none did.
    await page.waitForTimeout(1_000)
    expect(moves).toHaveLength(0)
  })

  test('holding still past the long-press menu delay does not open the new-card input', async ({ page }) => {
    const { moves, cardEl, cardBox, doneBox, cdp, from, to } = await setup(page)
    // Android fires contextmenu at ~500ms; the cell's right-click-to-add must
    // not open mid-drag.
    await touchDrag(cdp, from, to, 1_200)

    await expect.poll(() => moves.length, { timeout: 5_000 }).toBe(1)
    expect(moves[0]).toEqual({
      column_id: COLUMN_DONE.id,
      swimlane_id: SWIMLANE.id,
      position: 0,
      version: CARD.version,
    })
    await expect(page.getByPlaceholder('Card title…')).toHaveCount(0)

    await expect.poll(async () => {
      const box = await cardEl.boundingBox()
      return box ? box.x : null
    }, { timeout: 5_000 }).not.toBeNull()
    const movedCardBox = await cardEl.boundingBox()
    if (!movedCardBox) throw new Error('Could not locate card after the move')
    expect(movedCardBox.x).toBeGreaterThan(cardBox.x + 50)
    expect(Math.abs(movedCardBox.x - doneBox.x)).toBeLessThan(150)
  })
})
