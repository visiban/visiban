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
  })

  test('opens card detail when a card is clicked', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    // Description should be rendered.
    await expect(page.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
  })

  test('shows the card description in the detail panel', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
  })

  test('updates the card title inline', async ({ page }) => {
    const updatedCard = { ...CARD, title: 'Updated title' }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, async (route) => {
      if (route.request().method() === 'PATCH') {
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

    await expect(page.getByText('Updated title').first()).toBeVisible({ timeout: 5_000 })
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
