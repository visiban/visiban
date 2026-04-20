/**
 * Shared helpers for Playwright E2E tests.
 *
 * routeAuth()  — mocks the authenticated-user endpoints so tests can skip
 *               the login flow and navigate directly to protected pages.
 * routeBoard() — mocks all board-detail endpoints for a given board fixture.
 *
 * All route patterns use ** so they match regardless of the origin
 * (http://localhost:8000 in dev, any host in CI).
 */

import type { Page } from '@playwright/test'
import { USER, BOARD_FULL, BOARD_LIST_ITEM, SITE_CONFIG, AUTH_PROVIDERS } from './fixtures/board'

export async function routeAuth(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/user/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) }),
  )
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) }),
  )
  await page.route('**/api/v1/auth/site-config/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SITE_CONFIG) }),
  )
  await page.route('**/api/v1/auth/providers/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_PROVIDERS) }),
  )
  await page.route('**/api/v1/version/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '1.1.0' }) }),
  )
  // Notifications and boards list needed for the sidebar / dashboard
  await page.route('**/api/v1/notifications/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
  )
  await page.route('**/api/v1/boards/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [BOARD_LIST_ITEM] }) }),
  )
  await page.route('**/api/v1/groups/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
  )
}

export async function routeBoard(page: Page, board = BOARD_FULL): Promise<void> {
  await page.route(`**/api/v1/boards/${board.id}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${board.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: board.cards.length, results: board.cards }) }),
  )
  await page.route(`**/api/v1/boards/${board.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
  )
  // WebSocket stub — sends a connected event immediately so the board does not
  // render in "disconnected" state during tests.
  await page.routeWebSocket(`**/ws/boards/${board.id}/`, (ws) => {
    ws.onopen(() => ws.send(JSON.stringify({ event: 'connected', data: {} })))
  })
}
