/**
 * Toast region narrow-viewport rules in a real browser (#2123, follow-up to
 * #2060). frontend/CLAUDE.md § Toasts → Placement and Dismissal. The unit test
 * (src/test/toastProvider.test.tsx) only pins class names; jsdom evaluates no
 * media queries, so these computed-style checks are the only proof the
 * Tailwind `max-[…px]:` variants actually apply.
 *
 * The toast is the real admin "WIP limit reached" refusal: dragging a card
 * onto Done with a mocked 409 whose column name is long enough to wrap past
 * three lines on a phone, and the admin override as the toast's action button.
 */
import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

const LONG_COLUMN = 'Done and awaiting the quarterly stakeholder sign-off review across every regional office and partner team '.repeat(4).trim()

async function raiseBlockedToast(page: Page) {
  await routeAuth(page)
  await routeBoard(page)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'wip_limit_exceeded', column_name: LONG_COLUMN, current_count: 3, wip_limit: 3 }),
    }),
  )
  await page.goto(`/boards/${BOARD_FULL.id}`)
  const cardEl = page.getByText(CARD.title).first()
  await expect(cardEl).toBeVisible({ timeout: 10_000 })
  const cardBox = await cardEl.boundingBox()
  const doneBox = await page.getByText('Done').first().boundingBox()
  if (!cardBox || !doneBox) throw new Error('Could not locate card or Done column')
  const fromX = cardBox.x + cardBox.width / 2
  const fromY = cardBox.y + cardBox.height / 2
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(fromX, fromY + 10, { steps: 3 })
  await page.mouse.move(doneBox.x + doneBox.width / 2, doneBox.y + doneBox.height / 2, { steps: 10 })
  await page.mouse.up()
  const region = page.getByTestId('toast-region')
  await expect(region).toBeVisible({ timeout: 5_000 })
  return region
}

const css = (loc: Locator, prop: string) =>
  loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)

/**
 * Layout size, not boundingBox: the toast plays a scale-in fade (animate-fade-in)
 * and a mid-animation transform would read 43.9px for a 44px target.
 */
const size = (loc: Locator) => loc.evaluate((el) => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }))

/** The region's own px insets from the viewport edges. */
async function insets(page: Page, region: Locator) {
  const box = (await region.boundingBox())!
  const vw = page.viewportSize()!.width
  return { left: box.x, right: vw - (box.x + box.width), width: box.width }
}

test.describe('toast region viewport rules (#2123)', () => {
  test('1024px: centered, capped width, 44px dismiss target, no phone rules', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 })
    const region = await raiseBlockedToast(page)
    const toast = region.locator('[data-toast-id]').first()

    // Desktop width rule (#1439): shrink-wrapped, capped at 24rem, centered.
    const { left, right, width } = await insets(page, region)
    expect(width).toBeLessThanOrEqual(384 + 0.5)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    expect(left).toBeGreaterThan(100)

    // max-[1024px] close button: 44px, up from 24px on desktop.
    const close = toast.getByRole('button', { name: 'Dismiss notification' })
    const closeBox = await size(close)
    expect(closeBox.width).toBeGreaterThanOrEqual(44)
    expect(closeBox.height).toBeGreaterThanOrEqual(44)

    // The phone-only line clamp is off.
    expect(await css(toast.locator('p').first(), '-webkit-line-clamp')).toBe('none')
  })

  test('820px: left-4/right-4 gutters, 28rem cap, 44px action and dismiss, safe-area padding', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 800 })
    const region = await raiseBlockedToast(page)
    const toast = region.locator('[data-toast-id]').first()

    // left-4 / right-4 (the box itself is capped by max-w-[28rem] and centered
    // by mx-auto, so the gutters show in the computed offsets, not the box).
    expect(await css(region, 'left')).toBe('16px')
    expect(await css(region, 'right')).toBe('16px')
    expect(await css(region, 'max-width')).toBe('448px')
    const { left, right, width } = await insets(page, region)
    expect(width).toBeLessThanOrEqual(448 + 0.5)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    expect(left).toBeGreaterThanOrEqual(16)

    // Safe-area padding: headless Chrome resolves env() to 0, so the computed
    // value cannot differ. Pin that the shipped stylesheet carries the rule
    // for the class the region actually has.
    const hasSafeAreaRule = await region.evaluate((el) => {
      if (!el.classList.contains('max-[820px]:pb-[env(safe-area-inset-bottom)]')) return false
      const scan = (rules: CSSRuleList): boolean =>
        Array.from(rules).some((r) => {
          const nested = (r as CSSGroupingRule).cssRules
          if (nested && scan(nested)) return true
          return r.cssText.includes('safe-area-inset-bottom') && r.cssText.includes('padding-bottom')
        })
      return Array.from(document.styleSheets).some((s) => {
        try { return scan(s.cssRules) } catch { return false }
      })
    })
    expect(hasSafeAreaRule).toBe(true)

    // Action: 44px tap target, label centered in it.
    const action = toast.getByRole('button', { name: 'Move anyway (admin override)' })
    expect(await css(action, 'min-height')).toBe('44px')
    expect((await size(action)).height).toBeGreaterThanOrEqual(44)
    expect(await css(action, 'align-items')).toBe('center')

    const close = toast.getByRole('button', { name: 'Dismiss notification' })
    const closeBox = await size(close)
    expect(closeBox.width).toBeGreaterThanOrEqual(44)
    expect(closeBox.height).toBeGreaterThanOrEqual(44)

    // The line clamp is a phone-only rule (≤640px).
    expect(await css(toast.locator('p').first(), '-webkit-line-clamp')).toBe('none')
  })

  test('640px: full width between 16px gutters, three-line clamp with full text in title, 44px targets', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 })
    const region = await raiseBlockedToast(page)
    const toast = region.locator('[data-toast-id]').first()

    // max-w-none: the region spans the viewport minus left-4/right-4.
    expect(await css(region, 'max-width')).toBe('none')
    const { left, right } = await insets(page, region)
    expect(left).toBeCloseTo(16, 0)
    expect(right).toBeCloseTo(16, 0)

    // line-clamp-3 on the message, with the whole text recoverable from `title`.
    const text = toast.locator('p').first()
    expect(await css(text, '-webkit-line-clamp')).toBe('3')
    const title = await text.getAttribute('title')
    expect(title).toContain('WIP limit reached')
    expect(title).toContain(LONG_COLUMN)
    const metrics = await text.evaluate((el) => ({
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      clamped: el.clientHeight,
      // The same text with the clamp lifted: proves it really overflowed.
      unclamped: (() => {
        const h = el as HTMLElement
        h.style.setProperty('-webkit-line-clamp', 'none')
        h.style.setProperty('display', 'block')
        const full = h.clientHeight
        h.style.removeProperty('-webkit-line-clamp')
        h.style.removeProperty('display')
        return full
      })(),
    }))
    // Rendered height is exactly three lines, and there was more text than fit.
    expect(metrics.clamped).toBeLessThanOrEqual(metrics.lineHeight * 3 + 1)
    expect(metrics.unclamped).toBeGreaterThan(metrics.clamped)

    const action = toast.getByRole('button', { name: 'Move anyway (admin override)' })
    expect(await css(action, 'min-height')).toBe('44px')
    expect((await size(action)).height).toBeGreaterThanOrEqual(44)

    const closeBox = await size(toast.getByRole('button', { name: 'Dismiss notification' }))
    expect(closeBox.width).toBeGreaterThanOrEqual(44)
    expect(closeBox.height).toBeGreaterThanOrEqual(44)
  })
})
