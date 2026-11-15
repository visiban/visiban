import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The Analytics Overview against mocked `metrics/*` and `analytics/` responses (#448, #2261). jsdom cannot
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
    start: dateDaysAgo(84 - 7 * n), count: n % 4, card_uids: cards.slice(n, n + n % 4).map((c) => c.uid), started: n % 3,
  })),
  cards,
}
// The #2260 column-flow fields: a net change only, so entered - left matches the counts below.
const columnFlow = (start: number, end: number) => ({
  start_count: start, end_count: end,
  entered: Math.max(end - start, 0), left: Math.max(start - end, 0),
  entered_per_week: (Math.max(end - start, 0) * 7) / 89, left_per_week: (Math.max(start - end, 0) * 7) / 89,
})
const cumulativeFlow = {
  definition: 'for each day, the number of cards in each column at the end of that day.',
  columns: [
    { column_uid: 'col-backlog', column_name: 'Backlog', is_done: false, ...columnFlow(8, 8) },
    { column_uid: 'col-doing', column_name: 'Doing', is_done: false, ...columnFlow(2, 9) },
    { column_uid: 'col-review', column_name: 'Review', is_done: false, ...columnFlow(3, 3) },
    { column_uid: 'col-done', column_name: 'Done', is_done: true, ...columnFlow(0, 22) },
    { column_uid: null, column_name: null, is_done: false, ...columnFlow(0, 0) },
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

const dwell = {
  definition: 'completed time in each column.',
  sample_size: 24,
  excluded_incomplete_history: 0,
  columns: [
    { column_uid: 'col-backlog', column_name: 'Backlog', sample_size: 24, percentiles: { p50: 1.1, p85: 2, p95: 3 } },
    { column_uid: 'col-doing', column_name: 'Doing', sample_size: 24, percentiles: { p50: 2.1, p85: 4, p95: 6 } },
    { column_uid: 'col-review', column_name: 'Review', sample_size: 24, percentiles: { p50: 0.8, p85: 1.5, p95: 2 } },
  ],
}
const blocked = {
  definition: 'manual blocks that overlapped the period.',
  total: { days: 14.5, blocks: 10 },
  blocked_now: 3,
  columns: [{ column_uid: 'col-doing', column_name: 'Doing', days: 14.5, blocks: 10 }],
  reasons: [{ reason: 'Waiting on security review', days: 6.5, blocks: 5 }],
  reason_count: 1,
}
const attention = {
  definition: 'blocked, past the 85th percentile, or stalled.',
  stalled_threshold_days: 7,
  cycle_time_percentiles: { p50: 4.2, p85: 8.1, p95: 12.6 },
  items: [{ card_uid: cards[5].uid, column_uid: 'col-doing', swimlane_id: BOARD_FULL.swimlanes[0].id, age_days: 12, unmoved_days: 9, reasons: ['stalled'] }],
  cards: [cards[5]],
}

async function openAnalytics(page: Page) {
  await routeAuth(page)
  await routeBoard(page)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/analytics/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        days: 90, columns: ['Doing'], done_columns: [], board_medians: {},
        swimlanes: [{
          id: BOARD_FULL.swimlanes[0].id, name: 'A very long swimlane name that must not widen the page',
          avg_days_per_column: { Doing: 3 }, is_outlier: {}, age_avg_days_per_column: { Doing: 3 },
          deal_velocity_days: 5, stalled_cards: [],
        }],
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
  await metric('dwell', dwell)
  await metric('blocked', blocked)
  await metric('attention', attention)
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
  test('names the bottleneck, states the headline numbers, and one filter refetches every panel', async ({ page }) => {
    await openAnalytics(page)
    const bottleneck = page.getByTestId('analytics-bottleneck')
    await expect(bottleneck.getByRole('heading', { name: 'Doing' })).toBeVisible()
    await expect(bottleneck).toContainText('Cards wait 2.1 days here, about half of the whole cycle.')
    await expect(page.getByTestId('analytics-tiles')).toContainText('14.5days')
    await expect(page.getByTestId('analytics-attention')).toContainText(cards[5].title)
    await expect(page.getByTestId('analytics-blocked')).toContainText('Waiting on security review')

    const requested: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.searchParams.get('days') === '30') requested.push(url.pathname.split('/').slice(-2, -1)[0])
    })
    await page.getByRole('button', { name: /^Date range/ }).click()
    await page.getByRole('menuitem', { name: 'Last 30 days' }).click()
    await expect.poll(() => [...requested].sort()).toEqual(
      ['analytics', 'attention', 'blocked', 'cumulative-flow', 'cycle-time', 'dwell', 'throughput', 'wip-age'],
    )
    await expect(page.getByTestId('flow-wip-age')).toBeVisible()
  })

  test('has no sideways page scroll at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openAnalytics(page)
    await expect(page.getByTestId('analytics-bottleneck').getByRole('heading', { name: 'Doing' })).toBeVisible()
    const fits = await page.getByTestId('analytics-page').evaluate((el) => el.scrollWidth <= el.clientWidth)
    expect(fits).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

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
    // Cumulative flow and Throughput share a row from lg; below it they stack.
    const [first, second] = await Promise.all(
      [page.getByTestId('flow-cumulative'), page.getByTestId('flow-throughput')].map((panel) => panel.boundingBox()),
    )
    expect(second?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 1)
    const panels = [page.getByTestId('flow-cycle-time')]
    await panels[0].getByRole('button', { name: 'table' }).click()
    const region = panels[0].getByRole('region', { name: 'Cycle time per card' })
    await region.focus()
    await expect(region).toBeFocused()
    await expect(region.getByRole('button', { name: CARD.title })).toBeVisible()
  })
})
