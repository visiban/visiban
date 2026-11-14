import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HealthStatusPill, { HealthListingPill } from '../components/Common/HealthStatusPill'
import HealthStatusControl from '../components/Common/HealthStatusControl'
import { InstanceFlagsContext, DEFAULT_INSTANCE_FLAGS } from '../contexts/InstanceFlagsContext'
import {
  HEALTH_STATUS_STYLES, HEALTH_STATUS_VALUES, HEALTH_STATUS_LABELS, NO_STATUS_LABEL,
} from '../constants/healthStatus'
import {
  getHealthDisplay, healthStatusAnnouncement, healthStatusErrorMessage, healthTitle,
} from '../utils/healthStatus'
import type { HealthStatus, HealthStatusSource } from '../types'

const ENG: HealthStatusSource = { id: 7, name: 'Engineering', changed_at: null }

type Fields = {
  health_status: HealthStatus | null
  effective_health_status: HealthStatus | null
  health_status_source: HealthStatusSource | null
}
const own = (v: HealthStatus): Fields => ({ health_status: v, effective_health_status: v, health_status_source: null })
const inherited = (v: HealthStatus, src = ENG): Fields => ({ health_status: null, effective_health_status: v, health_status_source: src })
const none: Fields = { health_status: null, effective_health_status: null, health_status_source: null }

describe('health status helpers (#1133)', () => {
  it('derives value, label and inheritance from the three fields', () => {
    expect(getHealthDisplay(own('at_risk'))).toEqual({ value: 'at_risk', label: 'At risk', inheritedFrom: null })
    expect(getHealthDisplay(inherited('off_track'))).toEqual({ value: 'off_track', label: 'Off track', inheritedFrom: 'Engineering' })
    expect(getHealthDisplay(none)).toEqual({ value: 'none', label: NO_STATUS_LABEL, inheritedFrom: null })
  })

  it('writes the documented titles', () => {
    expect(healthTitle(getHealthDisplay(own('on_track')), 'interactive')).toBe('Health status: On track. Click to change.')
    expect(healthTitle(getHealthDisplay(inherited('at_risk')), 'interactive'))
      .toBe('Health status: At risk (inherited from Engineering). Click to change.')
    expect(healthTitle(getHealthDisplay(none), 'interactive')).toBe('No status set. Click to set one.')
    expect(healthTitle(getHealthDisplay(inherited('at_risk')), 'static')).toBe('Health status: At risk (inherited from Engineering).')
    expect(healthTitle(getHealthDisplay(none), 'static')).toBe('No status set.')
    expect(healthTitle(getHealthDisplay(own('off_track')), 'demo'))
      .toBe("Health status: Off track. This is a shared demo — health status can't be changed here.")
  })

  it('maps save failures to messages', () => {
    expect(healthStatusErrorMessage({ response: { status: 403 } })).toBe('Only admins can change health status.')
    expect(healthStatusErrorMessage({ response: { status: 400, data: { detail: 'Nope.' } } })).toBe('Nope.')
    expect(healthStatusErrorMessage({ response: { status: 400, data: { health_status: ['bad'] } } }))
      .toBe('Could not save health status. Try again.')
    expect(healthStatusErrorMessage(new Error('network'))).toBe('Could not save health status. Try again.')
  })

  it('announces set, follow and clear', () => {
    expect(healthStatusAnnouncement('at_risk', 'at_risk', 'Eng')).toBe('Health status set to At risk.')
    expect(healthStatusAnnouncement(null, 'off_track', 'Eng')).toBe('Health status now follows Eng: Off track.')
    expect(healthStatusAnnouncement(null, null, 'Eng')).toBe('Health status now follows Eng: No status.')
    expect(healthStatusAnnouncement(null, null, null)).toBe('Health status cleared.')
  })
})

describe('HealthStatusPill (#1133)', () => {
  it.each([...HEALTH_STATUS_VALUES, 'none' as const])('%s renders its tint, its own shape and its word', (value) => {
    const { container } = render(<HealthStatusPill value={value} />)
    const pill = container.querySelector('[data-health-status]') as HTMLElement
    for (const cls of HEALTH_STATUS_STYLES[value].split(' ')) expect(pill).toHaveClass(cls)
    expect(pill.querySelector(`svg[data-health-shape="${value}"]`)).toHaveAttribute('aria-hidden', 'true')
    const word = value === 'none' ? NO_STATUS_LABEL : HEALTH_STATUS_LABELS[value]
    expect(pill).toHaveTextContent(`Health status: ${word}`)
    expect(pill).not.toHaveClass('border-dashed')
    expect(pill.tagName).toBe('SPAN')
  })

  it('an inherited pill is dashed and names its source for assistive tech', () => {
    const { container } = render(<HealthStatusPill value="at_risk" inheritedFrom="Engineering" />)
    const pill = container.querySelector('[data-health-status]') as HTMLElement
    expect(pill).toHaveClass('border-dashed')
    expect(pill).toHaveTextContent('Health status: At risk, inherited from Engineering')
  })

  it('collapseLabel keeps the word in the accessible name but hides it below md', () => {
    render(<HealthStatusPill value="off_track" collapseLabel onClick={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Health status: Off track' })
    expect(within(btn).getByText('Off track')).toHaveClass('sr-only', 'md:not-sr-only')
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })

  it('listing pill renders only when a status applies and never for a navigation-only group', () => {
    const { container, rerender } = render(<HealthListingPill fields={none} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HealthListingPill fields={{ ...inherited('at_risk'), navigation_only: true }} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HealthListingPill fields={inherited('at_risk')} />)
    const pill = container.querySelector('[data-health-status="at_risk"]') as HTMLElement
    expect(pill.tagName).toBe('SPAN')
    expect(pill).toHaveAttribute('title', 'Health status: At risk (inherited from Engineering).')
  })
})

function renderControl(props: Partial<React.ComponentProps<typeof HealthStatusControl>> & { demo?: boolean } = {}) {
  const { demo, ...rest } = props
  const onSave = rest.onSave ?? vi.fn().mockResolvedValue({ effective_health_status: 'at_risk' })
  const utils = render(
    <InstanceFlagsContext.Provider value={{ ...DEFAULT_INSTANCE_FLAGS, demo_mode: !!demo }}>
      <button type="button">before</button>
      <HealthStatusControl
        entityKind="board"
        entityName="Roadmap"
        parentName="Engineering"
        canEdit
        {...none}
        {...rest}
        onSave={onSave}
      />
      <button type="button">after</button>
    </InstanceFlagsContext.Provider>,
  )
  return { ...utils, onSave }
}

const trigger = () => screen.getByRole('button', { name: /^Health status:/ })

describe('HealthStatusControl (#1133)', () => {
  it('renders nothing for a non-admin when no status applies', () => {
    renderControl({ canEdit: false })
    expect(screen.queryByText(NO_STATUS_LABEL)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Health status/ })).not.toBeInTheDocument()
  })

  it('shows a plain pill to a non-admin when a status applies', () => {
    renderControl({ canEdit: false, ...inherited('off_track') })
    expect(screen.queryByRole('button', { name: /Health status/ })).not.toBeInTheDocument()
    expect(screen.getByTitle('Health status: Off track (inherited from Engineering).')).toBeInTheDocument()
  })

  it('shows the hollow No status trigger to an admin', () => {
    renderControl()
    expect(trigger()).toHaveAttribute('data-health-status', 'none')
    expect(trigger()).toHaveAttribute('title', 'No status set. Click to set one.')
  })

  it('shows the inherited caption only when asked to', () => {
    const { unmount } = renderControl({ ...inherited('at_risk'), showCaption: true })
    expect(screen.getByText('Inherited from Engineering')).toBeInTheDocument()
    unmount()
    renderControl({ ...own('at_risk'), showCaption: true })
    expect(screen.queryByText(/Inherited from/)).not.toBeInTheDocument()
  })

  it('opens a dialog with the checked radio focused and the state line', async () => {
    const user = userEvent.setup()
    renderControl(inherited('at_risk'))
    await user.click(trigger())
    const dialog = await screen.findByRole('dialog', { name: 'Health status for Roadmap' })
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).getByText('Inherited from Engineering.')).toBeInTheDocument()
    const reset = within(dialog).getByRole('radio', { name: /Inherit from Engineering/ })
    await waitFor(() => expect(reset).toHaveFocus())
    expect(reset).toBeChecked()
  })

  it('arrow keys move the draft without a request; Enter saves it', async () => {
    const user = userEvent.setup()
    const { onSave } = renderControl(own('on_track'))
    await user.click(trigger())
    const dialog = await screen.findByRole('dialog')
    const onTrack = within(dialog).getByRole('radio', { name: /On track/ })
    await waitFor(() => expect(onTrack).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    const atRisk = within(dialog).getByRole('radio', { name: /At risk/ })
    expect(atRisk).toBeChecked()
    expect(onSave).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('at_risk', null))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger()).toHaveFocus()
    expect(screen.getByText('Health status set to At risk.')).toBeInTheDocument()
  })

  it('Enter on an unchanged draft closes with no request and refocuses the trigger', async () => {
    const user = userEvent.setup()
    const { onSave } = renderControl(own('off_track'))
    await user.click(trigger())
    const radio = await screen.findByRole('radio', { name: /Off track/ })
    await waitFor(() => expect(radio).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
    expect(trigger()).toHaveFocus()
  })

  it('choosing Inherit saves null and announces what now applies', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ effective_health_status: 'off_track' })
    renderControl({ ...own('on_track'), onSave })
    await user.click(trigger())
    await user.click(await screen.findByRole('radio', { name: /Inherit from Engineering/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null, null))
    expect(await screen.findByText('Health status now follows Engineering: Off track.')).toBeInTheDocument()
  })

  it('at the root the reset option is No status and clears', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ effective_health_status: null })
    renderControl({ ...own('at_risk'), parentName: null, entityKind: 'group', onSave })
    await user.click(trigger())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Set on this group.')).toBeInTheDocument()
    expect(within(dialog).getByText("Boards and subgroups that don't set their own status follow this one.")).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /No status/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Health status cleared.')).toBeInTheDocument()
  })

  it('Cancel and Escape close without a write and return focus to the trigger', async () => {
    const user = userEvent.setup()
    const { onSave } = renderControl(own('on_track'))
    await user.click(trigger())
    await user.click(await screen.findByRole('radio', { name: /Off track/ }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()

    await user.click(trigger())
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a failed save keeps the popover open with the draft and a message', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockRejectedValue({ response: { status: 403 } })
    renderControl({ ...own('on_track'), onSave })
    await user.click(trigger())
    await user.click(await screen.findByRole('radio', { name: /Off track/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Only admins can change health status.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Off track/ })).toBeChecked()
  })

  it('shows Saving… while the request is in flight and swallows Escape', async () => {
    const user = userEvent.setup()
    let resolve: (v: { effective_health_status: HealthStatus | null }) => void = () => {}
    const onSave = vi.fn().mockReturnValue(new Promise((r) => { resolve = r }))
    renderControl({ ...own('on_track'), onSave })
    await user.click(trigger())
    await user.click(await screen.findByRole('radio', { name: /At risk/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    resolve({ effective_health_status: 'at_risk' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes when focus leaves the popover', async () => {
    const user = userEvent.setup()
    renderControl(own('on_track'))
    await user.click(trigger())
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'after' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a resize while focus is in the popover closes it and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    renderControl(own('on_track'))
    await user.click(trigger())
    const radio = await screen.findByRole('radio', { name: /On track/ })
    await waitFor(() => expect(radio).toHaveFocus())
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('an outside scroll closes; it refocuses the trigger only when focus was inside the panel', async () => {
    const user = userEvent.setup()
    renderControl(own('on_track'))
    await user.click(trigger())
    const radio = await screen.findByRole('radio', { name: /On track/ })
    await waitFor(() => expect(radio).toHaveFocus())
    // Blur fires no focusin, so the panel stays open with focus on <body>.
    act(() => { radio.blur() })
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).not.toHaveFocus()

    await user.click(trigger())
    await waitFor(() => expect(screen.getByRole('radio', { name: /On track/ })).toHaveFocus())
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('the admin trigger shows a pointer and a hover ring; the demo trigger does not advertise a popup', () => {
    const { unmount } = renderControl(own('at_risk'))
    expect(trigger()).toHaveClass('cursor-pointer', 'hover:ring-1', 'hover:ring-line-strong')
    unmount()
    renderControl({ ...own('at_risk'), demo: true })
    expect(trigger()).not.toHaveClass('cursor-pointer')
    expect(trigger()).not.toHaveAttribute('aria-haspopup')
    expect(trigger()).not.toHaveAttribute('aria-expanded')
  })

  it('a remote change while open updates the state line but never the draft', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ effective_health_status: 'at_risk' })
    const { rerender } = renderControl({ ...own('on_track'), onSave })
    await user.click(trigger())
    await user.click(await screen.findByRole('radio', { name: /Off track/ }))
    rerender(
      <InstanceFlagsContext.Provider value={DEFAULT_INSTANCE_FLAGS}>
        <button type="button">before</button>
        <HealthStatusControl
          entityKind="board" entityName="Roadmap" parentName="Engineering" canEdit
          {...inherited('at_risk')} onSave={onSave}
        />
        <button type="button">after</button>
      </InstanceFlagsContext.Provider>,
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Inherited from Engineering.')).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Off track/ })).toBeChecked()
    expect(trigger()).toHaveAttribute('data-health-status', 'at_risk')
  })

  it('in the hosted demo the trigger is aria-disabled and never opens', async () => {
    const user = userEvent.setup()
    const { onSave } = renderControl({ ...own('at_risk'), demo: true })
    const btn = trigger()
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveClass('opacity-40', 'cursor-not-allowed')
    expect(btn.title).toBe("Health status: At risk. This is a shared demo — health status can't be changed here.")
    await user.click(btn)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })
})
