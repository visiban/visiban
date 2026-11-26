import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Planned children (#2549, #2551 rollup half, #2552), at 390px and a wide window, light and dark:
// - the parent's child footer draws planned children as dashed segments and shows the row-2 warning in warning
//   text with no glyph, at >= 4.5:1, without horizontal overflow;
// - a planned child's card detail explains the inactive date and offers Needed (Now only when the parent is hidden).
const PARENT_CARD = {
  ...CARD, title: 'Hooli: pilot rollout',
  children_rollup: {
    visible: true, total: 6, done: 2, doing: 1, todo: 2, blocked: 0, last_moved_at: null,
    planned: 1, planned_due_dates: ['2026-12-04'], needed_not_started: [{ column_name: 'Qualify', count: 1 }],
  },
}
const PLANNED_CARD = {
  ...CARD, id: 11, uid: 'card000011p', title: 'Proposal workshop', position: 2, planned: true,
  due_date: '2030-12-04', needed_at_column: null, needed_at_column_name: null, parent: { hidden: true },
}
const BOARD = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT_CARD, PLANNED_CARD] }

async function setup(page: Page) {
  await routeAuth(page)
  await routeBoard(page, BOARD as typeof BOARD_FULL)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks|movements)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
}

const contrast = (el: Element) => {
  const ctx = document.createElement('canvas').getContext('2d')!
  const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
  const lum = (v: number[]) => v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0)
  let bg = el as Element | null
  while (bg && getComputedStyle(bg).backgroundColor.match(/rgba\(.*, 0\)|transparent/)) bg = bg.parentElement
  const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(getComputedStyle(bg ?? document.body).backgroundColor))]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

for (const width of [390, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`parent footer: dashed planned segment and row-2 warning at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      await page.goto(`/boards/${BOARD.id}`)
      const footer = page.getByTestId('card-children-rollup').first()
      await expect(footer).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await expect(footer).toHaveAttribute('aria-label', /1 planned; Qualify: 1 child not started/)
      const seg = footer.locator('[data-segment="planned"]')
      await expect(seg).toHaveCount(1)
      expect(await seg.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
      const warning = footer.getByTestId('rollup-warning')
      await expect(warning).toHaveText('Qualify: 1 child not started')
      await expect(warning.locator('svg')).toHaveCount(0)
      const ratio = await warning.evaluate(contrast)
      expect(ratio, `warning contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      expect(await footer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    })

    test(`planned child detail: inactive-date helper and Needed at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      await page.goto(`/boards/${BOARD.id}?card=${PLANNED_CARD.id}`)
      const help = page.getByTestId('due-planned-help')
      await expect(help).toBeVisible({ timeout: 10_000 })
      await expect(help).toContainText('Inactive while planned.')
      await expect(help).toContainText(width < 640 ? 'Counts once needed.' : 'It counts once the work is pulled or needed.')
      const ratio = await help.evaluate(contrast)
      expect(ratio, `helper contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      const field = page.getByTestId('card-needed-field')
      await expect(field).toContainText("Needed can only be set to Now")
      const needed = field.getByLabel('Needed')
      if (width < 640) expect((await needed.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      // Scroll first: the dropdown closes on any outside scroll, and a click that scrolls the trigger into view would close it.
      await needed.scrollIntoViewIfNeeded()
      await needed.click()
      await expect(page.getByRole('option', { name: 'Now' })).toBeVisible()
      if (width < 640) await expect(page.locator('[data-sheet="true"]')).toBeVisible()
    })
  }
}
