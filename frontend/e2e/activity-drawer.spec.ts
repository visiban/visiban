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
    await expect(page.getByRole('button', { name: 'Filter activity' })).toBeVisible()
    await expect(page.getByText('Live · board events')).toHaveCount(0)
    // #2274: one drawer, two tabs; Recent is selected on open.
    await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Archived' })).toBeVisible()
  })

  test('floats over the board: the grid does not resize when the drawer opens (#2274)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    const scroll = page.locator('[data-board-scroll]')
    const before = await scroll.evaluate((el) => el.getBoundingClientRect().width)
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer).toBeVisible()
    const after = await scroll.evaluate((el) => el.getBoundingClientRect().width)
    expect(after).toBe(before)
    const box = await drawer.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440)
    await page.screenshot({ path: process.env.DRAWER_SHOT ?? 'test-results/activity-drawer-1440.png' })
  })

  test('populated feed renders in both themes at 1440px for visual parity (#2316)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await routeAuth(page)
    const mk = (id: number, title: string, column: number) => ({
      ...CARD, id, uid: `card0000${id}a`, title, column, last_moved_at: new Date().toISOString(),
    })
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
        ws.send(JSON.stringify({ event: 'card.created', data: mk(98, 'Zurich Insurance renewal', 1) }))
        ws.send(JSON.stringify({ event: 'card.created', data: mk(99, 'Draft onboarding checklist', 1) }))
      }, 200)
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer.getByText('Zurich Insurance renewal')).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText('Draft onboarding checklist')).toBeVisible()
    const dir = process.env.DRAWER_SHOT_DIR ?? 'test-results'
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: `${dir}/activity-drawer-populated-${theme}-1440.png` })
    }
  })

  test('opens with the board\'s saved moves, not empty, on a fresh load (#2596)', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    const movedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    let query: URLSearchParams | null = null
    await page.route(/\/api\/v1\/boards\/\d+\/movements\/(\?.*)?$/, (route) => {
      query = new URL(route.request().url()).searchParams
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          count: 1, offset: 0, page_size: 50,
          results: [{
            id: 501, card_uid: 'card000501a', card_title: 'Seeded lease renewal',
            from_column: 1, from_column_name: 'To Do', from_column_uid: 'col1',
            to_column: 2, to_column_name: 'In Progress', to_column_uid: 'col2',
            from_swimlane: 1, from_swimlane_name: 'Default', from_swimlane_uid: 'sw1',
            to_swimlane: 1, to_swimlane_name: 'Default', to_swimlane_uid: 'sw1',
            moved_by: { id: 2, username: 'maya', display_name: 'Maya Chen', avatar_url: '' },
            moved_at: movedAt, notes: '', movement_type: 'move', imported_from_username: null,
          }],
        }),
      })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer.getByText('Seeded lease renewal')).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText('No activity yet')).toHaveCount(0)
    expect(query!.get('exclude_type')).toBe('archived,unarchived')
    expect(query!.get('moved_after')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  const savedMove = (id: number, title: string, movedAt: string) => ({
    id, card_uid: `card000${id}a`, card_title: title,
    from_column: 1, from_column_name: 'To Do', from_column_uid: 'col1',
    to_column: 2, to_column_name: 'In Progress', to_column_uid: 'col2',
    from_swimlane: 1, from_swimlane_name: 'Default', from_swimlane_uid: 'sw1',
    to_swimlane: 1, to_swimlane_name: 'Default', to_swimlane_uid: 'sw1',
    moved_by: { id: 2, username: 'maya', display_name: 'Maya Chen', avatar_url: '' },
    moved_at: movedAt, notes: '', movement_type: 'move', imported_from_username: null,
  })

  test('opens on 7 days when the board has no moves in the last 24 hours (#2596)', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    await page.route(/\/api\/v1\/boards\/\d+\/movements\/(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 1, offset: 0, page_size: 50, results: [savedMove(601, 'Quiet board renewal', threeDaysAgo)] }),
      }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer.getByText('Quiet board renewal')).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText('Nothing in the last 24 hours. Showing the last 7 days.')).toBeVisible()
    await expect(drawer.getByText('No activity yet')).toHaveCount(0)
    await drawer.getByRole('button', { name: /^Filter, 1 active/ }).click()
    await expect(drawer.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('a failed history load shows Retry, and Retry loads it (#2596)', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    let calls = 0
    await page.route(/\/api\/v1\/boards\/\d+\/movements\/(\?.*)?$/, (route) => {
      calls += 1
      if (calls === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 1, offset: 0, page_size: 50, results: [savedMove(602, 'Recovered renewal', new Date(Date.now() - 60_000).toISOString())] }),
      })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer.getByText(/load earlier activity/)).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText('No activity yet')).toHaveCount(0)
    await drawer.getByRole('button', { name: 'Retry' }).click()
    await expect(drawer.getByText('Recovered renewal')).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText(/load earlier activity/)).toHaveCount(0)
    await expect(drawer.getByRole('region', { name: 'Recent activity' })).toBeFocused()
    expect(calls).toBe(2)
  })

  test('is a full-height right edge panel at 390px (#2274)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByRole('button', { name: 'Open activity drawer' }).click({ timeout: 10_000 })
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer).toBeVisible()
    const box = await drawer.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    expect(box!.height).toBeGreaterThanOrEqual(799)
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
              custom_field_values: [],
              blocker_count: 0,
              is_blocked: false,
              blocked_at: null,
              blocked_reason: '',
            },
          }),
        )
      }, 200)
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+\\`)

    // #2316: the row's primary line is the card title, with "Created" beneath it.
    const drawer = page.getByRole('complementary', { name: 'Activity' })
    await expect(drawer.getByText('Remote-created card')).toBeVisible({ timeout: 3_000 })
    await expect(drawer.getByText('Created', { exact: true })).toBeVisible()

    // The kind filter lives behind the Filter button and works from the keyboard.
    const filter = drawer.getByRole('button', { name: 'Filter activity' })
    await filter.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Activity filters' })).toBeVisible()
    await page.getByRole('button', { name: 'Members', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(drawer.getByText('Remote-created card')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: 'Filter, 1 active' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Activity filters' })).toHaveCount(0)
    await expect(drawer).toBeVisible()
  })
})
