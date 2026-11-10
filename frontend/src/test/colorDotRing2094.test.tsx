/**
 * #2094: every dot filled from a user color carries the `color-dot` ring, and
 * every label chip carries `cf-choice-badge` plus the --cf-* variables.
 *
 * Cheap harnesses are rendered here; SummaryView, the Bulk move menu, GroupDetail
 * labels and the Trello review chips are rendered in their own test files.
 * BoardSettingsModal, CreateBoardModal and BoardView need a full board to mount,
 * so the source scan below covers them. The scan only covers its listed files, so
 * a new dot in an unlisted file is not caught.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ColumnHeader from '../components/Board/ColumnHeader'
import CheckboxDropdown from '../components/Common/CheckboxDropdown'
import CardItem from '../components/Card/CardItem'
import ShareBoardPage from '../pages/ShareBoardPage'
import { ChoiceDot } from '../components/Card/ChoiceValue'
import type { BoardPublic, Card, Column } from '../types'

vi.mock('../api/boards', () => ({ updateColumn: vi.fn(), getPublicBoard: vi.fn() }))
import { getPublicBoard } from '../api/boards'

const CF_VARS = ['--cf-bg-light', '--cf-fg-light', '--cf-border-light', '--cf-bg-dark', '--cf-fg-dark', '--cf-border-dark']

function expectChip(el: HTMLElement) {
  expect(el.className).toContain('cf-choice-badge')
  for (const v of CF_VARS) expect(el.style.getPropertyValue(v), v).toMatch(/^#[0-9A-F]{6}$/)
  expect(el.style.color).toBe('')
}

const column: Column = {
  id: 10, uid: 'coluid000001', name: 'Backlog', position: 0, color: '#FFFFFF',
  wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null,
}

describe('color-dot ring on rendered dots (#2094)', () => {
  it.each([false, true])('ColumnHeader dot (collapsed=%s)', (collapsed) => {
    const { container } = render(
      <ColumnHeader column={column} cards={[]} boardId={1} isAdmin onColumnUpdated={vi.fn()}
        onRequestDelete={vi.fn()} collapsed={collapsed} onToggleCollapse={vi.fn()} />,
    )
    const dot = container.querySelector('[data-column-drag-handle], .rounded-full.shrink-0') as HTMLElement
    expect(container.querySelectorAll('.color-dot').length).toBeGreaterThan(0)
    expect(container.querySelector('.color-dot')).toHaveStyle({ backgroundColor: '#FFFFFF' })
    expect(dot).not.toBeNull()
  })

  it('CheckboxDropdown option dot', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    render(<CheckboxDropdown label="Col" options={[{ value: 'a', label: 'Alpha', color: '#000000' }]} selected={[]} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button'))
    const dot = screen.getByText('Alpha').parentElement?.querySelector('.color-dot')
    expect(dot).toBeTruthy()
  })

  it('ChoiceDot (hash-colored, pre-#1391 look) gets no ring', () => {
    const { container } = render(<ChoiceDot choice="Alpha" />)
    expect(container.firstElementChild).not.toHaveClass('color-dot')
  })

  it('ShareBoardPage column dot and label chip', async () => {
    const board = {
      uid: 'shareuid01', name: 'B',
      columns: [{ ...column, id: 1, uid: 'c1', name: 'Todo' }],
      swimlanes: [{ id: 10, uid: 'lane1', name: 'Lane', position: 0, color: '#3B82F6', is_collapsed: false, created_at: '' }], labels: [{ id: 1, uid: 'l1', name: 'Bug', color: '#FFFFFF' }],
      cards: [{
        uid: 'card1', column: 1, swimlane: 10, title: 'T', priority: 'low', assignee: null,
        labels: [{ id: 1, uid: 'l1', name: 'Bug', color: '#FFFFFF' }], due_date: null, weight: 1, position: 0,
        last_moved_at: null, checklist_total: 0, checklist_done: 0, is_stale: false, blocker_count: 0,
      }],
    } as unknown as BoardPublic
    ;(getPublicBoard as ReturnType<typeof vi.fn>).mockResolvedValue(board)
    const { container } = render(
      <MemoryRouter initialEntries={['/share/tok']}>
        <Routes><Route path="/share/:token" element={<ShareBoardPage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Bug')).toBeInTheDocument())
    expect(container.querySelector('.color-dot')).not.toBeNull()
    expectChip(screen.getByText('Bug'))
  })

  it('CardItem label chip', () => {
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'T', description: '', priority: 'low',
      assignee: null, labels: [{ id: 1, uid: 'l1', name: 'Bug', color: '#000000' }], due_date: null, weight: 1,
      position: 0, created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
      archived_at: null, version: 1,
    } as Card
    render(<CardItem density="comfortable" card={card} />)
    expectChip(screen.getByText('Bug'))
  })
})

describe('source scan: dots and chips (#2094)', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')
  const DOT_FILES = [
    'components/Board/ColumnHeader.tsx', 'components/Board/BoardSettingsModal.tsx',
    'components/Board/BulkActionToolbar.tsx', 'components/Board/CreateBoardModal.tsx',
    'components/Board/BoardView.tsx', 'components/Board/SummaryView.tsx',
    'components/Board/FilterChip.tsx', 'components/Common/CheckboxDropdown.tsx',
    'pages/GroupDetail.tsx', 'pages/ShareBoardPage.tsx',
  ]

  it.each(DOT_FILES)('%s: every rounded-full dot filled from a user color has color-dot', (file) => {
    const src = read(file)
    // A dot is a <span> whose style fills it from a column/lane/label/row color
    // (`.dot` is the shared card-action choice's color field, #2103).
    const spans = src.match(/<span\b[^<]*?backgroundColor: *(?:[\w.]+\.(?:color|dot)|colorDot|opt\.color)[^<]*?>/gs) ?? []
    // Stripes (w-1) sit beside a name and are decorative: no ring.
    const dots = spans.filter((s) => s.includes('rounded-full') && !/\bw-1 /.test(s))
    expect(dots.length).toBeGreaterThan(0)
    for (const s of dots) {
      // BulkActionToolbar's priority dot uses the fixed PRIORITY_COLORS palette (opaque, tested colors).
      if (file.endsWith('BulkActionToolbar.tsx') && /\bp\.(?:color|dot)\b/.test(s)) continue
      expect(s, s).toContain('color-dot')
    }
  })

  it.each([
    'components/Board/trello/TrelloReviewStep.tsx', 'components/Card/CardItem.tsx',
    'components/Card/CardDetail.tsx', 'components/Board/Lens/LensIssueCard.tsx', 'pages/ShareBoardPage.tsx',
  ])('%s: label chips use colorChipStyle with cf-choice-badge, not raw color + alpha', (file) => {
    const src = read(file)
    expect(src).toContain('colorChipStyle(')
    expect(src).toContain('cf-choice-badge')
    expect(src).not.toMatch(/label\.color \+ "(22|44)"|\$\{[a-z.]*color\}(22|44)/)
  })
})
