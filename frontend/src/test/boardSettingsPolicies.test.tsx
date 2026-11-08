import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import BoardSettingsPoliciesSection from '../components/Board/BoardSettingsPoliciesSection'
import ModalWrapper from '../components/shared/ModalWrapper'
import BoardSettingsModal from '../components/Board/BoardSettingsModal'
import type { BoardFull, Column, ColumnPolicy, User } from '../types'

vi.mock('../api/boards', () => ({
  patchColumn: vi.fn(),
  setBoardMember: vi.fn(),
  removeBoardMember: vi.fn(),
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
  patchBoard: vi.fn(),
  deleteBoard: vi.fn(),
  enableBoardSharing: vi.fn(),
  disableBoardSharing: vi.fn(),
  getBoardExportHistory: vi.fn().mockResolvedValue({ results: [], count: 0, next: null, previous: null }),
  listBoardInviteLinks: vi.fn().mockResolvedValue([]),
  revokeBoardInviteLink: vi.fn(),
  sendBoardInviteEmail: vi.fn(),
  createBoardInviteLink: vi.fn(),
}))
vi.mock('../api/webhooks', () => ({
  getWebhookStatus: vi.fn().mockResolvedValue({
    enabled: true, dispatcher_last_run_at: null, dispatcher_stale: true, subscribable_event_types: ['card.moved'],
    disable_after_failures: 20, test_timeout_seconds: 10,
  }),
  listWebhooks: vi.fn().mockResolvedValue([]),
  createWebhook: vi.fn(),
  rotateWebhookSecret: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  searchUsers: vi.fn(),
  getSiteConfig: vi.fn().mockResolvedValue({
    registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null,
    invite_email_available: true,
  }),
}))

import { patchColumn } from '../api/boards'
const mockPatchColumn = patchColumn as ReturnType<typeof vi.fn>

const ADVISORY: ColumnPolicy = { v: 1, entry: ['Spec written'], done: ['Merged', 'Deployed'], mode: 'advisory' }
const CONFIRM: ColumnPolicy = { v: 1, entry: ['a', 'b', 'c'], done: ['x', 'y'], mode: 'confirm' }

function col(id: number, name: string, policy: ColumnPolicy | null = null): Column {
  return {
    id, uid: `col-${id}`, name, position: id, color: '#6B7280', wip_limit: null, weight_limit: null,
    allow_card_creation: true, is_done: false, policy,
  }
}

const COLUMNS = [col(1, 'Backlog'), col(2, 'Review', ADVISORY), col(3, 'Doing', CONFIRM)]

function renderSection(props: Partial<React.ComponentProps<typeof BoardSettingsPoliciesSection>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const utils = render(
    <BoardSettingsPoliciesSection columns={COLUMNS} isAdmin onSaveColumnPolicy={onSave} {...props} />,
  )
  return { onSave, ...utils }
}

// Row buttons are named "<column> <summary>"; match on the leading column name.
const rowButton = (name: string) =>
  screen.getByRole('button', { name: (accessible) => accessible.startsWith(name) })

beforeEach(() => { vi.clearAllMocks() })

describe('BoardSettingsPoliciesSection — summaries', () => {
  it('shows none / advisory / confirm summaries with counts', () => {
    renderSection()
    expect(rowButton('Backlog')).toHaveTextContent('No policy')
    expect(rowButton('Review')).toHaveTextContent('1 entry criterion, 2 done criteria · Advisory')
    expect(rowButton('Doing')).toHaveTextContent('3 entry criteria, 2 done criteria · Confirm on entry')
  })

  it('lists a hidden column with a Hidden badge only when hidden', () => {
    renderSection({ hiddenColumnIds: [2] })
    expect(rowButton('Review')).toHaveTextContent('Hidden')
    expect(rowButton('Backlog')).not.toHaveTextContent('Hidden')
  })

  it('updates a closed row summary when the columns prop changes', () => {
    const { rerender, onSave } = renderSection()
    rerender(
      <BoardSettingsPoliciesSection
        columns={[col(1, 'Backlog', { v: 1, entry: ['one'], done: [], mode: 'confirm' }), COLUMNS[1], COLUMNS[2]]}
        isAdmin
        onSaveColumnPolicy={onSave}
      />,
    )
    expect(rowButton('Backlog')).toHaveTextContent('1 entry criterion, 0 done criteria · Confirm on entry')
  })

  it('shows an empty state for a board with no columns', () => {
    renderSection({ columns: [] })
    expect(screen.getByText('This board has no columns yet.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Column policies' })).toBeInTheDocument()
  })
})

describe('BoardSettingsPoliciesSection — admin editing', () => {
  it('adds a policy and saves only that column', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    await user.click(rowButton('Backlog'))
    expect(rowButton('Backlog')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add criterion to Entry criteria' }))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '  Ready  ')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(1, { v: 1, entry: ['Ready'], done: [], mode: 'advisory' })
  })

  it('edits an existing policy, including mode', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    await user.click(rowButton('Review'))
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written')
    await user.click(screen.getByRole('radio', { name: /Ask the mover to confirm/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(2, { ...ADVISORY, mode: 'confirm' }))
  })

  it('removing every criterion saves a null policy', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection({ columns: [col(2, 'Review', { v: 1, entry: ['only'], done: [], mode: 'advisory' })] })
    await user.click(rowButton('Review'))
    await user.click(screen.getByRole('button', { name: 'Remove entry criterion 1' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(2, null))
  })

  it('an unchanged draft cannot be saved', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    await user.click(rowButton('Review'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // Typing then undoing leaves the draft equal to the seed.
    const input = screen.getByRole('textbox', { name: 'Entry criterion 1' })
    await user.type(input, 'x')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.type(input, '{Backspace}')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('collapses on success, moves focus to the row button and announces', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(rowButton('Backlog'))
    await user.click(screen.getByRole('button', { name: 'Add criterion to Entry criteria' }))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), 'Ready')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(rowButton('Backlog')).toHaveAttribute('aria-expanded', 'false'))
    await waitFor(() => expect(rowButton('Backlog')).toHaveFocus())
    expect(screen.getByText('Policy saved for Backlog.')).toBeInTheDocument()
  })

  it('shows the server error inline and keeps the draft on failure', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    onSave.mockRejectedValueOnce({ response: { data: { policy: ['Too many criteria.'] } } })
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Too many criteria.')).toBeInTheDocument()
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written!')
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-describedby')
    // The error clears on the next edit.
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '?')
    expect(screen.queryByText('Too many criteria.')).toBeNull()
  })

  it.each([
    [{ response: { data: { detail: 'Nope.' } } }, 'Nope.'],
    [new Error('network'), "Couldn't save the policy. Try again."],
  ])('falls back sensibly for error %#', async (err, text) => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    onSave.mockRejectedValueOnce(err)
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('Cancel discards the draft, collapses and refocuses the row', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(rowButton('Review')).toHaveFocus())
    await user.click(rowButton('Review'))
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written')
  })

  it('locks the editor and other rows while saving', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSection()
    let resolve!: () => void
    onSave.mockReturnValueOnce(new Promise<void>((r) => { resolve = r }))
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(rowButton('Backlog')).toHaveAttribute('aria-disabled', 'true')
    await user.click(rowButton('Backlog'))
    expect(rowButton('Backlog')).toHaveAttribute('aria-expanded', 'false')
    resolve()
    await waitFor(() => expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'false'))
  })
})

describe('BoardSettingsPoliciesSection — switching rows', () => {
  it('switches straight over when the open row is clean', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(rowButton('Review'))
    await user.click(rowButton('Doing'))
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'false')
    expect(rowButton('Doing')).toHaveAttribute('aria-expanded', 'true')
  })

  const PROMPT = 'Discard changes to “Review” and open “Doing”?'
  const dirtyThenClickDoing = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(rowButton('Doing'))
  }

  it('asks before discarding a dirty draft; Cancel keeps it and returns focus to the clicked row', async () => {
    const user = userEvent.setup()
    renderSection()
    await dirtyThenClickDoing(user)
    const prompt = screen.getByText(PROMPT).closest('[role="status"]') as HTMLElement
    expect(prompt).toHaveAttribute('aria-live', 'polite')
    expect(prompt).toHaveAttribute('aria-atomic', 'true')
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(PROMPT)).toBeNull()
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written!')
    await waitFor(() => expect(rowButton('Doing')).toHaveFocus())
  })

  it('Confirm drops the draft and opens the target', async () => {
    const user = userEvent.setup()
    renderSection()
    await dirtyThenClickDoing(user)
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(rowButton('Doing')).toHaveAttribute('aria-expanded', 'true')
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(PROMPT)).toBeNull()
    await waitFor(() => expect(rowButton('Doing')).toHaveFocus())
  })

  it('Escape dismisses the prompt without closing the modal or dropping the draft', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ModalWrapper open onClose={onClose} title="Host" labelId="host-title">
      <BoardSettingsPoliciesSection columns={COLUMNS} isAdmin onSaveColumnPolicy={vi.fn()} />
    </ModalWrapper>)
    await dirtyThenClickDoing(user)
    expect(screen.getByText(PROMPT)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText(PROMPT)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written!')
    // A second Escape, with no prompt, reaches the modal.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking the open row while dirty collapses and discards silently', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    await user.click(rowButton('Review'))
    expect(screen.queryByText(/Discard changes to/)).toBeNull()
    expect(rowButton('Review')).toHaveAttribute('aria-expanded', 'false')
  })

  it('collapses silently when the open column is removed', async () => {
    const user = userEvent.setup()
    const { rerender, onSave } = renderSection()
    await user.click(rowButton('Review'))
    rerender(<BoardSettingsPoliciesSection columns={[COLUMNS[0], COLUMNS[2]]} isAdmin onSaveColumnPolicy={onSave} />)
    expect(screen.queryByRole('textbox', { name: 'Entry criterion 1' })).toBeNull()
    expect(screen.queryByRole('button', { name: (n) => n.startsWith('Review') })).toBeNull()
  })

  it('does not reseed an open draft from live column updates', async () => {
    const user = userEvent.setup()
    const { rerender, onSave } = renderSection()
    await user.click(rowButton('Review'))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), '!')
    rerender(
      <BoardSettingsPoliciesSection
        columns={[COLUMNS[0], col(2, 'Review', { ...ADVISORY, entry: ['Changed elsewhere'] }), COLUMNS[2]]}
        isAdmin
        onSaveColumnPolicy={onSave}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Spec written!')
    expect(rowButton('Review')).toHaveTextContent('1 entry criterion')
  })
})

describe('BoardSettingsPoliciesSection — read only', () => {
  it('lists policies with no buttons for a non-admin', () => {
    renderSection({ isAdmin: false })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/Only admins can change these\./)).toBeInTheDocument()
    expect(screen.getByText('No policy')).toBeInTheDocument()
    expect(screen.getByText('1 entry criterion, 2 done criteria · Advisory')).toBeInTheDocument()
    expect(screen.getAllByText('Entry criteria')).toHaveLength(2)
    expect(screen.getAllByText('Definition of done')).toHaveLength(2)
    expect(screen.getByText('Spec written')).toBeInTheDocument()
    expect(screen.getByText('Deployed')).toBeInTheDocument()
  })

  it('shows "None." for an empty list within a policy', () => {
    renderSection({ isAdmin: false, columns: [col(1, 'A', { v: 1, entry: ['x'], done: [], mode: 'advisory' })] })
    expect(screen.getByText('None.')).toBeInTheDocument()
  })

  it('shows an empty state for a non-admin on a board with no columns', () => {
    renderSection({ isAdmin: false, columns: [] })
    expect(screen.getByText('This board has no columns yet.')).toBeInTheDocument()
  })
})

// ─── Wiring through BoardSettingsModal ───────────────────────────────────────

const fakeUser: User = {
  id: 1, username: 'admin', email: 'a@example.com', first_name: 'A', last_name: 'U', avatar_url: '',
  display_name: 'Admin User', is_site_admin: false, must_change_password: false, must_change_username: false,
  has_usable_password: true,
}

function makeBoard(columns: Column[]): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', archived_card_count: 0, name: 'Sprint Board', description: '', group: null,
    group_name: null, columns, swimlanes: [], cards: [], labels: [], card_count: 0, wip_limit: null,
    members: [{ id: 10, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false,
    show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false,
    created_at: '', updated_at: '', current_user_role: 'admin', custom_field_definitions: [],
    swimlane_custom_field_definitions: [], owner: fakeUser, capabilities: { movement_export: false },
    share_token: null, share_token_expires_at: null, share_link_active: false,
  } as unknown as BoardFull
}

function Host({ onColumnUpdated, isAdmin = true, demoMode = false }: { onColumnUpdated: (c: Column) => void; isAdmin?: boolean; demoMode?: boolean }) {
  const [columns, setColumns] = useState(COLUMNS)
  return (
    <BoardSettingsModal
      currentUserId={1}
      board={makeBoard(columns)}
      isAdmin={isAdmin}
      demoMode={demoMode}
      onClose={vi.fn()}
      initialTab="rules"
      viewPrefs={{ hiddenColumnIds: [1], hiddenSwimlaneIds: [] } as never}
      onColumnUpdated={(c) => { onColumnUpdated(c); setColumns((cs) => cs.map((x) => (x.id === c.id ? c : x))) }}
    />
  )
}

describe('BoardSettingsModal — Rules tab column policies', () => {
  it('lists every column (including hidden) and PATCHes only policy, then reports the column', async () => {
    const user = userEvent.setup()
    const onColumnUpdated = vi.fn()
    const saved = col(1, 'Backlog', { v: 1, entry: ['Ready'], done: [], mode: 'advisory' })
    mockPatchColumn.mockResolvedValue(saved)
    render(<Host onColumnUpdated={onColumnUpdated} />)
    expect(rowButton('Backlog')).toHaveTextContent('Hidden')
    await user.click(rowButton('Backlog'))
    await user.click(screen.getByRole('button', { name: 'Add criterion to Entry criteria' }))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 1' }), 'Ready')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockPatchColumn).toHaveBeenCalledWith(1, 1, { policy: saved.policy }))
    expect(Object.keys(mockPatchColumn.mock.calls[0][2])).toEqual(['policy'])
    expect(onColumnUpdated).toHaveBeenCalledWith(saved)
    // The summary reflects the new board state without a reload.
    await waitFor(() => expect(rowButton('Backlog')).toHaveTextContent('1 entry criterion, 0 done criteria · Advisory'))
  })

  it('is read-only for non-admins', () => {
    render(<Host onColumnUpdated={vi.fn()} isAdmin={false} />)
    expect(screen.queryByRole('button', { name: (n) => n.startsWith('Backlog') })).toBeNull()
    expect(screen.getByText('Spec written')).toBeInTheDocument()
  })

  it('is inert in demo mode: Save never reaches the API', async () => {
    const user = userEvent.setup()
    render(<Host onColumnUpdated={vi.fn()} demoMode />)
    await user.click(rowButton('Backlog'))
    expect(rowButton('Backlog')).toHaveAttribute('aria-expanded', 'false')
    expect(mockPatchColumn).not.toHaveBeenCalled()
  })
})
