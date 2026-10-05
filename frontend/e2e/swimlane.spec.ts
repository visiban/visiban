import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// Swimlane collapse is driven by the chevron button in the swimlane label
// panel.  The `c` key shortcut in BoardView.tsx is technically wired but the
// parent never supplies the hover-tracking callback to SwimlaneRow, so the
// shortcut is effectively a no-op in production.  These tests exercise the
// button + persistence path, which is the supported interaction.

test.describe('swimlane collapse', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('collapse chevron toggles aria-pressed state', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const chevron = page.getByRole('button', { name: `Collapse ${SWIMLANE.name}` })
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-pressed', 'false')

    await chevron.click()

    // Once collapsed, the button's accessible name flips to "Expand …".
    const expandBtn = page.getByRole('button', { name: `Expand ${SWIMLANE.name}` })
    await expect(expandBtn).toBeVisible()
    await expect(expandBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('collapsed state persists to localStorage under the board-scoped view-prefs key', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: `Collapse ${SWIMLANE.name}` }).click()
    await expect(page.getByRole('button', { name: `Expand ${SWIMLANE.name}` })).toBeVisible()

    const prefs = await page.evaluate((boardId) => {
      const raw = window.localStorage.getItem(`board:${boardId}:view-prefs`)
      return raw ? (JSON.parse(raw) as { collapsedSwimlaneIds?: number[] }) : null
    }, BOARD_FULL.id)
    expect(prefs?.collapsedSwimlaneIds).toContain(SWIMLANE.id)
  })

  test('collapsed swimlane stays collapsed after reload', async ({ page }) => {
    // Pre-seed the view-prefs key so the board renders in the collapsed state
    // on first load — avoids a toggle → reload sequence whose race window can
    // fluctuate on CI.
    await page.addInitScript(
      ({ boardId, swimlaneId }) => {
        window.localStorage.setItem(
          `board:${boardId}:view-prefs`,
          JSON.stringify({ collapsedSwimlaneIds: [swimlaneId] }),
        )
      },
      { boardId: BOARD_FULL.id, swimlaneId: SWIMLANE.id },
    )

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByRole('button', { name: `Expand ${SWIMLANE.name}` })).toBeVisible({ timeout: 10_000 })
  })
})

// #1458 — admin shortcut from the row's +N popover to Board settings → Swimlane fields.
test.describe('swimlane field order shortcut', () => {
  const defBase = {
    field_type: 'text', choices: [], show_on_row: false, is_admin_only: false, is_required: false,
    help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const board = {
    ...BOARD_FULL,
    swimlane_custom_field_definitions: [
      { ...defBase, id: 1, uid: 'sfuid0000001', name: 'Owner', position: 0 },
      { ...defBase, id: 2, uid: 'sfuid0000002', name: 'Region', position: 1 },
    ],
    swimlanes: BOARD_FULL.swimlanes.map((s) => ({
      ...s,
      custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }],
    })),
  }

  test('admin opens Swimlane fields from the +N popover; Ctrl+, still opens Members', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, board as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /Show all 1 field values/ }).click()
    await page.getByRole('button', { name: 'Edit field order…' }).click()

    const tab = page.getByRole('button', { name: 'Swimlane fields' })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('dialog', { name: /Field values for/ })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(tab).toHaveCount(0)

    await page.keyboard.press('Control+,')
    // aria-current marks the active tab, so this fails if the modal reopens on Swimlane fields.
    await expect(page.getByRole('button', { name: /^Members \(/ })).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: 'Swimlane fields' })).not.toHaveAttribute('aria-current', 'true')
  })
})
