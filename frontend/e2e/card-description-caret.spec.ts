import { test, expect } from '@playwright/test'
import { END_OF_LINE, routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

/**
 * #1475: typing at the end of a card description must leave the caret visible
 * in the card panel.
 *
 * The reported jump (panel scrollTop 0 → its bottom, caret off-screen) came
 * from the spec, not the app: on a macOS host a bare `'End'` keypress is
 * macOS's `scrollToEndOfDocument:`, which smooth-scrolls the panel to its
 * bottom without moving the caret (see END_OF_LINE in ./helpers). This spec
 * starts the caret at the beginning of the line so the end-of-line key has
 * to actually move it — a key that only scrolls fails the caret assertion
 * on every platform, not only the one it happens to scroll on.
 */
test.describe('card description caret', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    for (const sub of ['movements', 'comments', 'activity', 'checklist', 'attachments']) {
      await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${sub}/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )
    }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) }),
    )
  })

  test('typing at the end of the description keeps the caret visible in the card panel', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText(CARD.title).first().click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByText(CARD.description).click()
    const editor = dialog.locator('div[contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })

    // The nearest overflowing scroll container is the card panel. The fixture
    // must overflow it, or there is no scroll to go wrong.
    const panelFound = await editor.evaluate((el) => {
      let s = el.parentElement
      while (s && !(getComputedStyle(s).overflowY === 'auto' && s.scrollHeight > s.clientHeight)) s = s.parentElement
      if (s) s.dataset.testid = 'card-panel-scroller'
      return !!s
    })
    expect(panelFound).toBe(true)
    const scroller = page.getByTestId('card-panel-scroller')

    // Caret to the start of the line, through Tiptap's own command (Tiptap
    // attaches the Editor to its root element), so the key below must move it.
    await editor.click()
    await editor.evaluate((el) => {
      (el as unknown as { editor: { commands: { setTextSelection: (pos: number) => void } } })
        .editor.commands.setTextSelection(1)
    })
    await page.keyboard.press(END_OF_LINE)
    await page.keyboard.type('xy')

    // Wait for any scroll animation to settle before measuring the caret.
    let last = -1
    await expect.poll(async () => {
      const top = await scroller.evaluate((el) => el.scrollTop)
      const settled = top === last
      last = top
      return settled
    }, { timeout: 5_000, intervals: [100] }).toBe(true)

    const geometry = await scroller.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const caret = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      return { caretTop: caret.top, caretBottom: caret.bottom, top: box.top, bottom: box.bottom }
    })
    expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.top)
    expect(geometry.caretBottom).toBeLessThanOrEqual(geometry.bottom)
    // And the text went in at the end of the line, so the key moved the caret.
    await expect(editor).toContainText(`${CARD.description}xy`)
  })
})
