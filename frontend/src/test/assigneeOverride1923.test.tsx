import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import MoveBlockedToast from '../components/Board/MoveBlockedToast'
import { overrideEligibility, type OverrideEligibility } from '../utils/forceOverride'
import { activityLabel } from '../utils/cardTimelineLabels'
import { failureReason } from '../utils/moveFailure'
import { ToastProvider } from '../contexts/ToastContext'

const me = { id: 7, username: 'ada', display_name: 'Ada', avatar_url: '' }
const bo = { id: 3, username: 'bo', display_name: '', avatar_url: '' }
const input = { role: 'member' as const, userId: 7, allowAssigneeOverride: true, card: { assignee: me, assigned_by: 9 } }

describe('overrideEligibility (#1923)', () => {
  it('admins always qualify, even with no card or user', () => {
    for (const role of ['admin', 'site_admin'] as const) {
      expect(overrideEligibility({ role, userId: null, allowAssigneeOverride: false, card: undefined }).kind).toBe('admin')
    }
  })

  it('a member assignee somebody else assigned qualifies', () => {
    expect(overrideEligibility(input).kind).toBe('assignee')
  })

  it.each([
    ['no role', { role: null }],
    ['viewer', { role: 'viewer' as const }],
    ['collaborator', { role: 'collaborator' as const }],
    ['no user', { userId: undefined }],
    ['switch off', { allowAssigneeOverride: false }],
    ['switch absent', { allowAssigneeOverride: undefined }],
    ['no card', { card: undefined }],
    ['no assignee', { card: { assignee: null, assigned_by: 9 } }],
    ['unknown assigner', { card: { assignee: me, assigned_by: null } }],
    ['absent assigner', { card: { assignee: me } }],
    ['another assignee who assigned themselves', { card: { assignee: bo, assigned_by: 3 } }],
  ])('fails closed: %s', (_name, over) => {
    expect(overrideEligibility({ ...input, ...over }).kind).toBe('none')
  })

  it('tells a self-assigned assignee apart and names another assignee', () => {
    expect(overrideEligibility({ ...input, card: { assignee: me, assigned_by: 7 } }).kind).toBe('self_assigned')
    expect(overrideEligibility({ ...input, card: { assignee: bo, assigned_by: 9 } })).toEqual({ kind: 'other_member', assigneeName: 'bo' })
  })
})

describe('MoveBlockedToast assignee override (#1923)', () => {
  const error = { code: 'wip_limit_exceeded' as const, column_name: 'Review', current_count: 2, wip_limit: 2 }
  const show = (eligibility: OverrideEligibility, onForce = vi.fn()) => {
    render(<ToastProvider><MoveBlockedToast error={error} eligibility={eligibility} onForce={onForce} onDismiss={vi.fn()} /></ToastProvider>)
    return onForce
  }

  it('asks for a reason, and sends it', async () => {
    const user = userEvent.setup()
    const onForce = show({ kind: 'assignee' })
    await user.click(screen.getByRole('button', { name: 'Move anyway (assignee override)' }))
    const dialog = screen.getByRole('dialog', { name: 'Move to Review anyway?' })
    expect(within(dialog).getByLabelText('Reason (required)')).toHaveFocus()
    expect(within(dialog).getByText('Visible to everyone on this board.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Reason (required)')).toHaveAttribute('maxlength', '500')
    await user.click(within(dialog).getByRole('button', { name: 'Move anyway' }))
    expect(onForce).not.toHaveBeenCalled()
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'Hotfix')
    await user.click(within(dialog).getByRole('button', { name: 'Move anyway' }))
    expect(onForce).toHaveBeenCalledWith('Hotfix')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Cancel closes the dialog without moving', async () => {
    const user = userEvent.setup()
    const onForce = show({ kind: 'assignee' })
    await user.click(screen.getByRole('button', { name: 'Move anyway (assignee override)' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onForce).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'self_assigned' } as const, 'You assigned this card to yourself, so a board admin needs to move it anyway.'],
    [{ kind: 'other_member', assigneeName: 'Bo' } as const, "Ask Bo (the card's assignee) or a board admin to move it anyway."],
  ])('%o gets a hint and no override', (eligibility, hint) => {
    show(eligibility)
    expect(screen.getAllByText(hint, { exact: false }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
  })
})

describe('override copy (#1923)', () => {
  it('labels the timeline row with kinds, basis and reason', () => {
    expect(activityLabel('override_used', { from_value: 'assignee', to_value: 'wip,weight', item_text: 'Hotfix' }))
      .toBe('WIP and weight limits overridden (assignee override). Reason: Hotfix')
    expect(activityLabel('override_used', { from_value: 'site_admin', to_value: 'weight', item_text: '' }))
      .toBe('Weight limit overridden (admin override)')
    expect(activityLabel('override_used', { from_value: 'admin' })).toBe('Card limit overridden (admin override)')
  })

  it('names the assignee-override refusals', () => {
    const fail = (status: number, data: unknown) =>
      new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, { status, data } as never)
    expect(failureReason(fail(403, { code: 'force_not_permitted', reason: 'self_assigned' })))
      .toBe('you assigned this card to yourself, so a board admin needs to move it anyway')
    expect(failureReason(fail(403, { code: 'force_not_permitted' }))).toBe('you do not have permission')
    expect(failureReason(fail(400, { code: 'override_reason_required' }))).toBe('a reason is required to move it anyway')
  })
})
