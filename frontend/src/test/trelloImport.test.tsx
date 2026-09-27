import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrelloImportPreview } from '../types'

vi.mock('../api/boards', () => ({
  previewTrelloImport: vi.fn(),
  confirmTrelloImport: vi.fn(),
}))

import { previewTrelloImport, confirmTrelloImport } from '../api/boards'
import TrelloImportModal from '../components/Board/TrelloImportModal'
import { describeTrelloError, formatMinutes, unmappableLine } from '../components/Board/trello/trelloImportCopy'

const mockPreview = previewTrelloImport as unknown as ReturnType<typeof vi.fn>
const mockConfirm = confirmTrelloImport as unknown as ReturnType<typeof vi.fn>

function makePreview(overrides: Partial<TrelloImportPreview> = {}): TrelloImportPreview {
  return {
    source: 'trello',
    file_sha256: 'sha-1',
    board: { name: 'Product Roadmap', description: '' },
    counts: {
      lists: 3, lists_archived: 1, cards: 5, cards_archived: 1, labels: 2, checklists: 1,
      checklist_items: 3, comments: 4, attachments: 1, members: 3,
    },
    result: { columns: 2, swimlanes: 1, labels: 2, cards: 4, cards_archived: 1, checklist_items: 3, comments: 4 },
    mapping: {
      columns: [
        { trello_id: 'a', name: 'To Do', position: 0, card_count: 3, archived: false },
        { trello_id: 'b', name: 'Done', position: 1, card_count: 1, archived: false },
        { trello_id: 'c', name: 'Icebox', position: null, card_count: 1, archived: true },
      ],
      labels: [
        { trello_id: 'l1', name: 'Acme', color: '#4BCE97', original_color: 'green', card_count: 2, swimlane_eligible: true },
        { trello_id: 'l2', name: 'Yellow', color: '#F5CD47', original_color: 'yellow', card_count: 1, swimlane_eligible: false },
      ],
      swimlanes: [{ name: 'Unassigned', label_id: null }],
      default_swimlane: 'Unassigned',
    },
    members: {
      total: 3,
      matched: 1,
      unmatched: [
        { trello_id: 'm2', full_name: 'Grace Hopper' },
        { trello_id: 'm3', full_name: 'Stranger Danger' },
      ],
    },
    options: { swimlane_label_ids: [], default_swimlane_name: 'Unassigned', include_archived_lists: false, add_matched_members: false },
    warnings: [
      { code: 'archived_lists_skipped', message: 'Archived lists and their cards will be skipped.', count: 1 },
    ],
    unmappable: [{ kind: 'power_up_data', count: 2 }],
    ...overrides,
  }
}

const jsonFile = () => new File(['{"lists":[],"cards":[]}'], 'board.json', { type: 'application/json' })

function renderModal(props: Partial<React.ComponentProps<typeof TrelloImportModal>> = {}) {
  const onCancel = vi.fn()
  const onImported = vi.fn()
  render(<TrelloImportModal onCancel={onCancel} onImported={onImported} {...props} />)
  return { onCancel, onImported }
}

async function pickFile(user: ReturnType<typeof userEvent.setup>, file: File = jsonFile()) {
  const input = document.getElementById('trello-file') as HTMLInputElement
  await user.upload(input, file)
}

async function goToReview(user: ReturnType<typeof userEvent.setup>, preview = makePreview()) {
  mockPreview.mockResolvedValue(preview)
  await pickFile(user)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByText('Step 2 of 2 · Review and configure')
}

describe('TrelloImportModal', () => {
  beforeEach(() => {
    mockPreview.mockReset()
    mockConfirm.mockReset()
  })

  it('starts on step 1 with Continue disabled until a file is chosen', async () => {
    const user = userEvent.setup()
    renderModal()
    expect(screen.getByText('Import from Trello')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2 · Choose file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await pickFile(user)
    expect(screen.getByText('board.json')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    // Picking a file does not spend a preview request.
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON file client-side but leaves the size limit to the server', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderModal()
    await pickFile(user, new File(['x'], 'board.csv', { type: 'text/csv' }))
    expect(screen.getByText('Unsupported file format. Please upload the .json file exported from Trello.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    const big = new File(['{}'], 'big.json', { type: 'application/json' })
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    await pickFile(user, big)
    // Sizes are server-configured, so a big file is not blocked client-side.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('previews once on Continue and shows the review step', async () => {
    const user = userEvent.setup()
    renderModal({ groupId: 4, groupName: 'Design Team' })
    await goToReview(user)
    expect(mockPreview).toHaveBeenCalledTimes(1)
    expect(mockPreview.mock.calls[0][1]).toMatchObject({ groupId: 4 })
    expect(screen.getByLabelText('Board name')).toHaveValue('Product Roadmap')
    expect(screen.getByText('This board will be created in Design Team.')).toBeInTheDocument()
    expect(screen.getByText("Some Trello data can't be imported")).toBeInTheDocument()
    expect(screen.getByText("2 Power-Up data entries won't be imported")).toBeInTheDocument()
    expect(screen.getByText('1 archived card will be imported as archived.')).toBeInTheDocument()
  })

  it('toggling options never fires another preview and updates derived counts', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    const table = screen.getByRole('table')
    expect(within(table).getByText('Skipped')).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Include archived lists' }))
    expect(within(table).queryByText('Skipped')).not.toBeInTheDocument()
    // The archived-lists warning no longer applies.
    expect(screen.queryByText('Archived lists and their cards will be skipped.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Make swimlane: Acme' }))
    expect(screen.getByText('1 of 2 labels selected')).toBeInTheDocument()
    expect(mockPreview).toHaveBeenCalledTimes(1)
  })

  it('disables the swimlane toggle for unnamed labels', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    expect(screen.getByRole('switch', { name: 'Make swimlane: Yellow' })).toBeDisabled()
    expect(screen.getByText("Unnamed labels can't be swimlanes.")).toBeInTheDocument()
  })

  it('shows unmatched names but only a count for matched members', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    expect(screen.getByText('1 of 3 Trello members match existing users.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByText('Stranger Danger')).toBeInTheDocument()
    expect(screen.getByLabelText('Add matched members to this board')).not.toBeChecked()
  })

  it('confirms with the chosen mapping and calls onImported', async () => {
    const user = userEvent.setup()
    const { onImported } = renderModal()
    await goToReview(user)
    mockConfirm.mockResolvedValue({ board: { id: 42, name: 'Roadmap' }, summary: {} })

    await user.click(screen.getByRole('switch', { name: 'Make swimlane: Acme' }))
    const defaultName = screen.getByLabelText('Default swimlane name')
    await user.clear(defaultName)
    await user.type(defaultName, 'Everything else')
    await user.click(screen.getByLabelText('Add matched members to this board'))
    const name = screen.getByLabelText('Board name')
    await user.clear(name)
    await user.type(name, 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create board' }))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ id: 42, name: 'Roadmap' }))
    const [file, params] = mockConfirm.mock.calls[0]
    expect(file).toBeInstanceOf(File)
    expect(params).toEqual({
      name: 'Roadmap',
      fileSha256: 'sha-1',
      mapping: {
        swimlane_label_ids: ['l1'],
        default_swimlane_name: 'Everything else',
        include_archived_lists: false,
        add_matched_members: true,
      },
    })
  })

  it('defaults add_matched_members to false in the confirm payload', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    mockConfirm.mockResolvedValue({ board: { id: 1 }, summary: {} })
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockConfirm.mock.calls[0][1].mapping.add_matched_members).toBe(false)
  })

  it('blocks Create board when the name is empty or the default swimlane collides', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    const name = screen.getByLabelText('Board name')
    await user.clear(name)
    expect(screen.getByLabelText('Board name')).toHaveAccessibleDescription('Enter a board name.')
    const create = screen.getByRole('button', { name: 'Create board' })
    expect(create).toHaveAttribute('aria-disabled', 'true')
    expect(create).toHaveAccessibleDescription('Enter a board name.')
    // Clicking the blocked button focuses the field that needs fixing and sends nothing.
    await user.click(create)
    expect(screen.getByLabelText('Board name')).toHaveFocus()
    expect(mockConfirm).not.toHaveBeenCalled()
    await user.type(name, 'X')

    await user.click(screen.getByRole('switch', { name: 'Make swimlane: Acme' }))
    const defaultName = screen.getByLabelText('Default swimlane name')
    await user.clear(defaultName)
    await user.type(defaultName, 'acme')
    expect(screen.getByRole('button', { name: 'Create board' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('is not dismissable while creating', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderModal()
    await goToReview(user)
    mockConfirm.mockReturnValue(new Promise(() => {}))
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(await screen.findByText(/Uploading file…/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('returns to review with an error when confirm fails', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    mockConfirm.mockRejectedValue({ response: { status: 400, data: { detail: 'There are no lists to import.' } } })
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(await screen.findByText('There are no lists to import.')).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 2 · Review and configure')).toBeInTheDocument()
  })

  it('shows preview errors on step 1 and keeps the file', async () => {
    const user = userEvent.setup()
    renderModal()
    mockPreview.mockRejectedValue({ response: { status: 403, data: {} } })
    await pickFile(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText("You don't have permission to create boards in this group.")).toBeInTheDocument()
    expect(screen.getByText('board.json')).toBeInTheDocument()
  })

  it('Back keeps the cached preview and Continue does not re-preview', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToReview(user)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Step 2 of 2 · Review and configure')
    expect(mockPreview).toHaveBeenCalledTimes(1)
  })
})

describe('describeTrelloError', () => {
  it('maps status codes to copy', () => {
    expect(describeTrelloError({ response: { status: 400, data: { detail: 'Bad file' } } }, 'preview')?.text).toBe('Bad file')
    expect(describeTrelloError({ response: { status: 400, data: '<html>' } }, 'preview')?.text).toBe(
      "We couldn't read this file. Make sure it's a Trello JSON export.",
    )
    expect(describeTrelloError({ response: { status: 413, data: '<html>nginx</html>' } }, 'confirm')?.text).toBe(
      'This file is too large for this server. Ask your administrator about the upload limit.',
    )
    expect(
      describeTrelloError({ response: { status: 413, data: { detail: 'Maximum is 40 MB.' } } }, 'preview')?.text,
    ).toBe('Maximum is 40 MB.')
    expect(describeTrelloError({ response: { status: 403 } }, 'confirm')?.text).toBe(
      "You don't have permission to create boards in this group.",
    )
    expect(describeTrelloError({ response: { status: 500 } }, 'confirm')?.text).toBe(
      'Something went wrong on our side. Try again in a moment.',
    )
    expect(describeTrelloError({ response: { status: 401 } }, 'preview')).toBeNull()
    expect(describeTrelloError({ code: 'ERR_CANCELED' }, 'preview')).toBeNull()
  })

  it('uses Retry-After and warning tone for 429', () => {
    const preview = describeTrelloError({ response: { status: 429, headers: { 'retry-after': '90' } } }, 'preview')
    expect(preview).toEqual({ tone: 'warning', text: 'Too many previews. Try again in 2 minutes.' })
    const confirm = describeTrelloError({ response: { status: 429, headers: {} } }, 'confirm')
    expect(confirm?.text).toBe('Import limit reached. Try again in a little while.')
  })

  it('warns that a board may exist after a network error on confirm', () => {
    expect(describeTrelloError(new Error('Network Error'), 'confirm')?.text).toContain('may have been created')
    expect(describeTrelloError(new Error('Network Error'), 'preview')?.text).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    )
  })

  it('formats helpers', () => {
    expect(formatMinutes(30)).toBe('1 minute')
    expect(formatMinutes(null)).toBe('a little while')
    expect(unmappableLine('stickers', 1)).toBe("1 sticker won't be imported")
    expect(unmappableLine('attachment_files', 2)).toBe(
      "2 attachment files won't be imported (links are added to card descriptions)",
    )
    expect(unmappableLine('mystery_kind', 3)).toBe("3 mystery kind won't be imported")
  })
})
