import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import LensToolbar from '../components/Board/Lens/LensToolbar'
import type { LensConnection } from '../types'

const conn = {
  id: 1,
  provider: 'gitlab',
  repo_slug: 'a/b',
  column_dim: 'status',
  swimlane_dim: 'milestone',
  created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
  created_at: '',
  updated_at: '',
} as unknown as LensConnection

function setup(opts: { url?: string; cardLayout?: 'compact' | 'expanded'; showFilters?: boolean } = {}) {
  const onToggleLayout = vi.fn()
  const onToggleFilters = vi.fn()
  const { container } = render(
    <MemoryRouter initialEntries={[opts.url ?? '/']}>
      <LensToolbar
        connection={conn}
        cardLayout={opts.cardLayout ?? 'expanded'}
        onToggleLayout={onToggleLayout}
        showFilters={opts.showFilters ?? false}
        onToggleFilters={onToggleFilters}
      />
    </MemoryRouter>,
  )
  return { onToggleLayout, onToggleFilters, container }
}

describe('LensToolbar', () => {
  it('renders pivot dropdowns + Filters + layout toggle', () => {
    setup()
    expect(screen.getByText('Columns: Status')).toBeInTheDocument()
    expect(screen.getByText('Swimlanes: Milestone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })

  it('Filters button calls onToggleFilters', async () => {
    const user = userEvent.setup()
    const { onToggleFilters } = setup()
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    expect(onToggleFilters).toHaveBeenCalled()
  })

  it('shows the active-filter count from the URL', () => {
    setup({ url: '/?state=open&milestone=0.3' })
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument()
  })

  it('marks the active layout toggle with the underline cue, not tint alone (#2188)', () => {
    setup()
    const filters = screen.getByRole('button', { name: 'Filters' })
    const layout = screen.getByRole('button', { name: 'Switch to compact card layout' })
    expect(filters).toHaveAttribute('aria-pressed', 'false')
    expect(layout).toHaveAttribute('aria-pressed', 'false')
    expect(within(layout).queryByTestId('active-underline')).not.toBeInTheDocument()
  })

  it('shows the underline cue on the layout toggle while compact, and none on the labeled Filters button (#2188)', () => {
    setup({ showFilters: true, cardLayout: 'compact' })
    const filters = screen.getByRole('button', { name: 'Filters' })
    const layout = screen.getByRole('button', { name: 'Switch to expanded card layout' })
    expect(filters).toHaveAttribute('aria-pressed', 'true')
    expect(within(filters).queryByTestId('active-underline')).not.toBeInTheDocument()
    expect(layout).toHaveAttribute('aria-pressed', 'true')
    expect(within(layout).getByTestId('active-underline')).toBeInTheDocument()
  })

  it('keeps a filled, readable count badge on Filters while the filter row is open (#2302)', () => {
    setup({ url: '/?state=open&milestone=0.3', showFilters: true })
    const badge = within(screen.getByRole('button', { name: 'Filters, 2 active' })).getByText('2')
    expect(badge).toBeVisible()
    expect(badge).toHaveClass('bg-primary', 'text-on-primary')
  })

  it('layout toggle reflects cardLayout and toggles', async () => {
    const user = userEvent.setup()
    const { onToggleLayout } = setup({ cardLayout: 'compact' })
    const btn = screen.getByRole('button', { name: 'Switch to expanded card layout' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveClass('bg-primary-emphasis/10')
    await user.click(btn)
    expect(onToggleLayout).toHaveBeenCalled()
  })

  it('Collapse menu menuitems carry a visible keyboard-focus ring (#1234)', async () => {
    // Roving-tabindex menuitems are real tab stops; `focus:bg-surface-hover`
    // alone is invisible to a keyboard user who arrowed onto an item without
    // touching the mouse.
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'Collapse menu' }))
    expect(screen.getByRole('menuitem', { name: 'Hide all swimlanes' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    expect(screen.getByRole('menuitem', { name: 'Show all swimlanes' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
  })

  describe('wrapping row, no fold (#2302)', () => {
    it('keeps every control inline: layout toggle, Filters, Collapse and both pivots, no kebab', () => {
      setup()
      expect(screen.getByRole('button', { name: /card layout/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Collapse menu' })).toBeInTheDocument()
      expect(screen.getByText('Columns: Status')).toBeInTheDocument()
      expect(screen.getByText('Swimlanes: Milestone')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Lens actions' })).not.toBeInTheDocument()
    })

    it('wraps instead of scrolling and has no vertical dividers', () => {
      const { container } = setup()
      const row = screen.getByTestId('lens-toolbar')
      expect(row).toHaveClass('flex-wrap')
      expect(row.className).not.toMatch(/overflow-x-auto|min-w-max/)
      expect(container.querySelector('.w-px')).toBeNull()
    })

    it('uses the board toolbar button style (h-9, bordered)', () => {
      setup()
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveClass('h-9', 'border')
      expect(screen.getByRole('button', { name: /card layout/i })).toHaveClass('h-9', 'border')
      const collapse = screen.getByRole('button', { name: 'Hide all swimlanes' })
      expect(collapse.parentElement).toHaveClass('h-9', 'border', 'border-line-strong')
      expect(collapse).toHaveClass('text-sm', 'px-3')
    })

    it('Collapse primary hides all lanes via the URL sentinel, then offers Expand', async () => {
      const user = userEvent.setup()
      setup()
      await user.click(screen.getByRole('button', { name: 'Hide all swimlanes' }))
      expect(screen.getByRole('button', { name: 'Show all swimlanes' })).toBeInTheDocument()
    })

    it('Show all swimlanes clears the collapse sentinel; the menu items and pivot options work', async () => {
      const user = userEvent.setup()
      setup({ url: '/?lens_collapsed=*' })
      await user.click(screen.getByRole('button', { name: 'Show all swimlanes' }))
      expect(screen.getByRole('button', { name: 'Hide all swimlanes' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Collapse menu' }))
      await user.click(screen.getByRole('menuitem', { name: 'Hide all swimlanes' }))
      expect(screen.getByRole('button', { name: 'Show all swimlanes' })).toBeInTheDocument()
    })

    it('choosing pivots writes them and shows the custom note', async () => {
      const user = userEvent.setup()
      setup()
      await user.click(screen.getByText('Columns: Status'))
      await user.click(screen.getByText('Columns: State (open/closed)'))
      await user.click(screen.getByText('Swimlanes: Milestone'))
      await user.click(screen.getByText('Swimlanes: Label'))
      expect(screen.getByText(/Viewing a custom pivot/)).toBeInTheDocument()
    })

    it('shows the custom pivot note with a working Reset', async () => {
      const user = userEvent.setup()
      setup({ url: '/?column_dim=state' })
      expect(screen.getByText(/Viewing a custom pivot/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.queryByText(/Viewing a custom pivot/)).not.toBeInTheDocument()
    })

    it('advertises the keyboard shortcuts the native controls have', () => {
      setup()
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-keyshortcuts', 'f')
      expect(screen.getByRole('button', { name: /card layout/i })).toHaveAttribute('aria-keyshortcuts')
    })
  })

  // #1161 — the tab group is `overflow-x-auto`, which can clip an in-flow dropdown menu. Both pivot dropdowns must opt into `portalMenu`
  // (#1147) so their menus render outside that clipping subtree.
  describe('pivot dropdown portal (#1161)', () => {
    it('renders the Columns pivot menu outside the toolbar subtree', async () => {
      const user = userEvent.setup()
      const { container } = setup()
      await user.click(screen.getByText('Columns: Status'))
      const menu = screen.getByRole('menu')
      expect(container.contains(menu)).toBe(false)
      expect((menu as HTMLElement).style.position).toBe('fixed')
    })

    it('renders the Swimlanes pivot menu outside the toolbar subtree', async () => {
      const user = userEvent.setup()
      const { container } = setup()
      await user.click(screen.getByText('Swimlanes: Milestone'))
      const menu = screen.getByRole('menu')
      expect(container.contains(menu)).toBe(false)
      expect((menu as HTMLElement).style.position).toBe('fixed')
    })
  })
})
