import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { contrastRatio, effectiveBackground, fillColor, textColor } from './contrast'

// Children mode on the Board tab (#2370, planned sections #2550), at a phone and a wide window, light and dark:
// the Show control, the mode and lane surviving a reload and a shared link, the lane band and planned wording,
// and 44px targets at 390px.
const PARENT = { ...CARD, title: 'Acme: analytics module' }
const BOARD = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT] }
const LANE_ID = BOARD_FULL.swimlanes[0].id

const view = {
  board_total: { in_progress: 5, total: 6, blocked: 1, hidden: 4, planned: 1 },
  lanes: [{
    id: LANE_ID, name: BOARD_FULL.swimlanes[0].name, position: 0, parents: 2, child_boards: 1, total: 6,
    in_progress: 5, done: 1, doing: 1, todo: 3, blocked: 1, hidden: 4, folded: 0, planned: 1, planned_only: 0,
    last_moved_at: null,
  }],
  rows: [
    {
      id: PARENT.id, title: PARENT.title, swimlane_id: LANE_ID, column_id: PARENT.column, column_name: 'Discovery',
      assignee: null, rollup: { visible: true, total: 6, done: 1, doing: 1, todo: 3, blocked: 1, last_moved_at: null },
      in_progress: 5, folded: false, planned: 1, planned_only: false, child_board_id: 7,
      children: [
        { id: 20, title: 'Usage export spec', column_id: 100, swimlane_id: 1, position: 0, state: 'todo', assignee: null, blocked: false, blocked_at: null, planned: false },
        { id: 21, title: 'Proposal workshop', column_id: 100, swimlane_id: 1, position: 1, state: 'todo', assignee: null, blocked: false, blocked_at: null, planned: true },
        { id: 22, title: 'SSO for analytics', column_id: 101, swimlane_id: 1, position: 0, state: 'blocked', assignee: null, blocked: true, blocked_at: '2026-11-20T09:00:00Z', planned: false },
      ],
    },
    {
      id: 900, title: 'Acme: expansion pilot', swimlane_id: LANE_ID, column_id: PARENT.column, column_name: 'Qualify',
      assignee: null, rollup: { visible: false, total: 4 }, in_progress: null, folded: false, planned: null,
      planned_only: false, child_board_id: null, children: [],
    },
  ],
  child_boards: [{
    id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false,
    columns: [
      { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 9 },
      { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: 5, is_done: false, card_count: 4 },
      { id: 102, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 3 },
    ],
  }],
  next_cursor: null,
}

async function setup(page: Page) {
  await routeAuth(page)
  await routeBoard(page, BOARD as typeof BOARD_FULL)
  await page.route(/\/api\/v1\/boards\/\d+\/children-view\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }),
  )
}

for (const width of [390, 1440]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Children mode survives reload and link at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      await page.goto(`/boards/${BOARD.id}`)
      const show = page.getByTestId('show-mode')
      await expect(show).toBeVisible({ timeout: 10_000 })
      await show.getByRole('button', { name: 'Children' }).click()
      await expect(page).toHaveURL(/show=children/)
      const mode = page.getByTestId('children-mode')
      await expect(mode).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await expect(mode.getByText('4 in progress · 1 planned')).toBeVisible()
      await expect(mode.getByText("+4 on a board you can't open")).toBeVisible()
      await expect(mode.getByRole('grid', { name: /children on Delivery, by parent/ })).toBeVisible()
      await expect(mode.getByRole('button', { name: '1 planned · Show' })).toHaveAttribute('aria-expanded', 'false')
      await expect(mode.getByText("4 children on a board you can't open. Their columns and titles are not shown.")).toBeVisible()

      // Remembered per board: a reload without ?show= comes back in Children mode.
      await page.goto(`/boards/${BOARD.id}`)
      await expect(page).toHaveURL(/show=children/)
      await expect(page.getByTestId('children-mode')).toBeVisible()

      // A shared lane link opens that lane.
      await page.goto(`/boards/${BOARD.id}?show=children&lane=${LANE_ID}`)
      await expect(page.getByRole('region', { name: `${BOARD_FULL.swimlanes[0].name} lane` })).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(new RegExp(`lane=${LANE_ID}`))
      await expect(page.getByTestId('children-mode')).toBeVisible()

      // The page never scrolls sideways; the grid scrolls inside its own box.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)

      if (width === 390) {
        for (const target of await page.getByTestId('children-mode').getByRole('button').all()) {
          const box = await target.boundingBox()
          if (box) expect(box.height, await target.innerText()).toBeGreaterThanOrEqual(44)
        }
        const toggle = page.getByTestId('show-mode').getByRole('button', { name: 'Children' })
        expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      }

      // Back to Cards clears the mode and the lane.
      await page.getByTestId('show-mode').getByRole('button', { name: 'Cards' }).click()
      await expect(page).not.toHaveURL(/show=children/)
      await expect(page).not.toHaveURL(/lane=/)
    })
  }
}

// Ways in, band actions, column meters, and measured contrast on those surfaces (#2370 items 1, 2, 3, 8, 14).
async function expectText(loc: import('@playwright/test').Locator, label: string) {
  await expect(loc).toBeVisible()
  const ratio = contrastRatio(await textColor(loc), await effectiveBackground(loc))
  expect(ratio, `${label} text contrast`).toBeGreaterThanOrEqual(4.5)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Children ways in, band actions and meters at 1440px, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await setup(page)
    const laneName = BOARD_FULL.swimlanes[0].name
    await page.goto(`/boards/${BOARD.id}`)
    // Cards mode: the Children lane action beside Focus, with the server's in-progress count (5 - 1 planned).
    const action = page.getByRole('button', { name: `Children 4 in progress, ${laneName}` })
    await action.focus()
    await expect(action).toHaveCSS('opacity', '1')
    await expectText(action, 'lane action')
    await action.click()
    await expect(page).toHaveURL(new RegExp(`show=children&lane=${LANE_ID}`))
    const mode = page.getByTestId('children-mode')
    await expect(mode).toBeVisible()

    // Band: Focus (pressed for the linked lane), Copy link, the admin menu.
    const focus = mode.getByRole('button', { name: `Focus on ${laneName}` })
    await expect(focus).toHaveAttribute('aria-pressed', 'true')
    await expectText(focus, 'Focus')
    await expectText(mode.getByRole('button', { name: 'Copy link' }), 'Copy link')
    await mode.getByRole('button', { name: `${laneName} lane menu` }).click()
    await expect(page.getByRole('menuitem', { name: 'Edit swimlane…' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Heading names the parent board; column heads carry whole-column counts and the limit meter.
    await expectText(mode.getByText(`Parent · column on ${BOARD.name}`), 'heading')
    await expectText(mode.getByRole('link', { name: 'Delivery', exact: true }), 'child board link')
    await expectText(mode.getByText('1 of 4 on Delivery · limit 5'), 'column caption')
    const meter = mode.getByRole('meter', { name: 'Doing on Delivery: 4 of limit 5' })
    await expect(meter).toBeVisible()
    const fill = meter.locator('span')
    const nonText = contrastRatio(await fillColor(fill), await effectiveBackground(meter.locator('xpath=..')))
    expect(nonText, 'meter fill against its surface').toBeGreaterThanOrEqual(3)

    // Home/End inside the grid.
    const parent = mode.getByRole('button', { name: PARENT.title })
    await parent.focus()
    await page.keyboard.press('End')
    await expect(parent).not.toBeFocused()
    await page.keyboard.press('Home')
    await expect(parent).toBeFocused()

    // A lane the viewer was not served is simply absent: every lane, no error.
    await page.goto(`/boards/${BOARD.id}?show=children&lane=987654`)
    await expect(page.getByRole('region', { name: `${laneName} lane` })).toBeVisible()
    await expect(page.getByText("Children didn't load")).toHaveCount(0)
  })
}
