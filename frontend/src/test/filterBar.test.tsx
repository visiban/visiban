import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar, { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { BoardFull, User } from '../types'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeBoard(): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    columns: [], swimlanes: [], cards: [],
    labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }, { id: 101, uid: 'lbluid000002', name: 'Feature', color: '#3B82F6' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
  }
}

describe('FilterBar', () => {
  it('renders search input', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('Search cards…')).toBeInTheDocument()
  })

  it('renders assignee dropdown button', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByText('Assignee')).toBeInTheDocument()
  })

  it('clicking assignee dropdown shows options', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('Assignee'))
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('clicking due date dropdown shows options', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('Due date'))
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Due this week')).toBeInTheDocument()
    expect(screen.getByText('No due date')).toBeInTheDocument()
  })

  it('renders label dropdown', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByText('Label')).toBeInTheDocument()
  })

  it('renders priority dropdown', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByText('Priority')).toBeInTheDocument()
  })

  it('renders due date select', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByText('Due date')).toBeInTheDocument()
  })

  it('does not show clear all when no filters active', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
  })

  it('shows clear all when filters are active', () => {
    const filters: FilterState = { ...EMPTY_FILTER, search: 'test' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    expect(screen.getByText('Clear all')).toBeInTheDocument()
  })

  it('clicking clear all resets to EMPTY_FILTER', async () => {
    const onChange = vi.fn()
    const filters: FilterState = { ...EMPTY_FILTER, search: 'test' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={onChange} />)
    await userEvent.setup().click(screen.getByText('Clear all'))
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER)
  })

  it('typing in search calls onChange', async () => {
    const onChange = vi.fn()
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={onChange} />)
    await userEvent.setup().type(screen.getByPlaceholderText('Search cards…'), 'bug')
    expect(onChange).toHaveBeenCalled()
  })

  it('clicking label dropdown shows options', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('Label'))
    expect(screen.getByText('Bug')).toBeInTheDocument()
    expect(screen.getByText('Feature')).toBeInTheDocument()
  })

  it('clicking priority dropdown shows options', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('Priority'))
    expect(screen.getByText('Low')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })

  it('Escape clears search and blurs the input', async () => {
    const onChange = vi.fn()
    const filters: FilterState = { ...EMPTY_FILTER, search: 'bug' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Search cards…')
    input.focus()
    await userEvent.setup().keyboard('{Escape}')
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, search: '' })
  })
})

describe('FilterBar — MyCardsButton', () => {
  it('does not render My cards button when currentUser is not provided', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.queryByText('My cards')).not.toBeInTheDocument()
  })

  it('does not render My cards button when currentUser is null', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} currentUser={null} />)
    expect(screen.queryByText('My cards')).not.toBeInTheDocument()
  })

  it('renders My cards button when currentUser is provided', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} currentUser={fakeUser} />)
    expect(screen.getByText('My cards')).toBeInTheDocument()
  })

  it('clicking My cards sets assigneeIds to currentUser.id', async () => {
    const onChange = vi.fn()
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={onChange} currentUser={fakeUser} />)
    await userEvent.setup().click(screen.getByText('My cards'))
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, assigneeIds: [fakeUser.id] })
  })

  it('clicking My cards again clears assigneeIds', async () => {
    const onChange = vi.fn()
    const activeFilters: FilterState = { ...EMPTY_FILTER, assigneeIds: [fakeUser.id] }
    render(<FilterBar board={makeBoard()} filters={activeFilters} onChange={onChange} currentUser={fakeUser} />)
    await userEvent.setup().click(screen.getByText('My cards'))
    expect(onChange).toHaveBeenCalledWith({ ...activeFilters, assigneeIds: [] })
  })

  it('My cards button has aria-pressed=true when filter is active', () => {
    const activeFilters: FilterState = { ...EMPTY_FILTER, assigneeIds: [fakeUser.id] }
    render(<FilterBar board={makeBoard()} filters={activeFilters} onChange={vi.fn()} currentUser={fakeUser} />)
    const btn = screen.getByText('My cards').closest('button')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('My cards button has aria-pressed=false when filter is not active', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} currentUser={fakeUser} />)
    const btn = screen.getByText('My cards').closest('button')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('My cards button is not active when multiple assignees are selected', () => {
    const multiFilters: FilterState = { ...EMPTY_FILTER, assigneeIds: [fakeUser.id, 99] }
    render(<FilterBar board={makeBoard()} filters={multiFilters} onChange={vi.fn()} currentUser={fakeUser} />)
    const btn = screen.getByText('My cards').closest('button')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })
})
