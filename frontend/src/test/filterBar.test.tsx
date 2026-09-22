import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    owner: fakeUser,
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
  }
}

describe('FilterBar', () => {
  it('renders search input', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('Search cards on this board…')).toBeInTheDocument()
  })

  it('does not render the built-in facet dropdowns at rest (#964)', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.queryByText('Assignee')).not.toBeInTheDocument()
    expect(screen.queryByText('Label')).not.toBeInTheDocument()
    expect(screen.queryByText('Priority')).not.toBeInTheDocument()
    expect(screen.queryByText('Due date')).not.toBeInTheDocument()
  })

  it('renders the "+ Filter" trigger', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByText('+ Filter')).toBeInTheDocument()
  })

  it('"+ Filter" menu lists all four built-in facets', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('+ Filter'))
    const menu = screen.getByRole('group', { name: '+ Filter' })
    expect(menu).toHaveTextContent('Assignee')
    expect(menu).toHaveTextContent('Label')
    expect(menu).toHaveTextContent('Priority')
    expect(menu).toHaveTextContent('Due date')
  })

  it('picking Assignee from "+ Filter" reveals the Assignee control in Row 1 (two-click flow)', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    // The facet control is now revealed but its own menu is not auto-opened
    const assigneeTrigger = screen.getByRole('button', { name: /^Assignee/ })
    expect(assigneeTrigger).toBeInTheDocument()
    expect(assigneeTrigger).toHaveAttribute('aria-expanded', 'false')
    // Opening it shows its options
    await user.click(assigneeTrigger)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('picking Due date from "+ Filter" reveals the Due date control and its options open on click', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Due date' }))
    await user.click(screen.getByRole('button', { name: /^Due date/ }))
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Due this week')).toBeInTheDocument()
    expect(screen.getByText('No due date')).toBeInTheDocument()
  })

  it('picking Label and Priority from "+ Filter" reveals both controls', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Label' }))
    await user.click(screen.getByRole('checkbox', { name: 'Priority' }))
    expect(screen.getByRole('button', { name: /^Label/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Priority/ })).toBeInTheDocument()
  })

  it('a facet with an active value shows a chip even when its control is collapsed', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    // Control is collapsed (not in openFacetIds) — only the chip is visible
    expect(screen.queryByRole('button', { name: /^Label/ })).not.toBeInTheDocument()
    expect(screen.getByTitle('Bug')).toBeInTheDocument()
  })

  it('"+ Filter" shows an active-count badge reflecting facets with a value, not open facets', () => {
    const filters: FilterState = { ...EMPTY_FILTER, labelIds: [100], priorities: ['high'] }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} />)
    const trigger = screen.getByText('+ Filter').closest('button') as HTMLButtonElement
    expect(trigger).toHaveTextContent('2')
    expect(trigger).toHaveAttribute('aria-label', '+ Filter, 2 active')
  })

  it('"+ Filter" shows no badge when no built-in facet has a value', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const trigger = screen.getByText('+ Filter').closest('button') as HTMLButtonElement
    expect(trigger).not.toHaveAttribute('aria-label')
  })

  it('closing a facet control (Escape) collapses it out of Row 1 and returns focus to "+ Filter"', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    const assigneeTrigger = screen.getByRole('button', { name: /^Assignee/ })
    await user.click(assigneeTrigger)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    // The control's own control has already collapsed the facet out of Row 1
    expect(screen.queryByRole('button', { name: /^Assignee/ })).not.toBeInTheDocument()
    // Focus falls back to "+ Filter" on the next tick
    await vi.waitFor(() => {
      expect(screen.getByText('+ Filter').closest('button')).toHaveFocus()
    })
  })

  it('closing a facet control via outside click does NOT steal focus back to "+ Filter"', async () => {
    render(
      <div>
        <button>Outside target</button>
        <FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />
      </div>
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    const assigneeTrigger = screen.getByRole('button', { name: /^Assignee/ })
    await user.click(assigneeTrigger)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    const outsideTarget = screen.getByText('Outside target')
    await user.click(outsideTarget)
    // The facet control has collapsed out of Row 1 (outside click closes it, same as before)...
    expect(screen.queryByRole('button', { name: /^Assignee/ })).not.toBeInTheDocument()
    // ...but focus stays where the user's click intentionally sent it, not on "+ Filter"
    expect(outsideTarget).toHaveFocus()
    // Give the deferred focus-recovery tick a chance to run and confirm it
    // still didn't fire (regression guard for the Escape-only recovery path)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(outsideTarget).toHaveFocus()
  })

  it('closing a facet control by re-toggling its own trigger (not Escape, not outside click) collapses it out of Row 1 (#964)', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    const assigneeTrigger = screen.getByRole('button', { name: /^Assignee/ })
    await user.click(assigneeTrigger)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    // Re-toggle: click the facet's own trigger a second time to close it (third close path)
    await user.click(assigneeTrigger)
    expect(screen.queryByRole('button', { name: /^Assignee/ })).not.toBeInTheDocument()
  })

  it('unchecking a facet in the "+ Filter" menu itself removes its control from Row 1, without ever opening the facet\'s own control (#964)', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    expect(screen.getByRole('button', { name: /^Assignee/ })).toBeInTheDocument()
    // Uncheck it again from the same "+ Filter" menu — the facet's own control is never opened
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    expect(screen.queryByRole('button', { name: /^Assignee/ })).not.toBeInTheDocument()
  })

  it('two revealed facets close independently via different paths, without cross-contaminating each other\'s close (#964)', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    await user.click(screen.getByRole('checkbox', { name: 'Label' }))
    // Both facets are now revealed ("open") in Row 1 simultaneously
    expect(screen.getByRole('button', { name: /^Assignee/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Label/ })).toBeInTheDocument()

    // Close Assignee via Escape (its own popup opened, then Escape-closed)
    const assigneeTrigger = screen.getByRole('button', { name: /^Assignee/ })
    await user.click(assigneeTrigger)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: /^Assignee/ })).not.toBeInTheDocument()
    // Label is untouched by Assignee's close — still revealed in Row 1
    const labelTrigger = screen.getByRole('button', { name: /^Label/ })
    expect(labelTrigger).toBeInTheDocument()
    // Focus returned to "+ Filter" after Assignee's Escape-close
    await vi.waitFor(() => {
      expect(screen.getByText('+ Filter').closest('button')).toHaveFocus()
    })

    // Label's own close (re-toggle, a different path) still works correctly
    // afterward — Assignee's earlier close didn't leave stale state (e.g. a
    // stuck escapeCloseRef) behind that would break Label's close.
    await user.click(labelTrigger)
    expect(screen.getByText('Bug')).toBeInTheDocument()
    await user.click(labelTrigger)
    expect(screen.queryByRole('button', { name: /^Label/ })).not.toBeInTheDocument()
  })

  it('"+ Filter" trigger text stays pinned to "+ Filter" with multiple facets open (#964 label-in-name fix)', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }))
    await user.click(screen.getByRole('checkbox', { name: 'Label' }))
    const trigger = screen.getByRole('button', { name: '+ Filter' })
    expect(trigger).toHaveTextContent('+ Filter')
    expect(trigger.textContent).not.toContain('Assignee')
    expect(trigger.textContent).not.toContain('Label')
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
    await userEvent.setup().type(screen.getByPlaceholderText('Search cards on this board…'), 'bug')
    expect(onChange).toHaveBeenCalled()
  })

  it('clicking label dropdown shows options (after revealing it via "+ Filter")', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Label' }))
    await user.click(screen.getByRole('button', { name: /^Label/ }))
    expect(screen.getByText('Bug')).toBeInTheDocument()
    expect(screen.getByText('Feature')).toBeInTheDocument()
  })

  it('clicking priority dropdown shows options (after revealing it via "+ Filter")', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Priority' }))
    await user.click(screen.getByRole('button', { name: /^Priority/ }))
    expect(screen.getByText('Low')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })

  it('Escape clears search and blurs the input', async () => {
    const onChange = vi.fn()
    const filters: FilterState = { ...EMPTY_FILTER, search: 'bug' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Search cards on this board…')
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
  async function revealFacet(facetLabel: string) {
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: facetLabel }))
    return user
  }

  it('"+ Filter" trigger has aria-haspopup and aria-expanded', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const trigger = screen.getByText('+ Filter').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('SingleSelectDropdown trigger (Due date) has aria-haspopup and aria-expanded once revealed', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await revealFacet('Due date')
    const trigger = screen.getByRole('button', { name: /^Due date/ }) as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('SingleSelectDropdown trigger aria-expanded becomes true when open', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = await revealFacet('Due date')
    const trigger = screen.getByRole('button', { name: /^Due date/ }) as HTMLButtonElement
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('CheckboxDropdown trigger (Assignee) has aria-haspopup and aria-expanded once revealed', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await revealFacet('Assignee')
    const trigger = screen.getByRole('button', { name: /^Assignee/ }) as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('CheckboxDropdown trigger aria-expanded becomes true when open', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const user = await revealFacet('Assignee')
    const trigger = screen.getByRole('button', { name: /^Assignee/ }) as HTMLButtonElement
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('keyboard navigation: ArrowDown from open SingleSelectDropdown moves focus to first menu item', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    await revealFacet('Due date')
    const trigger = screen.getByRole('button', { name: /^Due date/ }) as HTMLButtonElement
    trigger.focus()
    // Open the menu
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // ArrowDown from trigger moves focus into the menu items
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const items = screen.getAllByRole('menuitem')
    // First menu item should have received focus
    expect(document.activeElement).toBe(items[0])
  })
})

describe('FilterBar — search scope toggle (#852)', () => {
  it('renders placeholder "Search cards on this board…" (exact copy)', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('Search cards on this board…')).toBeInTheDocument()
  })

  it('does not render the scope toggle when onScopeChange is not provided', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.queryByText('This board')).not.toBeInTheDocument()
    expect(screen.queryByText('Everywhere')).not.toBeInTheDocument()
  })

  it('renders the scope toggle with "This board" trigger label when onScopeChange is provided', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={vi.fn()} />)
    expect(screen.getByText('This board')).toBeInTheDocument()
  })

  it('opens the scope toggle menu and shows both options', async () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('This board'))
    const menu = screen.getByRole('menu')
    expect(menu).toHaveTextContent('This board')
    expect(menu).toHaveTextContent('Everywhere')
  })

  it('selecting "Everywhere" calls onScopeChange("all") and dispatches visiban:open-palette', async () => {
    const onScopeChange = vi.fn()
    const paletteListener = vi.fn()
    window.addEventListener('visiban:open-palette', paletteListener)
    try {
      render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={onScopeChange} />)
      await userEvent.setup().click(screen.getByText('This board'))
      await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Everywhere' }))
      expect(onScopeChange).toHaveBeenCalledWith('all')
      expect(paletteListener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('visiban:open-palette', paletteListener)
    }
  })

  it('selecting "This board" does NOT dispatch visiban:open-palette', async () => {
    const onScopeChange = vi.fn()
    const paletteListener = vi.fn()
    window.addEventListener('visiban:open-palette', paletteListener)
    try {
      render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="all" onScopeChange={onScopeChange} />)
      // Trigger label reads "Everywhere" when scope=all
      await userEvent.setup().click(screen.getByText('Everywhere'))
      await userEvent.setup().click(screen.getByRole('menuitem', { name: 'This board' }))
      expect(onScopeChange).toHaveBeenCalledWith('board')
      expect(paletteListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('visiban:open-palette', paletteListener)
    }
  })

  it('disables the search input when scope=all', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="all" onScopeChange={vi.fn()} />)
    const input = screen.getByPlaceholderText('Search cards on this board…') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('search input is enabled when scope=board (default)', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={vi.fn()} />)
    const input = screen.getByPlaceholderText('Search cards on this board…') as HTMLInputElement
    expect(input.disabled).toBe(false)
  })

  it('shows helper text "Searching across all your boards" when scope=all', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="all" onScopeChange={vi.fn()} />)
    expect(screen.getByText('Searching across all your boards')).toBeInTheDocument()
  })

  it('hides helper text when scope=board', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={vi.fn()} />)
    expect(screen.queryByText('Searching across all your boards')).not.toBeInTheDocument()
  })

  it('search input retains its value when scope flips to all (disabled but not cleared)', () => {
    const filters: FilterState = { ...EMPTY_FILTER, search: 'keep me' }
    render(<FilterBar board={makeBoard()} filters={filters} onChange={vi.fn()} scope="all" onScopeChange={vi.fn()} />)
    const input = screen.getByPlaceholderText('Search cards on this board…') as HTMLInputElement
    expect(input.value).toBe('keep me')
    expect(input.disabled).toBe(true)
  })

  it('renders the 🔍 icon inside the scope toggle trigger', () => {
    render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} scope="board" onScopeChange={vi.fn()} />)
    const trigger = screen.getByText('This board').closest('button') as HTMLButtonElement
    expect(trigger.textContent).toContain('🔍')
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
