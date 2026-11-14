import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HealthStatusControl from '../components/Common/HealthStatusControl'
import { InstanceFlagsContext, DEFAULT_INSTANCE_FLAGS } from '../contexts/InstanceFlagsContext'
import {
  getHealthDisplay, healthCaption, healthSetLine, healthSetWhen, healthSetterName, healthStatusErrorMessage, healthTitle,
} from '../utils/healthStatus'
import type { BoardUser, HealthHistory, HealthStatus, HealthStatusSource } from '../types'

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
import client from '../api/client'
import { getBoardHealthHistory, setBoardHealthStatus } from '../api/boards'
import { getGroupHealthHistory, setGroupHealthStatus } from '../api/groups'

const NOW = new Date('2026-11-14T12:00:00Z')
const PRIYA: BoardUser = { id: 3, username: 'priya', display_name: 'Priya', avatar_url: '' }
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

const own = (v: HealthStatus, extra: Record<string, unknown> = {}) => ({
  health_status: v, effective_health_status: v, health_status_source: null,
  health_status_changed_at: daysAgo(3), health_status_changed_by: PRIYA, health_status_note: null, ...extra,
})

function renderControl(props: Partial<React.ComponentProps<typeof HealthStatusControl>> = {}) {
  const onSave = props.onSave ?? vi.fn().mockResolvedValue({ effective_health_status: 'at_risk' })
  const onConfirm = props.onConfirm ?? vi.fn().mockResolvedValue({})
  const fetchHistory = props.fetchHistory ?? vi.fn<() => Promise<HealthHistory>>().mockResolvedValue({ results: [], has_more: false })
  render(
    <InstanceFlagsContext.Provider value={DEFAULT_INSTANCE_FLAGS}>
      <HealthStatusControl
        entityKind="group"
        entityName="Roadmap"
        parentName="Eng"
        canEdit
        {...own('at_risk')}
        {...props}
        onSave={onSave}
        onConfirm={onConfirm}
        fetchHistory={fetchHistory}
      />
    </InstanceFlagsContext.Provider>,
  )
  return { onSave, onConfirm, fetchHistory }
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Health status/ }))
  return screen.findByRole('dialog', { name: 'Health status for Roadmap' })
}

describe('health attribution helpers (#2242)', () => {
  it('builds the set line only from healthSetLine', () => {
    expect(healthSetLine(daysAgo(3), PRIYA)).toBe('Set 3d ago by Priya')
    expect(healthSetLine(daysAgo(30), PRIYA)).toMatch(/^Set on .+ by Priya$/)
    expect(healthSetLine(daysAgo(1), null)).toBe('Set 1d ago by System')
    expect(healthSetLine(null, PRIYA)).toBe('')
    expect(healthSetWhen('not a date')).toBe('')
    expect(healthSetterName({ ...PRIYA, display_name: '' })).toBe('priya')
  })

  it('writes the tooltip with attribution, note truncation and history hint', () => {
    const long = 'x'.repeat(130)
    const display = getHealthDisplay(own('at_risk'))
    const attribution = { health_status_changed_at: daysAgo(3), health_status_changed_by: PRIYA, health_status_note: long }
    expect(healthTitle(display, 'interactive', attribution))
      .toBe(`Health status: At risk. Set 3d ago by Priya. Note: ${'x'.repeat(120)}…. Click to change.`)
    expect(healthTitle(display, 'readonly', { ...attribution, health_status_note: 'short' }))
      .toBe('Health status: At risk. Set 3d ago by Priya. Note: short. Click for history.')
    const src: HealthStatusSource = { id: 1, name: 'Eng', changed_at: daysAgo(2) }
    const inherited = getHealthDisplay({ health_status: null, effective_health_status: 'off_track', health_status_source: src })
    expect(healthTitle(inherited, 'static', null, src)).toBe('Health status: Off track (inherited from Eng, set 2d ago).')
    expect(healthCaption(inherited, null, src)).toBe('Inherited from Eng · 2d ago')
    expect(healthCaption(inherited, null, { ...src, changed_at: null })).toBe('Inherited from Eng')
    expect(healthCaption(display, attribution, null)).toBe('Set 3d ago by Priya')
    expect(healthCaption(getHealthDisplay({ health_status: null, effective_health_status: null, health_status_source: null }), attribution, null)).toBe('')
  })

  it('maps field errors from the health-status action', () => {
    expect(healthStatusErrorMessage({ response: { status: 400, data: { note: ['Too long.'] } } })).toBe('Too long.')
    expect(healthStatusErrorMessage({ response: { status: 400, data: { status: ['Nothing set here to confirm.'] } } }))
      .toBe('Nothing set here to confirm.')
  })
})

describe('health status API (#2242)', () => {
  it('posts the action and reads the history', async () => {
    const post = client.post as ReturnType<typeof vi.fn>
    const get = client.get as ReturnType<typeof vi.fn>
    post.mockResolvedValue({ data: { id: 1 } })
    get.mockResolvedValue({ data: { results: [], has_more: false } })
    await setBoardHealthStatus(1, { status: 'at_risk', note: 'n' })
    expect(post).toHaveBeenCalledWith('/api/v1/boards/1/health-status/', { status: 'at_risk', note: 'n' })
    await setGroupHealthStatus(2, { status: null })
    expect(post).toHaveBeenCalledWith('/api/v1/groups/2/health-status/', { status: null })
    await getBoardHealthHistory(1)
    expect(get).toHaveBeenCalledWith('/api/v1/boards/1/health-history/')
    expect(await getGroupHealthHistory(2)).toEqual({ results: [], has_more: false })
    expect(get).toHaveBeenCalledWith('/api/v1/groups/2/health-history/')
  })
})

describe('HealthStatusPopover detailed mode (#2242)', () => {
  it('shows the set line, the note and an empty note field with a counter', async () => {
    const user = userEvent.setup()
    renderControl({ ...own('at_risk', { health_status_note: 'vendor slipped' }), showCaption: true })
    expect(screen.getByText('Set 3d ago by Priya')).toHaveAttribute('title', 'Set 3d ago by Priya. Note: vendor slipped')
    const dialog = await openDialog(user)
    expect(within(dialog).getByTestId('health-set-line')).toHaveTextContent('Set 3d ago by Priya')
    expect(within(dialog).getByText('vendor slipped')).toHaveAttribute('title', 'vendor slipped')
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' })
    expect(note).toHaveValue('')
    expect(within(dialog).getByText('0/280')).toBeInTheDocument()
    await user.type(note, 'a{Shift>}{Enter}{/Shift}b')
    expect(note).toHaveValue('ab')
    await user.click(note)
    await user.paste('line1\nline2')
    expect(note).toHaveValue('abline1 line2')
  })

  it('counter turns warning at 260 and danger at 280', async () => {
    const user = userEvent.setup()
    renderControl()
    const dialog = await openDialog(user)
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' })
    await user.click(note)
    await user.paste('y'.repeat(260))
    expect(within(dialog).getByText('260/280')).toHaveClass('text-warning')
    await user.paste('y'.repeat(30))
    expect(within(dialog).getByText('280/280')).toHaveClass('text-danger')
  })

  it('unchanged: Save is disabled, Confirm reconfirms with the note and announces', async () => {
    const user = userEvent.setup()
    const { onConfirm, onSave } = renderControl()
    const dialog = await openDialog(user)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm status' })
    expect(confirm).not.toHaveAttribute('aria-disabled')
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' })
    await user.type(note, 'checked with vendor')
    // Enter in the note with an unchanged draft moves focus to Confirm (reconfirm stays explicit).
    await user.keyboard('{Enter}')
    expect(confirm).toHaveFocus()
    expect(onConfirm).not.toHaveBeenCalled()
    await user.click(confirm)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('at_risk', 'checked with vendor'))
    expect(onSave).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Health status confirmed: At risk.')).toBeInTheDocument()
  })

  it('changed: Save sends the note, Confirm is disabled with a reason; Enter in the note saves', async () => {
    const user = userEvent.setup()
    const { onSave, onConfirm } = renderControl()
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    const confirm = within(dialog).getByRole('button', { name: 'Confirm status' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).toHaveAttribute('title', 'Save to change the status. Confirm keeps the current one.')
    await user.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), '  vendor  {Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('off_track', 'vendor'))
  })

  it('inherit with nothing set here: both disabled, Confirm says why', async () => {
    const user = userEvent.setup()
    renderControl({
      showCaption: true,
      health_status: null, effective_health_status: 'on_track',
      health_status_source: { id: 1, name: 'Eng', changed_at: daysAgo(2) },
      health_status_changed_at: null, health_status_changed_by: null,
    })
    expect(screen.getByText('Inherited from Eng · 2d ago')).toBeInTheDocument()
    const dialog = await openDialog(user)
    expect(within(dialog).getByText('Eng set this 2d ago.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Confirm status' })).toHaveAttribute('title', 'Nothing set here to confirm.')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('a failed confirm keeps the popover open with the message', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockRejectedValue({ response: { status: 403 } })
    renderControl({ onConfirm })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Confirm status' }))
    expect(await within(dialog).findByText('Only admins can change health status.')).toBeInTheDocument()
  })

  it('History: collapsed, fetches on first expand, renders rows, reconfirm, System and has_more', async () => {
    const user = userEvent.setup()
    const fetchHistory = vi.fn<() => Promise<HealthHistory>>().mockResolvedValue({
      results: [
        { from_status: 'at_risk', to_status: 'at_risk', changed_by: PRIYA, changed_at: daysAgo(1), note: 'still late' },
        { from_status: null, to_status: 'at_risk', changed_by: null, changed_at: daysAgo(3), note: null },
        { from_status: 'on_track', to_status: null, changed_by: PRIYA, changed_at: daysAgo(4), note: null },
      ],
      has_more: true,
    })
    renderControl({ fetchHistory })
    const dialog = await openDialog(user)
    const toggle = within(dialog).getByRole('button', { name: 'History' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(fetchHistory).not.toHaveBeenCalled()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const region = await within(dialog).findByRole('region', { name: 'Status history' })
    const rows = await within(region).findAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('At risk· confirmed')
    expect(rows[0]).toHaveTextContent('still late')
    expect(within(rows[1]).getByText('System')).toHaveAttribute('title', 'Automatic change or removed account')
    expect(rows[1]).toHaveTextContent('Inherited')
    expect(rows[2]).toHaveTextContent('On track')
    expect(within(rows[0]).getByText('1d ago').tagName).toBe('TIME')
    expect(within(region).getByText('Showing the 20 most recent changes.')).toBeInTheDocument()
    await user.click(toggle)
    await user.click(toggle)
    expect(fetchHistory).toHaveBeenCalledTimes(1)
  })

  it('History: empty, error and retry', async () => {
    const user = userEvent.setup()
    const fetchHistory = vi.fn<() => Promise<HealthHistory>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ results: [], has_more: false })
    renderControl({ fetchHistory, parentName: null })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'History' }))
    expect(await within(dialog).findByText('Could not load history.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByText(/No changes recorded yet/)).toBeInTheDocument()
  })

  it('non-admins open a read-only popover with the history loaded at once', async () => {
    const user = userEvent.setup()
    const fetchHistory = vi.fn<() => Promise<HealthHistory>>().mockResolvedValue({ results: [], has_more: false })
    renderControl({ canEdit: false, fetchHistory })
    const trigger = screen.getByRole('button', { name: /^Health status/ })
    expect(trigger).toHaveAttribute('title', 'Health status: At risk. Set 3d ago by Priya. Click for history.')
    const dialog = await openDialog(user)
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Confirm status' })).not.toBeInTheDocument()
    await waitFor(() => expect(dialog).toHaveFocus())
    expect(await within(dialog).findByText(/No changes recorded yet/)).toBeInTheDocument()
    expect(fetchHistory).toHaveBeenCalledTimes(1)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('basic mode renders the #1133 editor: no note, Confirm or History', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ effective_health_status: 'off_track' })
    renderControl({ mode: 'basic', onSave })
    const dialog = await openDialog(user)
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Confirm status' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
    expect(within(dialog).queryByTestId('health-set-line')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('off_track'))
  })
})
