import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Element } from 'hast'
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
// rehype-sanitize: mock the plugin as a no-op and provide a minimal defaultSchema shape
// so SANITIZE_SCHEMA construction in the component doesn't throw. The actual sanitization
// behaviour is tested separately in the 'XSS sanitization schema' describe block below.
vi.mock('rehype-sanitize', () => ({
  default: () => {},
  defaultSchema: { attributes: {}, tagNames: [] as string[] },
}))

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

  describe('XSS sanitization — component rendering', () => {
    it('does not render <script> elements from description content', () => {
      const { container } = render(
        <RichTextEditor value={'Hello <script>alert("xss")</script> world'} onSave={vi.fn()} />
      )
      expect(container.querySelector('script')).toBeNull()
    })

    it('renders without error when description contains raw HTML attributes', () => {
      expect(() =>
        render(
          <RichTextEditor
            value={'<img src="x" onerror="alert(1)">'}
            onSave={vi.fn()}
          />
        )
      ).not.toThrow()
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

// These tests exercise the sanitization schema logic directly via hast-util-sanitize.
// They run outside the component mock scope and use the REAL rehype-sanitize defaultSchema
// (vi.mock is hoisted but only applies to imports used by the component — hast-util-sanitize
// is imported directly here and is not mocked). They verify the two key guarantees:
// (1) <script> and event-handler attributes are stripped, and
// (2) <span style="color:..."> values from the Tiptap Color extension are preserved.
describe('XSS sanitization schema', () => {
  // COLOR_PATTERN mirrors the regex in SANITIZE_SCHEMA in RichTextEditor.tsx.
  const COLOR_PATTERN = /^color:\s*(#[0-9a-fA-F]{3,6}|[a-z]+)$/

  // Minimal schema that replicates the component's SANITIZE_SCHEMA shape for these tests.
  // Uses hast-util-sanitize's defaultSchema as the base (imported directly, not mocked).
  const buildSchema = (base: Record<string, unknown>) => ({
    ...base,
    attributes: {
      ...((base.attributes as Record<string, unknown>) ?? {}),
      span: [
        ...(((base.attributes as Record<string, unknown[]>)?.span) ?? []),
        ['style', COLOR_PATTERN],
      ],
    },
  })

  it('strips <script> elements', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const scriptNode: Element = {
      type: 'element',
      tagName: 'script',
      properties: {},
      children: [{ type: 'text', value: 'alert(1)' }],
    }
    const result = sanitize({ type: 'root', children: [scriptNode] }, schema as Parameters<typeof sanitize>[1])
    const tags = result.children.map((n) => ('tagName' in n ? n.tagName : n.type))
    expect(tags).not.toContain('script')
  })

  it('strips event-handler attributes (onerror)', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const imgNode: Element = {
      type: 'element',
      tagName: 'img',
      properties: { src: 'x', onerror: 'alert(1)' },
      children: [],
    }
    const result = sanitize({ type: 'root', children: [imgNode] }, schema as Parameters<typeof sanitize>[1])
    const img = result.children.find((n) => 'tagName' in n && n.tagName === 'img') as Element | undefined
    expect(img?.properties?.onerror).toBeUndefined()
  })

  it('preserves <span style="color:#ff0000"> written by the Color extension', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const spanNode: Element = {
      type: 'element',
      tagName: 'span',
      properties: { style: 'color:#ff0000' },
      children: [{ type: 'text', value: 'red text' }],
    }
    const result = sanitize({ type: 'root', children: [spanNode] }, schema as Parameters<typeof sanitize>[1])
    const span = result.children.find((n) => 'tagName' in n && n.tagName === 'span') as Element | undefined
    expect(span).toBeDefined()
    expect(span?.properties?.style).toBe('color:#ff0000')
  })

  it('strips <span style> with non-color values (CSS injection)', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const spanNode: Element = {
      type: 'element',
      tagName: 'span',
      properties: { style: 'background:url(javascript:alert(1))' },
      children: [],
    }
    const result = sanitize({ type: 'root', children: [spanNode] }, schema as Parameters<typeof sanitize>[1])
    const span = result.children.find((n) => 'tagName' in n && n.tagName === 'span') as Element | undefined
    expect(span?.properties?.style).toBeUndefined()
  })
})
