import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

/**
 * Runtime coverage for the Tiptap description editor.
 *
 * The unit tests in src/test/richTextEditor.test.tsx mock @tiptap/* wholesale —
 * ProseMirror needs a real browser DOM — so they exercise the surrounding React
 * markup but never the editor itself. These specs are the only place the actual
 * Tiptap runtime is driven: extension loading, typing, the toolbar marks, and
 * (most importantly) tiptap-markdown's serialization on save.
 *
 * That serialization is the thing worth guarding. `onSave` hands CardDetail the
 * output of `editor.storage.markdown.getMarkdown()`, so asserting on the PATCH
 * body is an end-to-end check that the editor still round-trips content to
 * markdown — the failure mode a major Tiptap upgrade is most likely to cause,
 * and one that no amount of type-checking would catch.
 */

/** Captures the description sent by the next PATCH to the card endpoint. */
async function routeCardWithPatchCapture(page: Page, sink: { description?: string }): Promise<void> {
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { description?: string }
      sink.description = body.description
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CARD, description: body.description ?? '' }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) })
  })
}

/** Opens the card detail dialog and puts the description into edit mode. */
async function openDescriptionEditor(page: Page) {
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.getByText(CARD.title).first().click()

  const dialog = page.locator('[role="dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // View mode renders the description through react-markdown; clicking it swaps
  // in the Tiptap editor.
  await dialog.getByText(CARD.description).click()

  const editor = dialog.locator('div[contenteditable="true"]')
  await expect(editor).toBeVisible({ timeout: 5_000 })
  return { dialog, editor }
}

test.describe('rich text editor', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    for (const sub of ['movements', 'comments', 'activity', 'checklist', 'attachments']) {
      await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${sub}/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )
    }
  })

  test('clicking the description loads its existing content into the editor', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { editor } = await openDescriptionEditor(page)

    // Proves the Tiptap extensions loaded and markdown parsed into the document —
    // an extension that failed to construct would leave the editor empty.
    await expect(editor).toContainText(CARD.description)
  })

  test('typed text round-trips to markdown in the save payload', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Extra sentence.')

    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect.poll(() => sink.description, { timeout: 5_000 }).toContain('Extra sentence.')
  })

  test('the bold toolbar button serializes to ** markdown', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press('End')
    // Type the word, then select just it so the mark applies to a known range.
    await page.keyboard.type(' standout')
    for (let i = 0; i < 'standout'.length; i++) {
      await page.keyboard.press('Shift+ArrowLeft')
    }
    await dialog.getByTitle('Bold (Ctrl+B)').click()

    await dialog.getByRole('button', { name: 'Save' }).click()

    // tiptap-markdown emits **bold** — the assertion that actually exercises the
    // serializer rather than just the editor's internal state.
    await expect.poll(() => sink.description, { timeout: 5_000 }).toContain('**standout**')
  })

  test('a typed URL stays plain text rather than autolinking', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' https://example.com ')

    await dialog.getByRole('button', { name: 'Save' }).click()

    // Tiptap 3's StarterKit enables Link with autolink: true, which Tiptap 2's did
    // not. RichTextEditor disables it so this upgrade does not change stored
    // content. With autolink on, tiptap-markdown serializes the URL using markdown
    // autolink syntax — `<https://example.com>` — rather than leaving it bare, so
    // that exact form is what this asserts against. (Verified by re-enabling link
    // locally and watching this fail; a looser check for `](` or `<a ` passes
    // either way and guards nothing.)
    await expect.poll(() => sink.description, { timeout: 5_000 }).toContain('https://example.com')
    // Note the trailing character the editor leaves is a non-breaking space, so
    // only the leading boundary is asserted here.
    expect(sink.description).toContain(' https://example.com')
    expect(sink.description).not.toContain('<https://example.com>')
  })

  test('Ctrl+U does not write underline HTML into the description', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' underlined')
    for (let i = 0; i < 'underlined'.length; i++) {
      await page.keyboard.press('Shift+ArrowLeft')
    }
    // ControlOrMeta, not Control: Tiptap binds Mod-u, which is Cmd on macOS and
    // Ctrl on CI's Linux. A bare 'Control+u' is a no-op on macOS and would make
    // this test pass whether or not Underline is enabled.
    await page.keyboard.press('ControlOrMeta+u')

    await dialog.getByRole('button', { name: 'Save' }).click()

    // Tiptap 3's StarterKit bundles Underline; Tiptap 2's did not, and
    // RichTextEditor disables it. This guard matters more than the Link one: there
    // is no markdown for underline, so tiptap-markdown emits raw <u> HTML — and <u>
    // is absent from rehype-sanitize's defaultSchema.tagNames (53 tags, checked),
    // so view mode strips it. With Underline enabled the user's formatting is
    // written to the card and then silently discarded on display.
    await expect.poll(() => sink.description, { timeout: 5_000 }).toContain('underlined')
    expect(sink.description).not.toContain('<u>')
  })

  test('Cancel leaves the description unsaved', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' discarded text')

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Back to view mode with the original content, and nothing PATCHed.
    await expect(dialog.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
    expect(sink.description).toBeUndefined()
  })
})
