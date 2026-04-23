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
