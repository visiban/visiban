/**
 * Swimlane default team (#2211): the create surfaces' Assignees chip and caption, Edit Swimlane's
 * deactivated and no-access rows, at desktop and 390px, light and dark, with the contrast of every
 * new color pair MEASURED in the browser (4.5:1 text, 3:1 non-text; #2206 shared rule 8).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_TEAM, CARD, CHILD_BOARD_OPTIONS_TEAM, TEAM_ACCESS } from './fixtures/board'

const BOARD = BOARD_TEAM as unknown as Parameters<typeof routeBoard>[1]

/**
 * Contrast of `el`'s text (or its border) against the background it is painted on, compositing
 * every ancestor's background color and the element's (and ancestors') opacity.
 */
async function contrast(el: Locator, what: 'text' | 'border' | 'fill' = 'text'): Promise<number> {
  return el.evaluate((node, kind) => {
    const parse = (c: string): number[] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] ?? 1]
    }
    const blend = (top: number[], bot: number[]) => {
      const a = top[3]
      return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1)
    }
    const bgBehind = (e: Element | null) => {
      const chain: Element[] = []
      for (let x = e; x; x = x.parentElement) chain.unshift(x)
      let c = [255, 255, 255, 1]
      for (const x of chain) {
        const b = parse(getComputedStyle(x).backgroundColor)
        if (b[3] > 0) c = blend(b, c)
      }
      return c
    }
    let opacity = 1
    for (let x: Element | null = node; x; x = x.parentElement) opacity *= Number(getComputedStyle(x).opacity)
    const style = getComputedStyle(node)
    // 'fill': the element's own background (an avatar disc) against what is behind it, at its
    // opacity. 'text' on a translucent element composites its own fill at that opacity too.
    const own = parse(style.backgroundColor)
    const behind = bgBehind(node.parentElement)
    const raw = parse(kind === 'border' ? style.borderTopColor : kind === 'fill' ? style.backgroundColor : style.color)
    const bg = kind === 'text' ? (own[3] > 0 ? blend([own[0], own[1], own[2], own[3] * opacity], behind) : bgBehind(node)) : behind
    const fg = blend([raw[0], raw[1], raw[2], raw[3] * opacity], bg)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  }, what)
}

async function open(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => { window.localStorage.setItem('user:prefs:theme', t) }, theme)
  await routeAuth(page)
  await routeBoard(page, BOARD)
  await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/swimlanes/1/default-team-access/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEAM_ACCESS) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/child-board-options/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CHILD_BOARD_OPTIONS_TEAM) }),
  )
  const empty = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/`, empty(CARD))
  for (const p of ['movements', 'comments', 'activity', 'checklist', 'attachments', 'relations', 'blocks']) {
    await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/${p}/`, empty([]))
  }
  await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/timeline/**`, empty({ count: 0, next: null, previous: null, results: [] }))
  // Add child lives on the parent's Children tab (#2209); a parent with no children yet.
  await page.route(new RegExp(`/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/children/(\\?.*)?$`), empty({ count: 0, visible: true, offset: 0, limit: 50, results: [] }))
  await page.goto(`/boards/${BOARD_TEAM.id}`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

const TEXT = 4.5
const NON_TEXT = 3

/** Open the card's Children tab and its Add child dialog (Add child moved there in #2209). */
async function openAddChild(page: Page) {
  await page.getByRole('tab', { name: 'Children' }).click()
  await page.getByTestId('card-children-tab').getByRole('button', { name: /^Add child/ }).click()
}

async function checkAssignees(group: Locator) {
  await expect(group).toContainText('Mia Reyes')
  await expect(group).toContainText('Also on the team, not assigned: Dan Kovacs.')
  // Kim is deactivated: never pre-assigned, never named.
  await expect(group).not.toContainText('Kim Lee')
  expect(await contrast(group.getByText('Mia Reyes', { exact: true }))).toBeGreaterThanOrEqual(TEXT)
  expect(await contrast(group.locator('p').filter({ hasText: 'default team' }))).toBeGreaterThanOrEqual(TEXT)
  expect(await contrast(group.getByText('Assignees', { exact: true }))).toBeGreaterThanOrEqual(TEXT)
  // Unassign, then the "+ Add" pill takes focus and its label is readable.
  await group.getByRole('button', { name: 'Unassign Mia Reyes' }).click()
  const add = group.getByRole('button', { name: 'Add Mia Reyes' })
  await expect(add).toBeFocused()
  expect(await contrast(add)).toBeGreaterThanOrEqual(TEXT)
  expect(await contrast(group.getByText('No one assigned.'))).toBeGreaterThanOrEqual(TEXT)
  await expect(group).toContainText('default team')
  await add.click()
  await expect(group.getByRole('button', { name: 'Unassign Mia Reyes' })).toBeFocused()
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`swimlane default team, desktop, ${theme} (#2211)`, () => {
    test.use({ viewport: { width: 1280, height: 900 } })

    test('Add card pre-assigns the first member with the caption', async ({ page }) => {
      await open(page, theme)
      await page.getByRole('button', { name: 'Add card to To Do in Acme Corp' }).click()
      const group = page.getByRole('group', { name: 'Assignees' })
      await expect(group).toContainText("From the Acme Corp default team. Remove anyone this card shouldn't have.")
      await expect(group).toContainText('Pre-assigned from lane team')
      await expect(page.getByTestId('cell-add-tag')).toHaveText(/^Acme Corp · To Do$/)
      await expect(page.getByRole('button', { name: 'Add card', exact: true })).toBeVisible()
      await checkAssignees(group)
    })

    test('Edit Swimlane marks the deactivated and the no-access member', async ({ page }) => {
      await open(page, theme)
      await page.getByRole('button', { name: 'Actions for swimlane "Acme Corp"' }).click()
      await page.getByRole('menuitem', { name: /Edit swimlane/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Edit Swimlane' })
      const team = dialog.getByRole('group', { name: 'Default team members' })
      const dan = team.getByRole('listitem').filter({ hasText: 'Dan Kovacs' })
      const kim = team.getByRole('listitem').filter({ hasText: 'Kim Lee' })
      await expect(dan).toContainText('No access to Delivery: skipped on new children')
      await expect(kim).toContainText('Deactivated: remove to save the team')
      for (const row of [dan, kim]) {
        expect(await contrast(row, 'border')).toBeGreaterThanOrEqual(NON_TEXT)
        expect(await contrast(row.locator('.text-warning'))).toBeGreaterThanOrEqual(TEXT)
        expect(await contrast(row.locator('.truncate'))).toBeGreaterThanOrEqual(TEXT)
        // The canvas dims a warning row's avatar to 60%; measured, that is 1.6-4.0:1 for the
        // initials and 1.8-2.5:1 for the disc, so the avatar stays at full opacity.
        const avatar = row.locator(':scope > :first-child')
        expect(await avatar.evaluate((n) => getComputedStyle(n).opacity)).toBe('1')
      }
      await expect(dan.getByRole('button', { name: 'Remove Dan Kovacs from default team' }))
        .toHaveAccessibleDescription('No access to Delivery: skipped on new children')
      // One click removes the deactivated person; focus stays in the dialog.
      await kim.getByRole('button', { name: 'Remove Kim Lee from default team' }).click()
      await expect(team.getByRole('listitem')).toHaveCount(2)
      await expect(team.getByRole('button', { name: 'Remove Dan Kovacs from default team' })).toBeFocused()
      expect(await contrast(dialog.getByText(/^Pre-assigned to new cards/))).toBeGreaterThanOrEqual(TEXT)
    })

    test('Add child shows the parent lane team and the Parent line', async ({ page }) => {
      await open(page, theme)
      await page.getByText(CARD.title).first().click()
      await openAddChild(page)
      const dialog = page.getByRole('dialog', { name: 'Add child' })
      await expect(dialog).toContainText(`Parent: ${CARD.title} · To Do`)
      const group = dialog.getByRole('group', { name: 'Assignees' })
      await expect(group).toContainText("From the Acme Corp default team on Pipeline, the lane the parent is in. Delivery's own lanes are not consulted.")
      await checkAssignees(group)
    })
  })

  test.describe(`swimlane default team, 390px, ${theme} (#2211)`, () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('phone composer and Edit Swimlane sheet', async ({ page }) => {
      await open(page, theme)
      await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /^\+?\s*Add card/ }).first().click()
      const group = page.getByRole('group', { name: 'Assignees' })
      await expect(page.getByTestId('phone-add-card-heading')).toHaveText(/^New card in Acme Corp · /)
      await expect(page.getByPlaceholder('Card title', { exact: true })).toBeVisible()
      await expect(group).toContainText('Pre-assigned from lane team')
      await checkAssignees(group)
      const unassign = group.getByRole('button', { name: 'Unassign Mia Reyes' })
      expect((await unassign.boundingBox())!.height).toBeGreaterThanOrEqual(44)

      await page.getByTestId('phone-add-card').getByRole('button', { name: 'Cancel' }).click()
      await page.getByRole('button', { name: /^Lane actions for / }).first().click()
      await page.getByRole('button', { name: /^Edit swimlane/ }).click()
      const sheet = page.getByRole('dialog', { name: 'Edit Swimlane' })
      const back = sheet.getByRole('button', { name: 'Back to board' })
      await expect(back).toBeVisible()
      for (const name of ['Back to board', 'Close', 'Cancel', 'Save', 'Delete swimlane']) {
        const box = await sheet.getByRole('button', { name, exact: true }).boundingBox()
        expect(box!.height, name).toBeGreaterThanOrEqual(44)
      }
      const dan = sheet.getByRole('group', { name: 'Default team members' }).getByRole('listitem').filter({ hasText: 'Dan Kovacs' })
      await expect(dan).toContainText('No access to Delivery: skipped on new children')
      expect(await contrast(dan.locator('.text-warning'))).toBeGreaterThanOrEqual(TEXT)
      expect(await contrast(dan, 'border')).toBeGreaterThanOrEqual(NON_TEXT)
      await back.click()
      await expect(sheet).toBeHidden()
    })

    test('Add child sheet keeps its footer reachable', async ({ page }) => {
      await open(page, theme)
      await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
      await page.locator(`[data-card-id="${CARD.id}"]`).first().click()
      await openAddChild(page)
      const sheet = page.getByRole('dialog', { name: 'Add child' })
      await checkAssignees(sheet.getByRole('group', { name: 'Assignees' }))
      const add = sheet.getByRole('button', { name: 'Add to Delivery' })
      await expect(add).toBeInViewport()
      // The footer is pinned to the sheet's bottom edge, not left mid-sheet.
      const box = (await add.boundingBox())!
      expect(844 - (box.y + box.height)).toBeLessThan(48)
      // Keyboard open: a short viewport. The sheet never outgrows it, and its body scrolls to Add.
      await page.setViewportSize({ width: 390, height: 420 })
      await sheet.getByLabel('Title').focus()
      const panel = (await sheet.boundingBox())!
      expect(panel.height).toBeLessThanOrEqual(420)
      await add.scrollIntoViewIfNeeded()
      await expect(add).toBeInViewport()
    })
  })
}
