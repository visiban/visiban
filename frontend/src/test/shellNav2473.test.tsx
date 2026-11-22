import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import BoardSwitcher from '../components/Layout/BoardSwitcher'
import { buildSwitcherSections } from '../components/Layout/shellNavModel'
import NavDrawer from '../components/Layout/NavDrawer'
import { NavDrawerContext, ShellNavDataContext } from '../contexts/ShellNavContext'
import type { ShellNavData } from '../contexts/ShellNavContext'
import type { Board, Group, User } from '../types'

const mockIsPhone = vi.fn(() => false)
vi.mock('../hooks/useIsPhoneViewport', () => ({ useIsPhoneViewport: () => mockIsPhone() }))

function board(id: number, name: string, group: number | null, status: Board['effective_health_status'] = null): Board {
  return { id, name, group, group_name: group ? `G${group}` : null, effective_health_status: status } as unknown as Board
}
function group(id: number, name: string, parent: number | null = null): Group {
  return { id, name, parent } as unknown as Group
}

const boards = [
  board(1, 'Alpha', 10, 'on_track'),
  board(2, 'Beta', 10),
  board(3, 'Gamma', 10, 'at_risk'),
  board(4, 'Solo', null),
  board(5, 'Orphan', 99),
]
const data: ShellNavData = {
  loading: false,
  groups: [group(10, 'Team'), group(11, 'Sub', 10)],
  boards,
  starredBoards: [boards[1]],
  recentBoards: [{ id: 3, name: 'Gamma', openedAt: Date.now() - 5 * 60000 }, { id: 2, name: 'Beta' }, { id: 1, name: 'Alpha' }],
  addBoard: () => {},
  removeBoard: () => {},
  addGroup: () => {}, removeGroup: () => {},
}

describe('buildSwitcherSections (#2473)', () => {
  it('orders Starred, Recent, then the rest of the group, each board once', () => {
    const sections = buildSwitcherSections(boards[0], data, '', Date.now())
    // Every board of the group already appeared above, so the group section drops out.
    expect(sections.map((s) => s.title)).toEqual(['Starred', 'Recent on this device'])
    expect(sections.map((s) => s.options.map((o) => o.name))).toEqual([['Beta'], ['Gamma', 'Alpha']])
    const fewer = buildSwitcherSections(boards[0], { ...data, recentBoards: [] }, '', 0)
    expect(fewer.map((s) => [s.title, s.options.map((o) => o.name)])).toEqual([['Starred', ['Beta']], ['G10', ['Alpha', 'Gamma']]])
  })

  it('shows "<N> ago" only for entries that carry openedAt', () => {
    const now = Date.now()
    const recent = buildSwitcherSections(boards[0], data, '', now).find((s) => s.title === 'Recent on this device')!
    expect(recent.options[0].ago).toBe('5m ago')
    expect(recent.options[1].ago).toBeUndefined()
  })

  it('names the third section Personal boards on a personal board, and filters by query', () => {
    const sections = buildSwitcherSections(boards[3], { ...data, starredBoards: [], recentBoards: [] }, '', 0)
    expect(sections).toEqual([{ title: 'Personal boards', options: [{ id: 4, name: 'Solo', tone: 'none' }] }])
    expect(buildSwitcherSections(boards[0], data, 'gam', 0).flatMap((s) => s.options.map((o) => o.name))).toEqual(['Gamma'])
  })
})

function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}

function renderSwitcher(current = boards[0]) {
  return render(
    <MemoryRouter initialEntries={[`/boards/${current.id}`]}>
      <ShellNavDataContext.Provider value={data}>
        <h1><BoardSwitcher board={current} /></h1>
        <Routes><Route path="*" element={<LocationProbe />} /></Routes>
      </ShellNavDataContext.Provider>
    </MemoryRouter>,
  )
}

describe('BoardSwitcher (#2473)', () => {
  it('lives in the h1, opens a Switch board dialog with a combobox controlling a listbox', () => {
    renderSwitcher()
    const trigger = within(screen.getByRole('heading', { level: 1 })).getByRole('button', { name: 'Alpha, switch board' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const dialog = screen.getByRole('dialog', { name: 'Switch board' })
    const combo = within(dialog).getByRole('combobox', { name: 'Find a board' })
    expect(combo).toHaveFocus()
    const list = within(dialog).getByRole('listbox')
    expect(combo).toHaveAttribute('aria-controls', list.id)
    const current = within(list).getByRole('option', { selected: true })
    expect(current).toHaveTextContent('Alpha')
    expect(current).toHaveTextContent('Current')
    // Status words ride along for screen readers.
    expect(within(list).getAllByText('At risk').length).toBeGreaterThan(0)
    expect(dialog).toHaveTextContent('↑↓ move · Enter open · Esc close')
    expect(dialog).toHaveTextContent('for everything')
  })

  it('arrow keys and Enter open a board; Escape closes and refocuses the trigger', () => {
    renderSwitcher()
    const trigger = screen.getByRole('button', { name: 'Alpha, switch board' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Switch board' })).toBeNull()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    const combo = screen.getByRole('combobox', { name: 'Find a board' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowUp' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'Enter' })
    expect(screen.getByTestId('loc')).toHaveTextContent('/boards/3')
  })

  it('opens the hovered/active option with Enter or Space when the option itself has the key event (#2526)', () => {
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha, switch board' }))
    const opt = screen.getByRole('option', { name: /Beta/ })
    fireEvent.keyDown(opt, { key: 'a' })
    expect(screen.getByTestId('loc')).not.toHaveTextContent('/boards/2')
    fireEvent.keyDown(opt, { key: ' ' })
    expect(screen.getByTestId('loc')).toHaveTextContent('/boards/2')
  })

  it('renders the panel outside the h1', () => {
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha, switch board' }))
    expect(screen.getByRole('heading', { level: 1 })).not.toContainElement(screen.getByRole('dialog', { name: 'Switch board' }))
  })

  it('says how to search wider when no board matches', () => {
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha, switch board' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a board' }), { target: { value: 'zzz' } })
    expect(screen.getByText(/No board named “zzz”\. Press .+ to search cards and actions too\./)).toBeInTheDocument()
  })

  it('opens as a bottom sheet on phones', () => {
    mockIsPhone.mockReturnValue(true)
    try {
      renderSwitcher()
      fireEvent.click(screen.getByRole('button', { name: 'Alpha, switch board' }))
      expect(screen.getByRole('dialog', { name: 'Switch board' })).toHaveAttribute('data-variant', 'sheet')
      expect(screen.getByRole('dialog', { name: 'Switch board' })).toHaveAttribute('aria-modal', 'true')
    } finally {
      mockIsPhone.mockReturnValue(false)
    }
  })
})

const fakeUser = { id: 1, username: 'jane', is_site_admin: false } as unknown as User

function renderDrawer(opts: { user?: User; navData?: ShellNavData; path?: string; open?: boolean } = {}) {
  const value = { open: opts.open ?? true, setOpen: vi.fn(), toggle: vi.fn(), menuButtonRef: { current: null }, registerHeader: () => () => {} }
  render(
    <MemoryRouter initialEntries={[opts.path ?? '/']}>
      <NavDrawerContext.Provider value={value}>
        <ShellNavDataContext.Provider value={opts.navData ?? data}>
          <NavDrawer user={opts.user ?? fakeUser} />
        </ShellNavDataContext.Provider>
      </NavDrawerContext.Provider>
    </MemoryRouter>,
  )
  return value
}

describe('NavDrawer (#2473)', () => {
  it('is a modal dialog with Home, Starred, Groups (with counts), Personal boards and a footer', () => {
    renderDrawer()
    const drawer = screen.getByRole('dialog', { name: 'Main navigation' })
    expect(drawer).toHaveAttribute('aria-modal', 'true')
    expect(within(drawer).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    expect(within(drawer).getByRole('region', { name: 'Starred' })).toHaveTextContent('Beta')
    const groups = within(drawer).getByRole('region', { name: 'Groups' })
    expect(within(groups).getByRole('link', { name: /Team/ })).toHaveTextContent('3 boards')
    expect(within(groups).getByRole('link', { name: /Sub/ })).toHaveTextContent('0 boards')
    // A board whose group isn't visible lands under Personal boards.
    const personal = within(drawer).getByRole('region', { name: 'Personal boards' })
    expect(personal).toHaveTextContent('Solo')
    expect(personal).toHaveTextContent('Orphan')
    expect(within(drawer).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    expect(within(drawer).queryByRole('link', { name: 'Site admin' })).toBeNull()
    expect(drawer).toHaveTextContent('Press [ to toggle this drawer')
    expect(drawer).not.toHaveTextContent('My activity')
  })

  it('shows Site admin to admins and hides empty sections', () => {
    renderDrawer({ user: { ...fakeUser, is_site_admin: true }, navData: { ...data, starredBoards: [], groups: [], boards: [] } })
    expect(screen.getByRole('link', { name: 'Site admin' })).toHaveAttribute('href', '/admin')
    expect(screen.queryByRole('region', { name: 'Starred' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Groups' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Personal boards' })).toBeNull()
  })

  it('shows skeleton rows while loading', () => {
    renderDrawer({ navData: { ...data, loading: true } })
    expect(screen.getByTestId('nav-drawer-skeleton')).toBeInTheDocument()
  })

  it('the X closes it', () => {
    const value = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(value.setOpen).toHaveBeenCalledWith(false)
  })
})

// `[` opens through the same guard as `?` and `g u` (shouldIgnoreGlobalShortcut); each
// refusing branch is tested beside the opening case (CLAUDE.md, absent-input guards).
describe('NavDrawer `[` shortcut (#2473)', () => {
  function pressFrom(el: Element) {
    fireEvent.keyDown(el, { key: '[' })
  }
  function mount(html: string) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  it('opens a closed drawer from the page', () => {
    const value = renderDrawer({ open: false })
    pressFrom(document.body)
    expect(value.setOpen).toHaveBeenCalledWith(true)
  })

  it('does not open from inside a popover scope (FilterPanel, board overflow menu)', () => {
    const value = renderDrawer({ open: false })
    const host = mount('<div data-shortcut-scope="popover"><button type="button">Filter</button></div>')
    try {
      pressFrom(host.querySelector('button')!)
      expect(value.setOpen).not.toHaveBeenCalled()
    } finally {
      host.remove()
    }
  })

  it('does not open over another modal', () => {
    const value = renderDrawer({ open: false })
    const host = mount('<div role="dialog" aria-modal="true"><button type="button">OK</button></div>')
    try {
      pressFrom(document.body)
      expect(value.setOpen).not.toHaveBeenCalled()
    } finally {
      host.remove()
    }
  })

  it('does not open from a typing context', () => {
    const value = renderDrawer({ open: false })
    const host = mount('<input aria-label="Notes" />')
    try {
      pressFrom(host.querySelector('input')!)
      expect(value.setOpen).not.toHaveBeenCalled()
    } finally {
      host.remove()
    }
  })

  it('closes an open drawer even though the drawer itself is aria-modal', () => {
    const value = renderDrawer({ open: true })
    pressFrom(screen.getByRole('button', { name: 'Close navigation' }))
    expect(value.setOpen).toHaveBeenCalledWith(false)
  })
})
