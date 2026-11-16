import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL } from './fixtures/board'

// #2310: at phone width the header cue collapses to "18d" and its tooltip is
// unreachable on touch, so the popover must carry the full sentence.
test.describe('health review cue on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the popover shows the full cue text and the confirm hint', async ({ page }) => {
    const day = 86_400_000
    const board = {
      ...BOARD_FULL,
      health_status: 'at_risk',
      effective_health_status: 'at_risk',
      health_status_changed_at: new Date(Date.now() - 18 * day).toISOString(),
      health_review_due_at: new Date(Date.now() - day).toISOString(),
    } as unknown as typeof BOARD_FULL
    await routeAuth(page)
    await routeBoard(page, board)
    await page.goto(`/boards/${board.id}`)
    const cue = page.locator('[data-health-review-cue]').first()
    await expect(cue).toBeVisible({ timeout: 10_000 })
    await expect(cue).toContainText('18d')
    await page.getByRole('button', { name: /^Health status:/ }).first().click()
    await expect(page.getByTestId('health-review-cue-text')).toContainText('Not reviewed in 18 days')
    await expect(page.getByTestId('health-review-cue-text')).toBeInViewport()
  })
})
