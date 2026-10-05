import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { END_OF_LINE, routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_USER, CARD } from './fixtures/board'

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

/**
 * Returns the text covered by the editor's own selection state, which is not
 * necessarily the DOM selection.
 *
 * Why the two can differ: Shift+Arrow extends the DOM selection natively, and
 * ProseMirror only copies it into `editor.state.selection` when the browser's
 * asynchronous `selectionchange` event reaches its DOMObserver. `toggleBold()`
 * and Ctrl+U act on the state, not the DOM. #1195 therefore polled this helper
 * after the keypresses, but that was insufficient (#1474): under load a
 * Shift+ArrowLeft can be dropped, so the state never reaches the word and the
 * poll just times out. The specs now set the range deterministically with
 * `selectWordInEditor` (see it for the full explanation) and use this helper
 * only to confirm the state holds exactly that text. Keep that confirmation:
 * a mark applied to a stale or empty selection passes vacuously, and the
 * Ctrl+U guard would then assert nothing.
 *
 * Tiptap attaches the Editor instance to its root element (`dom.editor`),
 * which lets the test wait on the real editor state instead of on a
 * `waitForTimeout`.
 */
async function editorSelectedText(editor: Locator): Promise<string> {
  return editor.evaluate((el) => {
    type EditorLike = {
      state: {
        selection: { from: number; to: number }
        doc: { textBetween(from: number, to: number): string }
      }
    }
    const ed = (el as HTMLElement & { editor?: EditorLike }).editor
    if (!ed) return ''
    const { from, to } = ed.state.selection
    return ed.state.doc.textBetween(from, to)
  })
}

/**
 * Selects the last occurrence of `word` by writing the range straight into the
 * editor's own state, then returns once the state reports exactly that text.
 *
 * Why not Shift+ArrowLeft x N (what #1195 kept): the keystrokes are not
 * idempotent. Under CI load a keypress can be consumed while ProseMirror is
 * still flushing the typed text and re-asserting its own DOM selection, so the
 * selection stops one character short and stays there ("d" for "underlined",
 * "tandout" for "standout", or empty). Waiting longer cannot fix that, which is
 * why polling `editorSelectedText` alone (#1195) still flaked in CI (#1474):
 * the expected value was never going to arrive. These specs guard the markdown
 * serializer and the Underline extension, not native text selection, so the
 * range is set deterministically.
 */
async function selectWordInEditor(editor: Locator, word: string): Promise<void> {
  await editor.evaluate((el, w) => {
    type EditorLike = {
      state: { doc: { textBetween(from: number, to: number, sep?: string): string; content: { size: number } } }
      commands: { setTextSelection(range: { from: number; to: number }): boolean; focus(): boolean }
    }
    const ed = (el as HTMLElement & { editor?: EditorLike }).editor
    if (!ed) throw new Error('Tiptap editor instance not found on the contenteditable root')
    const size = ed.state.doc.content.size
    // Doc positions are offset by node boundaries, so scan backwards for the
    // last position whose text equals the word.
    for (let from = size; from >= 0; from--) {
      const to = from + w.length
      if (to <= size && ed.state.doc.textBetween(from, to) === w) {
        ed.commands.focus()
        ed.commands.setTextSelection({ from, to })
        return
      }
    }
    throw new Error(`could not map "${w}" to a document range`)
  }, word)
  await expect.poll(() => editorSelectedText(editor), { timeout: 5_000 }).toBe(word)
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
    await page.keyboard.press(END_OF_LINE)
    await page.keyboard.type(' Extra sentence.')

    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect.poll(() => sink.description, { timeout: 5_000 }).toContain('Extra sentence.')
  })

  test('the bold toolbar button serializes to ** markdown', async ({ page }) => {
    const sink: { description?: string } = {}
    await routeCardWithPatchCapture(page, sink)

    const { dialog, editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press(END_OF_LINE)
    // Type the word, then select just it so the mark applies to a known range.
    await page.keyboard.type(' standout')
    await selectWordInEditor(editor, 'standout')
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
    await page.keyboard.press(END_OF_LINE)
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
    await page.keyboard.press(END_OF_LINE)
    await page.keyboard.type(' underlined')
    // Without a real selection this guard can pass vacuously: Ctrl+U has no text
    // to mark, so no <u> is written even with Underline enabled.
    await selectWordInEditor(editor, 'underlined')
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
    await page.keyboard.press(END_OF_LINE)
    await page.keyboard.type(' discarded text')

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Back to view mode with the original content, and nothing PATCHed.
    await expect(dialog.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
    expect(sink.description).toBeUndefined()
  })

  // #1457: the @mention suggestion list is a `fixed` popup that is not a React
  // child, placed by `placeFixedElement` from its measured height. When the
  // caret sits low in the viewport a full list (six members) cannot fit below
  // it, so it must sit above the caret. A scroll re-anchors it to the live
  // caret instead of dismissing it (the named exception in frontend/CLAUDE.md),
  // which is how this test moves the caret down deterministically. A resize
  // must end the suggestion.
  test('the @mention list sits above a caret near the bottom edge and closes on resize', async ({ page }) => {
    const members = [BOARD_USER, ...Array.from({ length: 5 }, (_, i) => ({
      ...BOARD_USER, id: 100 + i, username: `tester${i}`, display_name: `Tester ${i}`,
    }))].map((user, i) => ({ id: i + 1, user, role: 'member' as const, is_moderator: false, joined_at: '2026-01-01T00:00:00Z' }))
    // Registered after beforeEach's routeBoard, so this route wins.
    // BOARD_FULL's fixture types `role` as the literal "admin"; these members are
    // deliberately plain members.
    await routeBoard(page, { ...BOARD_FULL, members: members as unknown as typeof BOARD_FULL.members })
    await routeCardWithPatchCapture(page, {})
    const { editor } = await openDescriptionEditor(page)

    await editor.click()
    await page.keyboard.press(END_OF_LINE)
    // Room above the text, so the panel can scroll the caret's line down.
    await page.addStyleTag({ content: '.ProseMirror { padding-top: 1000px !important; }' })
    await page.keyboard.type(' @test')

    const popup = page.getByTestId('mention-popup')
    await expect(popup.getByRole('button')).toHaveCount(6, { timeout: 5_000 })

    // Scroll the panel so the suggestion's anchor (its decoration) sits 60px
    // above the bottom of the panel's visible area.
    const scrollAnchorLow = () =>
      page.evaluate(() => {
        const deco = document.querySelector('[data-decoration-id]') as HTMLElement
        let scroller = deco.parentElement
        while (scroller && !(getComputedStyle(scroller).overflowY === 'auto' && scroller.scrollHeight > scroller.clientHeight)) {
          scroller = scroller.parentElement
        }
        const bottom = Math.min(window.innerHeight, scroller!.getBoundingClientRect().bottom)
        scroller!.scrollTop += deco.getBoundingClientRect().bottom - (bottom - 60)
      })
    const geometry = () =>
      page.evaluate(() => {
        const deco = document.querySelector('[data-decoration-id]')!.getBoundingClientRect()
        const pop = document.querySelector('[data-testid="mention-popup"]') as HTMLElement
        const rect = pop.getBoundingClientRect()
        return {
          fitsBelow: deco.bottom + 4 + rect.height <= window.innerHeight - 8,
          above: rect.bottom <= deco.top,
          onScreen: rect.top >= 0,
          visible: getComputedStyle(pop).visibility === 'visible',
        }
      })
    // A bare 'End' used to smooth-scroll the panel on macOS hosts (#1475), which
    // is why this once re-scrolled inside the poll; END_OF_LINE moves the caret.
    await scrollAnchorLow()
    await expect.poll(geometry, { timeout: 5_000 }).toEqual({ fitsBelow: false, above: true, onScreen: true, visible: true })

    // A resize ends the suggestion through Tiptap's exit path, which removes
    // the popup, and leaves the editor open.
    const { width, height } = page.viewportSize()!
    await page.setViewportSize({ width, height: height - 100 })
    await expect(page.getByTestId('mention-popup')).toHaveCount(0)
    // The suggestion decoration only clears on Tiptap's `{ exit: true }`, so this
    // fails if the popup were merely removed from the DOM.
    await expect(page.locator('[data-decoration-id]')).toHaveCount(0)
    await expect(editor).toBeVisible()
  })
})
