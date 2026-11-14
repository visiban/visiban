import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrelloReviewStep from '../components/Board/trello/TrelloReviewStep'
import type { TrelloImportMapping, TrelloImportPreview } from '../types'

function makePreview(over: Partial<TrelloImportPreview> = {}): TrelloImportPreview {
  return {
    source: 'trello',
    file_sha256: 'sha',
    board: { name: 'Roadmap', description: '' },
    counts: { lists: 3, lists_archived: 1, cards: 5, cards_archived: 1, labels: 2, checklists: 1, checklist_items: 3, comments: 4, attachments: 1, members: 3 },
    result: { columns: 2, swimlanes: 1, labels: 2, cards: 4, cards_archived: 1, checklist_items: 3, comments: 4 },
    mapping: {
      columns: [
        { trello_id: 'a', name: 'To Do', position: 0, card_count: 3, archived: false },
        { trello_id: 'b', name: 'Done', position: 1, card_count: 1, archived: false },
        { trello_id: 'c', name: 'Icebox', position: null, card_count: 1, archived: true },
      ],
      labels: [
        { trello_id: 'l1', name: 'Acme', color: '#4BCE97', original_color: 'green', card_count: 2, swimlane_eligible: true },
        { trello_id: 'l2', name: '', color: '#F5CD47', original_color: 'yellow', card_count: 1, swimlane_eligible: false },
      ],
      swimlanes: [{ name: 'Unassigned', label_id: null }],
      default_swimlane: 'Unassigned',
    },
    members: { total: 3, matched: 1, unmatched: [{ trello_id: 'm2', full_name: 'Grace Hopper' }] },
    options: { swimlane_label_ids: [], default_swimlane_name: 'Unassigned', include_archived_lists: false, add_matched_members: false },
    warnings: [{ code: 'archived_lists_skipped', message: 'Archived lists and their cards will be skipped.', count: 1 }],
    unmappable: [{ kind: 'power_up_data', count: 2 }],
    ...over,
  }
}

const baseConfig: TrelloImportMapping = { swimlane_label_ids: [], default_swimlane_name: 'Unassigned', include_archived_lists: false, add_matched_members: false }

function Harness({ preview, initial = baseConfig, groupName, onConfig }: {
  preview: TrelloImportPreview
  initial?: TrelloImportMapping
  groupName?: string
  onConfig?: (c: TrelloImportMapping) => void
}) {
  const [config, setConfig] = useState(initial)
  const [name, setName] = useState('Roadmap')
  return (
    <TrelloReviewStep
      preview={preview}
      config={config}
      onConfigChange={(c) => { setConfig(c); onConfig?.(c) }}
      boardName={name}
      onBoardNameChange={setName}
      groupName={groupName}
    />
  )
}

describe('TrelloReviewStep', () => {
  it('names the destination: personal boards, or the group', () => {
    const { unmount } = render(<Harness preview={makePreview()} />)
    expect(screen.getByText('This board will be created in your personal boards.')).toBeInTheDocument()
    unmount()
    render(<Harness preview={makePreview()} groupName="Design" />)
    expect(screen.getByText('This board will be created in Design.')).toBeInTheDocument()
  })

  it('flags an empty board name as invalid', async () => {
    const user = userEvent.setup()
    render(<Harness preview={makePreview()} />)
    const input = screen.getByLabelText('Board name')
    await user.clear(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a board name.')).toBeInTheDocument()
  })

  it('lists warnings and unmappable data in a labelled group', () => {
    render(<Harness preview={makePreview()} />)
    const group = screen.getByRole('group', { name: "Some Trello data can't be imported" })
    expect(within(group).getByText('Archived lists and their cards will be skipped.')).toBeInTheDocument()
    expect(within(group).getByText(/won't be imported/)).toBeInTheDocument()
  })

  it('omits the warnings group when there is nothing to warn about', () => {
    render(<Harness preview={makePreview({ warnings: [], unmappable: [] })} />)
    expect(screen.queryByText("Some Trello data can't be imported")).toBeNull()
  })

  it('counts only included columns and cards, and shows archived lists as skipped', async () => {
    const user = userEvent.setup()
    render(<Harness preview={makePreview()} />)
    const lists = screen.getByRole('group', { name: 'Trello lists' })
    expect(within(lists).getByText('Icebox').closest('tr')).toHaveTextContent('Skipped')
    expect(within(lists).getByText('To Do').closest('tr')).toHaveTextContent('Imported')
    expect(screen.getByText('Columns', { selector: 'p' }).previousElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Cards', { selector: 'p' }).previousElementSibling).toHaveTextContent('4')
    await user.click(screen.getByRole('switch', { name: /Include archived lists/ }))
    expect(within(lists).getByText('Icebox').closest('tr')).toHaveTextContent('Imported')
    expect(screen.getByText('Columns', { selector: 'p' }).previousElementSibling).toHaveTextContent('3')
    expect(screen.getByText('Cards', { selector: 'p' }).previousElementSibling).toHaveTextContent('5')
  })

  it('hides the archived toggle when the export has no archived lists', () => {
    render(<Harness preview={makePreview({ counts: { ...makePreview().counts, lists_archived: 0 } })} />)
    expect(screen.queryByRole('switch', { name: /Include archived lists/ })).toBeNull()
  })

  it('says so when the export has no lists, labels or members', () => {
    const p = makePreview()
    render(<Harness preview={makePreview({
      mapping: { ...p.mapping, columns: [], labels: [] },
      members: { total: 0, matched: 0, unmatched: [] },
    })} />)
    expect(screen.getByText('This export has no lists.')).toBeInTheDocument()
    expect(screen.getByText(/No labels in this export/)).toBeInTheDocument()
    expect(screen.getByText('This export has no members.')).toBeInTheDocument()
  })

  it('turns labels into swimlanes in the order picked and reveals the default-name field', async () => {
    const user = userEvent.setup()
    const onConfig = vi.fn()
    render(<Harness preview={makePreview()} onConfig={onConfig} />)
    expect(screen.queryByLabelText('Default swimlane name')).toBeNull()
    expect(screen.getByText('0 of 2 labels selected')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Make swimlane: Acme' }))
    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({ swimlane_label_ids: ['l1'] }))
    expect(screen.getByText('1 of 2 labels selected')).toBeInTheDocument()
    expect(screen.getByLabelText('Default swimlane name')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Make swimlane: Acme' }))
    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({ swimlane_label_ids: [] }))
  })

  it('disables an unnamed label with the reason attached', () => {
    render(<Harness preview={makePreview()} />)
    const toggle = screen.getAllByRole('switch').find((el) => el.getAttribute('aria-label')?.trim() === 'Make swimlane:')!
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAccessibleDescription("Unnamed labels can't be swimlanes.")
  })

  it('flags a default swimlane name that collides with a chosen label', async () => {
    const user = userEvent.setup()
    render(<Harness preview={makePreview()} initial={{ ...baseConfig, swimlane_label_ids: ['l1'], default_swimlane_name: 'Unassigned' }} />)
    const field = screen.getByLabelText('Default swimlane name')
    expect(field).toHaveAttribute('aria-invalid', 'false')
    await user.clear(field)
    await user.type(field, 'acme')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/matches a label you turned into a swimlane/)).toBeInTheDocument()
  })

  it('summarizes member matching and offers unmatched names', () => {
    render(<Harness preview={makePreview()} />)
    const group = screen.getByRole('group', { name: 'Member matching' })
    expect(within(group).getByText(/1 of 3 Trello members match existing users/)).toBeInTheDocument()
  })

  it('notes how many archived cards will be imported as archived', () => {
    render(<Harness preview={makePreview()} />)
    expect(screen.getByText(/will be imported as archived/)).toBeInTheDocument()
  })
})
