import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// #1478 — the Edit Swimlane modal's field list is an `overflow-y-auto` region.
// A dropdown field's menu used to render inside it and was clipped, so a value
// could not be picked. jsdom does not clip, so this asserts, in a real
// browser, that the *last* choice is the topmost element at its own center.

const CHOICES = ['Bob', 'Ed', 'Sally']

function dropdownField(id: number, name: string, position: number) {
  return {
    id, uid: `sfuid00000${id}`, name, field_type: 'dropdown', choices: CHOICES, position,
    show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
    number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    created_at: '2026-01-01T00:00:00Z',
  }
}

async function openEditModal(page: import('@playwright/test').Page, fieldCount: number) {
  const board = {
    ...BOARD_FULL,
    swimlane_custom_field_definitions: Array.from({ length: fieldCount }, (_, i) => dropdownField(i + 1, `Owner ${i + 1}`, i)),
    swimlanes: [{ ...SWIMLANE, custom_field_values: [] }],
  }
  await routeAuth(page)
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Edit swimlane' }).click({ force: true })
  await expect(page.getByText('Swimlane fields')).toBeVisible()
}

async function expectLastChoiceHitTestable(page: import('@playwright/test').Page) {
  const last = page.getByRole('menuitem', { name: CHOICES[CHOICES.length - 1] })
  await expect(last).toBeVisible()
  const hit = await last.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return top !== null && el.contains(top)
  })
  expect(hit).toBe(true)
}

test.describe('Edit Swimlane dropdown field (#1478)', () => {
  test('a lone dropdown field shows every choice, hit-testable, and saves the pick', async ({ page }) => {
    await openEditModal(page, 1)
    let patched: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/swimlanes/${SWIMLANE.id}/`, (route) => {
      patched = route.request().postDataJSON()
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...SWIMLANE, custom_field_values: [{ field_definition: 1, value: 'Sally' }] }),
      })
    })

    await page.getByRole('button', { name: /— No value —/ }).click()
    await expectLastChoiceHitTestable(page)
    await page.getByRole('menuitem', { name: 'Sally' }).click()
    await expect(page.getByRole('button', { name: 'Sally' })).toBeVisible()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => patched).toMatchObject({ custom_field_values: [{ field_definition: 1, value: 'Sally' }] })
  })

  test('the last of several dropdown rows still shows every choice', async ({ page }) => {
    await openEditModal(page, 4)
    await page.getByRole('button', { name: /— No value —/ }).last().click()
    await expectLastChoiceHitTestable(page)
  })

  test('Escape closes only the menu, not the modal', async ({ page }) => {
    await openEditModal(page, 1)
    await page.getByRole('button', { name: /— No value —/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByText('Swimlane fields')).toBeVisible()
  })
})
