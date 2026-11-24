import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Planned children follow-ups (#2550, #2553 third edge case), at a phone and a wide window, light and dark:
// - the parent's Children tab reads a planned child with a passed date as "passed while planned", never Overdue;
// - its Move popover warns, as a role="status" line, before pulling that child out of To do;
// - the board's Planned filter row hides planned cards and adds the removable "Planned: hidden" chip.
const PARENT_CARD = { ...CARD, title: 'Hooli: pilot rollout' }
const PLANNED_CARD = { ...CARD, id: 11, uid: 'card000011p', title: 'Proposal workshop', position: 2, planned: true, due_date: '2020-12-04' }
const BOARD = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT_CARD, PLANNED_CARD] }

const columns = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 2 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: null, is_done: false, card_count: 1 },
  { id: 102, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 0 },
]
const children = {
  count: 1, visible: true, offset: 0, limit: 50,
  results: [{
    id: 20, title: 'Proposal readout with Hooli CFO', board_id: 7, column_id: 100, column_name: 'To do', swimlane_id: 1,
    swimlane_name: 'Lane', archived: false, position: 0, assignee: null, blocked: false, blocked_at: null,
    priority: 'low', due_date: '2020-12-04', labels: [], planned: true,
  }],
  board: { id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false, columns },
}

async function setup(page: Page) {
  await routeAuth(page)
  await routeBoard(page, BOARD as typeof BOARD_FULL)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks|movements)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/children\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(children) }),
  )
}

for (const width of [390, 880]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`planned child on the Children tab and its Move warning at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      await page.goto(`/boards/${BOARD.id}?card=${CARD.id}&tab=children`)
      const tab = page.getByTestId('card-children-tab')
      await expect(tab).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      const face = tab.getByTestId('child-card-face')
      await expect(face).toContainText('Dec 4 passed while planned')
      await expect(face).not.toContainText('Overdue')
      await tab.getByRole('button', { name: 'Move Proposal readout with Hooli CFO' }).click()
      const dialog = page.getByRole('dialog', { name: 'Move Proposal readout with Hooli CFO' })
      await expect(dialog.getByRole('status')).toHaveCount(0)
      await dialog.getByRole('radio', { name: 'Doing' }).check()
      const warning = dialog.getByRole('status')
      await expect(warning).toHaveText('Its date, Dec 4, has passed. It will be overdue once moved.')
      const ratio = await warning.evaluate((el) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
        const lum = (v: number[]) => v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0)
        let bg = el as Element | null
        while (bg && getComputedStyle(bg).backgroundColor.match(/rgba\(.*, 0\)|transparent/)) bg = bg.parentElement
        const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(getComputedStyle(bg ?? document.body).backgroundColor))]
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
      expect(ratio, `warning contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })

    test(`Planned filter row and chip at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      await page.goto(`/boards/${BOARD.id}`)
      await expect(page.getByText('Proposal workshop').first()).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /^Filters/ }).click()
      await page.getByRole('button', { name: 'Planned filter: Any' }).click()
      await page.getByRole('radio', { name: 'Hide planned' }).check()
      await expect(page.getByRole('button', { name: 'Planned filter: Hide planned' })).toBeVisible()
      // The panel's "Filtered by" row carries the removable chip (the shipped chip name, FilterChip).
      await expect(page.getByRole('button', { name: 'Remove Planned: hidden filter' }).first()).toBeVisible()
      await expect(page.locator('[data-card-id="11"]')).toHaveCount(0)
      // The chip's × button dismisses it (the chip itself answers Enter, Space and Delete).
      await page.getByRole('button', { name: 'Remove Planned: hidden filter' }).last().click()
      await expect(page.getByRole('button', { name: 'Planned filter: Any' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-card-id="11"]').first()).toBeVisible()
    })
  }
}
