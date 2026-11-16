import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Phone layout (#2277): one column at a time, lanes stacked, 44px targets.
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

  test('has no sideways page scroll and every control is at least 44px', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const small = await page.evaluate(() => {
      const out: string[] = []
      const roots = ['[data-testid="phone-board"]', '[data-testid="show-chips"]']
      for (const sel of roots) {
        document.querySelectorAll(`${sel} button, ${sel} [role="tab"], ${sel} input`).forEach((el) => {
          // The card face is the shared CardItem; its controls are checked separately below.
          if (el.closest('[data-card-id]')) return
          const r = (el as HTMLElement).getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          if (Math.min(r.width, r.height) < 43.5) out.push(`${el.tagName} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`)
        })
      }
      return out
    })
    expect(small).toEqual([])
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
    await page.mouse.up()
    await expect(card).toBeVisible()
    await expect(page.getByTestId('phone-column-switcher').getByRole('tab', { name: /To Do, 1 card/ })).toBeVisible()
    const after = await card.boundingBox()
    expect(after!.y).toBeCloseTo(before!.y, 0)
  })

  test('captures the phone board in light and dark for the side-by-side review', async ({ page }) => {
    for (const scheme of ['dark', 'light'] as const) {
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark')
        document.documentElement.setAttribute('data-theme', t)
      }, scheme)
      await page.screenshot({ path: `test-results/board-phone-${scheme}.png`, fullPage: true })
    }
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
