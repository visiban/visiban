import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// #2180 — the overflow fades are absolute layers over the bottom (and top) of
// their scroll region. Without `scroll-padding` equal to the fade height, the
// browser scrolls a focused control to the region's edge, under the fade. Each
// case measures, in one page turn (the fade can unmount between two locator
// calls), that the focused control is clear of every fade.

const FADE = '.bg-gradient-to-t, .bg-gradient-to-b'

/** True when the element `el` does not intersect any gradient fade inside `root`. */
async function clearOfFades(page: Page, rootSelector: string) {
  return page.evaluate(({ rootSelector, FADE }) => {
    const root = document.querySelector(rootSelector)
    if (!root) return true
    const el = document.activeElement
    if (!el) return true
    const r = el.getBoundingClientRect()
    return Array.from(document.querySelectorAll(FADE)).every((veil) => {
      if (!root.contains(veil) && !veil.parentElement?.contains(el)) return true
      const v = veil.getBoundingClientRect()
      return r.bottom <= v.top + 0.5 || r.top >= v.bottom - 0.5
    })
  }, { rootSelector, FADE })
}

function dropdownField(id: number) {
  return {
    id, uid: `sfuid00000${id}`, name: `Owner ${id}`, field_type: 'dropdown', choices: ['Bob', 'Ed'], position: id,
    show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
    number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    created_at: '2026-01-01T00:00:00Z',
  }
}

test.describe('Overflow fades never cover the focused control (#2180)', () => {
  test.use({ viewport: { width: 1024, height: 420 } })

  test('Edit Swimlane body: tabbing down the fields', async ({ page }) => {
    const board = {
      ...BOARD_FULL,
      swimlane_custom_field_definitions: Array.from({ length: 10 }, (_, i) => dropdownField(i + 1)),
      swimlanes: [{ ...SWIMLANE, custom_field_values: [] }],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Edit swimlane' }).click({ force: true })
    const body = page.getByRole('region', { name: 'Swimlane settings' })
    await expect(body).toBeVisible()
    await body.locator('input').first().focus()
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      await expect.poll(() => clearOfFades(page, '[role="dialog"]')).toBe(true)
    }
  })

  test('Card detail body: tabbing down and back up', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith(`/cards/${CARD.id}/`) ? CARD : []) }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    await page.locator('#card-detail-title').focus()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      await expect.poll(() => clearOfFades(page, '[role="dialog"]')).toBe(true)
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => clearOfFades(page, '[role="dialog"]')).toBe(true)
    }
  })
})
