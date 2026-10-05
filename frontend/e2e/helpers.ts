/**
 * Shared helpers for Playwright E2E tests.
 *
 * routeAuth()  — mocks the authenticated-user endpoints so tests can skip
 *               the login flow and navigate directly to protected pages.
 * routeBoard() — mocks all board-detail endpoints for a given board fixture.
 * END_OF_LINE  — the key that moves an editor's caret to the end of its line
 *               on the host platform (see its comment before using bare 'End').
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
  // Boards list — the sidebar calls both GET /boards/ and GET /boards/?starred=true.
  // Match both with an explicit starred handler and a fallback for the bare list.
  await page.route(/\/api\/v1\/boards\/(\?starred=true)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [BOARD_LIST_ITEM] }) }),
  )
  await page.route(/\/api\/v1\/groups\/(\?starred=true)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
  )
}

export async function routeBoard(page: Page, board = BOARD_FULL): Promise<void> {
  await page.route(`**/api/v1/boards/${board.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${board.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: board.cards.length, results: board.cards }) }),
  )
  // The saved-filters endpoint returns a bare array (not paginated).
  await page.route(`**/api/v1/boards/${board.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  // WebSocket stub — sends a connected event immediately so the board does not
  // render in "disconnected" state during tests.
  await page.routeWebSocket(`**/ws/boards/${board.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
}

/**
 * The key that moves a text caret to the end of its line, on the platform the
 * browser runs on. Use it instead of a bare `'End'` in editor specs.
 *
 * Why it differs: on a macOS host, Playwright's Chromium driver attaches the
 * native Cocoa editing command to each key (`macEditingCommands` in
 * playwright-core), and macOS binds End to `scrollToEndOfDocument:` — a
 * smooth scroll of the nearest scroll container to its bottom that does not
 * move the caret. Linux (CI) has no such binding, so End moves the caret to
 * the end of the line there. A spec that presses End therefore scrolls the
 * card panel to its bottom only on a developer's Mac, and any text typed
 * during that animation is inserted while the caret is still visible, so
 * ProseMirror's scroll-into-view has nothing to correct (#1475).
 * Cmd+ArrowRight is macOS's `moveToRightEndOfLine:`.
 */
export const END_OF_LINE = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'
