import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2298 — the intake callout's "More" body is hidden with the `hidden` attribute.
// jsdom cannot see CSS, so only a browser proves a display utility is not
// overriding it (preflight's [hidden] rule is not !important).

test.describe('intake column callout', () => {
  test('More body is hidden until the toggle is opened', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    // To Do is the first not-done column in the fixture, so it is the intake column.
    await page.getByText('To Do').first().dblclick()

    const callout = page.getByTestId('intake-column-callout')
    await expect(callout).toBeVisible()
    const more = callout.getByRole('button', { name: 'More' })
    const body = page.locator(`#${await more.getAttribute('aria-controls')}`)
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(body).toBeHidden()

    await more.click()
    await expect(body).toBeVisible()
    await expect(callout.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
  })

  test('Done column More body is hidden until the toggle is opened', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText('Done', { exact: true }).first().dblclick()

    const doneMore = page.getByTestId('done-column-more')
    await expect(doneMore).toBeVisible()
    const more = doneMore.getByRole('button', { name: 'More' })
    const body = page.locator(`#${await more.getAttribute('aria-controls')}`)
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(body).toBeHidden()

    await more.click()
    await expect(body).toBeVisible()
    await expect(doneMore.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
  })
})
