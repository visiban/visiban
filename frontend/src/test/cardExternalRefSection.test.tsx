import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardExternalRefSection from '../components/Card/CardExternalRefSection'
import { externalRefErrorMessage } from '../utils/externalRef'
import type { CardExternalRef } from '../types'

const GH: CardExternalRef = {
  provider: 'github',
  ref: 'acme/web#12',
  url: 'https://github.com/acme/web/pull/12',
}

describe('CardExternalRefSection (#352)', () => {
  it('renders nothing for a read-only reader when no link is set', () => {
    const { container } = render(<CardExternalRefSection externalRef={null} canEdit={false} onSave={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('treats undefined like null', () => {
    const { container } = render(<CardExternalRefSection externalRef={undefined} canEdit={false} onSave={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the link without edit controls for a read-only reader', () => {
    render(<CardExternalRefSection externalRef={GH} canEdit={false} onSave={vi.fn()} />)
    const link = screen.getByRole('link', { name: 'acme/web#12, opens in new tab' })
    expect(link).toHaveAttribute('href', GH.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('title', 'acme/web#12 — github.com (opens in new tab)')
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit pull or merge request link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove pull or merge request link' })).not.toBeInTheDocument()
  })

  it('never renders an href for a non-http URL', () => {
    render(
      <CardExternalRefSection
        externalRef={{ ...GH, url: 'javascript:alert(1)' }}
        canEdit
        onSave={vi.fn()}
      />,
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('acme/web#12')).toBeInTheDocument()
  })

  it('shows the empty-state affordance for an editor', () => {
    render(<CardExternalRefSection externalRef={null} canEdit onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: '+ Link a pull or merge request' })).toBeInTheDocument()
  })

  it('derives provider and ref from a pasted GitLab URL and saves the full object', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CardExternalRefSection externalRef={null} canEdit onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: '+ Link a pull or merge request' }))
    const urlInput = screen.getByLabelText('URL')
    expect(urlInput).toHaveFocus()
    await userEvent.click(urlInput)
    await userEvent.paste('https://gitlab.com/group/sub/proj/-/merge_requests/45')
    expect(screen.getByLabelText('Reference')).toHaveValue('group/sub/proj!45')
    expect(screen.getByRole('radio', { name: 'GitLab' })).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Save link' }))
    expect(onSave).toHaveBeenCalledWith({
      provider: 'gitlab',
      ref: 'group/sub/proj!45',
      url: 'https://gitlab.com/group/sub/proj/-/merge_requests/45',
    })
  })

  it('does not overwrite a manually edited ref when the URL changes', async () => {
    render(<CardExternalRefSection externalRef={null} canEdit onSave={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '+ Link a pull or merge request' }))
    await userEvent.type(screen.getByLabelText('Reference'), 'custom-ref')
    await userEvent.click(screen.getByLabelText('URL'))
    await userEvent.paste('https://github.com/acme/web/pull/12')
    expect(screen.getByLabelText('Reference')).toHaveValue('custom-ref')
    expect(screen.getByRole('radio', { name: 'GitHub' })).toBeChecked()
  })

  it('sets provider to Other for an unrecognized http URL', async () => {
    render(<CardExternalRefSection externalRef={null} canEdit onSave={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '+ Link a pull or merge request' }))
    await userEvent.click(screen.getByLabelText('URL'))
    await userEvent.paste('https://tracker.example.com/PROJ-42')
    expect(screen.getByRole('radio', { name: 'Other' })).toBeChecked()
  })

  it('disables Save until the URL is http(s) and the ref is valid', async () => {
    render(<CardExternalRefSection externalRef={null} canEdit onSave={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '+ Link a pull or merge request' }))
    const save = screen.getByRole('button', { name: 'Save link' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('URL'), 'javascript:alert(1)')
    await userEvent.type(screen.getByLabelText('Reference'), 'x')
    expect(save).toBeDisabled()
    expect(screen.getByText('Enter a valid http or https URL.')).toBeInTheDocument()
  })

  it('surfaces a nested server validation error and stays in edit mode', async () => {
    const onSave = vi.fn().mockRejectedValue({
      response: { data: { external_ref: { url: ['Only http and https URLs are allowed.'] } } },
    })
    render(<CardExternalRefSection externalRef={GH} canEdit onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit pull or merge request link' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save link' }))
    expect(await screen.findByText('URL: Only http and https URLs are allowed.')).toBeInTheDocument()
    expect(screen.getByLabelText('URL')).toBeInTheDocument()
  })

  it('removes the link and returns to the empty state', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<CardExternalRefSection externalRef={GH} canEdit onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove pull or merge request link' }))
    expect(onSave).toHaveBeenCalledWith(null)
    rerender(<CardExternalRefSection externalRef={null} canEdit onSave={onSave} />)
    expect(screen.getByRole('button', { name: '+ Link a pull or merge request' })).toBeInTheDocument()
  })

  it('shows an error when remove fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network'))
    render(<CardExternalRefSection externalRef={GH} canEdit onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove pull or merge request link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the link. Try again.")
  })

  it('first Escape cancels the edit without closing the panel (priority 38 > 30)', async () => {
    const panelClose = vi.fn()
    const { useEscapeStack } = await import('../hooks/useEscapeStack')
    function Harness() {
      useEscapeStack(panelClose, 30)
      return <CardExternalRefSection externalRef={GH} canEdit onSave={vi.fn()} />
    }
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit pull or merge request link' }))
    expect(screen.getByLabelText('URL')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('URL')).not.toBeInTheDocument())
    expect(panelClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit pull or merge request link' })).toHaveFocus()
  })
})

describe('externalRefErrorMessage (#352)', () => {
  it('handles a list under external_ref', () => {
    expect(externalRefErrorMessage({ response: { data: { external_ref: ['Bad.', 'Worse.'] } } })).toBe('Bad. Worse.')
  })
  it('handles non_field_errors without a field prefix', () => {
    expect(
      externalRefErrorMessage({ response: { data: { external_ref: { non_field_errors: ['Invalid data.'] } } } }),
    ).toBe('Invalid data.')
  })
  it('falls back to detail', () => {
    expect(externalRefErrorMessage({ response: { data: { detail: 'Forbidden.' } } })).toBe('Forbidden.')
  })
  it('falls back to generic copy', () => {
    expect(externalRefErrorMessage(new Error('x'))).toBe("Couldn't save the link. Try again.")
  })
})
