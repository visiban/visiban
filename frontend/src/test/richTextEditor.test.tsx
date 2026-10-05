import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { Element as HastElement, Root } from 'hast'
import { useEditor, ReactRenderer } from '@tiptap/react'
import MentionExtension from '@tiptap/extension-mention'
import RichTextEditor from '../components/Card/RichTextEditor'

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

function makeFakeEditor(markdown = 'current markdown') {
  const { chain, calls } = makeChainTracker()
  const commands = { focus: vi.fn(), setContent: vi.fn() }
  const editor = {
    isActive: vi.fn(() => false),
    getAttributes: vi.fn(() => ({})),
    storage: { markdown: { getMarkdown: vi.fn(() => markdown) } },
    chain: vi.fn(() => chain),
    commands,
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
    const editor = { isDestroyed: false, view: { dispatch }, state: { tr: { setMeta } } }
    return { renderer: suggestion.render(), component, editor, dispatch, setMeta, disconnect, listKeyDown, fireObserver: () => observe?.() }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.querySelectorAll('[data-testid="mention-popup"]').forEach((el) => el.remove())
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
