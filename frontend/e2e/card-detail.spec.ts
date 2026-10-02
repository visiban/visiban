import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.describe('card detail', () => {
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
})
