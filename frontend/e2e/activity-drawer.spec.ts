import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.describe('board activity drawer', () => {
  test('opens via Cmd+\\ shortcut and renders the Activity heading', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+\\`)

    // The toolbar toggle button reuses the "Close activity drawer" label when
    // the drawer is open, so scope the locator to the drawer's <aside> region.
    const drawer = page.getByRole('complementary').filter({ hasText: 'Activity' })
    await expect(drawer.getByRole('button', { name: 'Close activity drawer' })).toBeVisible({ timeout: 2_000 })
    await expect(page.getByRole('group', { name: 'Activity kind filter' })).toBeVisible()
  })

  test('WebSocket card.created event appears in the feed', async ({ page }) => {
    await routeAuth(page)
    // Custom WebSocket handler: emit a card.created event after the connected
    // handshake so BoardView's collectActivityEvent() pushes an entry.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [CARD] }) }),
    )
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            event: 'card.created',
            data: {
              id: 99,
              uid: 'card000099a',
              column: 1,
              swimlane: 1,
              title: 'Remote-created card',
              description: '',
              priority: 'medium',
              assignee: null,
              labels: [],
              due_date: null,
              weight: 1,
              position: 2,
              created_by: { id: 1, username: 'testuser', display_name: 'Test User', avatar_url: '' },
              created_at: '2026-04-22T12:00:00Z',
              updated_at: '2026-04-22T12:00:00Z',
              last_moved_at: null,
              attachment_count: 0,
              checklist_total: 0,
              checklist_done: 0,
              is_stale: false,
              archived_at: null,
              version: 1,
            },
          }),
        )
      }, 200)
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+\\`)

    // The drawer renders the activity headline text — `created <card title>`.
    await expect(page.getByText('created Remote-created card')).toBeVisible({ timeout: 3_000 })
  })
})
