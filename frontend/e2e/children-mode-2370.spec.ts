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

// The server's shape since #2551: the 1 planned child is its own bucket, in total but not in todo or in_progress.
const view = {
  board_total: { in_progress: 4, total: 6, blocked: 1, hidden: 4, planned: 1 },
  lanes: [{
    id: LANE_ID, name: BOARD_FULL.swimlanes[0].name, position: 0, parents: 2, child_boards: 1, total: 6,
    in_progress: 4, done: 1, doing: 1, todo: 2, blocked: 1, hidden: 4, folded: 0, planned: 1, planned_only: 0,
    last_moved_at: null,
  }],
  rows: [
    {
      id: PARENT.id, title: PARENT.title, swimlane_id: LANE_ID, column_id: PARENT.column, column_name: 'Discovery',
      assignee: null, rollup: { visible: true, total: 6, done: 1, doing: 1, todo: 2, blocked: 1, last_moved_at: null },
      in_progress: 4, folded: false, planned: 1, planned_only: false, child_board_id: 7,
      children: [
        { id: 20, title: 'Usage export spec', column_id: 100, swimlane_id: 1, position: 0, state: 'todo', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false },
        { id: 21, title: 'Proposal workshop', column_id: 100, swimlane_id: 1, position: 1, state: 'todo', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: true },
        { id: 22, title: 'SSO for analytics', column_id: 101, swimlane_id: 1, position: 0, state: 'blocked', assignee: null, blocked: true, blocked_at: '2026-11-20T09:00:00Z', blocked_reason: 'IdP access', planned: false },
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
      await expect(mode.getByRole('region', { name: `${BOARD_FULL.swimlanes[0].name} lane` })).toContainText('4 in progress · 1 planned')
      await expect(mode.getByText(width === 390 ? "+4 you can't open" : "+4 on a board you can't open")).toBeVisible()
      // The board total sits beside the Show control from sm up; on phone the view tabs keep their own row.
      if (width === 390) {
        await expect(page.getByRole('navigation', { name: 'Board toolbar' }).getByRole('link', { name: 'Board' }).or(page.getByRole('navigation', { name: 'Board toolbar' }).getByRole('button', { name: 'Board', exact: true }))).toBeInViewport()
      } else {
        await expect(page.getByRole('navigation', { name: 'Board toolbar' }).getByTestId('children-board-total')).toHaveText('4 in progress')
      }
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

      // The page never scrolls sideways; on desktop the grid scrolls inside its own box, on phone it fits (item 12).
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

    // The lane action lands on its lane: focus on the lane's collapse button (#2370 fix A2).
    await expect(mode.getByRole('button', { name: `Collapse ${laneName}` })).toBeFocused()
    // Band: Focus (a filter of its own, not pressed by the link: #2370 fix A1), Copy link, the admin menu.
    const focus = mode.getByRole('button', { name: `Focus on ${laneName}` })
    await expect(focus).toHaveAttribute('aria-pressed', 'false')
    await expectText(focus, 'Focus')
    await expectText(mode.getByRole('button', { name: `Copy link to ${laneName}` }), 'Copy link')
    await mode.getByRole('button', { name: `Actions for swimlane "${laneName}"` }).click()
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

// Move (item 11), the over-limit column head (warning, never danger), and 44px lane actions under touch (#2370).
test('Children mode Move changes the column only and returns focus to the moved card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  const moves: unknown[] = []
  await page.route(/\/api\/v1\/boards\/7\/cards\/20\/move\/?(\?.*)?$/, async (route) => {
    moves.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.goto(`/boards/${BOARD.id}?show=children`)
  const mode = page.getByTestId('children-mode')
  const card = mode.getByRole('link', { name: /^Usage export spec/ })
  await card.focus()
  // Move lives inside the card's stop: Right reaches it, Tab never stops on it.
  await expect(mode.getByRole('button', { name: 'Move Usage export spec' })).toHaveAttribute('tabindex', '-1')
  await page.keyboard.press('ArrowRight')
  await expect(mode.getByRole('button', { name: 'Move Usage export spec' })).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Move Usage export spec' })
  await dialog.getByRole('radio', { name: /^Doing/ }).check()
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(moves).toEqual([expect.objectContaining({ column_id: 101, swimlane_id: 1 })])
  await expect(mode.getByRole('link', { name: /^Usage export spec/ })).toBeFocused()
  // No parent change and no drag here: the grid has no draggable card.
  await expect(mode.locator('[draggable="true"]')).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Children mode over-limit column head is warning, with the word over, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await routeAuth(page)
    await routeBoard(page, BOARD as typeof BOARD_FULL)
    const over = { ...view, child_boards: [{ ...view.child_boards[0], columns: view.child_boards[0].columns.map((c) => (c.id === 101 ? { ...c, card_count: 7 } : c)) }] }
    await page.route(/\/api\/v1\/boards\/\d+\/children-view\/(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(over) }),
    )
    await page.goto(`/boards/${BOARD.id}?show=children`)
    const caption = page.getByTestId('children-mode').getByText('1 of 7 on Delivery · limit 5 over')
    await expectText(caption, 'over-limit caption (warning on surface)')
    const fill = page.getByRole('meter', { name: 'Doing on Delivery: 7 of limit 5' }).locator('span')
    await expect(fill).toHaveClass(/bg-primary-emphasis/)
  })
}

test.describe('lane actions under a coarse pointer (#2370 ruling)', () => {
  test.use({ hasTouch: true })
  test('the Children lane action and Focus are 44px high at 1024px with touch', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await setup(page)
    await page.goto(`/boards/${BOARD.id}`)
    const laneName = BOARD_FULL.swimlanes[0].name
    const action = page.getByRole('button', { name: `Children 4 in progress, ${laneName}` })
    await expect(action).toBeVisible({ timeout: 10_000 })
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const focus = page.getByRole('button', { name: `Focus on ${laneName}` }).first()
    expect((await focus.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

// Phone at 390px (#2370 item 12, canvas 6b and 2f g): two-line tinted band, one child board and one of its columns
// at a time, parent headings, "Nothing blocked", the Onboarding switch, no sideways scroll box, 44px, contrast.
const phoneView = {
  ...view,
  lanes: [{ ...view.lanes[0], parents: 3, child_boards: 2 }],
  rows: [
    view.rows[0],
    {
      ...view.rows[0], id: 901, title: 'Acme: platform renewal',
      rollup: { visible: true, total: 1, done: 0, doing: 1, todo: 0, blocked: 0, last_moved_at: null }, in_progress: 1, planned: 0,
      children: [{ id: 30, title: 'Migrate to v4 tenant', column_id: 100, swimlane_id: 1, position: 2, state: 'todo', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false }],
    },
    {
      ...view.rows[0], id: 902, title: 'Acme: training pack', child_board_id: 8,
      rollup: { visible: true, total: 2, done: 0, doing: 1, todo: 1, blocked: 0, last_moved_at: null }, in_progress: 2, planned: 0,
      children: [
        { id: 40, title: 'Kickoff deck', column_id: 200, swimlane_id: 1, position: 0, state: 'todo', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false },
        { id: 41, title: 'Trainer booked', column_id: 201, swimlane_id: 1, position: 0, state: 'doing', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false },
      ],
    },
    view.rows[1],
  ],
  child_boards: [
    { ...view.child_boards[0], columns: [...view.child_boards[0].columns.slice(0, 2), { id: 103, name: 'Blocked', color: '#EF4444', wip_limit: null, is_done: false, card_count: 2 }, view.child_boards[0].columns[2]] },
    {
      id: 8, name: 'Onboarding', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false,
      columns: [
        { id: 200, name: 'Booked', color: '#6B7280', wip_limit: null, is_done: false, card_count: 1 },
        { id: 201, name: 'Running', color: '#3B82F6', wip_limit: null, is_done: false, card_count: 1 },
      ],
    },
  ],
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Children mode phone layout at 390px, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await routeAuth(page)
    await routeBoard(page, BOARD as typeof BOARD_FULL)
    await page.route(/\/api\/v1\/boards\/\d+\/children-view\/(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(phoneView) }),
    )
    await page.goto(`/boards/${BOARD.id}?show=children`)
    const mode = page.getByTestId('children-mode')
    const laneName = BOARD_FULL.swimlanes[0].name
    // Two-line tinted band: the collapse button with name and total, then blocked and the hidden count.
    const band = mode.getByTestId('children-phone-band')
    await expect(band).toBeVisible({ timeout: 10_000 })
    await expectText(band.getByRole('button', { name: `Collapse lane ${laneName}, 4 in progress of 6` }).getByText(laneName), 'band name on tint')
    await expectText(band.getByText('4 in progress · 1 planned'), 'band total on tint')
    await expectText(band.getByText('1 blocked'), 'blocked on tint')
    await expectText(band.getByText("+4 you can't open"), 'hidden count on tint')
    await expectText(band.getByRole('button', { name: `Copy link to ${laneName}` }), 'Copy link on tint')

    // One column at a time, with the phone board's column buttons; parents are headings inside it.
    const columns = mode.getByRole('group', { name: 'Columns on Delivery' })
    const todo = columns.getByRole('button', { name: /^To do/ })
    await expect(todo).toHaveAttribute('aria-pressed', 'true')
    await expectText(todo, 'pressed column button')
    await expectText(columns.getByRole('button', { name: /^Doing/ }), 'column button')
    await expect(mode.getByRole('heading', { level: 4, name: PARENT.title })).toBeVisible()
    await expect(mode.getByText('Parent · column on')).toHaveCount(0)
    await todo.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const blocked = columns.getByRole('button', { name: /^Blocked/ })
    await expect(blocked).toBeFocused()
    await expect(blocked).toHaveAttribute('aria-pressed', 'true')
    // Neither Delivery parent has a child in the Blocked column (the band's "1 blocked" counts the flag, in Doing).
    await expect(mode.getByText('Nothing blocked')).toHaveCount(2)
    await expectText(mode.getByText("Delivery's columns. Blocked here is the column; the band counts the flag."), 'Blocked column note')
    await expectText(mode.getByText('Nothing blocked').nth(1), 'Nothing blocked')
    await expect(mode.getByRole('heading', { level: 4, name: 'Acme: platform renewal' })).toBeVisible()

    // The grid is not a sideways scroll box any more: it fits the viewport and nothing in the page scrolls sideways.
    const grid = mode.getByRole('grid', { name: /children on Delivery, by parent/ })
    const gridBox = (await grid.boundingBox())!
    expect(gridBox.x + gridBox.width).toBeLessThanOrEqual(390)
    expect(await grid.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

    // A second child board in the lane is one switch; it swaps the column buttons to that board.
    const toOnboarding = mode.getByRole('button', { name: 'Show Onboarding, 2 children, columns' })
    await expectText(toOnboarding, 'board switch')
    await toOnboarding.click()
    const onboarding = mode.getByRole('group', { name: 'Columns on Onboarding' })
    await expect(onboarding.getByRole('button', { name: /^Booked/ })).toBeFocused()
    await expect(mode.getByRole('group', { name: 'Columns on Delivery' })).toHaveCount(0)
    await expect(mode.getByRole('heading', { level: 4, name: 'Acme: training pack' })).toBeVisible()

    // Every target is at least 44px high.
    for (const target of await mode.locator('button, a').all()) {
      const box = await target.boundingBox()
      if (box) expect(box.height, await target.innerText()).toBeGreaterThanOrEqual(44)
    }
  })
}

test('the phone lane band has the Children lane action at 44px (390px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await setup(page)
  await page.goto(`/boards/${BOARD.id}`)
  const laneName = BOARD_FULL.swimlanes[0].name
  const action = page.getByRole('button', { name: `Children 4 in progress, ${laneName}` })
  await expect(action).toBeVisible({ timeout: 10_000 })
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await action.click()
  await expect(page).toHaveURL(new RegExp(`show=children&lane=${LANE_ID}`))
})
