import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_TODO, COLUMN_DONE } from './fixtures/board'

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

  test('the empty-board Add card opens the input on phones', async ({ page }) => {
    const empty = { ...BOARD_FULL, cards: [] }
    await routeBoard(page, empty as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByTestId('board-empty-state').getByRole('button', { name: /Add a card/ }).click()
    await expect(page.getByLabel(/New card title/)).toBeVisible()
  })
})
