import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
