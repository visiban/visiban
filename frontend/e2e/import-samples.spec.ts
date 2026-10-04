import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL } from './fixtures/board'

// "Start from a sample" gallery in the Import Board modal (#1452). Every API
// call is mocked; the sample list mirrors the shape of GET /boards/samples/.
const SAMPLES = [
  ['sales_overlay', 'Sales Overlay', 'See which accounts have coverage gaps under an enterprise overlay sales model.', 'account', 42],
  ['simple_kanban', 'Simple Kanban', 'A general-purpose team board with story points and merge request links.', 'team', 113],
  ['sales_pipeline', 'Sales Pipeline', 'Track deals from first prospect to closed, by region.', 'region', 60],
  ['product_roadmap', 'Product Roadmap', 'Plan and ship themes across quarters.', 'quarter', 50],
  ['customer_support', 'Customer Support', 'Triage and resolve tickets by priority.', 'priority', 70],
  ['content_production', 'Content Production', 'Move content from idea to published by channel.', 'channel', 55],
].map(([id, title, description, swimlane_theme, card_count], i) => ({
  id, title, description, swimlane_theme, card_count,
  includes: ['labels', 'checklists', 'comments', 'history'],
  order: i + 1,
  schema_version: 2,
  date_anchor: '2026-03-15',
}))

const SAMPLE_JSON = JSON.stringify({ schema_version: 2, name: 'Sales Overlay' })

async function routeSamples(page: Page) {
  await routeAuth(page)
  await routeBoard(page)
  await page.route('**/api/v1/boards/samples/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLES) }),
  )
  await page.route('**/api/v1/boards/samples/*/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: SAMPLE_JSON }),
  )
}

async function openImport(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Start from a sample' })).toBeVisible()
}

test.describe('import board — sample gallery', () => {
  test('on a 768px-tall laptop screen the header and footer stay fixed and the upload path is one scroll away', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 768 })
    await routeSamples(page)
    await openImport(page)
    const dialog = page.getByRole('dialog')

    await expect(page.getByRole('button', { name: 'Use the Sales Overlay sample' })).toBeVisible()
    await expect(page.getByText('Show all 6 samples')).toBeVisible()
    // The "or upload your own file" divider tells the user there is another path below the fold.
    await expect(page.getByText('or upload your own file')).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 })

    // 640px wide panel that fits the viewport; the body scrolls, not the page.
    const panel = await dialog.boundingBox()
    expect(panel?.width).toBeLessThanOrEqual(640)
    expect(panel?.width).toBeGreaterThan(600)
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(768)

    // Known gap (reported on #1452): with the real manifest text the dropzone
    // starts below the fold at 768px until the body is scrolled to it.
    const zone = dialog.getByRole('button', { name: /Click to select a \.json or \.csv file/ })
    await zone.scrollIntoViewIfNeeded()
    await expect(zone).toBeInViewport({ ratio: 1 })
  })

  test('shows four samples in two columns, and three in one column below 560px', async ({ page }) => {
    await routeSamples(page)
    await openImport(page)
    await expect(page.getByRole('heading', { level: 4 })).toHaveCount(4)
    const [a, b] = [
      await page.getByRole('heading', { name: 'Sales Overlay' }).boundingBox(),
      await page.getByRole('heading', { name: 'Simple Kanban' }).boundingBox(),
    ]
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(4) // same row

    await page.setViewportSize({ width: 480, height: 800 })
    await expect(page.getByRole('heading', { level: 4 })).toHaveCount(3)
    const [c, d] = [
      await page.getByRole('heading', { name: 'Sales Overlay' }).boundingBox(),
      await page.getByRole('heading', { name: 'Simple Kanban' }).boundingBox(),
    ]
    expect(d!.y).toBeGreaterThan(c!.y + 20) // stacked
    // The sheet never overflows the viewport sideways.
    const dialog = await page.getByRole('dialog').boundingBox()
    expect(dialog!.x).toBeGreaterThanOrEqual(0)
    expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(480)
  })

  test('a sample imports in two clicks with the date anchor', async ({ page }) => {
    await routeSamples(page)
    let importBody = ''
    await page.route('**/api/v1/boards/import/', async (route) => {
      importBody = route.request().postData() ?? ''
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...BOARD_FULL, import_summary: { skipped: {}, options_applied: { shift_dates_from: '2026-03-15' } } }),
      })
    })
    await openImport(page)

    await page.getByRole('button', { name: 'Use the Sales Overlay sample' }).click()
    await expect(page.getByText(/From sample:/)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Cards' })).toBeFocused()
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click()

    await expect(page).toHaveURL(new RegExp(`/boards/${BOARD_FULL.id}$`))
    expect(importBody).toContain('sales_overlay.json')
    expect(importBody).toContain('shift_dates_from')
    expect(importBody).toContain('2026-03-15')
  })

  test('Escape cancels a slow load, keeps the modal open, and returns focus to the card', async ({ page }) => {
    await routeSamples(page)
    await page.route('**/api/v1/boards/samples/*/', async (route) => {
      await new Promise((r) => setTimeout(r, 4_000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: SAMPLE_JSON }).catch(() => {})
    })
    await openImport(page)

    await page.getByRole('button', { name: 'Use the Sales Overlay sample' }).click()
    await expect(page.getByText('Loading sample…')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.getByText('Loading canceled.')).toBeAttached()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use the Sales Overlay sample' })).toBeFocused()
    await expect(page.getByText(/From sample:/)).toHaveCount(0)
  })

  test('a failed sample offers Try again and leaves uploading usable', async ({ page }) => {
    await routeSamples(page)
    await page.route('**/api/v1/boards/samples/*/', (route) => route.fulfill({ status: 500, body: 'boom' }))
    await openImport(page)

    await page.getByRole('button', { name: 'Use the Sales Overlay sample' }).click()
    await expect(page.getByRole('alert')).toContainText('Couldn’t load this sample.')
    await expect(page.getByRole('button', { name: /Try loading the Sales Overlay sample again/ })).toBeFocused()
    await expect(page.getByRole('button', { name: /Click to select a \.json or \.csv file/ })).toBeEnabled()
  })

  test('shows a banner with Retry when the sample list is unavailable', async ({ page }) => {
    await routeSamples(page)
    await page.route('**/api/v1/boards/samples/', (route) => route.fulfill({ status: 503, body: 'down' }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Import', exact: true }).click()

    await expect(page.getByText('Samples aren’t available right now.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Click to select a \.json or \.csv file/ })).toBeEnabled()
  })
})
