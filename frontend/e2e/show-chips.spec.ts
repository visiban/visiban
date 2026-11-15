import { test, expect } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2272: the Show chips quick-view. The board is mocked with one overdue card
// and one calm card; the chip narrows the grid and travels in the page address.
const OVERDUE = { ...CARD, id: 11, uid: 'card00011ov', title: 'Overdue task', due_date: '2020-01-01', position: 0 }
const CALM = { ...CARD, id: 12, uid: 'card00012ca', title: 'Calm task', due_date: null, position: 1 }

test.describe('Show chips', () => {
  test('Overdue chip keeps only overdue cards and writes ?show=overdue; All cards clears it', async ({ page }) => {
    await routeAuth(page)
    const cards = [OVERDUE, CALM]
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...BOARD_FULL, cards }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CALM.title).first()).toBeVisible({ timeout: 10_000 })

    const overdueChip = page.getByRole('button', { name: /^Overdue 1 card$/ })
    await overdueChip.click()
    await expect(page).toHaveURL(/[?&]show=overdue\b/)
    await expect(page.getByText(OVERDUE.title).first()).toBeVisible()
    await expect(page.getByText(CALM.title)).toHaveCount(0)

    await page.getByRole('button', { name: /^All cards/ }).click()
    await expect(page).not.toHaveURL(/show=/)
    await expect(page.getByText(CALM.title).first()).toBeVisible()
  })
})
