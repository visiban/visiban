import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SavedFiltersDropdown from '../components/Board/SavedFiltersDropdown'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { SavedFilter } from '../types'

function makeSavedFilter(id: number, name: string): SavedFilter {
  return {
    id,
    name,
    state_json: { search: 'bug', assigneeIds: [], labelIds: [], priorities: ['high'], dueDate: null },
    created_at: '2026-03-25T10:00:00Z',
  }
}

const defaultProps = {
  boardId: 1,
  filters: EMPTY_FILTER,
  savedFilters: [],
  loading: false,
  onLoad: vi.fn(),
  onSave: vi.fn().mockResolvedValue({}),
  onDelete: vi.fn(),
}

describe('SavedFiltersDropdown', () => {
  it('renders the Saved button', () => {
    render(<SavedFiltersDropdown {...defaultProps} />)
    expect(screen.getByRole('button', { name: /saved filters/i })).toBeInTheDocument()
  })

  it('shows count badge when saved filters exist', () => {
    render(
      <SavedFiltersDropdown
        {...defaultProps}
        savedFilters={[makeSavedFilter(1, 'Alpha'), makeSavedFilter(2, 'Beta')]}
      />,
    )
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('does not show count badge when no saved filters', () => {
    render(<SavedFiltersDropdown {...defaultProps} savedFilters={[]} />)
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('opens dropdown on button click', async () => {
    render(<SavedFiltersDropdown {...defaultProps} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    expect(screen.getByText(/no saved filters/i)).toBeInTheDocument()
  })

  it('shows loading state', async () => {
    render(<SavedFiltersDropdown {...defaultProps} loading={true} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('lists saved filters when dropdown is open', async () => {
    render(
      <SavedFiltersDropdown
        {...defaultProps}
        savedFilters={[makeSavedFilter(1, 'Sprint view'), makeSavedFilter(2, 'Bugs only')]}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    expect(screen.getByText('Sprint view')).toBeInTheDocument()
    expect(screen.getByText('Bugs only')).toBeInTheDocument()
  })

  it('calls onLoad when a saved filter is clicked', async () => {
    const onLoad = vi.fn()
    const sf = makeSavedFilter(1, 'Sprint view')
    render(
      <SavedFiltersDropdown
        {...defaultProps}
        savedFilters={[sf]}
        onLoad={onLoad}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    await userEvent.setup().click(screen.getByText('Sprint view'))
    expect(onLoad).toHaveBeenCalledWith(sf)
  })

  it('closes the dropdown after loading a filter', async () => {
    const sf = makeSavedFilter(1, 'Sprint view')
    render(<SavedFiltersDropdown {...defaultProps} savedFilters={[sf]} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    await userEvent.setup().click(screen.getByText('Sprint view'))
    expect(screen.queryByText('Sprint view')).not.toBeInTheDocument()
  })

  it('"Save current filters" button is disabled when no active filters', async () => {
    render(<SavedFiltersDropdown {...defaultProps} filters={EMPTY_FILTER} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    const saveBtn = screen.getByText(/save current filters/i)
    expect(saveBtn.closest('button')).toBeDisabled()
  })

  it('"Save current filters" button is enabled when filters are active', async () => {
    const activeFilters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    render(<SavedFiltersDropdown {...defaultProps} filters={activeFilters} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    const saveBtn = screen.getByText(/save current filters/i)
    expect(saveBtn.closest('button')).not.toBeDisabled()
  })

  it('entering save mode shows the name input', async () => {
    const activeFilters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    render(<SavedFiltersDropdown {...defaultProps} filters={activeFilters} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    await userEvent.setup().click(screen.getByText(/save current filters/i))
    expect(screen.getByPlaceholderText(/filter name/i)).toBeInTheDocument()
  })

  it('calls onSave with the entered name on Save button click', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    const activeFilters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    render(<SavedFiltersDropdown {...defaultProps} filters={activeFilters} onSave={onSave} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /saved filters/i }))
    await user.click(screen.getByText(/save current filters/i))
    await user.type(screen.getByPlaceholderText(/filter name/i), 'My preset')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('My preset'))
  })

  it('shows error message when onSave returns an error', async () => {
    const onSave = vi.fn().mockResolvedValue({ error: 'A saved filter with this name already exists on this board.' })
    const activeFilters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    render(<SavedFiltersDropdown {...defaultProps} filters={activeFilters} onSave={onSave} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /saved filters/i }))
    await user.click(screen.getByText(/save current filters/i))
    await user.type(screen.getByPlaceholderText(/filter name/i), 'Dupe')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeInTheDocument())
  })

  it('calls onDelete when the delete button is activated', async () => {
    const onDelete = vi.fn()
    const sf = makeSavedFilter(42, 'To delete')
    render(
      <SavedFiltersDropdown
        {...defaultProps}
        savedFilters={[sf]}
        onDelete={onDelete}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /saved filters/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete saved filter "To delete"/i })
    await userEvent.setup().click(deleteBtn)
    expect(onDelete).toHaveBeenCalledWith(42)
  })

  it('Cancel button in save mode returns to list view', async () => {
    const activeFilters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    render(<SavedFiltersDropdown {...defaultProps} filters={activeFilters} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /saved filters/i }))
    await user.click(screen.getByText(/save current filters/i))
    expect(screen.getByPlaceholderText(/filter name/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByPlaceholderText(/filter name/i)).not.toBeInTheDocument()
    expect(screen.getByText(/save current filters/i)).toBeInTheDocument()
  })
})
