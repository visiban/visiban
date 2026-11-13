import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, COLUMN_TODO, SWIMLANE } from './fixtures/board'

test.describe('card detail', () => {
  // Desktop Chrome is exactly 1280px wide, the anchored/docked boundary of the
  // card detail sheet (#1914). Pin a viewport that is unambiguously anchored.
  test.use({ viewport: { width: 1600, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    // Card detail endpoint returns the full card shape.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/movements/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/comments/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/activity/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/checklist/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/attachments/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    // CardRelationsSection fetches this unconditionally on mount. Without a
    // mock it falls through to the real backend at localhost:8000 (reachable
    // in this dev environment) and gets a 401, which trips the app's
    // logout-on-401 handling and bounces the whole page to the sign-in
    // screen — every test in this file failed at the dialog-visible
    // assertion until this was added, not just the ones #1401 touched.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/relations/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    // Block history (#1149): the block section fetches it on open, same 401 trap.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/blocks/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
  })

  test('opens card detail when a card is clicked', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    // Description should be rendered.
    await expect(page.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
  })

  // Replaces the former "shows the card description in the detail panel" test,
  // which only re-asserted what "opens card detail" above already covers.
  // This exercises the edit → PATCH payload → reopen → persisted-value flow
  // that was previously missing: the old version of this test asserted only
  // that the new title became visible, which an optimistic-only local update
  // (with no real PATCH, or the wrong PATCH body) would also satisfy.
  test('updates the card title inline, sends the correct PATCH body, and persists across reopen', async ({ page }) => {
    const updatedCard = { ...CARD, title: 'Updated title' }
    let patchRequestBody: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchRequestBody = JSON.parse(route.request().postData() ?? '{}')
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updatedCard) })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })

    // Find the title field in the detail panel and update it.
    const titleField = page.locator('#card-detail-title')
    await titleField.fill('Updated title')
    await titleField.press('Enter')

    // Assert the actual PATCH payload (api/cards.ts updateCard) — only the
    // title field should be sent.
    await expect.poll(() => patchRequestBody, { timeout: 5_000 }).toEqual({ title: 'Updated title' })

    await expect(page.getByText('Updated title').first()).toBeVisible({ timeout: 5_000 })

    // Reopen the card and assert the persisted representation. CardDetail's
    // `card` prop comes from the board's in-memory card list (updated via the
    // PATCH response above, not a fresh GET /cards/{id}/ — there is no such
    // fetch on open), so this proves the server response actually landed in
    // board state rather than only in a transient local edit.
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.getByText('Updated title').first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('#card-detail-title')).toHaveValue('Updated title')
  })

  test('unified activity timeline renders a move entry', async ({ page }) => {
    // Feed a canned timeline response so the Activity tab has something to render.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/timeline/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          results: [
            {
              kind: 'move',
              ts: '2026-04-20T09:00:00Z',
              event_type: 'card_moved',
              actor: { id: 1, username: 'testuser', display_name: 'Test User', avatar_url: '' },
              data: {
                id: 500,
                card: CARD.id,
                from_column: 1,
                from_column_name: 'To Do',
                to_column: 2,
                to_column_name: 'Done',
                user: { id: 1, username: 'testuser', display_name: 'Test User', avatar_url: '' },
                created_at: '2026-04-20T09:00:00Z',
              },
            },
          ],
        }),
      }),
    )

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })

    await page.getByRole('tab', { name: 'activity' }).click()

    // The timeline dot/label pair should render the move as "From → To"; scope
    // to the dialog so we don't collide with the "Done" column header on the
    // board behind the open card detail.
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByText('To Do → Done')).toBeVisible({ timeout: 5_000 })
  })

  test('unblocking shows the outcome as a success toast that clears itself (#2060)', async ({ page }) => {
    const blockedAt = new Date(Date.now() - (3 * 86400 + 5 * 3600 + 60) * 1000).toISOString()
    const blocked = { ...CARD, is_blocked: true, blocked_at: blockedAt, blocked_reason: 'Waiting on vendor' }
    await routeBoard(page, { ...BOARD_FULL, cards: BOARD_FULL.cards.map((c) => (c.id === CARD.id ? blocked : c)) })
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocked) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/unblock/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...CARD, version: CARD.version + 1 }) }),
    )

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByTestId('card-blocked-banner')).toBeVisible({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Unblock', exact: true }).click()
    await dialog.getByRole('button', { name: 'Unblock card' }).click()

    const toast = page.getByRole('region', { name: 'Notifications' }).getByTestId('unblock-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText(`Unblocked "${CARD.title}" after 3d 5h`)
    await expect(dialog.getByTestId('card-blocked-banner')).toHaveCount(0)
    // success: 4 s, then it leaves on its own.
    await expect(toast).toHaveCount(0, { timeout: 8_000 })
  })

  // The Move-blocked toast is outside the panel's focus trap (#1732; there is
  // no backdrop since #1914, but the trap stands), so an admin overrides a
  // limit from the Move popover itself (#1772). Keyboard-only from the failure
  // on: the override must be reachable with Tab inside the trap.
  test('admin overrides a WIP limit from the Move popover by keyboard', async ({ page }) => {
    const moveUrls: string[] = []
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/move\/(\?.*)?$/, (route) => {
      const url = route.request().url()
      moveUrls.push(url)
      if (url.includes('force=true')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ card: { ...CARD, column: COLUMN_DONE.id, position: 0, version: CARD.version + 1 } }),
        })
      }
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'wip_limit_exceeded', column_name: COLUMN_DONE.name, current_count: 3, wip_limit: 3 }),
      })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await dialog.getByRole('button', { name: 'Move card to different column or swimlane' }).click()
    const popover = dialog.locator('div.fixed.w-64')
    await expect(popover.getByText('Move to')).toBeVisible()
    await popover.getByRole('combobox').filter({ hasText: COLUMN_TODO.name }).click()
    await page.getByRole('option', { name: COLUMN_DONE.name }).click()
    await popover.getByRole('button', { name: 'Move', exact: true }).click()

    await expect(popover.getByRole('alert')).toContainText(`"${COLUMN_DONE.name}" has reached its limit.`)
    await expect(popover.getByRole('alert')).toContainText('Limit 3 cards, 3 active.')
    const override = popover.getByRole('button', { name: 'Move anyway (admin override)' })
    await expect(override).toBeVisible()
    // The shared toast region mirrors the refusal behind the sheet (#2060);
    // the popover's inline alert stays the one announcement.
    const mirror = page.getByRole('region', { name: 'Notifications' }).getByTestId('move-blocked-toast')
    await expect(mirror).toContainText('WIP limit reached')

    // Nothing is auto-focused when the failure appears, and the clicked Move
    // button was disabled while its request ran, so focus has no reliable
    // keyboard starting point. Anchor it on the first popover control, then
    // keyboard only: pin the designed Tab order (Swimlane, Column, Move anyway,
    // Cancel, Move) forward, walk back to the override, and press Enter.
    const swimlaneSelect = popover.getByRole('combobox').filter({ hasText: SWIMLANE.name })
    const columnSelect = popover.getByRole('combobox').filter({ hasText: COLUMN_DONE.name })
    const cancel = popover.getByRole('button', { name: 'Cancel' })
    const moveSubmit = popover.getByRole('button', { name: 'Move', exact: true })
    await swimlaneSelect.focus()
    await expect(swimlaneSelect).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(columnSelect).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(override).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(moveSubmit).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(override).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(popover).toHaveCount(0)
    expect(moveUrls).toHaveLength(2)
    expect(moveUrls[0]).not.toContain('force=true')
    expect(moveUrls[1]).toContain('force=true')
    await expect(dialog.getByTitle(COLUMN_DONE.name)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Move card to different column or swimlane' })).toBeFocused()
    // The forced move cleared the refusal, so its mirror left the region.
    await expect(mirror).toHaveCount(0)
  })
})

// #1914 — the card detail sheet's placement, swap, close and focus return.
// Same column, below the first card: the anchored sheet covers the next column.
const CARD_TWO = { ...CARD, id: 2, uid: 'card000002b', title: 'Second task', position: 1 }
const TWO_CARD_BOARD = { ...BOARD_FULL, cards: [CARD, CARD_TWO] }

/** Waits for the sheet's open/swap transition, which moves its box while it runs. */
async function settled(dialog: Locator) {
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)))
  return (await dialog.boundingBox())!
}

/** Records every card move request; answers each with the card in place. */
async function recordMoves(page: Page): Promise<string[]> {
  const moves: string[] = []
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/move\/(\?.*)?$/, (route) => {
    moves.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...CARD_TWO, position: 0, version: 2 } }) })
  })
  return moves
}

/** A mouse drag of `card` to just above `target` (dnd-kit needs > 5px of travel). */
async function dragAbove(page: Page, card: Locator, target: Locator) {
  const from = (await card.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + 20, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y + from.height / 2 - 10, { steps: 4 })
  await page.mouse.move(to.x + 20, to.y + 4, { steps: 10 })
  await page.mouse.up()
}

async function routeTwoCardBoard(page: Page) {
  await routeAuth(page)
  await routeBoard(page, TWO_CARD_BOARD)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|movements|blocks)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
}

test.describe('card detail sheet — anchored (>= 1280px)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })
  test.beforeEach(async ({ page }) => { await routeTwoCardBoard(page) })

  test('opens beside the card, swaps on another card click, closes on empty space and returns focus', async ({ page }) => {
    const moveRequests = await recordMoves(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    const second = page.locator(`[data-card-id="${CARD_TWO.id}"]`)
    await expect(first).toBeVisible({ timeout: 10_000 })
    await first.click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'anchored')
    await expect(dialog).toHaveAttribute('data-sheet-side', 'right')
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(first).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('card-sheet-notch')).toBeAttached()
    // #1946: real-browser checks jsdom cannot make. The tail paints a visible brand color, the
    // root stays overflow-visible so it can sit outside, and the inner wrapper clips with the
    // border's inner radius (anchored only).
    const tail = await page.getByTestId('card-sheet-notch').evaluate((el) => {
      const root = el.parentElement!
      const wrapper = el.nextElementSibling as HTMLElement
      return {
        fill: getComputedStyle(el).fill,
        rootOverflow: getComputedStyle(root).overflow,
        rootShadow: getComputedStyle(root).boxShadow,
        rootBorder: getComputedStyle(root).borderTopColor,
        wrapperRadius: getComputedStyle(wrapper).borderTopLeftRadius,
        wrapperOverflow: getComputedStyle(wrapper).overflow,
      }
    })
    // Right-side sheet only (asserted above): the tail sits on the sheet's left edge. The 7px SVG box
    // spans 6px outside the border box to 1px inside it; the apex is 5px outside, 1px clear of the column.
    const tailBox = (await page.getByTestId('card-sheet-notch').boundingBox())!
    const dlg = (await dialog.boundingBox())!
    expect(tailBox.x).toBeLessThan(dlg.x)
    expect(tailBox.x + tailBox.width).toBeGreaterThan(dlg.x)
    expect(Math.abs((tailBox.x + tailBox.width) - (dlg.x + 1))).toBeLessThanOrEqual(1.5)
    expect(tail.fill).not.toMatch(/none|rgba\(0, 0, 0, 0\)/)
    expect(tail.fill).toBe(tail.rootBorder)
    expect(tail.rootOverflow).toBe('visible')
    expect(tail.rootShadow).not.toBe('none')
    expect(tail.wrapperRadius).toBe('7px')
    expect(tail.wrapperOverflow).toBe('hidden')

    // 6px from the column's edge, 14px from the card's (cells pad by 8px).
    const cardBox = (await first.boundingBox())!
    const sheetBox = await settled(dialog)
    expect(Math.abs(sheetBox.x - (cardBox.x + cardBox.width + 14))).toBeLessThanOrEqual(2)
    expect(sheetBox.width).toBe(540)

    // Swap: the click on another card passes through and replaces the sheet.
    await second.click()
    await expect(page.locator('#card-detail-title')).toHaveValue(CARD_TWO.title)
    await expect(page.getByRole('dialog', { name: /./ })).toHaveCount(1)
    await expect(second).toHaveAttribute('aria-current', 'true')
    await expect(first).not.toHaveAttribute('aria-current', 'true')
    // Drag-and-drop is suspended while the sheet is open: dragging the second
    // card above the first sends no move and leaves the order as it was. (The
    // same drag with the sheet closed does move it; see the next test.)
    await dragAbove(page, second, first)
    await page.waitForTimeout(300)
    expect(moveRequests).toHaveLength(0)
    expect((await second.boundingBox())!.y).toBeGreaterThan((await first.boundingBox())!.y)
    await expect(page.locator('#card-detail-title')).toHaveValue(CARD_TWO.title)

    // Empty board space closes it, and the click does not also start an
    // inline "add card" underneath; focus returns to the most recent card.
    await page.mouse.click(300, 860)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByPlaceholder('Card title…')).toHaveCount(0)
    await expect(second).toBeFocused()
    await expect(second).not.toHaveAttribute('aria-current', 'true')
  })

  // Control for the drag-suspended check above: with no sheet open the very
  // same drag sends a move, so that check cannot pass vacuously.
  test('the same drag moves the card when no sheet is open', async ({ page }) => {
    const moveRequests = await recordMoves(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    const second = page.locator(`[data-card-id="${CARD_TWO.id}"]`)
    await expect(second).toBeVisible({ timeout: 10_000 })
    await dragAbove(page, second, first)
    await expect.poll(() => moveRequests.length, { timeout: 5_000 }).toBeGreaterThan(0)
  })

  test('Escape closes one layer at a time and returns focus to the card', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    await first.click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Move card to different column or swimlane' }).click()
    await expect(dialog.getByText('Move to')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog.getByText('Move to')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(first).toBeFocused()
  })
})

test.describe('card detail sheet — docked (641-1279px)', () => {
  test.use({ viewport: { width: 1024, height: 768 } })
  test.beforeEach(async ({ page }) => { await routeTwoCardBoard(page) })

  test('docks to the right edge with a light backdrop', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    await first.click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'docked')
    const box = await settled(dialog)
    expect(box.x + box.width).toBe(1024)
    expect(box.width).toBe(540)
    await expect(page.getByTestId('card-detail-backdrop')).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(first).toBeFocused()
  })
})

test.describe('card detail sheet — Dock to edge (#1915)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })
  test.beforeEach(async ({ page }) => { await routeTwoCardBoard(page) })

  test('docks on toggle, persists across a reload, keeps the mode on a card swap, and toggles back', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    const second = page.locator(`[data-card-id="${CARD_TWO.id}"]`)
    await first.click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'anchored')
    const toggle = dialog.getByRole('button', { name: 'Dock to edge' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'docked')
    const box = await settled(dialog)
    expect(box.x + box.width).toBe(1600)
    await expect(dialog.getByRole('button', { name: 'Open next to card' })).toHaveAttribute('aria-pressed', 'true')

    // A card swap keeps the chosen mode.
    await second.click()
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'docked')

    // Persists across a reload.
    await page.reload()
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    await expect(page.getByRole('dialog', { name: /./ })).toHaveAttribute('data-sheet-mode', 'docked')

    await page.getByRole('dialog', { name: /./ }).getByRole('button', { name: 'Open next to card' }).click()
    await expect(page.getByRole('dialog', { name: /./ })).toHaveAttribute('data-sheet-mode', 'anchored')
  })

  test('focus opens on Close and Shift+Tab reaches the toggle', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Dock to edge' })).toBeFocused()
  })

  test.describe('reduced motion', () => {
    test('toggling still docks the sheet', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(`/boards/${BOARD_FULL.id}`)
      await page.locator(`[data-card-id="${CARD.id}"]`).click()
      const dialog = page.getByRole('dialog', { name: /./ })
      await dialog.getByRole('button', { name: 'Dock to edge' }).click()
      await expect(dialog).toHaveAttribute('data-sheet-mode', 'docked')
    })
  })
})

test.describe('card detail sheet — Dock to edge hidden at <= 640px (#1915)', () => {
  test.use({ viewport: { width: 640, height: 900 } })
  test.beforeEach(async ({ page }) => { await routeTwoCardBoard(page) })

  test('has no toggle in full-screen', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'fullscreen')
    await expect(dialog.getByRole('button', { name: /Dock to edge|Open next to card/ })).toHaveCount(0)
  })
})

test.describe('card detail sheet — full-screen (<= 640px)', () => {
  test.use({ viewport: { width: 600, height: 900 } })
  test.beforeEach(async ({ page }) => { await routeTwoCardBoard(page) })

  test('fills the screen with a Board back control that returns focus to the card', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    await first.click()
    const dialog = page.getByRole('dialog', { name: /./ })
    await expect(dialog).toHaveAttribute('data-sheet-mode', 'fullscreen')
    const box = await settled(dialog)
    expect(Math.round(box.width)).toBe(600)
    const back = dialog.getByRole('button', { name: 'Back to board' })
    expect((await back.boundingBox())!.height).toBe(44)
    await back.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(first).toBeFocused()
  })
})
