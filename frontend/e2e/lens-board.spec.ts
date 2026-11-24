import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, USER } from './fixtures/board'

// #1132: end-to-end coverage for the Issue Board Lens itself (lens-toolbar.spec.ts
// covers only the toolbar layout, against a failing board fetch). The provider is
// never called: the lens board endpoint is mocked and answers from the query string,
// so the filter assertions prove the UI sends the server-side filter rather than
// narrowing the cards itself.
const LENS_CONNECTION = {
  id: 1,
  provider: 'gitlab',
  repo_slug: 'acme/widgets',
  column_dim: 'pipeline',
  swimlane_dim: 'milestone',
  created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
  created_at: '',
  updated_at: '',
}

const PIPELINE_COLUMNS = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['doing', 'Doing'],
  ['review', 'Review'],
  ['done', 'Done'],
].map(([key, label]) => ({ key, label, is_current: false }))

function issue(number: number, title: string, state: 'open' | 'closed', column: string) {
  return {
    number,
    title,
    url: `https://gitlab.com/acme/widgets/-/issues/${number}`,
    state,
    labels: [],
    assignees: [],
    milestone: '1.0',
    milestone_due: null,
    milestone_state: 'active',
    column_keys: [column],
    swimlane_keys: ['1.0'],
    has_branch: column === 'doing',
    has_open_pr: column === 'review',
    pipeline_evidence: column === 'doing' ? { branch: '2-fix-login', mr_number: null, mr_url: null, mr_closes: false } : null,
  }
}

const OPEN_ISSUES = [
  issue(1, 'Write the spec', 'open', 'backlog'),
  issue(2, 'Fix the login redirect', 'open', 'doing'),
]
const CLOSED_ISSUE = issue(3, 'Ship the beta', 'closed', 'done')

function lensData(issues: unknown[], extra: Record<string, unknown> = {}) {
  return {
    columns: PIPELINE_COLUMNS,
    swimlanes: [{ key: '1.0', label: '1.0', is_current: true }],
    issues,
    fetched_at: new Date().toISOString(),
    source: { provider: 'gitlab', repo: 'acme/widgets', url: 'https://gitlab.com/acme/widgets' },
    truncated: false,
    total_count: issues.length,
    closed_limit: 50,
    closed_truncated: false,
    available_milestones: ['1.0'],
    ...extra,
  }
}

interface Mock {
  /** Every query string the lens board endpoint was asked for, in order. */
  requests: URLSearchParams[]
  /** When true the next ?refresh=1 answers 502, as a degraded provider would with no stale copy. */
  failRefresh: boolean
}

async function setup(page: Page): Promise<Mock> {
  const mock: Mock = { requests: [], failRefresh: false }
  await routeAuth(page)
  const lensUser = { ...USER, git_lens_enabled: true }
  for (const path of ['auth/user', 'auth/me']) {
    await page.route(`**/api/v1/${path}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lensUser) }),
    )
  }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(`**/api/v1/git-lens/connections/${BOARD_FULL.id}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LENS_CONNECTION) }),
  )
  await page.route(`**/api/v1/git-lens/board/${BOARD_FULL.id}/**`, (route) => {
    const params = new URL(route.request().url()).searchParams
    mock.requests.push(params)
    if (params.get('refresh') === '1' && mock.failRefresh) {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'lens_error', detail: 'Could not fetch issues from the provider.' }),
      })
    }
    // Server-side filtering is the server's job; this mock plays that part.
    let body
    if (params.get('state') === 'open') body = lensData(OPEN_ISSUES, { closed_limit: null })
    else if (params.get('closed_limit') === '0') body = lensData(OPEN_ISSUES, { closed_limit: 0 })
    else body = lensData([...OPEN_ISSUES, CLOSED_ISSUE])
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  return mock
}

const card = (page: Page, number: number, title: string) =>
  page.getByRole('button', { name: `Open issue #${number}: ${title} (opens in new tab)` })

async function openLens(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
  const tab = page.getByRole('button', { name: 'Lens', exact: true })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(card(page, 1, 'Write the spec')).toBeVisible()
}

async function showFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expect(page.getByRole('search', { name: 'Lens filters' })).toBeVisible()
}

test.describe('Issue Board Lens', () => {
  test('renders the derived pipeline columns with the provider issues in them', async ({ page }) => {
    await setup(page)
    await openLens(page)
    for (const label of ['Backlog', 'To Do', 'Doing', 'Review', 'Done']) {
      await expect(page.getByRole('separator', { name: `Resize ${label} column` })).toBeAttached()
    }
    await expect(card(page, 2, 'Fix the login redirect')).toBeVisible()
    await expect(card(page, 3, 'Ship the beta')).toBeVisible()
    await expect(page.getByText('Read-only lens ·')).toBeVisible()
  })

  test('a State filter is sent to the server and narrows the cards to its answer', async ({ page }) => {
    const mock = await setup(page)
    await openLens(page)
    await showFilters(page)
    await page.getByRole('button', { name: /State: All/ }).click()
    await page.getByRole('menuitem', { name: 'State: Open' }).click()
    await expect(card(page, 3, 'Ship the beta')).toHaveCount(0)
    await expect(card(page, 1, 'Write the spec')).toBeVisible()
    expect(mock.requests.at(-1)?.get('state')).toBe('open')
    await expect(page).toHaveURL(/[?&]state=open/)
  })

  test('the Closed filter hides closed issues at the server and the banner says so (#1581)', async ({ page }) => {
    const mock = await setup(page)
    await openLens(page)
    // The default limit is the server's, so the first request does not send one.
    expect(mock.requests[0].get('closed_limit')).toBeNull()
    await showFilters(page)
    await page.getByRole('button', { name: /Closed: Last 50/ }).click()
    await page.getByRole('menuitem', { name: 'Closed: Hidden' }).click()
    await expect(card(page, 3, 'Ship the beta')).toHaveCount(0)
    expect(mock.requests.at(-1)?.get('closed_limit')).toBe('0')
    await expect(page.getByTestId('lens-closed-note')).toHaveText('Closed issues hidden')
    await expect(page).toHaveURL(/[?&]closed_limit=0/)
  })

  test('a failed refresh keeps the last good board on screen', async ({ page }) => {
    const mock = await setup(page)
    await openLens(page)
    mock.failRefresh = true
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => mock.requests.some((p) => p.get('refresh') === '1')).toBe(true)
    // The degraded provider never replaces the board with the error state.
    await expect(page.getByText('Could not load the lens')).toHaveCount(0)
    await expect(card(page, 1, 'Write the spec')).toBeVisible()
    await expect(card(page, 3, 'Ship the beta')).toBeVisible()
  })
})
