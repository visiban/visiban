import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.describe('board export', () => {
  test('admin sees the Export button and can open the export modal', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Export board' }).click()
    await expect(page.getByText('Export Board')).toBeVisible({ timeout: 2_000 })
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible()
  })

  test('clicking Export JSON triggers window.open with the correct URL', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)

    // Capture window.open calls — exportBoardJson() uses window.open(..., "_blank")
    // rather than a download/fetch, so we intercept that instead of a response.
    await page.addInitScript(() => {
      (window as unknown as { __opened: string[] }).__opened = []
      const original = window.open
      window.open = ((url?: string | URL, ...rest: unknown[]) => {
        (window as unknown as { __opened: string[] }).__opened.push(String(url ?? ''))
        // Return null to avoid popup blockers / about:blank noise in tests.
        void original; void rest
        return null
      }) as typeof window.open
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Export board' }).click()
    await page.getByRole('button', { name: 'Export JSON' }).click()

    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
    expect(opened.some((u) => u.includes(`/api/v1/boards/${BOARD_FULL.id}/export/`) && u.includes('format=json'))).toBe(true)

    // The modal surfaces a success message after a successful trigger.
    await expect(page.getByText('Download started')).toBeVisible({ timeout: 2_000 })
  })

  test('viewer without permission does not see the Export button', async ({ page }) => {
    await routeAuth(page)
    // Re-bind the board routes with a lower-privileged viewer and a
    // member-or-higher export gate.
    const lockedBoard = {
      ...BOARD_FULL,
      current_user_role: 'viewer' as const,
      export_min_role: 'member' as const,
    }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lockedBoard) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [CARD] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await expect(page.getByRole('button', { name: 'Export board' })).toHaveCount(0)
  })
})
