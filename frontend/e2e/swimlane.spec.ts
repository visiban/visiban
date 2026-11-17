import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// Swimlane collapse is driven by the chevron button in the swimlane label
// panel.  The `c` key shortcut in BoardView.tsx is technically wired but the
// parent never supplies the hover-tracking callback to SwimlaneRow, so the
// shortcut is effectively a no-op in production.  These tests exercise the
// button + persistence path, which is the supported interaction.

test.describe('swimlane collapse', () => {
  // Desktop Chrome is exactly 1280px, the card detail sheet's anchored/docked
  // boundary (#1914): pin a viewport that is unambiguously anchored.
  test.use({ viewport: { width: 1600, height: 900 } })
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('collapse chevron toggles aria-expanded state', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const chevron = page.getByRole('button', { name: `Collapse ${SWIMLANE.name}` })
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    await chevron.click()

    // Once collapsed, the button's accessible name flips to "Expand …".
    const expandBtn = page.getByRole('button', { name: `Expand ${SWIMLANE.name}` })
    await expect(expandBtn).toBeVisible()
    await expect(expandBtn).toHaveAttribute('aria-expanded', 'false')
    // The collapsed lane shows a strip of counts under the columns, not its cells.
    await expect(page.getByTestId('swimlane-collapsed-strip')).toBeVisible()
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

// #1458 — admin shortcut from the band's open field grid to Board settings → Swimlane fields.
test.describe('swimlane field order shortcut', () => {
  test.use({ viewport: { width: 1600, height: 900 } })
  const defBase = {
    field_type: 'text', choices: [], show_on_row: false, is_admin_only: false, is_required: false,
    help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const board = {
    ...BOARD_FULL,
    swimlane_custom_field_definitions: ([
      { ...defBase, id: 1, uid: 'sfuid0000001', name: 'Owner', position: 0 },
      { ...defBase, id: 2, uid: 'sfuid0000002', name: 'Region', position: 1 },
      { ...defBase, id: 3, uid: 'sfuid0000003', name: 'Tier', position: 2 },
    ] as unknown) as typeof BOARD_FULL.swimlane_custom_field_definitions,
    swimlanes: BOARD_FULL.swimlanes.map((s) => ({
      ...s,
      custom_field_values: [
        { field_definition: 1, value: 'J. Rivera' },
        { field_definition: 2, value: 'EMEA' },
        { field_definition: 3, value: 'Gold' },
      ],
    })) as typeof BOARD_FULL.swimlanes,
  }

  test('admin opens Swimlane fields from the open field grid; Ctrl+, still opens Members', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, board)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const more = page.getByRole('button', { name: /^\d+ fields:/ })
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Tier')).toBeVisible()
    await page.getByRole('button', { name: 'Change field order' }).click()

    const tab = page.getByRole('button', { name: 'Swimlane fields' })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-current', 'true')

    await page.keyboard.press('Escape')
    await expect(tab).toHaveCount(0)

    await page.keyboard.press('Control+,')
    // aria-current marks the active tab, so this fails if the modal reopens on Swimlane fields.
    await expect(page.getByRole('button', { name: /^Members \(/ })).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: 'Swimlane fields' })).not.toHaveAttribute('aria-current', 'true')
  })
})

// Lane health status (#2243): a set status rides inline on a collapsed lane
// and must not make the row taller than an unset one (jsdom cannot measure).
test.describe('collapsed swimlane health status height', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('a collapsed lane with a status is the same height as one without', async ({ page }) => {
    const withStatus = { ...SWIMLANE, id: 1, uid: 'swim000001g', name: 'Alpha', position: 0, health_status: 'at_risk' }
    const without = { ...SWIMLANE, id: 2, uid: 'swim000002g', name: 'Bravo', position: 1, health_status: null }
    const board = { ...BOARD_FULL, swimlanes: [withStatus, without], cards: [] } as unknown as typeof BOARD_FULL
    await routeAuth(page)
    await routeBoard(page, board)
    await page.addInitScript(
      ({ boardId }) => {
        window.localStorage.setItem(
          `board:${boardId}:view-prefs`,
          JSON.stringify({ collapsedSwimlaneIds: [1, 2] }),
        )
      },
      { boardId: board.id },
    )
    await page.goto(`/boards/${board.id}`)
    const a = page.getByRole('button', { name: 'Expand Alpha' })
    const b = page.getByRole('button', { name: 'Expand Bravo' })
    await expect(a).toBeVisible({ timeout: 10_000 })
    await expect(b).toBeVisible()
    await expect(page.getByText(/Health status for lane Alpha/)).toBeAttached()
    // Measure the band: a status pill must not make a collapsed band taller.
    const panelHeight = async (name: string) =>
      page
        .getByRole('button', { name: `Expand ${name}` })
        .locator('xpath=ancestor::*[@data-testid="swimlane-band"][1]')
        .evaluate((el) => el.getBoundingClientRect().height)
    expect(await panelHeight('Alpha')).toBe(await panelHeight('Bravo'))
  })
})

// Auto health status (#2245): a board admin turns automatic health on in
// Board Settings, runs Recompute now, and the lane's pill shows the
// calculated status. The API is mocked; the merge of the recompute response
// into the board and its lanes is what this exercises.
test.describe('auto health status', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('admin turns on automatic health, recomputes, and the lane shows a calculated status', async ({ page }) => {
    const computedAt = new Date().toISOString()
    const counts = { open: 1, overdue: 1, stale: 0, blocked: 0, flagged: 1 }
    const autoBoard = {
      ...BOARD_FULL, health_auto_enabled: true, health_off_track_cards: 3,
      computed_health_status: 'at_risk', health_computed_at: computedAt, health_computed_counts: counts,
      effective_health_status: 'at_risk', health_status_origin: 'computed', health_status_source: null,
    }
    const computedLane = {
      ...SWIMLANE, health_status: null, computed_health_status: 'at_risk', health_computed_at: computedAt,
      health_computed_counts: counts, effective_health_status: 'at_risk', health_status_origin: 'computed',
    }
    const manualBoard = {
      ...BOARD_FULL, health_auto_enabled: false, health_off_track_cards: 3,
      computed_health_status: null, health_computed_at: null, health_computed_counts: null,
      swimlanes: [{ ...SWIMLANE, health_status: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null }],
    } as unknown as typeof BOARD_FULL
    let patched: unknown = null
    let recomputed = 0
    await routeAuth(page)
    await routeBoard(page, manualBoard)
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/`, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      patched = route.request().postDataJSON()
      // The PATCH that turns auto on computes at once, but answers with the
      // board only: the lanes update from Recompute now (or the socket).
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(autoBoard) })
    })
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/health-recompute/`, (route) => {
      recomputed += 1
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ board: autoBoard, swimlanes: [computedLane] }),
      })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog', { name: 'Board Settings' })
    await dialog.getByRole('button', { name: 'Rules' }).click()

    const toggle = dialog.getByRole('switch', { name: 'Calculate health status automatically' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    const recompute = dialog.getByRole('button', { name: 'Recompute now' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(patched).toEqual({ health_auto_enabled: true })

    await recompute.click()
    await expect.poll(() => recomputed).toBe(1)
    await expect(dialog.getByTestId('health-last-computed')).toContainText(/Last computed/)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    const pill = page.getByText(`Health status for lane ${SWIMLANE.name}:`).locator('..')
    await expect(pill).toContainText('At risk')
    await expect(pill).toContainText('calculated automatically')
  })
})
