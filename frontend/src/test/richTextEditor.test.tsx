import { describe, it, expect, vi, afterEach } from 'vitest'
import { stubVisualViewport, clearVisualViewport } from './visualViewportStub'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import type { Element as HastElement, Root } from 'hast'
import { useEditor, ReactRenderer } from '@tiptap/react'
import MentionExtension from '@tiptap/extension-mention'
import RichTextEditor from '../components/Card/RichTextEditor'
import ColorSpan from '../components/Card/RichTextColorSpan'
import { COLOR_STYLE_PATTERN } from '../utils/richTextSanitize'

// Tiptap uses ProseMirror which requires a real browser DOM; mock it for unit tests.
// Behavioral tests for the real editor (typing, toolbar marks, markdown
// serialization, and the @mention popup's placement and resize dismissal) live
// in e2e/rich-text-editor.spec.ts (Playwright), where a real DOM is available.
// The mention popup's placement math is also unit-tested via placeFixedElement
// in useAnchoredPlacement.test.ts.
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => null),
  EditorContent: ({ className }: { className?: string }) => (
    <div data-testid="tiptap-editor" className={className} />
  ),
  ReactRenderer: vi.fn(),
}))

// RichTextEditor calls StarterKit.configure({ link: false, underline: false }) to
// keep Tiptap 3's newly-bundled Link and Underline extensions off, so the stub
// needs a configure() rather than a bare object.
vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: vi.fn(() => ({})) },
}))
// Tiptap 3 folded Placeholder into @tiptap/extensions and Color into
// @tiptap/extension-text-style — the standalone extension-placeholder and
// extension-color packages are no longer installed, so mock the new homes.
vi.mock('@tiptap/extensions', () => ({
  Placeholder: { configure: vi.fn(() => ({})) },
}))
vi.mock('@tiptap/extension-text-style', () => ({ TextStyle: {}, Color: {} }))
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
      // title alone is not a reliable accessible name (#1737)
      expect(screen.getByTitle('Edit description')).toHaveAttribute('aria-label', 'Edit description')
    })

    it('does not show pencil icon when readOnly', () => {
      render(<RichTextEditor value="some text" onSave={onSave} readOnly />)
      expect(screen.queryByTitle('Edit description')).not.toBeInTheDocument()
    })

    it('hover-reveal pencil icon includes focus:opacity-100 so keyboard users can reach it', () => {
      render(<RichTextEditor value="some text" onSave={onSave} />)
      const pencil = screen.getByTitle('Edit description')
      // focus:opacity-100 ensures the button is visible and activatable via keyboard Tab
      // even when the mouse is not hovering — critical for keyboard-only users
      expect(pencil.className).toContain('focus:opacity-100')
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

    // #1240 — glyph-only toolbar buttons (B, I, </>, ≡, 1., H, ") must expose an
    // aria-label describing the action, not rely on a bare letter/symbol as the
    // accessible name.
    it('gives every toolbar button an aria-label matching its title', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      for (const title of [
        'Bold (Ctrl+B)',
        'Italic (Ctrl+I)',
        'Inline code',
        'Bullet list',
        'Numbered list',
        'Heading',
        'Blockquote',
      ]) {
        const button = screen.getByTitle(title)
        expect(button).toHaveAttribute('aria-label', title)
      }
    })

    it('defaults aria-pressed to false when no mark is active', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      expect(screen.getByTitle('Bold (Ctrl+B)')).toHaveAttribute('aria-pressed', 'false')
      expect(within(screen.getByTitle('Bold (Ctrl+B)')).queryByTestId('active-underline')).not.toBeInTheDocument()
    })

    it('sets aria-pressed to true on the toolbar button for the active mark', () => {
      // mockReturnValue (not Once): the component calls useEditor() on every
      // render, including the initial isEditing=false mount, so a One-shot
      // value gets consumed before the toolbar (which only renders once
      // isEditing flips true) ever reads it.
      vi.mocked(useEditor).mockReturnValue({
        isActive: (name: string) => name === 'bold',
        getAttributes: () => ({}),
        storage: { markdown: { getMarkdown: () => 'text' } },
        chain: () => ({ focus: () => ({ toggleBold: () => ({ run: () => {} }) }) }),
        commands: { focus: () => {}, setContent: () => {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake editor surface for this one test
      } as any)
      try {
        const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
        fireEvent.click(container.firstChild as Element)
        expect(screen.getByTitle('Bold (Ctrl+B)')).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByTitle('Italic (Ctrl+I)')).toHaveAttribute('aria-pressed', 'false')
        // Non-color active cue (#2188): the underline bar moves with aria-pressed.
        expect(within(screen.getByTitle('Bold (Ctrl+B)')).getByTestId('active-underline')).toBeInTheDocument()
        expect(within(screen.getByTitle('Italic (Ctrl+I)')).queryByTestId('active-underline')).not.toBeInTheDocument()
      } finally {
        // Restore the module-level default so later tests in this file see a
        // null editor again.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mocked module types useEditor as always returning Editor; the real mock returns null
        vi.mocked(useEditor).mockReturnValue(null as any)
      }
    })

    it('gives the text color button an accessible name and marks its glyph decorative', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      const colorButton = screen.getByTitle('Text color')
      expect(colorButton).toHaveAttribute('aria-label', 'Text color')
      expect(colorButton.querySelector('span')).toHaveAttribute('aria-hidden', 'true')
    })

    it('flips aria-expanded on the text color button when the swatch panel opens and closes', () => {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      const colorButton = screen.getByTitle('Text color')
      expect(colorButton).toHaveAttribute('aria-expanded', 'false')

      // The trigger toggles on mousedown (with preventDefault to keep editor
      // focus), not click — see RichTextEditor.tsx's ColorPicker.
      fireEvent.mouseDown(colorButton)
      expect(colorButton).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByTitle('Default')).toBeInTheDocument() // swatch panel open

      fireEvent.mouseDown(colorButton)
      expect(colorButton).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTitle('Default')).not.toBeInTheDocument()
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
  // The component's own pattern, so the test cannot drift from SANITIZE_SCHEMA.
  const COLOR_PATTERN = COLOR_STYLE_PATTERN

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
    const scriptNode: HastElement = {
      type: 'element',
      tagName: 'script',
      properties: {},
      children: [{ type: 'text', value: 'alert(1)' }],
    }
    const result = sanitize({ type: 'root', children: [scriptNode] }, schema as Parameters<typeof sanitize>[1]) as Root
    const tags = result.children.map((n) => ('tagName' in n ? n.tagName : n.type))
    expect(tags).not.toContain('script')
  })

  it('strips event-handler attributes (onerror)', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const imgNode: HastElement = {
      type: 'element',
      tagName: 'img',
      properties: { src: 'x', onerror: 'alert(1)' },
      children: [],
    }
    const result = sanitize({ type: 'root', children: [imgNode] }, schema as Parameters<typeof sanitize>[1]) as Root
    const img = result.children.find((n) => 'tagName' in n && n.tagName === 'img') as HastElement | undefined
    expect(img?.properties?.onerror).toBeUndefined()
  })

  it('preserves <span style="color:#ff0000"> written by the Color extension', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const spanNode: HastElement = {
      type: 'element',
      tagName: 'span',
      properties: { style: 'color:#ff0000' },
      children: [{ type: 'text', value: 'red text' }],
    }
    const result = sanitize({ type: 'root', children: [spanNode] }, schema as Parameters<typeof sanitize>[1]) as Root
    const span = result.children.find((n) => 'tagName' in n && n.tagName === 'span') as HastElement | undefined
    expect(span).toBeDefined()
    expect(span?.properties?.style).toBe('color:#ff0000')
  })

  it('strips <span style> with non-color values (CSS injection)', async () => {
    const { sanitize, defaultSchema } = await import('hast-util-sanitize')
    const schema = buildSchema(defaultSchema as unknown as Record<string, unknown>)
    const spanNode: HastElement = {
      type: 'element',
      tagName: 'span',
      properties: { style: 'background:url(javascript:alert(1))' },
      children: [],
    }
    const result = sanitize({ type: 'root', children: [spanNode] }, schema as Parameters<typeof sanitize>[1]) as Root
    const span = result.children.find((n) => 'tagName' in n && n.tagName === 'span') as HastElement | undefined
    expect(span?.properties?.style).toBeUndefined()
  })
})

describe('RichTextEditor view mode — keyboard path (#1376)', () => {
  it('click-to-edit surface is presentational; the pencil button is the keyboard path', () => {
    const { container } = render(<RichTextEditor value="some text" onSave={vi.fn()} />)
    expect(container.firstChild).toHaveAttribute('role', 'presentation')
    const pencil = screen.getByTitle('Edit description')
    // Focusing the pencil enters edit mode, so Tab alone reaches the editor
    act(() => pencil.focus())
    expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #1371 — editor-interaction coverage. The suites above mock useEditor() to
// return null (a real Tiptap/ProseMirror instance needs a real browser DOM,
// so full editor behavior stays an e2e concern). These tests supply a fake
// non-null editor so the toolbar onClick handlers, Save/Cancel, the onBlur
// save path, and the value-sync effect — all gated on `editor?.` — actually
// run instead of short-circuiting on the optional chain.
// ─────────────────────────────────────────────────────────────────────────

/** Tracks every method call on a Tiptap-style fluent chain(); any method
 * name returns the same tracker so `.focus().toggleBold().run()` chains
 * without needing to hand-list every method tiptap exposes. */
function makeChainTracker() {
  const calls: string[] = []
  const chain: Record<string, (...args: unknown[]) => unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls.push(args.length ? `${prop}(${JSON.stringify(args)})` : prop)
          return chain
        }
      },
    }
  )
  return { chain, calls }
}

function makeFakeEditor(markdown = 'current markdown', textColor = '') {
  const { chain, calls } = makeChainTracker()
  const commands = { focus: vi.fn(), setContent: vi.fn() }
  const editor = {
    isActive: vi.fn(() => false),
    getAttributes: vi.fn(() => (textColor ? { color: textColor } : {})),
    storage: { markdown: { getMarkdown: vi.fn(() => markdown) } },
    chain: vi.fn(() => chain),
    commands,
    state: { selection: { from: 3, to: 7 } },
  }
  return { editor, calls, commands }
}

describe('RichTextEditor toolbar actions (fake non-null editor)', () => {
  // Each test below sets useEditor's mock return value to a fake non-null
  // editor and restores it to null in a `finally` block, so the default
  // null-returning mock other describe blocks in this file depend on is
  // never left clobbered if an assertion throws mid-test.

  it('Bold/Italic/Code/list/heading/blockquote buttons drive the chain', () => {
    const { editor, calls } = makeFakeEditor()
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)

      // ToolbarButton wires its action to onMouseDown (with preventDefault),
      // not onClick, so the editor never loses focus on a toolbar click.
      fireEvent.mouseDown(screen.getByTitle('Bold (Ctrl+B)'))
      expect(calls).toContain('toggleBold')

      fireEvent.mouseDown(screen.getByTitle('Italic (Ctrl+I)'))
      expect(calls).toContain('toggleItalic')

      fireEvent.mouseDown(screen.getByTitle('Inline code'))
      expect(calls).toContain('toggleCode')

      fireEvent.mouseDown(screen.getByTitle('Bullet list'))
      expect(calls).toContain('toggleBulletList')

      fireEvent.mouseDown(screen.getByTitle('Numbered list'))
      expect(calls).toContain('toggleOrderedList')

      fireEvent.mouseDown(screen.getByTitle('Heading'))
      expect(calls).toContain(`toggleHeading(${JSON.stringify([{ level: 2 }])})`)

      fireEvent.mouseDown(screen.getByTitle('Blockquote'))
      expect(calls).toContain('toggleBlockquote')

      // Every click must also chain through focus() and terminate with run()
      expect(calls.filter((c) => c === 'focus').length).toBeGreaterThanOrEqual(7)
      expect(calls.filter((c) => c === 'run').length).toBeGreaterThanOrEqual(7)
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('shows a set text color as a pressed swatch and an underline on the trigger (#2188)', () => {
    const { editor } = makeFakeEditor('current markdown', '#f87171')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)
      const trigger = screen.getByTitle('Text color')
      // Menu trigger, not a toggle: no aria-pressed, but the non-color cue shows.
      expect(trigger).not.toHaveAttribute('aria-pressed')
      expect(within(trigger).getByTestId('active-underline')).toBeInTheDocument()
      fireEvent.mouseDown(trigger)
      const red = screen.getByRole('button', { name: 'Text color Red' })
      expect(red).toHaveAttribute('aria-pressed', 'true')
      expect(red).toHaveClass('ring-fg')
      for (const name of ['Default', 'White', 'Orange', 'Blue']) {
        const other = screen.getByRole('button', { name: `Text color ${name}` })
        expect(other).toHaveAttribute('aria-pressed', 'false')
        expect(other).not.toHaveClass('ring-fg')
      }
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('shows no underline on the text color trigger when no color is set (#2188)', () => {
    const { editor } = makeFakeEditor()
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)
      expect(within(screen.getByTitle('Text color')).queryByTestId('active-underline')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('ColorPicker swatch selection calls setColor, and the Default swatch calls unsetColor', () => {
    const { editor, calls } = makeFakeEditor()
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)

      const colorButton = screen.getByTitle('Text color')
      fireEvent.mouseDown(colorButton)
      fireEvent.mouseDown(screen.getByTitle('Red'))
      expect(calls).toContain(`setColor(${JSON.stringify(['#f87171'])})`)


      fireEvent.mouseDown(colorButton)
      fireEvent.mouseDown(screen.getByTitle('Default'))
      expect(calls).toContain('unsetColor')

      // Selecting a swatch closes the panel
      expect(screen.queryByTitle('Red')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('clicking outside the open color swatch panel closes it', () => {
    const { editor } = makeFakeEditor()
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)

      fireEvent.mouseDown(screen.getByTitle('Text color'))
      expect(screen.getByTitle('Default')).toBeInTheDocument()

      fireEvent.mouseDown(document.body)
      expect(screen.queryByTitle('Default')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('Save button commits the markdown via onSave and exits edit mode', () => {
    const { editor } = makeFakeEditor('saved markdown')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="text" onSave={onSave} showActions />)
      fireEvent.click(container.firstChild as Element)

      fireEvent.mouseDown(screen.getByText('Save'))
      expect(onSave).toHaveBeenCalledWith('saved markdown')
      expect(screen.queryByTestId('tiptap-editor')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('Cancel restores the original value via setContent and does not call onSave', () => {
    const { editor, commands } = makeFakeEditor('unsaved draft markdown')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="original text" onSave={onSave} showActions />)
      fireEvent.click(container.firstChild as Element)

      fireEvent.mouseDown(screen.getByText('Cancel'))
      expect(onSave).not.toHaveBeenCalled()
      expect(commands.setContent).toHaveBeenCalledWith('original text')
      expect(screen.queryByTestId('tiptap-editor')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('Escape while editing cancels edit mode (restores content, does not save)', () => {
    const { editor, commands } = makeFakeEditor('draft markdown')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="committed text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(commands.setContent).toHaveBeenCalledWith('committed text')
      expect(onSave).not.toHaveBeenCalled()
      expect(screen.queryByTestId('tiptap-editor')).not.toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('onBlur saves and exits edit mode when focus leaves the editor container', () => {
    const { editor } = makeFakeEditor('blurred-out markdown')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)

      const optsArg = vi.mocked(useEditor).mock.calls.at(-1)?.[0] as unknown as {
        onBlur: (args: { event: { relatedTarget: Node | null } }) => void
      }
      act(() => {
        optsArg.onBlur({ event: { relatedTarget: document.body } })
      })

      expect(onSave).toHaveBeenCalledWith('blurred-out markdown')
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('onBlur does not save when focus moves to a toolbar/action button inside the container', () => {
    const { editor } = makeFakeEditor('should not save')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      const boldButton = screen.getByTitle('Bold (Ctrl+B)')

      const optsArg = vi.mocked(useEditor).mock.calls.at(-1)?.[0] as unknown as {
        onBlur: (args: { event: { relatedTarget: Node | null } }) => void
      }
      act(() => {
        optsArg.onBlur({ event: { relatedTarget: boldButton } })
      })

      expect(onSave).not.toHaveBeenCalled()
      // Still in edit mode — the editor stays mounted
      expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('onBlur never saves when showActions is true, even if focus leaves the container', () => {
    const { editor } = makeFakeEditor('should not autosave')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const onSave = vi.fn()
      const { container } = render(<RichTextEditor value="text" onSave={onSave} showActions />)
      fireEvent.click(container.firstChild as Element)

      const optsArg = vi.mocked(useEditor).mock.calls.at(-1)?.[0] as unknown as {
        onBlur: (args: { event: { relatedTarget: Node | null } }) => void
      }
      act(() => {
        optsArg.onBlur({ event: { relatedTarget: document.body } })
      })

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('tiptap-editor')).toBeInTheDocument()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('syncs editor content when the value prop changes externally while not editing', () => {
    const { editor, commands } = makeFakeEditor('old value')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { rerender } = render(<RichTextEditor value="old value" onSave={vi.fn()} />)
      rerender(<RichTextEditor value="new external value" onSave={vi.fn()} />)
      expect(commands.setContent).toHaveBeenCalledWith('new external value')
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('does not resync editor content from the value prop while actively editing', () => {
    const { editor, commands } = makeFakeEditor('old value')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container, rerender } = render(<RichTextEditor value="old value" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element) // enter edit mode
      commands.setContent.mockClear()

      rerender(<RichTextEditor value="externally changed while editing" onSave={vi.fn()} />)
      expect(commands.setContent).not.toHaveBeenCalled()
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })

  it('focuses the editor at the end of the content when entering edit mode', () => {
    const { editor, commands } = makeFakeEditor()
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    vi.useFakeTimers()
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)
      vi.runAllTimers()
      expect(commands.focus).toHaveBeenCalledWith('end')
    } finally {
      vi.useRealTimers()
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })
})

// The suggestion `render()` lifecycle (#1457) driven directly with fake Tiptap
// props: jsdom can't run ProseMirror, so the real typing path stays in
// e2e/rich-text-editor.spec.ts. This pins the wiring — listeners attached and
// removed, placement from the live caret rect, resize ending the suggestion
// through the plugin key, Escape consumed — that the e2e only proves end-to-end.
describe('RichTextEditor mention popup lifecycle (#1457)', () => {
  type Rect = () => DOMRect | null
  interface SuggestionRenderer {
    onStart: (props: { editor: unknown; clientRect?: Rect | null }) => void
    onUpdate: (props: { clientRect?: Rect | null }) => void
    onKeyDown: (props: { event: KeyboardEvent }) => boolean
    onExit: () => void
  }

  const rect = (top: number): DOMRect =>
    ({ top, bottom: top + 20, left: 30, right: 130, width: 100, height: 20, x: 30, y: top, toJSON: () => ({}) }) as DOMRect

  function setup() {
    const listKeyDown = vi.fn(() => false)
    const component = {
      element: document.createElement('div'),
      updateProps: vi.fn(),
      destroy: vi.fn(),
      ref: { onKeyDown: listKeyDown },
    }
    // ReactRenderer is constructed with `new`, so the stub must be a function.
    vi.mocked(ReactRenderer).mockImplementation(function () { return component } as never)
    let observe: (() => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observe = cb }
      observe() {}
      disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)

    render(<RichTextEditor value="text" onSave={vi.fn()} members={[]} />)
    const configure = vi.mocked(MentionExtension.extend).mock.results[0].value.configure as ReturnType<typeof vi.fn>
    const { suggestion } = configure.mock.calls.at(-1)?.[0] as { suggestion: { render: () => SuggestionRenderer } }

    const dispatch = vi.fn()
    const setMeta = vi.fn(() => 'exit-tr')
    const dom = document.createElement('div')
    dom.setAttribute('role', 'textbox')
    const editor = { isDestroyed: false, view: { dispatch, dom }, state: { tr: { setMeta } } }
    return { dom, renderer: suggestion.render(), component, editor, dispatch, setMeta, disconnect, listKeyDown, fireObserver: () => observe?.() }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.querySelectorAll('[data-testid="mention-popup"]').forEach((el) => el.remove())
  })

  // #2163 — the mention list is anchored to the caret in a text input, so a
  // list that fits neither side takes the larger one, capped and scrollable.
  it('caps the popup to the larger side instead of pinning over the caret', () => {
    const { renderer, editor } = setup()
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700)
    renderer.onStart({ editor, clientRect: () => rect(380) })
    const popup = document.querySelector<HTMLElement>('[data-testid="mention-popup"]')!
    expect(popup.style.overflowY).toBe('auto')
    expect(popup.style.top).toBe('8px')
    expect(popup.style.maxHeight).toBe('368px')
  })

  it('caps the popup to the visible viewport when the keyboard shrinks it (#2163)', () => {
    // 400 visible, caret 100-120: 400 - 8 - 124 = 268 below beats 88 above; the 768px window would allow 636.
    stubVisualViewport({ height: 400 })
    try {
      const { renderer, editor } = setup()
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700)
      renderer.onStart({ editor, clientRect: () => rect(100) })
      const popup = document.querySelector<HTMLElement>('[data-testid="mention-popup"]')!
      expect(popup.style.top).toBe('124px')
      expect(popup.style.maxHeight).toBe('268px')
    } finally {
      clearVisualViewport()
    }
  })

  it('places the popup below the caret, re-anchors on outside scroll, and cleans up on exit', () => {
    const { renderer, component, editor, disconnect, fireObserver } = setup()
    let caret: DOMRect | null = rect(100)
    renderer.onStart({ editor, clientRect: () => caret })

    const popup = document.querySelector<HTMLElement>('[data-testid="mention-popup"]')!
    expect(popup.contains(component.element)).toBe(true)
    expect(popup.style.position).toBe('fixed')
    expect(popup.style.top).toBe('124px')
    expect(popup.style.left).toBe('30px')
    expect(popup.style.visibility).toBe('')

    // A scroll outside the popup re-places it at the live caret.
    caret = rect(200)
    fireEvent.scroll(window)
    expect(popup.style.top).toBe('224px')
    // A scroll inside the popup (its own list) is ignored.
    caret = rect(300)
    fireEvent.scroll(component.element)
    expect(popup.style.top).toBe('224px')
    // A size change of the list re-places it too.
    fireObserver()
    expect(popup.style.top).toBe('324px')

    // onUpdate adopts the new clientRect and re-places.
    renderer.onUpdate({ clientRect: () => rect(50) })
    expect(component.updateProps).toHaveBeenCalled()
    expect(popup.style.top).toBe('74px')

    renderer.onExit()
    expect(disconnect).toHaveBeenCalled()
    expect(component.destroy).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="mention-popup"]')).toBeNull()
    // Listeners are gone: a later scroll does nothing.
    caret = rect(400)
    expect(() => fireEvent.scroll(window)).not.toThrow()
  })

  it('re-anchors (never ends the suggestion) on visualViewport changes, and unsubscribes on exit (#2138)', () => {
    const vv = Object.assign(new EventTarget(), { height: 768, offsetTop: 0 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    try {
      const { renderer, editor, dispatch } = setup()
      let caret: DOMRect | null = rect(500)
      renderer.onStart({ editor, clientRect: () => caret })
      const popup = document.querySelector<HTMLElement>('[data-testid="mention-popup"]')!
      expect(popup.style.top).toBe('524px')
      // Keyboard opens: 40px popup no longer fits below 520, so it goes above the caret.
      vv.height = 400
      vv.dispatchEvent(new Event('resize'))
      expect(popup.style.top).toBe('456px')
      expect(dispatch).not.toHaveBeenCalled()
      // No caret rect: nothing to place against, leaves the popup as it was.
      caret = null
      vv.dispatchEvent(new Event('scroll'))
      expect(popup.style.top).toBe('456px')
      renderer.onExit()
      caret = rect(100)
      vv.dispatchEvent(new Event('scroll'))
      expect(popup.style.top).toBe('456px')
    } finally {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    }
  })

  it('starts hidden when the caret rect is not available yet', () => {
    const { renderer, editor } = setup()
    renderer.onStart({ editor, clientRect: () => null })
    const popup = document.querySelector<HTMLElement>('[data-testid="mention-popup"]')!
    expect(popup.style.visibility).toBe('hidden')
    renderer.onUpdate({ clientRect: null })
    expect(popup.style.visibility).toBe('hidden')
    renderer.onExit()
  })

  it('ends the suggestion through its plugin key on window resize, unless the editor is gone', () => {
    const { renderer, editor, dispatch, setMeta } = setup()
    renderer.onStart({ editor, clientRect: () => rect(100) })

    fireEvent(window, new Event('resize'))
    expect(setMeta).toHaveBeenCalledWith(expect.anything(), { exit: true })
    expect(dispatch).toHaveBeenCalledWith('exit-tr')

    dispatch.mockClear()
    editor.isDestroyed = true
    fireEvent(window, new Event('resize'))
    expect(dispatch).not.toHaveBeenCalled()
    renderer.onExit()
  })

  it('consumes Escape and forwards other keys to the list', () => {
    const { renderer, editor, listKeyDown } = setup()
    renderer.onStart({ editor, clientRect: () => rect(100) })

    expect(renderer.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Escape' }) })).toBe(true)
    expect(document.querySelector('[data-testid="mention-popup"]')).toBeNull()
    expect(listKeyDown).not.toHaveBeenCalled()

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown' })
    renderer.onKeyDown({ event: down })
    expect(listKeyDown).toHaveBeenCalledWith({ event: down })
    renderer.onExit()
  })
})

describe('RichTextEditor mention combobox attributes (#2149)', () => {
  // Reuses the lifecycle harness shape: fake suggestion props, no ProseMirror.
  function start(extra: Record<string, string> = {}) {
    const component = { element: document.createElement('div'), updateProps: vi.fn(), destroy: vi.fn(), ref: { onKeyDown: vi.fn(() => false) } }
    vi.mocked(ReactRenderer).mockImplementation(function () { return component } as never)
    render(<RichTextEditor value="text" onSave={vi.fn()} members={[]} />)
    const configure = vi.mocked(MentionExtension.extend).mock.results[0].value.configure as ReturnType<typeof vi.fn>
    const { suggestion } = configure.mock.calls.at(-1)?.[0] as { suggestion: { render: () => { onStart: (p: unknown) => void; onExit: () => void; onKeyDown: (p: { event: KeyboardEvent }) => boolean } } }
    const dom = document.createElement('div')
    dom.setAttribute('role', 'textbox')
    for (const [k, v] of Object.entries(extra)) dom.setAttribute(k, v)
    const dispatch = vi.fn()
    const editor = { isDestroyed: false, view: { dispatch, dom }, state: { tr: { setMeta: vi.fn() } } }
    const renderer = suggestion.render()
    renderer.onStart({ editor, clientRect: () => null })
    const props = vi.mocked(ReactRenderer).mock.calls.at(-1)![1] as unknown as { props: { onActiveChange: (s: { listboxId: string; activeId: string } | null) => void } }
    return { dom, renderer, onActive: props.props.onActiveChange, dispatch }
  }
  afterEach(() => {
    vi.restoreAllMocks()
    document.querySelectorAll('[data-testid="mention-popup"]').forEach((el) => el.remove())
  })

  it('makes the editor a combobox pointing at the listbox and active option, then restores it on exit', () => {
    const { dom, renderer, onActive } = start()
    expect(dom).toHaveAttribute('role', 'combobox')
    expect(dom).toHaveAttribute('aria-haspopup', 'listbox')
    expect(dom).toHaveAttribute('aria-autocomplete', 'list')
    expect(dom).not.toHaveAttribute('aria-multiline')
    expect(dom).toHaveAttribute('aria-label', 'Add a description…')
    expect(dom).toHaveAttribute('aria-expanded', 'false')
    expect(dom).not.toHaveAttribute('aria-controls')

    onActive({ listboxId: 'lb', activeId: 'lb-option-0' })
    expect(dom).toHaveAttribute('aria-expanded', 'true')
    expect(dom).toHaveAttribute('aria-controls', 'lb')
    expect(dom).toHaveAttribute('aria-activedescendant', 'lb-option-0')

    onActive({ listboxId: 'lb', activeId: 'lb-option-1' })
    expect(dom).toHaveAttribute('aria-activedescendant', 'lb-option-1')

    // An empty list drops the references to the now-missing listbox.
    onActive(null)
    expect(dom).toHaveAttribute('aria-expanded', 'false')
    expect(dom).not.toHaveAttribute('aria-controls')
    expect(dom).not.toHaveAttribute('aria-activedescendant')

    onActive({ listboxId: 'lb', activeId: 'lb-option-0' })
    renderer.onExit()
    for (const a of ['aria-expanded', 'aria-haspopup', 'aria-autocomplete', 'aria-controls', 'aria-activedescendant', 'aria-label']) {
      expect(dom).not.toHaveAttribute(a)
    }
    expect(dom).toHaveAttribute('role', 'textbox')
    // A late report after exit does not resurrect the attributes.
    onActive({ listboxId: 'lb', activeId: 'lb-option-0' })
    expect(dom).toHaveAttribute('role', 'textbox')
  })

  it('removes the attributes on Escape', () => {
    const { dom, renderer, onActive } = start()
    onActive({ listboxId: 'lb', activeId: 'lb-option-0' })
    renderer.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Escape' }) })
    expect(dom).toHaveAttribute('role', 'textbox')
    expect(dom).not.toHaveAttribute('aria-activedescendant')
    renderer.onExit()
  })

  it('restores a pre-existing aria-label rather than clobbering it', () => {
    const { dom, renderer } = start({ 'aria-label': 'Card description' })
    expect(dom).toHaveAttribute('aria-label', 'Card description')
    renderer.onExit()
    expect(dom).toHaveAttribute('aria-label', 'Card description')
  })

  it('ends the suggestion when the editor blurs', () => {
    const { dom, dispatch } = start()
    fireEvent.blur(dom)
    expect(dispatch).toHaveBeenCalled()
  })
})

describe('RichTextEditor text color swatches (#1893)', () => {
  it('marks the current color pressed with the themed ring, never border-white', () => {
    const { editor } = makeFakeEditor('current markdown', '#f87171')
    vi.mocked(useEditor).mockReturnValue(editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={vi.fn()} />)
      fireEvent.click(container.firstChild as Element)
      fireEvent.mouseDown(screen.getByTitle('Text color'))
      const red = screen.getByRole('button', { name: 'Text color Red' })
      expect(red).toHaveAttribute('aria-pressed', 'true')
      expect(red.className).toContain('border-fg')
      expect(red.className).toContain('ring-fg')
      expect(red.className).toContain('ring-offset-2')
      expect(red.className).not.toContain('border-white')
      const blue = screen.getByRole('button', { name: 'Text color Blue' })
      expect(blue).toHaveAttribute('aria-pressed', 'false')
      expect(blue.className).not.toContain('ring-fg')
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  })
})

describe('RichTextEditor exits keep focus in the enclosing dialog (#2182)', () => {
  const onSave = vi.fn()
  function setup(showActions = true) {
    onSave.mockClear()
    const utils = render(
      <div role="dialog" tabIndex={-1} aria-label="Card">
        <RichTextEditor value="text" onSave={onSave} showActions={showActions} />
      </div>,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.click(utils.container.querySelector('[role="presentation"]') as Element)
    return dialog
  }

  it('Escape leaves focus on the dialog, not the body', () => {
    const dialog = setup()
    expect(screen.getByText('Save')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Save')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(dialog)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Cancel from the keyboard (click with detail 0) leaves focus on the dialog', () => {
    const dialog = setup()
    fireEvent.click(screen.getByText('Cancel'), { detail: 0 })
    expect(screen.queryByText('Save')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(dialog)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Save from the keyboard saves once and leaves focus on the dialog', () => {
    const dialog = setup()
    fireEvent.click(screen.getByText('Save'), { detail: 0 })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(dialog)
  })

  it('a mouse-detail click on Save never saves (mousedown owns it)', () => {
    setup()
    fireEvent.click(screen.getByText('Save'), { detail: 1 })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a mouse-detail click on Cancel never runs the cancel path', () => {
    setup()
    fireEvent.click(screen.getByText('Cancel'), { detail: 1 })
    expect(screen.getByText('Save')).toBeInTheDocument()
  })

  it('a mouse press on Save saves exactly once', () => {
    setup()
    fireEvent.mouseDown(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a mouse click on Cancel acts on mousedown only', () => {
    const dialog = setup()
    const cancel = screen.getByText('Cancel')
    fireEvent.mouseDown(cancel)
    expect(screen.queryByText('Save')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(dialog)
    expect(onSave).not.toHaveBeenCalled()
  })

  type BlurOpts = { onBlur: (args: { event: { relatedTarget: Node | null } }) => void }
  const lastBlur = () =>
    (vi.mocked(useEditor).mock.calls.at(-1)?.[0] as unknown as BlurOpts).onBlur

  it('Escape without actions does not blur-save (exiting guard)', () => {
    setup(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    act(() => lastBlur()({ event: { relatedTarget: document.body } }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('without actions, click-away blur saves', () => {
    setup(false)
    act(() => lastBlur()({ event: { relatedTarget: document.body } }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})

describe('RichTextEditor custom text color (#2097)', () => {
  const withEditor = (textColor: string, run: (h: ReturnType<typeof makeFakeEditor> & { onSave: ReturnType<typeof vi.fn> }) => void) => {
    const h = makeFakeEditor('current markdown', textColor)
    const onSave = vi.fn()
    vi.mocked(useEditor).mockReturnValue(h.editor as unknown as ReturnType<typeof useEditor>)
    try {
      const { container } = render(<RichTextEditor value="text" onSave={onSave} />)
      fireEvent.click(container.firstChild as Element)
      run({ ...h, onSave })
    } finally {
      vi.mocked(useEditor).mockReturnValue(null as unknown as ReturnType<typeof useEditor>)
    }
  }
  const openPanel = () => {
    fireEvent.mouseDown(screen.getByTitle('Text color'))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Text color Custom' }))
  }

  it('adds a 10th Custom swatch that is unpressed for a preset color', () => {
    withEditor('#f87171', () => {
      fireEvent.mouseDown(screen.getByTitle('Text color'))
      const swatches = screen.getAllByRole('button', { name: /^Text color / }).filter((b) => b.getAttribute('title') !== 'Text color')
      expect(swatches).toHaveLength(10)
      expect(screen.getByRole('button', { name: 'Text color Custom' })).toHaveAttribute('aria-pressed', 'false')
    })
  })

  it('compares preset colors case-insensitively', () => {
    withEditor('#F87171', () => {
      fireEvent.mouseDown(screen.getByTitle('Text color'))
      expect(screen.getByRole('button', { name: 'Text color Red' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'Text color Custom' })).toHaveAttribute('aria-pressed', 'false')
    })
  })

  it('rings the Custom swatch for a non-preset color', () => {
    withEditor('#123ABC', () => {
      fireEvent.mouseDown(screen.getByTitle('Text color'))
      const custom = screen.getByRole('button', { name: 'Text color Custom' })
      expect(custom).toHaveAttribute('aria-pressed', 'true')
      expect(custom.className).toContain('ring-fg')
    })
  })

  it('opens the trigger and selects a preset from the keyboard (click with detail 0)', () => {
    withEditor('', ({ calls }) => {
      const trigger = screen.getByTitle('Text color')
      fireEvent.click(trigger, { detail: 0 })
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByTitle('Red'), { detail: 0 })
      expect(calls).toContain(`setColor(${JSON.stringify(['#f87171'])})`)
      expect(screen.queryByTitle('Red')).not.toBeInTheDocument()
    })
  })

  it('ignores the click that follows a mouse press (detail > 0), so nothing runs twice', () => {
    withEditor('', ({ calls }) => {
      const trigger = screen.getByTitle('Text color')
      fireEvent.mouseDown(trigger)
      fireEvent.click(trigger, { detail: 1 })
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByTitle('Red'), { detail: 1 })
      expect(calls.filter((c) => c.startsWith('setColor'))).toHaveLength(0)
    })
  })

  it('opens the custom panel inside the editor container, marked as a dismiss layer', () => {
    withEditor('', () => {
      openPanel()
      const panel = screen.getByRole('group', { name: 'Color value' })
      const layer = panel.closest('[data-dismiss-layer]')
      expect(layer).not.toBeNull()
      expect(layer?.className).toContain('w-max')
      // No portal: the layer lives under the same container as the toolbar.
      expect(layer?.closest('.flex.flex-col')).toContainElement(screen.getByTitle('Bold (Ctrl+B)'))
    })
  })

  it('Apply re-applies the range captured on open, then sets the color', () => {
    withEditor('', ({ calls }) => {
      openPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const sel = calls.indexOf(`setTextSelection(${JSON.stringify([{ from: 3, to: 7 }])})`)
      const set = calls.indexOf(`setColor(${JSON.stringify(['#60A5FA'])})`)
      expect(sel).toBeGreaterThanOrEqual(0)
      expect(set).toBeGreaterThan(sel)
      expect(screen.queryByRole('group', { name: 'Color value' })).not.toBeInTheDocument()
    })
  })

  it('Cancel restores the selection without coloring', () => {
    withEditor('', ({ calls }) => {
      openPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(calls).toContain(`setTextSelection(${JSON.stringify([{ from: 3, to: 7 }])})`)
      expect(calls.filter((c) => c.startsWith('setColor'))).toHaveLength(0)
      expect(screen.queryByRole('group', { name: 'Color value' })).not.toBeInTheDocument()
    })
  })

  it('Escape closes the custom panel, restores the selection and stays in edit mode', () => {
    withEditor('', ({ calls }) => {
      openPanel()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('group', { name: 'Color value' })).not.toBeInTheDocument()
      expect(calls).toContain(`setTextSelection(${JSON.stringify([{ from: 3, to: 7 }])})`)
      expect(screen.getByTitle('Bold (Ctrl+B)')).toBeInTheDocument()
    })
  })

  it('a press outside the editor discards the draft and runs the blur-save', () => {
    withEditor('', ({ calls, onSave }) => {
      openPanel()
      fireEvent.mouseDown(document.body)
      expect(calls.filter((c) => c.startsWith('setColor'))).toHaveLength(0)
      expect(onSave).toHaveBeenCalledWith('current markdown')
      expect(screen.queryByTitle('Bold (Ctrl+B)')).not.toBeInTheDocument()
    })
  })

  it('a press on the panel padding is default-prevented so the editor does not blur', () => {
    withEditor('', ({ onSave }) => {
      openPanel()
      const layer = screen.getByRole('group', { name: 'Color value' }).closest('[data-dismiss-layer]') as HTMLElement
      const notPrevented = fireEvent.mouseDown(layer)
      expect(notPrevented).toBe(false)
      expect(screen.getByRole('group', { name: 'Color value' })).toBeInTheDocument()
      expect(onSave).not.toHaveBeenCalled()
      // A control keeps its own focus behavior.
      expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Apply' }))).toBe(true)
    })
  })
})

describe('RichTextEditor view-mode color span (#2097)', () => {
  it('emits per-theme custom properties for a hex color', () => {
    render(<ColorSpan style={{ color: '#f1f5f9' }}>white</ColorSpan>)
    const span = screen.getByText('white')
    expect(span.className).toContain('rt-color')
    expect(span.style.getPropertyValue('--rt-fg-dark')).toBe('#F1F5F9')
    // White is 1.1:1 on a light surface: the light-theme value must be darkened.
    expect(span.style.getPropertyValue('--rt-fg-light')).not.toBe('#F1F5F9')
  })

  it('accepts a style string and a 3-digit hex', () => {
    render(<ColorSpan style={'color: #fff' as unknown as React.CSSProperties}>short</ColorSpan>)
    expect(screen.getByText('short').className).toContain('rt-color')
  })

  it('renders the raw span for a named color or a 4-digit hex', () => {
    render(<><ColorSpan style={{ color: 'red' }}>named</ColorSpan><ColorSpan style={{ color: '#abcd' }}>four</ColorSpan></>)
    for (const t of ['named', 'four']) {
      const span = screen.getByText(t)
      expect(span.className).not.toContain('rt-color')
      expect(span.style.color).not.toBe('')
    }
  })
})

describe('COLOR_STYLE_PATTERN (#2097)', () => {
  it.each([
    'color:#ff0000',
    'color: #FFF',
    'color: red',
    'color: rgb(18, 52, 86);',
    'color:rgb(1,2,3)',
  ])('admits %s', (v) => expect(COLOR_STYLE_PATTERN.test(v)).toBe(true))

  it.each([
    'color: rgb(1, 2, 3, 0.5)',
    'color: rgba(1, 2, 3, 1)',
    'color: rgb(var(--x), 2, 3)',
    'color: url(javascript:alert(1))',
    'color: red; background: url(x)',
    'color: rgb(1, 2, 3); position: fixed',
    'color: #12',
    'color: expression(alert(1))',
  ])('rejects %s', (v) => expect(COLOR_STYLE_PATTERN.test(v)).toBe(false))
})
