import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_TODO, COLUMN_DONE } from './fixtures/board'

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
      await expect(help).toContainText(width < 640 ? 'Counts once needed.' : 'Counts once the work is pulled or needed.')
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

// ---- Add child dialog and the full planned-child flow (#2549, #2552) ----
const COLS = [
  { ...COLUMN_TODO, id: 1, name: 'Lead', position: 0 },
  { ...COLUMN_TODO, id: 3, uid: 'col0000003q', name: 'Qualify', position: 1 },
  { ...COLUMN_TODO, id: 4, uid: 'col0000004p', name: 'Proposal', position: 2 },
  { ...COLUMN_DONE, id: 2, position: 3 },
]
const CHILD_COLS = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 2 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: null, is_done: false, card_count: 1 },
  { id: 102, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 0 },
]
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const childRow = (id: number, title: string, planned: boolean, due: string | null) => ({
  id, title, board_id: 7, column_id: 100, column_name: 'To do', swimlane_id: 1, swimlane_name: 'Lane', archived: false,
  position: id, assignee: null, blocked: false, blocked_at: null, priority: 'low', due_date: due, labels: [], planned,
})

/** A parent with the later columns, the child board options, and a children list read from `state`. */
async function setupAdd(page: Page, state: { parentColumn: number; children: ReturnType<typeof childRow>[]; posted: Record<string, unknown>[]; moves: Record<string, unknown>[] }) {
  await routeAuth(page)
  await routeBoard(page, BOARD as typeof BOARD_FULL)
  const full = () => ({ ...BOARD_FULL, cards_can_have_children: true, current_user_role: 'admin', columns: COLS, cards: [{ ...CARD, title: 'Hooli: pilot rollout', column: state.parentColumn }] })
  await page.route(`**/api/v1/boards/${BOARD.id}/full/`, (r) => r.fulfill(json(full())))
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks|movements)\/(\?.*)?$/, (r) => r.fulfill(json([])))
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (r) => r.fulfill(json({ count: 0, next: null, results: [] })))
  await page.route(`**/api/v1/boards/${BOARD.id}/cards/${CARD.id}/child-board-options/`, (r) =>
    r.fulfill(json({ fixed_board: null, default: { id: 7, name: 'Delivery' }, can_set_default: false, boards: [{ id: 7, name: 'Delivery', can_set_default: false }] })))
  await page.route(`**/api/v1/boards/${BOARD.id}/cards/${CARD.id}/children/`, async (r) => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON()
      state.posted.push(body)
      const later = body.needed_at_column != null
      state.children.push(childRow(30, body.title, later, body.due_date ?? null))
      return r.fulfill(json({ id: 30, title: body.title, planned: later }, 201))
    }
    return r.fulfill(json({ count: state.children.length, visible: true, offset: 0, limit: 50, results: state.children,
      board: { id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false, columns: CHILD_COLS } }))
  })
  await page.route(/\/api\/v1\/boards\/7\/cards\/\d+\/move\//, (r) => {
    state.moves.push(r.request().postDataJSON())
    const id = Number(r.request().url().match(/cards\/(\d+)\/move/)![1])
    const c = state.children.find((x) => x.id === id)!
    Object.assign(c, { planned: false, column_id: 101, column_name: 'Doing' })
    return r.fulfill(json({ card: { id, planned: false, column: 101 } }))
  })
}

async function openAddChild(page: Page) {
  await page.goto(`/boards/${BOARD.id}?card=${CARD.id}&tab=children`)
  await page.getByRole('button', { name: /^Add child/ }).first().click()
  return page.getByRole('dialog', { name: /^Add child/ })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Add child: Needed sheet and Due date on a phone, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: scheme })
    await setupAdd(page, { parentColumn: 1, children: [], posted: [], moves: [] })
    const dialog = await openAddChild(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    const needed = dialog.getByRole('combobox', { name: 'Needed' })
    const due = dialog.getByLabel('Due date (optional)')
    await expect(needed).toBeVisible({ timeout: 10_000 })
    for (const el of [needed, due]) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Settle the scroll first: the dropdown closes on any outside scroll, including a click's scroll-into-view.
    await needed.scrollIntoViewIfNeeded()
    await needed.click()
    await expect(page.locator('[data-sheet="true"]')).toBeVisible()
    for (const name of ['Now', 'When the parent reaches Qualify', 'When the parent reaches Proposal', 'When the parent reaches Done']) {
      const opt = page.getByRole('option', { name })
      await expect(opt).toBeVisible()
      expect((await opt.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await page.getByRole('option', { name: 'When the parent reaches Proposal' }).click()
    await expect(page.locator('[data-sheet="true"]')).toHaveCount(0)
    await expect(needed).toContainText('Proposal')
    await due.fill('2030-12-04')
    const help = dialog.getByTestId('due-inactive-help')
    await expect(help).toContainText('Inactive while planned.')
    await expect(help).toContainText('Counts once needed.')
    // Both spans are in the DOM; the long desktop sentence is display:none on a phone.
    await expect(help.getByText(/^Saved now/)).toBeHidden()
    const ratio = await help.evaluate(contrast)
    expect(ratio, `helper contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  })
}

test('planned flow: add child at a later column, parent reaches it, release, pull another early', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const state = {
    parentColumn: 1, posted: [] as Record<string, unknown>[], moves: [] as Record<string, unknown>[],
    // Another planned child, already waiting for Done.
    children: [childRow(21, 'Pilot kickoff', true, null)],
  }
  await setupAdd(page, state)
  const dialog = await openAddChild(page)
  const tab = page.getByTestId('card-children-tab')
  const planned = () => tab.getByTestId('child-card-face').filter({ hasText: /planned/i })
  await expect(planned()).toHaveCount(1)
  // 1. Add child with Needed = Proposal and a date.
  await dialog.getByLabel('Title').fill('Proposal workshop')
  await dialog.getByRole('combobox', { name: 'Needed' }).click()
  await page.getByRole('option', { name: 'When the parent reaches Proposal' }).click()
  await dialog.getByLabel('Due date (optional)').fill('2030-12-04')
  await dialog.getByRole('button', { name: /^Add to / }).click()
  await expect.poll(() => state.posted).toEqual([expect.objectContaining({ title: 'Proposal workshop', needed_at_column: 4, due_date: '2030-12-04' })])
  await expect(dialog).toBeHidden()
  await expect(tab.getByRole('link', { name: /^Proposal workshop/ })).toBeVisible()
  await expect(planned()).toHaveCount(2)
  // 2. SIMULATED: the parent reaches Proposal. The server releases the child planned for it (its planned line goes
  // away, the other stays planned for Done); the page re-reads the board and the children, as it does on the socket event.
  state.parentColumn = 4
  state.children.find((c) => c.id === 30)!.planned = false
  await page.goto(`/boards/${BOARD.id}?card=${CARD.id}&tab=children`)
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await expect(tab.getByRole('link', { name: /^Proposal workshop/ })).toBeVisible()
  await expect(planned()).toHaveCount(1)
  // 3. Pull the other planned child early: its Move warns, then it leaves planned.
  await tab.getByRole('button', { name: 'Move Pilot kickoff' }).click()
  const move = page.getByRole('dialog', { name: 'Move Pilot kickoff' })
  await move.getByRole('radio', { name: 'Doing' }).check()
  await move.getByRole('button', { name: 'Move', exact: true }).click()
  await expect.poll(() => state.moves.length).toBe(1)
  await expect(planned()).toHaveCount(0)
})
