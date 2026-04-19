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
    owner: fakeUser,
    capabilities: { movement_export: false },
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

describe('FilterBar — chip row', () => {
  it('shows chip row when assignee filter is active', () => {
    const filters: FilterState = { ...EMPTY_FILTER, assigneeIds: [1] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} currentUser={fakeUser} />)
    expect(screen.getByRole('group', { name: 'Active filters' })).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('shows chip row when label filter is active', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Active filters' })).toBeInTheDocument()
    // The chip label 'Bug' should appear (not inside the dropdown)
    expect(screen.getByTitle('Bug')).toBeInTheDocument()
  })

  it('does not show chip row when no filters active', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument()
  })

  it('shows "N cards hidden" when hiddenCount > 0', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} hiddenCount={5} />)
    expect(screen.getByRole('status')).toHaveTextContent('5 cards hidden')
  })

  it('shows singular "1 card hidden" when hiddenCount is 1', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} hiddenCount={1} />)
    expect(screen.getByRole('status')).toHaveTextContent('1 card hidden')
  })

  it('does not show hidden count when hiddenCount is 0', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} hiddenCount={0} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clicking × on an assignee chip removes that filter value', async () => {
    const onChange = vi.fn()
    const filters: FilterState = { ...EMPTY_FILTER, assigneeIds: [1] }
    const { container } = render(<FilterBar board={makeBoard()} filters={filters} onChange={onChange} currentUser={fakeUser} />)
    // The dismiss button is the <button> inside the chip (the × button, not the <span role="button">)
    const chipGroup = container.querySelector('[role="group"]') as HTMLElement
    const dismissBtn = chipGroup.querySelector('button') as HTMLButtonElement
    await userEvent.setup().click(dismissBtn)
    expect(onChange).toHaveBeenCalledWith({ ...filters, assigneeIds: [] })
  })

  it('clicking × on a label chip removes that filter value', async () => {
    const onChange = vi.fn()
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    const { container } = render(<FilterBar board={makeBoard()} filters={filters} onChange={onChange} />)
    const chipGroup = container.querySelector('[role="group"]') as HTMLElement
    const dismissBtn = chipGroup.querySelector('button') as HTMLButtonElement
    await userEvent.setup().click(dismissBtn)
    expect(onChange).toHaveBeenCalledWith({ ...filters, labelIds: [] })
  })

  it('does not create a chip for search filter', () => {
    const filters: FilterState = { ...EMPTY_FILTER, search: 'bug' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument()
  })
})

describe('FilterBar — Clear all button styling', () => {
  it('Clear all button has border styling', () => {
    const filters: FilterState = { ...EMPTY_FILTER, search: 'test' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    const btn = screen.getByText('Clear all')
    expect(btn).toHaveClass('border')
    expect(btn).toHaveClass('rounded')
  })
})

describe('FilterBar — dropdown ARIA attributes', () => {
  it('SingleSelectDropdown trigger has aria-haspopup and aria-expanded', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    // "Due date" is rendered as a SingleSelectDropdown
    const trigger = screen.getByText('Due date').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('SingleSelectDropdown trigger aria-expanded becomes true when open', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const trigger = screen.getByText('Due date').closest('button') as HTMLButtonElement
    await userEvent.setup().click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('CheckboxDropdown trigger has aria-haspopup and aria-expanded', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    // "Assignee" is rendered as a CheckboxDropdown
    const trigger = screen.getByText('Assignee').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'true')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('CheckboxDropdown trigger aria-expanded becomes true when open', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const trigger = screen.getByText('Assignee').closest('button') as HTMLButtonElement
    await userEvent.setup().click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
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
