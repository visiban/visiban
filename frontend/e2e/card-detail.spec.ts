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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/comments/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/activity/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/checklist/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/attachments/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
    )
  })

  test('opens card detail when a card is clicked', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText(CARD.title).first().click()
    // Card detail panel or modal opens with the card title visible.
    await expect(page.getByText(CARD.title).first()).toBeVisible()
    // Description should be rendered.
    await expect(page.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
  })

  test('shows the card description in the detail panel', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
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

    // Find the title field in the detail panel and update it.
    const titleField = page.locator('#card-detail-title')
    await titleField.fill('Updated title')
    await titleField.press('Enter')

    await expect(page.getByText('Updated title').first()).toBeVisible({ timeout: 5_000 })
  })
})
