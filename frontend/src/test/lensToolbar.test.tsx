import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import LensToolbar from '../components/Board/Lens/LensToolbar'
import type { LensConnection } from '../types'

// Row-2 parity (#1064) includes the native board's responsive fold: below `lg`
// the low-frequency controls move into a kebab instead of pushing the row into a
// horizontal scroll. The viewport hook is mocked so both breakpoints are testable.
const mockIsLarge = vi.fn(() => true)
vi.mock('../hooks/useIsLargeViewport', () => ({
  useIsLargeViewport: () => mockIsLarge(),
}))

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
  render(
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
  return { onToggleLayout, onToggleFilters }
}

describe('LensToolbar', () => {
  beforeEach(() => mockIsLarge.mockReturnValue(true))
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

  it('layout toggle reflects cardLayout and toggles', async () => {
    const user = userEvent.setup()
    const { onToggleLayout } = setup({ cardLayout: 'compact' })
    const btn = screen.getByRole('button', { name: 'Switch to expanded card layout' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    await user.click(btn)
    expect(onToggleLayout).toHaveBeenCalled()
  })

  describe('responsive fold (#1064 parity)', () => {
    it('shows the layout toggle inline and no kebab at lg and above', () => {
      setup()
      expect(screen.getByRole('button', { name: /card layout/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Lens actions' })).not.toBeInTheDocument()
    })

    it('folds the layout toggle into a Lens actions kebab below lg', () => {
      mockIsLarge.mockReturnValue(false)
      setup()
      expect(screen.queryByRole('button', { name: /card layout/i })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Lens actions' })).toBeInTheDocument()
    })

    it('keeps the pivot dropdowns and Filters inline when folded', () => {
      // Only the low-frequency control folds. The pivots are the lens's primary
      // controls and Filters mirrors the native board, which also keeps it inline.
      mockIsLarge.mockReturnValue(false)
      setup()
      expect(screen.getByText('Columns: Status')).toBeInTheDocument()
      expect(screen.getByText('Swimlanes: Milestone')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    })

    it('the folded layout item toggles the layout', async () => {
      const user = userEvent.setup()
      mockIsLarge.mockReturnValue(false)
      const { onToggleLayout } = setup()
      await user.click(screen.getByRole('button', { name: 'Lens actions' }))
      await user.click(screen.getByText(/^Layout:/))
      expect(onToggleLayout).toHaveBeenCalledTimes(1)
    })

    it('advertises the keyboard shortcuts the native controls have', () => {
      setup()
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-keyshortcuts', 'f')
      expect(screen.getByRole('button', { name: /card layout/i })).toHaveAttribute('aria-keyshortcuts')
    })
  })
})
