import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import ExtensionPanels from '../components/Board/ExtensionPanels'
import { parseExtensionPanels, type ExtensionPanel } from '../components/Board/parseExtensionPanels'

/** The renderer half of #1770 (parseExtensionPanels has its own suite): enterprise panels are untrusted text. */

const stats: ExtensionPanel = {
  id: 'p1',
  type: 'stats',
  title: 'Revenue',
  description: 'Closed this quarter',
  items: [
    { label: 'Won', value: 12, hint: 'vs 9 last quarter' },
    { label: 'Pipeline', value: null },
    { label: 'Owner', value: 'Dana' },
  ],
}

const table: ExtensionPanel = {
  id: 'p2',
  type: 'table',
  title: 'Top accounts',
  columns: [
    { key: 'name', label: 'Account', align: 'left' },
    { key: 'arr', label: 'ARR', align: 'right' },
  ],
  rows: [
    { name: 'Acme', arr: 1200 },
    { name: 'Globex', arr: null },
  ],
}

describe('ExtensionPanels renderer', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<ExtensionPanels panels={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each panel as a labelled group with its title and description', () => {
    render(<ExtensionPanels panels={[stats, table]} />)
    expect(screen.getByTestId('extension-panels')).toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Revenue' })
    expect(within(group).getByText('Closed this quarter')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Top accounts' })).toBeInTheDocument()
  })

  it('renders stats items with label, value and hint, and an em dash for a null value', () => {
    render(<ExtensionPanels panels={[stats]} />)
    const group = screen.getByRole('group', { name: 'Revenue' })
    expect(within(group).getByText('Won').nextElementSibling).toHaveTextContent('12')
    expect(within(group).getByText('vs 9 last quarter')).toBeInTheDocument()
    expect(within(group).getByText('Pipeline').nextElementSibling).toHaveTextContent('—')
    expect(within(group).getByText('Dana')).toBeInTheDocument()
  })

  it('renders a table with column headers, right alignment, and a dash for an empty cell', () => {
    render(<ExtensionPanels panels={[table]} />)
    const t = screen.getByRole('table', { name: 'Top accounts' })
    expect(within(t).getByRole('columnheader', { name: 'ARR' })).toHaveClass('text-right')
    expect(within(t).getByRole('columnheader', { name: 'Account' })).toHaveClass('text-left')
    const rows = within(t).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]).getByText('1200')).toBeInTheDocument()
    expect(within(rows[2]).getAllByRole('cell')[1]).toHaveTextContent('—')
  })

  it('shows "No data." spanning every column for a table with no rows', () => {
    render(<ExtensionPanels panels={[{ ...(table as Extract<ExtensionPanel, { type: 'table' }>), rows: [] }]} />)
    const cell = screen.getByText('No data.')
    expect(cell).toHaveAttribute('colspan', '2')
  })

  it('renders hostile strings as inert text and never derives DOM ids from the payload', () => {
    const hostile: ExtensionPanel = {
      id: '"><img src=x onerror=alert(1)>',
      type: 'stats',
      title: '<b>bold</b>',
      items: [{ label: '<script>x</script>', value: '<i>v</i>' }],
    }
    const { container } = render(<ExtensionPanels panels={[hostile]} />)
    expect(container.querySelector('img, script, b, i')).toBeNull()
    expect(screen.getByText('<b>bold</b>')).toBeInTheDocument()
    const group = screen.getByRole('group')
    expect(group.getAttribute('aria-labelledby')).not.toContain('onerror')
    expect(container.innerHTML).not.toContain('onerror')
  })

  it('renders only the known panels a parsed payload leaves behind (unknown types are dropped upstream)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseExtensionPanels([
      { id: 'u', type: 'chart', title: 'Nope', data: { items: [] } },
      null,
      { id: 's', type: 'stats', title: 'Kept', data: { items: [{ label: 'A', value: 1 }] } },
    ])
    render(<ExtensionPanels panels={parsed} />)
    expect(screen.getAllByRole('group')).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'Kept' })).toBeInTheDocument()
    expect(screen.queryByText('Nope')).toBeNull()
  })
})
