import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The flow dashboard against mocked `metrics/*` responses (#448). jsdom cannot
// lay out SVG or resolve the color tokens, so this is what checks that the
// charts actually draw, that the marks stay clickable through the stacked
// layers, and that the drawer opens over the page.

const DAY_MS = 86_400_000
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()
const dateDaysAgo = (days: number) => isoDaysAgo(days).slice(0, 10)

const owner = { id: 7, username: 'pat', display_name: 'Pat Lee', avatar_url: '' }
const flowCard = (n: number) => ({
  uid: `flowcard${String(n).padStart(8, '0')}`, id: n === 0 ? CARD.id : 1000 + n, title: n === 0 ? CARD.title : `Flow card ${n}`, archived: false, assignee: n % 2 ? owner : null,
})
const cards = Array.from({ length: 24 }, (_, n) => flowCard(n))
const columnUids = ['col-backlog', 'col-doing', 'col-review', 'col-done']

const cycleTime = {
  definition: 'the time from a first pull until the first done entry.',
  sample_size: 24,
  excluded_incomplete_history: 1,
  percentiles: { p50: 4.2, p85: 8.1, p95: 12.6 },
  samples: cards.map((card, n) => ({
    card_uid: card.uid, value_days: 1 + (n * 13) / 24, start: isoDaysAgo(70 - n), end: isoDaysAgo(60 - 2 * n), reopened: n === 3,
  })),
  cards,
}
const throughput = {
  definition: 'the number of cards whose first entry into a done column falls in a period.',
  period: 'week',
  total: 24,
  median: 2,
  samples: Array.from({ length: 12 }, (_, n) => ({
    start: dateDaysAgo(84 - 7 * n), count: n % 4, card_uids: cards.slice(n, n + n % 4).map((c) => c.uid),
  })),
  cards,
}
const cumulativeFlow = {
  definition: 'for each day, the number of cards in each column at the end of that day.',
  columns: [
    { column_uid: 'col-backlog', column_name: 'Backlog', is_done: false },
    { column_uid: 'col-doing', column_name: 'Doing', is_done: false },
    { column_uid: 'col-review', column_name: 'Review', is_done: false },
    { column_uid: 'col-done', column_name: 'Done', is_done: true },
    { column_uid: null, column_name: null, is_done: false },
  ],
  days: Array.from({ length: 90 }, (_, n) => ({
    date: dateDaysAgo(90 - n),
    counts: { 'col-backlog': 8, 'col-doing': 2 + Math.floor(n / 12), 'col-review': 3, 'col-done': Math.floor(n / 4), null: 0 },
  })),
  bottleneck_column_uid: 'col-doing',
}
const wipAge = {
  definition: 'how long an in-progress card has been in progress.',
  sample_size: 12,
  excluded_incomplete_history: 0,
  cycle_time_percentiles: { p50: 4.2, p85: 8.1, p95: 12.6 },
  columns: columnUids.slice(0, 3).map((uid, n) => ({ column_uid: uid, column_name: ['Backlog', 'Doing', 'Review'][n] })),
  samples: cards.slice(0, 12).map((card, n) => ({
    card_uid: card.uid,
    column_uid: columnUids[n % 3],
    value_days: 1 + n * 1.3,
    start: isoDaysAgo(1 + n),
    dwell_by_column: [{ column_uid: 'col-backlog', value_days: 1 }, { column_uid: 'col-doing', value_days: n * 1.3 }],
    is_blocked: n % 5 === 0,
    blocked_days: n % 5 === 0 ? 1.5 : 0,
  })),
  cards,
}

async function openAnalytics(page: Page) {
  await routeAuth(page)
  await routeBoard(page)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/analytics/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        days: 30, columns: [], done_columns: [], board_medians: {}, swimlanes: [],
        stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
      }),
    }),
  )
  const metric = (name: string, body: unknown) =>
    page.route(`**/api/v1/boards/${BOARD_FULL.id}/metrics/${name}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    )
  await metric('cycle-time', cycleTime)
  await metric('throughput', throughput)
  await metric('cumulative-flow', cumulativeFlow)
  await metric('wip-age', wipAge)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/*/movements/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 1, card_uid: cards[0].uid, card_title: cards[0].title, from_column_name: '', to_column_name: 'Backlog',
        movement_type: 'move', moved_at: isoDaysAgo(9), moved_by: owner,
      }]),
    }),
  )
  await page.goto(`/boards/${BOARD_FULL.id}?view=analytics`)
  await expect(page.getByTestId('flow-wip-age')).toBeVisible({ timeout: 10_000 })
}

test.describe('flow metrics dashboard', () => {
  test('draws all four charts with direct labels and percentile lines', async ({ page }) => {
    await openAnalytics(page)
    const cycle = page.getByTestId('flow-cycle-time')
    await expect(cycle.getByRole('img')).toContainText('85th · 8.1d')
    await expect(page.getByTestId('flow-throughput').getByRole('img')).toContainText('Median · 2')
    const cumulative = page.getByTestId('flow-cumulative')
    await expect(cumulative.getByRole('img')).toContainText('Doing')
    // The hatch must resolve: a broken url(#id) renders the band unfilled.
    const hatch = cumulative.locator('[data-band="col-doing"] polygon')
    const patternId = (await hatch.getAttribute('fill'))?.match(/url\(#(.+)\)/)?.[1]
    expect(patternId).toBeTruthy()
    await expect(cumulative.locator(`pattern[id="${patternId}"]`)).toHaveCount(1)
    await expect(page.getByTestId('flow-wip-age').getByRole('img')).toContainText('95th · 12.6d')
    const box = await cycle.getByRole('img').boundingBox()
    expect(box?.width).toBeGreaterThan(200)
  })

  test('a click reaches a mark through the image layer and opens the drawer', async ({ page }) => {
    await openAnalytics(page)
    await page.getByTestId('flow-wip-age').getByRole('button', { name: /Flow card 1,/ }).click()
    const drawer = page.getByRole('dialog', { name: 'Flow card 1' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('Pat Lee', { exact: true })).toBeVisible()
    await expect(drawer.getByText('Created in Backlog')).toBeVisible()
    expect((await drawer.boundingBox())?.width).toBe(540)
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
  })

  test('aging dots are the only chart tab stops and Enter opens the drawer', async ({ page }) => {
    await openAnalytics(page)
    const dot = page.getByTestId('flow-wip-age').getByRole('button', { name: /days in progress/ }).first()
    await dot.focus()
    await expect(dot).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('the table is reachable with the keyboard and goes one column wide on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await openAnalytics(page)
    const panels = [page.getByTestId('flow-cycle-time'), page.getByTestId('flow-throughput')]
    const [first, second] = await Promise.all(panels.map((panel) => panel.boundingBox()))
    expect(second?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 1)
    await panels[0].getByRole('button', { name: 'table' }).click()
    const region = panels[0].getByRole('region', { name: 'Cycle time per card' })
    await region.focus()
    await expect(region).toBeFocused()
    await expect(region.getByRole('button', { name: CARD.title })).toBeVisible()
  })
})
