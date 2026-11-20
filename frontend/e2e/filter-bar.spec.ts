import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, LABEL_BUG } from './fixtures/board'

test.describe('filter bar', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('applies a label filter and renders a chip', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Filter row is hidden by default; pressing "f" toggles it.
    await page.keyboard.press('f')

    // #964 — Label is collapsed behind "+ Filter" until picked; a two-click
    // flow reveals its own control (pick facet, then open it), matching the
    // pre-existing "+ Custom fields" pattern.
    await page.getByRole('button', { name: '+ Filter' }).click()
    await page.getByRole('checkbox', { name: 'Label' }).click()
    await page.getByRole('button', { name: /^Label/ }).click()
    await page.getByRole('checkbox', { name: LABEL_BUG.name }).click()
    // Click outside to close the dropdown and commit the selection.
    await page.keyboard.press('Escape')

    const chips = page.getByRole('group', { name: 'Active filters' })
    await expect(chips).toBeVisible()
    await expect(chips.getByText(LABEL_BUG.name)).toBeVisible()
  })

  test('the Filter panel filters by label from the keyboard and the URL carries it (#2301)', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const trigger = page.getByRole('button', { name: /^Filters/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Filter' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Search fields and values to filter' })).toBeFocused()

    await panel.getByRole('textbox', { name: 'Search fields and values to filter' }).fill('lab')
    const row = panel.getByRole('button', { name: /Label/ })
    await expect(panel.getByRole('button', { name: /Assignee/ })).toHaveCount(0)
    await row.focus()
    await page.keyboard.press('Enter')
    const bug = panel.getByRole('checkbox', { name: LABEL_BUG.name })
    await bug.focus()
    await page.keyboard.press('Space')
    await expect(bug).toBeChecked()

    await expect(row).toContainText(LABEL_BUG.name)
    await expect(page).toHaveURL(/f_labels=/)
    // #2437: the first Escape clears the typed query, the second closes the panel.
    await page.keyboard.press('Escape')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('the Filter panel Filtered by row removes a chip and clears all, reflected in the URL (#2315)', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /^Filters/ }).click()
    const panel = page.getByRole('dialog', { name: 'Filter' })
    await panel.getByRole('button', { name: /^Label/ }).click()
    await panel.getByRole('checkbox', { name: LABEL_BUG.name }).check()
    await expect(page).toHaveURL(/f_labels=/)

    const chips = panel.getByRole('group', { name: 'Filtered by' })
    await expect(chips.getByText(LABEL_BUG.name)).toBeVisible()
    await chips.getByRole('button', { name: `Remove ${LABEL_BUG.name} filter` }).first().focus()
    await page.keyboard.press('Delete')
    await expect(page).not.toHaveURL(/f_labels=/)
    await expect(panel.getByTestId('filter-panel-chips')).toHaveCount(0)

    await panel.getByRole('checkbox', { name: LABEL_BUG.name }).check()
    await panel.getByRole('button', { name: 'Clear all' }).click()
    await expect(page).not.toHaveURL(/f_labels=/)
  })

  test('clears all filters via the Clear all button', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('f')
    await page.getByRole('button', { name: '+ Filter' }).click()
    await page.getByRole('checkbox', { name: 'Label' }).click()
    await page.getByRole('button', { name: /^Label/ }).click()
    await page.getByRole('checkbox', { name: LABEL_BUG.name }).click()
    await page.keyboard.press('Escape')

    await expect(page.getByRole('group', { name: 'Active filters' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByRole('group', { name: 'Active filters' })).toHaveCount(0)
  })

  test('saved filter tabs row appears after a preset is saved', async ({ page }) => {
    // Override the saved-filters route to return one preset. The endpoint
    // returns a bare array (not paginated) and the row shape uses state_json /
    // state_version (see backend SavedFilterSerializer).
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 11,
            name: 'My open bugs',
            state_json: { search: '', assigneeIds: [], labelIds: [LABEL_BUG.id], priorities: [], dueDate: null },
            state_version: 1,
            created_at: '2026-04-01T00:00:00Z',
          },
        ]),
      }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Saved filter tabs only render when the filter row is open.
    await page.keyboard.press('f')

    await expect(page.getByRole('button', { name: /My open bugs/ })).toBeVisible()
  })

  test('saves a filter from the Filter panel chip row (#2315)', async ({ page }) => {
    // Stateful stub: a POST adds the preset so the next GET (and the panel's Saved list) returns it.
    const store: unknown[] = []
    let posted: { name: string; state_json: { labelIds?: number[] } } | null = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { name: string; state_json: { labelIds?: number[] } }
        posted = body
        const row = { id: 21, name: body.name, state_json: body.state_json, state_version: 1, created_at: '2026-04-01T00:00:00Z' }
        store.push(row)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(row) })
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(store) })
      }
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /^Filters/ }).click()
    const panel = page.getByRole('dialog', { name: 'Filter' })
    await panel.getByRole('button', { name: /^Label/ }).click()
    await panel.getByRole('checkbox', { name: LABEL_BUG.name }).check()
    await panel.getByRole('button', { name: 'Save filter' }).click()
    await panel.getByRole('textbox', { name: 'Save current filters as:' }).fill('Panel preset')
    await page.keyboard.press('Enter')

    await expect(panel.getByRole('list', { name: 'Saved filters' }).getByText('Panel preset')).toBeVisible()
    // The POST must carry the filter that was picked, not an empty one.
    expect(posted).not.toBeNull()
    expect(posted!.name).toBe('Panel preset')
    expect(posted!.state_json.labelIds).toEqual([LABEL_BUG.id])
  })
})
