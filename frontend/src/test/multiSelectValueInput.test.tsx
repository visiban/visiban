import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import MultiSelectValueInput from '../components/Card/MultiSelectValueInput'
import type { FieldDefinitionShape } from '../types'

const def: FieldDefinitionShape = { name: 'Platforms', field_type: 'multi_select', choices: ['web', 'ios', 'android'], help_text: '' }

function setup(value: string | undefined, props: Partial<React.ComponentProps<typeof MultiSelectValueInput>> = {}) {
  const onCommit = vi.fn()
  render(<MultiSelectValueInput definition={def} value={value} onCommit={onCommit} {...props} />)
  return { onCommit }
}

async function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Platforms:/ }))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('MultiSelectValueInput (#1391)', () => {
  it('maps the stored JSON array onto the dropdown trigger and its choices', async () => {
    setup('["web","ios"]')
    expect(screen.getByRole('button', { name: 'Platforms: web, ios' })).toBeInTheDocument()
    await open()
    expect(screen.getByRole('option', { name: /web/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: /android/ })).toHaveAttribute('aria-selected', 'false')
  })

  it('reads an unparseable stored value as no entries', () => {
    setup('not json')
    expect(screen.getByRole('button', { name: 'Platforms: No value' })).toBeInTheDocument()
  })

  it('commits the canonical JSON array string once on close', async () => {
    const { onCommit } = setup('["web"]')
    await open()
    fireEvent.mouseDown(screen.getByRole('option', { name: 'android' }))
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('["web","android"]')
  })

  it('commits an empty string when everything is unchecked', async () => {
    const { onCommit } = setup('["web"]')
    await open()
    fireEvent.mouseDown(screen.getByRole('option', { name: 'web' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onCommit).toHaveBeenCalledWith('')
  })

  it('does not commit an unchanged selection', async () => {
    const { onCommit } = setup('["web"]')
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not open when disabled', () => {
    setup('["web"]', { disabled: true })
    expect(screen.getByRole('button', { name: /^Platforms:/ })).toBeDisabled()
  })
})
