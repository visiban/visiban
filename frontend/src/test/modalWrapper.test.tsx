import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModalWrapper from '../components/shared/ModalWrapper'

describe('ModalWrapper', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <ModalWrapper open={false} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </ModalWrapper>
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders backdrop, panel, title, and children when open', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="My Modal">
        <p>Hello</p>
      </ModalWrapper>
    )
    expect(screen.getByText('My Modal')).toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('has correct ARIA attributes', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="ARIA Test">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'modal-title')
  })

  it('uses custom labelId for aria-labelledby', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Custom" labelId="custom-id">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-labelledby', 'custom-id')
    expect(screen.getByText('Custom')).toHaveAttribute('id', 'custom-id')
  })

  it('renders close button that calls onClose', () => {
    const onClose = vi.fn()
    render(
      <ModalWrapper open={true} onClose={onClose} title="Closable">
        <p>Body</p>
      </ModalWrapper>
    )
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <ModalWrapper open={true} onClose={onClose} title="Backdrop Test">
        <p>Body</p>
      </ModalWrapper>
    )
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onClose when panel content is clicked', () => {
    const onClose = vi.fn()
    render(
      <ModalWrapper open={true} onClose={onClose} title="Panel Click">
        <p>Body</p>
      </ModalWrapper>
    )
    fireEvent.click(screen.getByText('Body'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn()
    render(
      <ModalWrapper open={true} onClose={onClose} title="Escape Test">
        <p>Body</p>
      </ModalWrapper>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hides close button and blocks backdrop click when dismissable is false', () => {
    const onClose = vi.fn()
    const { container } = render(
      <ModalWrapper open={true} onClose={onClose} title="Non-dismissable" dismissable={false}>
        <p>Body</p>
      </ModalWrapper>
    )
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders subtitle when provided', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Title" subtitle="A subtitle">
        <p>Body</p>
      </ModalWrapper>
    )
    expect(screen.getByText('A subtitle')).toBeInTheDocument()
  })

  it('does not render subtitle when not provided', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Title Only">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    const paragraphs = dialog.querySelectorAll('p')
    // Only the child paragraph, no subtitle
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0].textContent).toBe('Body')
  })

  it('applies custom maxWidth', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Width" maxWidth="max-w-2xl">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('max-w-2xl')
    expect(dialog.className).not.toContain('max-w-lg')
  })

  it('applies panelClassName', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Panel" panelClassName="h-[85vh]">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('h-[85vh]')
  })

  it('renders header border when headerBorder is true', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Bordered" headerBorder>
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    const header = dialog.firstChild as HTMLElement
    expect(header.className).toContain('border-b')
    expect(header.className).toContain('border-slate-700')
  })

  it('uses design system panel classes', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Design System">
        <p>Body</p>
      </ModalWrapper>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('bg-slate-800')
    expect(dialog.className).toContain('border-slate-700')
    expect(dialog.className).toContain('rounded-lg')
    expect(dialog.className).toContain('shadow-xl')
  })

  it('uses design system backdrop classes', () => {
    const { container } = render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Backdrop">
        <p>Body</p>
      </ModalWrapper>
    )
    const backdrop = container.firstChild as HTMLElement
    expect(backdrop.className).toContain('bg-black/60')
    expect(backdrop.className).toContain('z-50')
    expect(backdrop.className).toContain('fixed')
    expect(backdrop.className).toContain('inset-0')
  })

  it('wraps children in padding div when noPadding is false', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="Padded">
        <p>Padded content</p>
      </ModalWrapper>
    )
    const p = screen.getByText('Padded content')
    expect(p.parentElement?.className).toContain('px-6')
    expect(p.parentElement?.className).toContain('pb-6')
  })

  it('does not wrap children in padding div when noPadding is true', () => {
    render(
      <ModalWrapper open={true} onClose={vi.fn()} title="No Padding" noPadding>
        <div data-testid="direct-child" className="custom">Content</div>
      </ModalWrapper>
    )
    const child = screen.getByTestId('direct-child')
    expect(child.className).toBe('custom')
    // Parent should be the dialog panel itself, not a padding wrapper
    expect(child.parentElement?.getAttribute('role')).toBe('dialog')
  })
})
