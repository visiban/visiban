import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The Children tab (#2209 row 14): every state at the 880px sheet, the anchored 540px sheet and the phone,
// in light and dark. Each state must render its own content and never scroll the sheet sideways.
const PARENT_BOARD = { ...BOARD_FULL, cards_can_have_children: true }

const columns = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 9 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: 5, is_done: false, card_count: 4 },
  { id: 102, name: 'Blocked', color: '#EF4444', wip_limit: 4, is_done: false, card_count: 3 },
  { id: 103, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 6 },
]
const child = (id: number, title: string, column_id: number, over: Record<string, unknown> = {}) => ({
  id, title, board_id: 7, column_id, column_name: '', swimlane_id: 1, swimlane_name: 'Lane', archived: false,
  position: id, assignee: null, blocked: false, blocked_at: null, ...over,
})
const populated = {
  count: 5, visible: true, offset: 0, limit: 50,
  results: [
    child(10, 'Pen-test scoping call with a deliberately long title that has to wrap', 100),
    child(11, 'Kickoff', 101),
    child(12, 'Firewall review', 102, { blocked: true, blocked_at: new Date(Date.now() - 6 * 86_400_000).toISOString() }),
    child(13, 'Contract', 103),
    child(14, 'Sign-off', 103),
  ],
  board: { id: 7, name: 'Delivery', role: 'member', columns },
}

type Mode = 'populated' | 'empty' | 'hidden' | 'error' | 'loading'

async function setup(page: Page, mode: () => Mode) {
  await routeAuth(page)
  await routeBoard(page, PARENT_BOARD as typeof BOARD_FULL)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks|movements)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/children\/(\?.*)?$/, async (route) => {
    const m = mode()
    if (m === 'loading') return // never answers: the skeleton stays
    if (m === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    const body = m === 'populated' ? populated
      : m === 'hidden' ? { count: 5, visible: false, offset: 0, limit: 50, results: [] }
      : { count: 0, visible: true, offset: 0, limit: 50, results: [] }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

const expected: Record<Mode, RegExp> = {
  populated: /2 of 5 done/,
  empty: /No children yet/,
  hidden: /5 children on a board you can't open/,
  error: /The children didn't load/,
  loading: /./,
}

for (const width of [880, 540, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Children tab states at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      let mode: Mode = 'populated'
      await setup(page, () => mode)
      for (const m of ['populated', 'empty', 'hidden', 'error', 'loading'] as Mode[]) {
        mode = m
        await page.goto(`/boards/${PARENT_BOARD.id}?card=${CARD.id}&tab=children`)
        const tab = page.getByTestId('card-children-tab')
        await expect(tab, m).toBeVisible({ timeout: 10_000 })
        if (m === 'loading') await expect(page.getByRole('status', { name: 'Loading children' })).toBeVisible()
        else await expect(tab).toContainText(expected[m])
        if (m === 'error') await expect(tab.getByRole('alert').filter({ hasText: "didn't load" })).toBeVisible()
        if (m === 'populated') {
          await expect(tab.getByRole('link', { name: 'Open on Delivery' })).toHaveAttribute('href', `/boards/7?f_parent=${CARD.id}`)
          await expect(tab.getByRole('img', { name: '2 done, 1 doing, 1 blocked, 1 to do' })).toBeVisible()
          // The card sheet is 540px at every viewport above the phone and full screen at or below 640px
          // (useCardSheetPlacement), so the tab never gets the 840px of container the side-by-side layout
          // needs: asserted, not recorded. The side-by-side layout is pinned in cardChildrenTab2209.test.tsx
          // at a measured 840px container (open on #2209: no sheet is 880px wide).
          const box = await tab.boundingBox()
          expect(box!.width, `tab width at ${width}px`).toBeLessThan(800)
          await expect(tab.getByRole('region')).toHaveCount(1)
          await expect(tab.getByRole('group', { name: 'Columns on Delivery' })).toBeVisible()
          await expect(tab.getByTestId('children-limit-line')).toContainText("are this card's")
        }
        // No sideways scroll inside the sheet, in any state.
        const overflow = await tab.evaluate((el) => el.scrollWidth - el.clientWidth)
        expect(overflow, `${m} overflows by ${overflow}px`).toBeLessThanOrEqual(0)
      }
    })
  }
}
