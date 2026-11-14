import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, SWIMLANE } from './fixtures/board'

// #2205 — build a lane filter, see non-matching lanes hide, save it as a
// filter, and load it back. The saved-filters endpoint is stubbed statefully
// (a POST is stored and returned by the next GET), as in saved-filters.spec.ts.
const AE_FIELD = {
  id: 7, uid: 'slf0000007x', name: 'AE', field_type: 'dropdown', choices: ['Priya', 'Sam'], position: 0,
  show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
  number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
}
const lane = (id: number, name: string, ae: string) => ({
  ...SWIMLANE, id, uid: `swim00000${id}x`, name, position: id,
  custom_field_values: [{ field_definition: AE_FIELD.id, value: ae }],
})
const BOARD = {
  ...BOARD_FULL,
  swimlanes: [lane(1, 'Acme', 'Priya'), lane(2, 'Globex', 'Sam')],
  swimlane_custom_field_definitions: [AE_FIELD],
}

test.describe('lane filters', () => {
  test('hides non-matching lanes, saves, and loads back', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, BOARD as unknown as typeof BOARD_FULL)
    const stored: unknown[] = []
    let posted: { name: string; state_json: Record<string, unknown> } | null = null
    await page.route(`**/api/v1/boards/${BOARD.id}/saved-filters/`, async (route) => {
      const req = route.request()
      if (req.method() === 'POST') {
        posted = req.postDataJSON()
        const created = { id: 99, state_version: 1, created_at: '2026-11-13T00:00:00Z', ...posted }
        stored.push(created)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stored) })
    })

    await page.goto(`/boards/${BOARD.id}`)
    const acme = page.locator('[data-swimlane-id="1"]')
    const globex = page.locator('[data-swimlane-id="2"]')
    await expect(acme).toBeVisible()
    await expect(globex).toBeVisible()

    await page.getByRole('button', { name: /^filters/i }).click()
    const filters = page.getByRole('search', { name: 'Board filters' })
    await filters.getByRole('button', { name: 'Lanes', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Lane filters' })
    await dialog.getByRole('button', { name: '+ Add filter' }).click()
    await dialog.getByRole('button', { name: /^Filter 1 field/ }).click()
    await dialog.getByRole('menuitem', { name: 'AE' }).click()
    await dialog.getByRole('button', { name: /^Filter 1 value/ }).click()
    await dialog.getByRole('menuitem', { name: 'Priya' }).click()
    await expect(dialog.getByText('Reads as: AE is Priya')).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()

    await expect(globex).toHaveCount(0)
    await expect(acme).toBeVisible()
    await expect(filters.getByRole('button', { name: 'Lanes, 1 active' })).toBeFocused()
    await expect(filters.getByRole('status')).toHaveText('1 lane hidden')
    await expect(page).toHaveURL(/f_lanes=1\./)

    await page.getByRole('button', { name: 'Saved filters' }).click()
    await page.getByRole('button', { name: /save current filters/i }).click()
    await page.getByPlaceholder('Filter name…').fill('Priya accounts')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: /priya accounts/i })).toBeVisible()
    expect(posted).not.toBeNull()
    expect(posted!.state_json.laneFilter).toMatchObject({ items: [{ field: AE_FIELD.id, op: 'is', value: 'Priya' }] })

    // Dismiss the lane chip: every lane comes back.
    await filters.getByRole('button', { name: 'Lanes: AE is Priya, remove' }).last().click()
    await expect(globex).toBeVisible()

    // Load the saved filter back: Globex hides again.
    await page.getByRole('button', { name: /priya accounts/i }).click()
    await expect(globex).toHaveCount(0)
    await expect(acme).toBeVisible()
  })

  // #2226 — text swimlane fields: `is` picks from the lanes' own values,
  // `contains` matches a typed substring case-insensitively, and the rule
  // survives a reload through the URL.
  test('filters on a text field with is and contains', async ({ page }) => {
    const OWNER = { ...AE_FIELD, id: 8, uid: 'slf0000008x', name: 'Owner', field_type: 'text', choices: [], position: 1 }
    const textLane = (id: number, name: string, owner: string) => ({
      ...lane(id, name, 'Priya'),
      custom_field_values: [{ field_definition: OWNER.id, value: owner }],
    })
    const board = {
      ...BOARD,
      swimlanes: [textLane(1, 'Acme', 'Ethan Ross'), textLane(2, 'Globex', 'Olivia Grant')],
      swimlane_custom_field_definitions: [AE_FIELD, OWNER],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${board.id}`)
    const acme = page.locator('[data-swimlane-id="1"]')
    const globex = page.locator('[data-swimlane-id="2"]')
    await expect(globex).toBeVisible()

    await page.getByRole('button', { name: /^filters/i }).click()
    const filters = page.getByRole('search', { name: 'Board filters' })
    await filters.getByRole('button', { name: 'Lanes', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Lane filters' })
    await dialog.getByRole('button', { name: '+ Add filter' }).click()
    await dialog.getByRole('button', { name: /^Filter 1 field/ }).click()
    await dialog.getByRole('menuitem', { name: 'Owner' }).click()
    await dialog.getByRole('button', { name: /^Filter 1 value/ }).click()
    await expect(dialog.getByRole('menuitem')).toHaveText(['Ethan Ross', 'Olivia Grant'])
    await dialog.getByRole('menuitem', { name: 'Olivia Grant' }).click()
    await expect(dialog.getByText('Reads as: Owner is Olivia Grant')).toBeVisible()
    await expect(acme).toHaveCount(0)

    await dialog.getByRole('button', { name: /^Filter 1 operator/ }).click()
    await dialog.getByRole('menuitem', { name: 'contains' }).click()
    const box = dialog.getByRole('textbox', { name: 'Filter 1 Owner contains' })
    await box.fill('ROSS')
    await expect(dialog.getByText('Reads as: Owner contains ROSS')).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(globex).toHaveCount(0)
    await expect(acme).toBeVisible()
    await expect(filters.getByRole('button', { name: 'Lanes: Owner contains ROSS, remove' }).last()).toBeVisible()
    await expect(page).toHaveURL(/f_lanes=1\./)

    await page.reload()
    await expect(acme).toBeVisible()
    await expect(globex).toHaveCount(0)

    // #2227: switch to the wildcard operator; it matches any part of the value.
    await page.getByRole('button', { name: /^filters/i }).click()
    await filters.getByRole('button', { name: /^Lanes/ }).first().click()
    const dialog2 = page.getByRole('dialog', { name: 'Lane filters' })
    await dialog2.getByRole('button', { name: /^Filter 1 operator/ }).click()
    await dialog2.getByRole('menuitem', { name: 'matches wildcard' }).click()
    const box2 = dialog2.getByRole('textbox', { name: 'Filter 1 Owner matches wildcard' })
    await box2.fill('o*grant')
    await expect(dialog2.getByText('Reads as: Owner matches wildcard o*grant')).toBeVisible()
    await expect(globex).toBeVisible()
    await expect(acme).toHaveCount(0)
    // Any part of the value matches, so a bare word needs no surrounding *.
    await box2.fill('grant')
    await expect(globex).toBeVisible()
    await expect(acme).toHaveCount(0)
    await box2.fill('g?ant')
    await expect(globex).toBeVisible()
    await box2.fill('gant')
    await expect(globex).toHaveCount(0)
  })

  // The list's max-height reserves 9rem (10.5rem with the paused note) for the
  // header, Reads-as and footer. Verify the whole panel, Done included, fits a
  // short viewport with a long rule list, with and without focus mode.
  for (const paused of [false, true]) {
    test(`fits a short viewport with many rules${paused ? ' while paused' : ''}`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 520 })
      await routeAuth(page)
      await routeBoard(page, BOARD as unknown as typeof BOARD_FULL)
      const rules = Array.from({ length: 12 }, (_, i) => ({ ...(i ? { j: 'o' } : {}), f: AE_FIELD.id, o: 'is', v: i % 2 ? 'Sam' : 'Priya' }))
      const params = new URLSearchParams({ f_lanes: `1.${JSON.stringify(rules)}` })
      if (paused) params.set('focus', '2')
      await page.goto(`/boards/${BOARD.id}?${params.toString()}`)
      await page.getByRole('button', { name: /^filters/i }).click()
      await page.getByRole('button', { name: 'Lanes, 12 active' }).click()
      const dialog = page.getByRole('dialog', { name: 'Lane filters' })
      await expect(dialog).toBeVisible()
      if (paused) await expect(dialog.getByText(/^Paused while a lane is focused/)).toBeVisible()
      const box = (await dialog.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(520)
      await expect(dialog.getByRole('button', { name: 'Done' })).toBeInViewport({ ratio: 1 })
    })
  }

  // #2231 — the inner menus are in-flow, so on a short rule list an opened menu
  // used to be clipped by the list's overflow-y-auto and could not be chosen.
  test('an opened field menu is fully visible and selectable on a short list', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, BOARD as unknown as typeof BOARD_FULL)
    const rules = [{ f: AE_FIELD.id, o: 'is', v: 'Priya' }]
    await page.goto(`/boards/${BOARD.id}?${new URLSearchParams({ f_lanes: `1.${JSON.stringify(rules)}` }).toString()}`)
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.getByRole('button', { name: 'Lanes, 1 active' }).click()
    const dialog = page.getByRole('dialog', { name: 'Lane filters' })
    await dialog.getByRole('button', { name: '+ Add filter' }).click()
    await dialog.getByRole('button', { name: /^Filter 2 field/ }).click()
    const items = dialog.getByRole('menuitem')
    const last = items.last()
    await expect(last).toBeVisible()
    const list = (await dialog.locator('.overflow-y-auto').first().boundingBox())!
    const item = (await last.boundingBox())!
    expect(item.y).toBeGreaterThanOrEqual(list.y)
    expect(item.y + item.height).toBeLessThanOrEqual(list.y + list.height + 1)
    await last.click()
    await expect(dialog.getByRole('button', { name: /^Filter 2 field/ })).toContainText(AE_FIELD.name)
  })
})
