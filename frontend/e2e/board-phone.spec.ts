import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_TODO, COLUMN_DONE, SWIMLANE } from './fixtures/board'

// Phone layout (#2277): one column at a time, lanes stacked, 44px targets in the board body.
test.describe('board phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
  })

  test('switches columns and shows only the selected column\'s cards', async ({ page }) => {
    const switcher = page.getByTestId('phone-column-switcher')
    const todo = switcher.getByRole('tab', { name: /To Do/ })
    const done = switcher.getByRole('tab', { name: /Done/ })
    await expect(todo).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await done.click()
    await expect(done).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
  })

  test('collapses and expands a lane', async ({ page }) => {
    const lane = page.getByRole('button', { name: /Collapse lane/ })
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await lane.click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
    await page.getByRole('button', { name: /Expand lane/ }).click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
  })

  test('has no sideways page scroll and every board-body control is at least 44px', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const small = await page.evaluate(() => {
      const out: string[] = []
      // The board body only. The app header and the board toolbar sit outside these roots:
      // their 44px targets (icon buttons, four-tab strip) are #2333, not built yet.
      const roots = ['[data-testid="phone-board"]', '[data-testid="show-chips"]']
      for (const sel of roots) {
        document.querySelectorAll(`${sel} button, ${sel} [role="tab"], ${sel} input`).forEach((el) => {
          // Inside a card face: the face itself is the 44px target (asserted below). Its select
          // checkbox stays 16px, a recorded exception (frontend/CLAUDE.md § Phone layout).
          if (el.closest('[data-card-id]')) return
          const r = (el as HTMLElement).getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          if (Math.min(r.width, r.height) < 43.5) out.push(`${el.tagName} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`)
        })
      }
      return out
    })
    expect(small).toEqual([])
    const faces = await page.locator('[data-testid="phone-board"] [data-card-id]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    expect(faces.length).toBeGreaterThan(0)
    for (const h of faces) expect(h).toBeGreaterThanOrEqual(43.5)
  })

  test('adds a card to a lane and Edit swimlane opens the modal', async ({ page }) => {
    let body: Record<string, unknown> | null = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      body = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...CARD, id: 77, uid: 'card000077z', title: 'Phone card', position: 5 }) })
    })
    await page.getByRole('button', { name: /^\+?\s*Add card/ }).first().click()
    await page.getByLabel(/New card title/).fill('Phone card')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('[data-card-id="77"]')).toBeVisible()
    expect(body).toMatchObject({ column: 1, swimlane: 1, title: 'Phone card' })

    await page.getByRole('button', { name: /^Edit swimlane/ }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
  })

  test('Edit column opens the column modal; Add column and Add swimlane are reachable', async ({ page }) => {
    await page.getByTestId('phone-column-actions').click()
    await expect(page.getByRole('dialog').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '+ Add column' })).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Add swimlane' })).toBeVisible()
  })

  test('dragging a card does nothing at phone width', async ({ page }) => {
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    const before = await card.boundingBox()
    await page.mouse.move(before!.x + 40, before!.y + 20)
    await page.mouse.down()
    await page.mouse.move(before!.x + 40, before!.y + 200, { steps: 10 })
    // Asserted mid-drag: with sensors on, the card would fade (opacity-25) and the
    // DragOverlay copy would render a second face with the same title.
    await expect(page.getByText(CARD.title, { exact: true })).toHaveCount(1)
    await expect(card).not.toHaveClass(/opacity-25/)
    await page.mouse.up()
    await expect(card).toBeVisible()
    await expect(page.getByTestId('phone-column-switcher').getByRole('tab', { name: /To Do, 1 card/ })).toBeVisible()
  })

  test('Move later reorders the column through the reorder endpoint', async ({ page }) => {
    let order: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/columns/reorder/`, (route) => {
      order = JSON.parse(route.request().postData() ?? '{}').order
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...COLUMN_DONE, position: 0 }, { ...COLUMN_TODO, position: 1 }]) })
    })
    const later = page.getByRole('button', { name: 'Move column To Do later' })
    await expect(page.getByRole('button', { name: 'Move column To Do earlier' })).toBeDisabled()
    await later.click()
    await expect.poll(() => order).toEqual([COLUMN_DONE.id, COLUMN_TODO.id])
    await expect(page.getByTestId('phone-column-switcher').getByRole('tab')).toHaveText([/Done/, /To Do/])
    await expect(page.getByRole('button', { name: 'Move column To Do later' })).toBeDisabled()
  })

  test('Move from the peek sheet moves the card to Done', async ({ page }) => {
    let moveBody: Record<string, unknown> | null = null
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/`, (route) => {
      moveBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...CARD, column: 2, swimlane: 1, position: 0 } }) })
    })
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await page.getByTestId('card-peek-move-form').locator('select').first().selectOption({ label: 'Done' })
    await page.getByRole('button', { name: 'Move card' }).click()
    await expect.poll(() => moveBody).toMatchObject({ column_id: 2 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tab', { name: /To Do, 0 cards/ })).toBeVisible()
  })

  test('Move later in the peek sheet moves the card down one place and it stays after the server frame', async ({ page }) => {
    // A0 B1 C2 D3 in one cell. The move endpoint reads `position` as a raw slot
    // (no same-cell compaction), so Move later on B sends C's position + 1 and the
    // server answers B 3, D 4: the order A C B D, which the optimistic update
    // must already show, so the card.moved frame changes nothing visible.
    const mk = (id: number, title: string, position: number) => ({ ...CARD, id, uid: `card00000${id}a`, title, position })
    const cards = [mk(1, 'Alpha task', 0), mk(2, 'Bravo task', 1), mk(3, 'Charlie task', 2), mk(4, 'Delta task', 3)]
    await routeBoard(page, { ...BOARD_FULL, cards } as unknown as typeof BOARD_FULL)
    let socket: { send: (m: string) => void } | null = null
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      socket = ws
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    let moveBody: Record<string, unknown> | null = null
    const movedB = { ...cards[1], position: 3, version: (cards[1].version ?? 1) + 1 }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/2/move/`, (route) => {
      moveBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: movedB, movement: null }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const faces = page.locator('[data-testid="phone-board"] [data-card-id]')
    await expect(faces).toHaveCount(4)
    const ids = () => faces.evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id')))
    expect(await ids()).toEqual(['1', '2', '3', '4'])
    // Record every order the lane renders from here on, to catch a flash.
    await page.evaluate(() => {
      const w = window as unknown as { __orders: string[] }
      const read = () => Array.from(document.querySelectorAll('[data-testid="phone-board"] [data-card-id]')).map((el) => el.getAttribute('data-card-id')).join('')
      w.__orders = [read()]
      const root = document.querySelector('[data-testid="phone-board"]')!
      new MutationObserver(() => {
        const o = read()
        if (w.__orders[w.__orders.length - 1] !== o) w.__orders.push(o)
      }).observe(root, { childList: true, subtree: true })
    })
    await page.locator('[data-card-id="2"]').click()
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Move later' }).click()
    await expect.poll(() => moveBody).toMatchObject({ column_id: 1, swimlane_id: 1, position: 3 })
    await expect.poll(ids).toEqual(['1', '3', '2', '4'])
    await expect.poll(() => socket !== null).toBe(true)
    socket!.send(JSON.stringify({
      event: 'card.moved', event_id: 501,
      data: { card: movedB, movement: null, sibling_positions: [{ id: 4, position: 4, version: cards[3].version ?? 1 }] },
    }))
    // A later frame with a visible effect: once it shows, the card.moved frame
    // before it (same socket, in order) has been applied.
    socket!.send(JSON.stringify({ event: 'card.updated', data: { ...cards[0], title: 'Alpha renamed', version: 2 } }))
    await expect(page.getByText('Alpha renamed')).toBeVisible()
    expect(await ids()).toEqual(['1', '3', '2', '4'])
    expect(await page.evaluate(() => (window as unknown as { __orders: string[] }).__orders)).toEqual(['1234', '1324'])
  })

  test('the empty-board Add card opens the input on phones', async ({ page }) => {
    const empty = { ...BOARD_FULL, cards: [] }
    await routeBoard(page, empty as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByTestId('board-empty-state').getByRole('button', { name: /Add a card/ }).click()
    await expect(page.getByLabel(/New card title/)).toBeVisible()
  })

  test('lane band second line: fields, +N, lane WIP; one 44px collapse target (#2329)', async ({ page }) => {
    const def = (id: number, name: string, field_type = 'text') => ({
      id, uid: `sfd0000${id}x`, name, field_type, choices: [], position: id, show_on_row: false,
      is_admin_only: false, choice_colors: {}, number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01T00:00:00Z',
    })
    const lane = {
      ...SWIMLANE,
      name: 'North America with a long lane name that wraps on a phone',
      wip_limit: 0,
      custom_field_values: [{ field_definition: 1, value: 'Avery Brooks' }, { field_definition: 2, value: '600000' }, { field_definition: 3, value: 'West' }],
    }
    const board = { ...BOARD_FULL, swimlanes: [lane], swimlane_custom_field_definitions: [def(1, 'Owner'), def(2, 'Quota', 'number'), def(3, 'Region')] }
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const band = page.getByTestId('phone-lane-band')
    const details = band.getByTestId('phone-lane-band-details')
    await expect(details).toContainText('Avery Brooks')
    await expect(details).toContainText('600000')
    await expect(details).not.toContainText('West')
    await expect(band.getByTestId('swimlane-limit-stat')).toHaveText(/WIP \d+ \/ 0 over/)
    // One collapse target, at least 44px tall; the second line is outside it.
    const toggle = band.getByRole('button', { name: /Collapse lane/ })
    await expect(band.locator('[aria-expanded]').filter({ has: page.locator('svg') })).toHaveCount(1)
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    await expect(toggle.getByTestId('phone-lane-band-details')).toHaveCount(0)
    const more = band.getByRole('button', { name: /^\+1:/ })
    const box = (await more.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5)
    await more.click()
    await expect(details).toContainText('West')
    await expect(band.getByRole('button', { name: /^Less:/ })).toHaveAttribute('aria-expanded', 'true')
    // The long name wraps rather than pushing the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await toggle.click()
    await expect(page.getByRole('button', { name: /Expand lane/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
