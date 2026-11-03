import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL } from './fixtures/board'

// The rotate confirm (#2054), rendered for real: two named outcomes, and a
// one-time secret that the modal won't let go of while it is on its way.
// Everything is mocked, so this is the UI's half only.

const UNTIL = new Date(Date.now() + 86_400_000).toISOString()

const WEBHOOK = {
  id: 9, board: BOARD_FULL.id, name: '', url_display: 'hooks.example.com/…/abcd', url_host: 'hooks.example.com',
  event_types: [], enabled: true, disabled_reason: null, disabled_at: null, last_delivered_event_id: 0,
  consecutive_failures: 0, failing_since: null, next_attempt_at: null, last_attempt_at: null,
  last_success_at: null, last_error_code: '', last_status_code: null, created_by: null, configured_by: null,
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', configured_at: null,
  secret_rotated_at: null, previous_secret_expires_at: null,
}

async function routeWebhooks(page: Page) {
  const base = `**/api/v1/boards/${BOARD_FULL.id}/webhooks`
  await page.route(`${base}/status/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true, dispatcher_last_run_at: new Date().toISOString(), dispatcher_stale: false,
        subscribable_event_types: ['card.moved'], disable_after_failures: 20, test_timeout_seconds: 10,
      }),
    }),
  )
  await page.route(`${base}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([WEBHOOK]) }),
  )
}

// By its text: the app's toast announcer is an always-mounted, empty alert too.
const refusal = (page: Page) => page.getByRole('alert').filter({ hasText: /Wait for the new secret/ })

async function openRotateConfirm(page: Page) {
  await page.goto(`/boards/${BOARD_FULL.id}?settings=webhooks`)
  await page.getByRole('button', { name: /^Manage webhook/ }).click()
  await page.getByRole('button', { name: 'Rotate secret…' }).click()
}

test.describe('webhook secret rotation', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await routeWebhooks(page)
  })

  test('keep old holds the modal open until the secret arrives, then shows it and the until line', async ({ page }, testInfo) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let posted: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/webhooks/9/rotate/`, async (route) => {
      posted = route.request().postDataJSON()
      await held
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...WEBHOOK, previous_secret_expires_at: UNTIL, secret: 'whsec_rendered' }),
      })
    })

    await openRotateConfirm(page)
    const keep = page.getByRole('button', { name: 'Keep old secret for 24 hours' })
    await expect(keep).toBeFocused()
    await expect(page.getByRole('button', { name: 'Revoke old secret now' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('rotate-confirm.png'), fullPage: true })

    await keep.click()
    await expect(page.getByRole('button', { name: 'Rotating…' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Close' }).click()
    // Seen from the refused control, not somewhere below the fold.
    await expect(refusal(page)).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('rotate-pending.png'), fullPage: true })

    release()
    await expect(page.getByRole('textbox', { name: 'Signing secret' })).toHaveValue('whsec_rendered')
    await page.screenshot({ path: testInfo.outputPath('rotate-revealed.png'), fullPage: true })
    const until = page.getByText(/Old secret still signed until/)
    await until.scrollIntoViewIfNeeded()
    await expect(until).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('rotate-until-line.png'), fullPage: true })
    expect(posted).toEqual({ overlap_seconds: 86400 })
  })

  test('the confirm fits a phone-width viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await openRotateConfirm(page)
    await expect(page.getByRole('button', { name: 'Keep old secret for 24 hours' })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('rotate-confirm-phone.png') })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/webhooks/9/rotate/`, () => {
      // Never answered: the refusal is what's being looked at.
    })
    await page.getByRole('button', { name: 'Keep old secret for 24 hours' }).click()
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(refusal(page)).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('rotate-pending-phone.png') })
  })
})
