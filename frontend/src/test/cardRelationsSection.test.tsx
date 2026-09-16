import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardRelationsSection from '../components/Card/CardRelationsSection'
import type { BoardFull, Card, CardRelation } from '../types'

vi.mock('../api/cards', () => ({
  getCardRelations: vi.fn(),
  addCardRelation: vi.fn(),
  deleteCardRelation: vi.fn(),
  searchCards: vi.fn(),
}))

import {
  getCardRelations,
  addCardRelation,
  deleteCardRelation,
  searchCards,
} from '../api/cards'

const mockGet = vi.mocked(getCardRelations)
const mockAdd = vi.mocked(addCardRelation)
const mockDelete = vi.mocked(deleteCardRelation)
const mockSearch = vi.mocked(searchCards)

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'The card',
    description: '', priority: 'medium', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [],
    blocker_count: 0,
    ...overrides,
  }
}

function makeRelation(overrides: Partial<CardRelation> = {}): CardRelation {
  return {
    id: 500,
    relation_type: 'blocks',
    direction: 'blocked_by',
    card: { id: 2, uid: 'carduid00002', title: 'Blocker card', column: 10, archived: false },
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const board = {
  id: 7,
  columns: [
    { id: 10, uid: 'coluid001', name: 'To Do', position: 0 },
    { id: 11, uid: 'coluid002', name: 'Done', position: 1 },
  ],
} as unknown as BoardFull

function renderSection(props: Partial<React.ComponentProps<typeof CardRelationsSection>> = {}) {
  const onBlockerCountChange = vi.fn()
  const utils = render(
    <CardRelationsSection
      board={board}
      card={makeCard()}
      canEdit
      onBlockerCountChange={onBlockerCountChange}
      {...props}
    />,
  )
  return { ...utils, onBlockerCountChange }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue([])
  mockSearch.mockResolvedValue([])
})

describe('CardRelationsSection — loading and populated', () => {
  it('shows a loading line, then the rows', async () => {
    let resolve!: (v: CardRelation[]) => void
    mockGet.mockReturnValue(new Promise((r) => { resolve = r }))
    renderSection({ card: makeCard({ blocker_count: 1 }) })

    expect(screen.getByText('Loading relations…')).toBeInTheDocument()
    resolve([makeRelation()])
    expect(await screen.findByText('Blocker card')).toBeInTheDocument()
    expect(screen.queryByText('Loading relations…')).not.toBeInTheDocument()
  })

  it('shows the count in the header and the linked card column', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    renderSection()
    expect(await screen.findByText('(1)')).toBeInTheDocument()
    expect(screen.getByText('To Do')).toBeInTheDocument()
  })

  it('groups the three directions in severity order', async () => {
    mockGet.mockResolvedValue([
      makeRelation({ id: 1, direction: 'relates_to', relation_type: 'relates_to', card: { id: 4, uid: 'u4', title: 'Related', column: 10, archived: false } }),
      makeRelation({ id: 2, direction: 'blocks', card: { id: 5, uid: 'u5', title: 'Downstream', column: 10, archived: false } }),
      makeRelation({ id: 3, direction: 'blocked_by', card: { id: 6, uid: 'u6', title: 'Upstream', column: 10, archived: false } }),
    ])
    const { container } = renderSection()
    await screen.findByText('Upstream')
    const headings = Array.from(container.querySelectorAll('p.text-fg-tertiary')).map((e) => e.textContent)
    expect(headings).toEqual(['Blocked by', 'Blocks', 'Relates to'])
  })

  it('omits a group with no rows', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    renderSection()
    await screen.findByText('Blocker card')
    expect(screen.getByText('Blocked by')).toBeInTheDocument()
    expect(screen.queryByText('Relates to')).not.toBeInTheDocument()
  })

  it('starts expanded for a blocked card before the fetch resolves', () => {
    mockGet.mockReturnValue(new Promise(() => {}))
    renderSection({ card: makeCard({ blocker_count: 2 }) })
    expect(screen.getByRole('button', { name: /Relations/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('CardRelationsSection — empty and permissions', () => {
  it('keeps the add button reachable on an empty, collapsed section', async () => {
    // An empty section collapses itself; the add control must not collapse
    // with it, or creating the first relation would need an extra click on a
    // section that looks like it has nothing in it.
    renderSection()
    expect(await screen.findByRole('button', { name: '+ Add relation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Relations/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the empty line once expanded', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /Relations/ }))
    expect(screen.getByText('No relations yet.')).toBeInTheDocument()
  })

  it('expands itself when the first relation is added', async () => {
    mockSearch.mockResolvedValue([makeCard({ id: 42, title: 'Provision cluster', column: 11 })])
    mockAdd.mockResolvedValue(makeRelation({ id: 900, card: { id: 42, uid: 'u42', title: 'Provision cluster', column: 11, archived: false } }))
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await userEvent.click(await screen.findByRole('option', { name: /Provision cluster/ }))
    // Without the explicit expand, the new row would land in a collapsed list.
    expect(await screen.findByText('Provision cluster')).toBeInTheDocument()
  })

  it('renders nothing at all for a reader with no relations', async () => {
    const { container } = renderSection({ canEdit: false })
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders rows but no controls for a reader with relations', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    renderSection({ canEdit: false })
    expect(await screen.findByText('Blocker card')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove relation/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add relation' })).not.toBeInTheDocument()
  })
})

describe('CardRelationsSection — archived rows', () => {
  const archived = makeRelation({
    card: { id: 3, uid: 'carduid00003', title: 'Old spike', column: 11, archived: true },
  })

  it('marks it archived and does not make the title a link', async () => {
    mockGet.mockResolvedValue([archived])
    renderSection()
    expect(await screen.findByText('Archived')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Old spike' })).not.toBeInTheDocument()
  })

  it('still offers removal — that is the point of listing it', async () => {
    mockGet.mockResolvedValue([archived])
    renderSection()
    expect(await screen.findByRole('button', { name: 'Remove relation to Old spike' })).toBeInTheDocument()
  })

  it('removing an archived blocker does not decrement the count', async () => {
    mockGet.mockResolvedValue([archived])
    mockDelete.mockResolvedValue(undefined as never)
    const { onBlockerCountChange } = renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove relation to Old spike' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalled())
    expect(onBlockerCountChange).not.toHaveBeenCalled()
  })
})

describe('CardRelationsSection — removing', () => {
  it('removes the row and decrements for an active blocker', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    mockDelete.mockResolvedValue(undefined as never)
    const { onBlockerCountChange } = renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove relation to Blocker card' }))
    await waitFor(() => expect(screen.queryByText('Blocker card')).not.toBeInTheDocument())
    expect(onBlockerCountChange).toHaveBeenCalledWith(-1)
  })

  it('does not decrement for an outgoing blocks relation', async () => {
    mockGet.mockResolvedValue([makeRelation({ direction: 'blocks' })])
    mockDelete.mockResolvedValue(undefined as never)
    const { onBlockerCountChange } = renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove relation to Blocker card' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalled())
    expect(onBlockerCountChange).not.toHaveBeenCalled()
  })

  it('surfaces a remove failure inline', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    mockDelete.mockRejectedValue(new Error('boom'))
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove relation to Blocker card' }))
    expect(await screen.findByText('Could not remove the relation. Try again.')).toBeInTheDocument()
  })
})

describe('CardRelationsSection — load failure', () => {
  it('shows an error with a working retry, and hides the add control', async () => {
    mockGet.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce([makeRelation()])
    renderSection({ card: makeCard({ blocker_count: 1 }) })

    expect(await screen.findByText(/Failed to load relations\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add relation' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Blocker card')).toBeInTheDocument()
  })
})

describe('CardRelationsSection — add flow', () => {
  const candidate = makeCard({ id: 42, title: 'Provision cluster', column: 11 })

  async function openPicker() {
    const utils = renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    return utils
  }

  it('defaults to Blocked by and asks for at least two characters', async () => {
    await openPicker()
    const blockedBy = screen.getByRole('radio', { name: 'Blocked by' })
    expect(blockedBy).toBeChecked()
    await userEvent.type(screen.getByRole('combobox'), 'p')
    expect(await screen.findByText('Type at least 2 characters.')).toBeInTheDocument()
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('commits the highlighted option on Enter and reports the new blocker', async () => {
    mockSearch.mockResolvedValue([candidate])
    mockAdd.mockResolvedValue(makeRelation({ id: 900, card: { id: 42, uid: 'u42', title: 'Provision cluster', column: 11, archived: false } }))
    const { onBlockerCountChange } = await openPicker()

    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await screen.findByRole('option', { name: /Provision cluster/ })
    await userEvent.keyboard('{ArrowDown}{Enter}')

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith(7, 1, 42, 'blocked_by'))
    expect(onBlockerCountChange).toHaveBeenCalledWith(1)
    expect(await screen.findByText('Provision cluster')).toBeInTheDocument()
  })

  it('sends the chosen direction', async () => {
    mockSearch.mockResolvedValue([candidate])
    mockAdd.mockResolvedValue(makeRelation({ id: 901, direction: 'relates_to', relation_type: 'relates_to', card: { id: 42, uid: 'u42', title: 'Provision cluster', column: 11, archived: false } }))
    await openPicker()

    await userEvent.click(screen.getByRole('radio', { name: 'Relates to' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await userEvent.click(await screen.findByRole('option', { name: /Provision cluster/ }))

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith(7, 1, 42, 'relates_to'))
  })

  it('never offers the card itself', async () => {
    mockSearch.mockResolvedValue([makeCard({ id: 1, title: 'The card' }), candidate])
    await openPicker()
    await userEvent.type(screen.getByRole('combobox'), 'card')
    const list = await screen.findByRole('listbox')
    expect(within(list).queryByRole('option', { name: /The card/ })).not.toBeInTheDocument()
  })

  it('excludes a card already linked by blocks, in either direction', async () => {
    // The card blocks #42; picking it again as "blocked by" would be a 2-cycle.
    mockGet.mockResolvedValue([
      makeRelation({ direction: 'blocks', card: { id: 42, uid: 'u42', title: 'Provision cluster', column: 11, archived: false } }),
    ])
    mockSearch.mockResolvedValue([candidate])
    await openPicker()
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    expect(await screen.findByText('All matching cards are already linked.')).toBeInTheDocument()
  })

  it('still offers a blocks-linked card under relates_to', async () => {
    mockGet.mockResolvedValue([
      makeRelation({ direction: 'blocks', card: { id: 42, uid: 'u42', title: 'Provision cluster', column: 11, archived: false } }),
    ])
    mockSearch.mockResolvedValue([candidate])
    await openPicker()
    await userEvent.click(screen.getByRole('radio', { name: 'Relates to' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    expect(await screen.findByRole('option', { name: /Provision cluster/ })).toBeInTheDocument()
  })

  it('reports no matches distinctly from all-excluded', async () => {
    mockSearch.mockResolvedValue([])
    await openPicker()
    await userEvent.type(screen.getByRole('combobox'), 'zzz')
    expect(await screen.findByText('No matching cards on this board.')).toBeInTheDocument()
  })

  it('surfaces a search failure', async () => {
    mockSearch.mockRejectedValue(new Error('offline'))
    await openPicker()
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    expect(await screen.findByText('Search failed. Try again.')).toBeInTheDocument()
  })
})

describe('CardRelationsSection — backend error codes map to copy', () => {
  const cases: [string, string][] = [
    ['self_relation', 'A card cannot be related to itself.'],
    ['cross_board', 'That card is on another board. Relations can only link cards on this board.'],
    ['archived_card', 'That card is archived and cannot be linked.'],
    ['relation_exists', 'That relation already exists.'],
    ['relation_cycle', 'Those two cards would block each other. Remove the existing relation first.'],
  ]

  it.each(cases)('maps %s', async (code, copy) => {
    mockSearch.mockResolvedValue([makeCard({ id: 42, title: 'Provision cluster', column: 11 })])
    // DRF returns `code` as a single-item list.
    mockAdd.mockRejectedValue({ response: { data: { code: [code], detail: ['ignored'] } } })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await userEvent.click(await screen.findByRole('option', { name: /Provision cluster/ }))
    expect(await screen.findByText(copy)).toBeInTheDocument()
  })

  it('falls back to a generic line for an unknown code', async () => {
    mockSearch.mockResolvedValue([makeCard({ id: 42, title: 'Provision cluster', column: 11 })])
    mockAdd.mockRejectedValue({ response: { data: { code: ['something_new'] } } })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await userEvent.click(await screen.findByRole('option', { name: /Provision cluster/ }))
    expect(await screen.findByText('Could not add the relation. Try again.')).toBeInTheDocument()
  })

  it('falls back for a network error with no response body', async () => {
    mockSearch.mockResolvedValue([makeCard({ id: 42, title: 'Provision cluster', column: 11 })])
    mockAdd.mockRejectedValue(new Error('Network Error'))
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    await userEvent.type(screen.getByRole('combobox'), 'prov')
    await userEvent.click(await screen.findByRole('option', { name: /Provision cluster/ }))
    expect(await screen.findByText('Could not add the relation. Try again.')).toBeInTheDocument()
  })
})

describe('CardRelationsSection — navigation and escape', () => {
  it('dispatches visiban:open-card when a relation title is clicked', async () => {
    mockGet.mockResolvedValue([makeRelation()])
    const listener = vi.fn()
    window.addEventListener('visiban:open-card', listener)
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Blocker card' }))
    expect(listener).toHaveBeenCalled()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ cardId: 2 })
    window.removeEventListener('visiban:open-card', listener)
  })

  it('Escape closes the picker without consuming it at a lower priority', async () => {
    // A panel-close handler at priority 30 must NOT fire while the picker is
    // open — that is why the picker registers at 37 rather than through
    // useDropdownEscape (25).
    const panelClose = vi.fn()
    const { useEscapeStack } = await import('../hooks/useEscapeStack')
    function Harness() {
      useEscapeStack(panelClose, 30)
      return (
        <CardRelationsSection
          board={board}
          card={makeCard()}
          canEdit
          onBlockerCountChange={vi.fn()}
        />
      )
    }
    render(<Harness />)
    await userEvent.click(await screen.findByRole('button', { name: '+ Add relation' }))
    expect(screen.getByRole('combobox')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
    expect(panelClose).not.toHaveBeenCalled()
  })
})
