import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { AxiosError, AxiosHeaders } from 'axios'
import { ToastProvider } from '../contexts/ToastContext'
import MoveBlockedToast from '../components/Board/MoveBlockedToast'
import EntryWarnToast from '../components/Board/EntryWarnToast'
import { ADMIN_OVERRIDE, NO_OVERRIDE } from '../utils/forceOverride'
import type { MoveBlockedError } from '../hooks/useBoard'
import type { EntryUnmetItem } from '../types'
import {
  alsoSentences, entryNeedsLine, entryRefusal, limitBlockedMessage, toastBody, toastTitle, unmetRequirementLabel,
} from '../components/Board/moveBlockedMessages'
import { LIMIT_CODES, failureReason, isLimitFailure } from '../utils/moveFailure'

// #1923 MR B: the entry-requirements 409, its toast copy, and the Warn toast.

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>

const item = (over: Partial<EntryUnmetItem>): EntryUnmetItem => ({
  requirement_uid: 'r1', operator: 'filled', operand: null,
  field_uid: 'f1', field_name: 'Owner', field_set_uid: null, field_set_name: null, ...over,
})

const amount = item({ requirement_uid: 'r2', operator: 'gt', operand: '50000', field_name: 'Amount' })
const meddic = item({ requirement_uid: 'r3', operator: 'set_complete', field_uid: null, field_name: null, field_set_uid: 's1', field_set_name: 'MEDDIC' })

const entryError = (mode: 'block' | 'hard', unmet: EntryUnmetItem[] = [amount, meddic], also: string[] = []): MoveBlockedError => ({
  code: 'entry_requirements_unmet', detail: 'This card does not meet 2 entry requirements of "Proposal".',
  column_name: 'Proposal', mode, unmet, also,
})

function axios409(data: unknown): AxiosError {
  const headers = new AxiosHeaders()
  return new AxiosError('conflict', '409', undefined, undefined, {
    status: 409, statusText: 'Conflict', data, headers, config: { headers },
  })
}

describe('entry requirement copy', () => {
  it('labels every operator', () => {
    expect(unmetRequirementLabel(item({}))).toBe('Owner filled')
    expect(unmetRequirementLabel(amount)).toBe('Amount more than 50,000')
    expect(unmetRequirementLabel(item({ operator: 'gte', operand: '3.5', field_name: 'Score' }))).toBe('Score at least 3.5')
    expect(unmetRequirementLabel(item({ operator: 'min_count', operand: '1', field_name: 'Tags' }))).toBe('Tags with at least 1 choice')
    expect(unmetRequirementLabel(item({ operator: 'min_count', operand: '2', field_name: 'Tags' }))).toBe('Tags with at least 2 choices')
    expect(unmetRequirementLabel(item({ operator: 'satisfied', field_name: 'Budget' }))).toBe('Budget satisfied')
    expect(unmetRequirementLabel(meddic)).toBe('MEDDIC complete')
  })

  it('lists at most three, then "and N more"', () => {
    expect(entryNeedsLine([])).toBe('')
    expect(entryNeedsLine([amount])).toBe('Needs: Amount more than 50,000.')
    expect(entryNeedsLine([amount, meddic])).toBe('Needs: Amount more than 50,000 and MEDDIC complete.')
    const many = ['A', 'B', 'C', 'D', 'E'].map((n, i) => item({ requirement_uid: `r${i}`, field_name: n }))
    expect(entryNeedsLine(many)).toBe('Needs: A filled, B filled, C filled and 2 more.')
  })

  it('titles and bodies the refusal instead of falling through to weight copy', () => {
    const e = entryError('block')
    expect(toastTitle(e)).toBe("Can't move to Proposal")
    expect(toastBody(e)).toBe('Needs: Amount more than 50,000 and MEDDIC complete.')
    // An empty list falls back to the server's detail.
    expect(toastBody(entryError('block', []))).toBe(e.code === 'entry_requirements_unmet' ? e.detail : '')
  })

  it('turns the server also bodies into sentences and drops the unrecognized', () => {
    expect(alsoSentences(undefined)).toEqual([])
    expect(alsoSentences([
      'already a sentence',
      { code: 'wip_limit_exceeded', column_name: 'Proposal', current_count: 3, wip_limit: 3 },
      { code: 'entry_requirements_unmet', column_name: 'Proposal', unmet: [{}] },
      { code: 'something_else' },
      null,
    ])).toEqual([
      'already a sentence',
      '"Proposal" is at its limit of 3 cards (3 active).',
      '"Proposal" has 1 entry requirement this card doesn\'t meet.',
    ])
  })

  it('reads the 409 body for inline create and restore surfaces', () => {
    const err = axios409({ ...entryError('hard'), also: [{ code: 'wip_limit_exceeded', column_name: 'Proposal', current_count: 1, wip_limit: 1 }] })
    expect(entryRefusal(err)?.also).toEqual(['"Proposal" is at its limit of 1 card (1 active).'])
    expect(limitBlockedMessage(err)).toBe("Can't move to Proposal: Needs: Amount more than 50,000 and MEDDIC complete.")
    expect(entryRefusal(axios409({ code: 'wip_limit_exceeded' }))).toBeNull()
    expect(entryRefusal(new Error('x'))).toBeNull()
  })

  it('is a limit code with its own failure reason', () => {
    expect(LIMIT_CODES.has('entry_requirements_unmet')).toBe(true)
    const err = axios409({ code: 'entry_requirements_unmet' })
    expect(isLimitFailure(err)).toBe(true)
    expect(failureReason(err)).toBe("it does not meet the column's entry requirements")
  })
})

describe('MoveBlockedToast for entry requirements', () => {
  const toast = () => within(screen.getByTestId('move-blocked-toast'))

  it('offers an admin override on Block and asks for a reason first', async () => {
    const onForce = vi.fn().mockResolvedValue({ ok: true })
    render(wrap(<MoveBlockedToast error={entryError('block')} eligibility={ADMIN_OVERRIDE} cardId={7} onForce={onForce} onDismiss={vi.fn()} />))
    expect(toast().getByText("Can't move to Proposal")).toBeInTheDocument()
    await userEvent.click(toast().getByRole('button', { name: 'Move anyway (admin override)' }))
    // Owner Q2: a reason is required for any entry-requirements override, admins included.
    expect(onForce).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Move to Proposal anyway?' })
    await userEvent.type(within(dialog).getByRole('textbox'), 'Customer call booked')
    await userEvent.click(within(dialog).getByRole('button', { name: /Move anyway/ }))
    await waitFor(() => expect(onForce).toHaveBeenCalledWith('Customer call booked'))
  })

  it('offers no override on Hard and says so', () => {
    render(wrap(<MoveBlockedToast error={entryError('hard', [amount], ['"Proposal" is at its limit of 3 cards (3 active).'])} eligibility={ADMIN_OVERRIDE} onForce={vi.fn()} onDismiss={vi.fn()} />))
    expect(toast().queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    expect(toast().getByText("No one can override this column's requirements.")).toBeInTheDocument()
    expect(toast().getByText(/Also: "Proposal" is at its limit/)).toBeInTheDocument()
  })

  it('shows no action to a member who cannot override', () => {
    render(wrap(<MoveBlockedToast error={entryError('block')} eligibility={NO_OVERRIDE} onForce={vi.fn()} onDismiss={vi.fn()} />))
    expect(toast().queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
  })
})

describe('EntryWarnToast', () => {
  it('names the column and count, lists what is unmet, and Fill in opens the card', async () => {
    const onDismiss = vi.fn()
    const opened = vi.fn()
    const listener = (ev: Event) => opened((ev as CustomEvent).detail)
    window.addEventListener('visiban:open-card', listener)
    render(wrap(<EntryWarnToast warning={{ cardId: 9, columnName: 'Negotiation', unmet: [amount], seq: 1 }} onDismiss={onDismiss} />))
    const t = within(await screen.findByTestId('entry-warn-toast'))
    expect(t.getByText('Moved to Negotiation · 1 entry requirement not met')).toBeInTheDocument()
    expect(t.getByText(/Needs: Amount more than 50,000\./)).toBeInTheDocument()
    await userEvent.click(t.getByRole('button', { name: 'Fill in' }))
    expect(opened).toHaveBeenCalledWith({ cardId: 9 })
    expect(onDismiss).toHaveBeenCalled()
    window.removeEventListener('visiban:open-card', listener)
  })

  it('words a two-requirement miss in the plural', async () => {
    render(wrap(<EntryWarnToast warning={{ cardId: 9, columnName: '', unmet: [amount, meddic], seq: 1 }} onDismiss={vi.fn()} />))
    expect(await screen.findByText('Moved · 2 entry requirements not met')).toBeInTheDocument()
  })
})
