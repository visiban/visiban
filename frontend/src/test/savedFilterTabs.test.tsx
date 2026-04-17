import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SavedFilterTabs from '../components/Board/SavedFilterTabs'
import type { SavedFilter } from '../types'

function makeSavedFilter(id: number, name: string): SavedFilter {
  return {
    id,
    name,
    state_json: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null },
    state_version: 1,
    created_at: '2026-03-25T10:00:00Z',
  }
}

const filterA = makeSavedFilter(1, 'My open bugs')
const filterB = makeSavedFilter(2, 'Blocked cards')

function defaultProps(overrides?: Partial<Parameters<typeof SavedFilterTabs>[0]>) {
  return {
    savedFilters: [filterA, filterB],
    activeFilterId: null,
    onLoad: vi.fn(),
    onClearAll: vi.fn(),
    onSaveCurrentClick: vi.fn(),
    hasActiveFilters: false,
    ...overrides,
  }
}

describe('SavedFilterTabs', () => {
  it('renders nothing when savedFilters is empty', () => {
    const { container } = render(
      <SavedFilterTabs
        savedFilters={[]}
        activeFilterId={null}
        onLoad={vi.fn()}
        onClearAll={vi.fn()}
        onSaveCurrentClick={vi.fn()}
        hasActiveFilters={false}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders "All" pill plus one pill per saved filter', () => {
    render(<SavedFilterTabs {...defaultProps()} />)
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: filterA.name })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: filterB.name })).toBeInTheDocument()
  })

  it('"All" pill has aria-selected=true when no filter is active and no active filters exist', () => {
    render(<SavedFilterTabs {...defaultProps()} />)
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  })

  it('filter pills have aria-selected=false when no preset is active', () => {
    render(<SavedFilterTabs {...defaultProps()} />)
    expect(screen.getByRole('tab', { name: filterA.name })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: filterB.name })).toHaveAttribute('aria-selected', 'false')
  })

  it('active filter pill has aria-selected=true; "All" loses selection', () => {
    render(<SavedFilterTabs {...defaultProps({ activeFilterId: filterA.id })} />)
    expect(screen.getByRole('tab', { name: filterA.name })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: filterB.name })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false')
  })

  it('clicking a filter pill calls onLoad with the correct filter', async () => {
    const user = userEvent.setup()
    const onLoad = vi.fn()
    render(<SavedFilterTabs {...defaultProps({ onLoad })} />)
    await user.click(screen.getByRole('tab', { name: filterA.name }))
    expect(onLoad).toHaveBeenCalledOnce()
    expect(onLoad).toHaveBeenCalledWith(filterA)
  })

  it('clicking "All" calls onClearAll', async () => {
    const user = userEvent.setup()
    const onClearAll = vi.fn()
    render(<SavedFilterTabs {...defaultProps({ onClearAll })} />)
    await user.click(screen.getByRole('tab', { name: 'All' }))
    expect(onClearAll).toHaveBeenCalledOnce()
  })

  it('does not show "+ Save current" when hasActiveFilters is false', () => {
    render(<SavedFilterTabs {...defaultProps({ hasActiveFilters: false })} />)
    expect(screen.queryByText('+ Save current')).not.toBeInTheDocument()
  })

  it('does not show "+ Save current" when a preset is already active', () => {
    render(
      <SavedFilterTabs
        {...defaultProps({ hasActiveFilters: true, activeFilterId: filterA.id })}
      />
    )
    expect(screen.queryByText('+ Save current')).not.toBeInTheDocument()
  })

  it('shows "+ Save current" when hasActiveFilters=true and no preset is active', () => {
    render(
      <SavedFilterTabs
        {...defaultProps({ hasActiveFilters: true, activeFilterId: null })}
      />
    )
    expect(screen.getByText('+ Save current')).toBeInTheDocument()
  })

  it('clicking "+ Save current" calls onSaveCurrentClick', async () => {
    const user = userEvent.setup()
    const onSaveCurrentClick = vi.fn()
    render(
      <SavedFilterTabs
        {...defaultProps({ hasActiveFilters: true, activeFilterId: null, onSaveCurrentClick })}
      />
    )
    await user.click(screen.getByText('+ Save current'))
    expect(onSaveCurrentClick).toHaveBeenCalledOnce()
  })
})
