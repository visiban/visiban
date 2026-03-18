import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RichTextEditor from '../components/Card/RichTextEditor'

// Tiptap uses ProseMirror which requires a real browser DOM; mock it for unit tests.
// Behavioural tests for the full editor (toolbar clicks, mention autocomplete) live
// in Playwright/Cypress e2e tests where a real DOM is available.
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => null),
  EditorContent: ({ className }: { className?: string }) => (
    <div data-testid="tiptap-editor" className={className} />
  ),
  ReactRenderer: vi.fn(),
}))

vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: vi.fn(() => ({})) },
}))
vi.mock('@tiptap/extension-text-style', () => ({ default: {} }))
vi.mock('@tiptap/extension-color', () => ({ Color: {} }))
vi.mock('@tiptap/extension-mention', () => ({
  default: {
    extend: vi.fn((spec) => ({ ...spec, configure: vi.fn(() => ({})) })),
    configure: vi.fn(() => ({})),
  },
}))
vi.mock('tiptap-markdown', () => ({
  Markdown: { configure: vi.fn(() => ({})) },
}))
// rehype-raw must be a function (unified plugin) — an empty object causes react-markdown to throw
vi.mock('rehype-raw', () => ({ default: () => {} }))

describe('RichTextEditor', () => {
  const onSave = vi.fn()

  describe('view mode', () => {
    it('renders markdown content via react-markdown', () => {
      render(<RichTextEditor value="**bold text**" onSave={onSave} />)
      expect(screen.getByRole('strong')).toBeInTheDocument()
    })

    it('shows placeholder when value is empty and not readOnly', () => {
      render(<RichTextEditor value="" onSave={onSave} placeholder="Add a description…" />)
      expect(screen.getByText('Add a description…')).toBeInTheDocument()
    })

    it('does not show placeholder when readOnly and value is empty', () => {
      render(<RichTextEditor value="" onSave={onSave} readOnly placeholder="Add a description…" />)
      expect(screen.queryByText('Add a description…')).not.toBeInTheDocument()
    })

    it('shows pencil icon button when editable', () => {
      render(<RichTextEditor value="some text" onSave={onSave} />)
      expect(screen.getByTitle('Edit description')).toBeInTheDocument()
    })

    it('does not show pencil icon when readOnly', () => {
      render(<RichTextEditor value="some text" onSave={onSave} readOnly />)
      expect(screen.queryByTitle('Edit description')).not.toBeInTheDocument()
    })

    it('has cursor-text class when editable', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      expect(container.firstChild).toHaveClass('cursor-text')
    })

    it('does not have cursor-text class when readOnly', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} readOnly />)
      expect(container.firstChild).not.toHaveClass('cursor-text')
    })
  })

  describe('edit mode entry', () => {
    it('enters edit mode when container is clicked', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()
    })

    it('enters edit mode when pencil button is clicked', () => {
      render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(screen.getByTitle('Edit description'))
      expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()
    })

    it('does not enter edit mode when readOnly', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} readOnly />)
      fireEvent.click(container.firstChild as Element)
      // Should remain in view mode — tiptap editor not rendered
      expect(screen.queryByTestId('tiptap-editor')).not.toBeInTheDocument()
    })
  })

  describe('showActions', () => {
    it('shows Save and Cancel buttons in edit mode when showActions is true', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} showActions />)
      fireEvent.click(container.firstChild as Element)
      expect(screen.getByText('Save')).toBeInTheDocument()
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })

    it('does not show Save/Cancel buttons when showActions is false', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      expect(screen.queryByText('Save')).not.toBeInTheDocument()
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
    })

    it('does not show Save/Cancel in view mode even when showActions is true', () => {
      render(<RichTextEditor value="text" onSave={onSave} showActions />)
      expect(screen.queryByText('Save')).not.toBeInTheDocument()
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
    })
  })

  describe('toolbar', () => {
    it('renders toolbar in edit mode', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      // Toolbar buttons
      expect(screen.getByTitle('Bold (Ctrl+B)')).toBeInTheDocument()
      expect(screen.getByTitle('Italic (Ctrl+I)')).toBeInTheDocument()
      expect(screen.getByTitle('Inline code')).toBeInTheDocument()
      expect(screen.getByTitle('Bullet list')).toBeInTheDocument()
      expect(screen.getByTitle('Numbered list')).toBeInTheDocument()
      expect(screen.getByTitle('Heading')).toBeInTheDocument()
      expect(screen.getByTitle('Blockquote')).toBeInTheDocument()
    })

    it('does not render toolbar in view mode', () => {
      render(<RichTextEditor value="text" onSave={onSave} />)
      expect(screen.queryByTitle('Bold (Ctrl+B)')).not.toBeInTheDocument()
    })
  })
})
