import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_LIST_ITEM, BOARD_USER, CARD, SWIMLANE } from './fixtures/board'

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

/**
 * Like `clearOfFades`, but reports WHY it is not clear so a case cannot pass
 * vacuously because the region did not overflow (#2186). Returns 'missing'
 * (root/focus target absent), 'no-fade' (nothing mounted), 'clear' or
 * 'covered'. `activeDescendant` measures the focused combobox's
 * aria-activedescendant option instead of the focused element, for the
 * focus-staying comboboxes.
 */
async function fadeState(page: Page, rootSelector: string, activeDescendant = false) {
  return page.evaluate(({ rootSelector, FADE, activeDescendant }) => {
    const root = document.querySelector(rootSelector)
    if (!root) return 'missing'
    const id = activeDescendant ? document.activeElement?.getAttribute('aria-activedescendant') : null
    const el = activeDescendant ? (id ? document.getElementById(id) : null) : document.activeElement
    if (!el) return 'missing'
    const r = el.getBoundingClientRect()
    const veils = Array.from(document.querySelectorAll(FADE)).filter(
      (veil) => root.contains(veil) || veil.parentElement?.contains(el) === true,
    )
    if (veils.length === 0) return 'no-fade'
    const clear = veils.every((veil) => {
      const v = veil.getBoundingClientRect()
      return r.bottom <= v.top + 0.5 || r.top >= v.bottom - 0.5
    })
    return clear ? 'clear' : 'covered'
  }, { rootSelector, FADE, activeDescendant })
}

/**
 * Presses `key` up to `steps` times, requiring the focused control to be clear
 * of every mounted fade after each press. A fade that unmounts after having
 * been mounted means the list reached its end (nothing left to cover), so the
 * walk stops there; the case still fails unless a fade was mounted at least
 * once, so it cannot pass on a region that never overflowed.
 */
async function walkClearOfFades(
  page: Page, key: string, steps: number, rootSelector: string, activeDescendant = false,
) {
  let seenFade = false
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key)
    let ended = false
    await expect.poll(async () => {
      const state = await fadeState(page, rootSelector, activeDescendant)
      if (state === 'clear') { seenFade = true; return true }
      if (state === 'no-fade' && seenFade) { ended = true; return true }
      return false
    }).toBe(true)
    if (ended) break
  }
  expect(seenFade, 'a fade must have been mounted at least once').toBe(true)
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith(`/cards/${CARD.id}/`) ? CARD : route.request().url().includes('/timeline/') ? { count: 0, next: null, previous: null, results: [] } : []) }),
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

  // --- #2186: the remaining hosts ---------------------------------------

  test('Edit Column modal body: tabbing down the settings fields', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText('To Do').first().dblclick()
    const body = page.getByRole('region', { name: 'Column settings' })
    await expect(body).toBeVisible()
    await body.locator('input').first().focus()
    await walkClearOfFades(page, 'Tab', 8, '[role="dialog"]')
  })

  test('Custom-field quick-edit popover: tabbing down the choices', async ({ page }) => {
    const choices = Array.from({ length: 30 }, (_, i) => `Choice ${i + 1}`)
    const def = { ...dropdownField(1), choices, show_on_card: true }
    const board = {
      ...BOARD_FULL,
      custom_field_definitions: [def],
      cards: [{ ...CARD, custom_field_values: [{ field_definition: 1, value: 'Choice 1' }] }],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Owner 1: Choice 1. Press Enter to edit.', exact: true }).click()
    await expect(page.getByTestId('custom-field-quick-edit-popover')).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="listbox"]'))).toBe(true)
    // Past the first screenful, so focus has to scroll the list.
    await walkClearOfFades(page, 'Tab', 28, '[data-testid="custom-field-quick-edit-popover"]')
  })

  test('Collapsed sidebar flyout: tabbing down the favorites', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('user:prefs:sidebar-collapsed', 'true'))
    await routeAuth(page)
    await routeBoard(page)
    const starred = Array.from({ length: 30 }, (_, i) => ({
      ...BOARD_LIST_ITEM, id: 100 + i, uid: `boardfav${String(i).padStart(4, '0')}`, name: `Favorite board ${i + 1}`, is_starred: true,
    }))
    await page.route(/\/api\/v1\/boards\/(\?starred=true)?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: starred.length, results: starred }) }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByRole('button', { name: 'Favorites' }).click()
    const flyout = page.getByRole('menu', { name: /favorites/i })
    await expect(flyout).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true)
    await walkClearOfFades(page, 'Tab', 12, '[role="menu"]')
  })

  test('Anchored filter menu: tabbing down a long assignee list', async ({ page }) => {
    const members = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      user: i === 0 ? BOARD_USER : { id: i + 1, username: `member${i}`, display_name: `Member ${i}`, avatar_url: '' },
      role: i === 0 ? ('admin' as const) : ('member' as const),
      is_moderator: false,
      joined_at: '2026-01-01T00:00:00Z',
    }))
    const cards = members.map((m, i) => ({ ...CARD, id: 100 + i, title: `Card ${i}`, assignee: m.user }))
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, members, cards } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText('Card 0').first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.getByRole('button', { name: /\+ filter/i }).click()
    await page.getByRole('checkbox', { name: /assignee/i }).check()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^assignee/i }).click()
    const menu = page.locator('[role="group"][aria-label="Assignee"]')
    await expect(menu).toBeVisible()
    await menu.getByRole('checkbox').first().focus()
    await walkClearOfFades(page, 'Tab', 14, '[data-anchored-menu]')
  })

  test('SingleSelectDropdown portal menu: arrowing down a long choice list', async ({ page }) => {
    const choices = Array.from({ length: 30 }, (_, i) => `Choice ${i + 1}`)
    const board = {
      ...BOARD_FULL,
      swimlane_custom_field_definitions: [{ ...dropdownField(1), choices }],
      swimlanes: [{ ...SWIMLANE, custom_field_values: [] }],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Edit swimlane' }).click({ force: true })
    await expect(page.getByText('Swimlane fields')).toBeVisible()
    const trigger = page.getByRole('button', { name: /— No value —/ })
    // Scroll first: a scroll after opening is an outside scroll and dismisses the menu.
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await walkClearOfFades(page, 'ArrowDown', 14, '[role="menu"]')
  })

  test('MultiSelectDropdown: arrowing down a long choice list in Card Detail', async ({ page }) => {
    const choices = Array.from({ length: 30 }, (_, i) => `Choice ${i + 1}`)
    const def = { ...dropdownField(1), name: 'Tags', field_type: 'multi_select', choices }
    const board = { ...BOARD_FULL, custom_field_definitions: [def] }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith(`/cards/${CARD.id}/`) ? CARD : route.request().url().includes('/timeline/') ? { count: 0, next: null, previous: null, results: [] } : []) }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    // The Custom fields section starts collapsed when no field has a value.
    await page.getByRole('button', { name: /Custom fields/ }).click()
    const trigger = page.getByRole('button', { name: 'Tags: No value' })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    const search = page.getByRole('combobox', { name: /Filter Tags choices/ })
    await expect(search).toBeFocused()
    await walkClearOfFades(page, 'ArrowDown', 14, '[role="listbox"]', true)
  })
})
