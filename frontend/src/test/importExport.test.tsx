import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportBoardModal from '../components/Board/ImportBoardModal'
import ImportSkippedToast from '../components/Board/ImportSkippedToast'
import { formatImportSkipped } from '../utils/importSummary'
import type { ImportOptions, ImportSkippedCounts, ImportSummary } from '../types'

describe('ImportBoardModal', () => {
  let onImport: Mock<(file: File, name?: string) => Promise<void>>
  let onCancel: Mock<() => void>

  beforeEach(() => {
    onImport = vi.fn<(file: File, name?: string) => Promise<void>>().mockResolvedValue(undefined)
    onCancel = vi.fn<() => void>()
  })

  it('renders with a file input and Import button', () => {
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    expect(screen.getByText('Import Board')).toBeInTheDocument()
    expect(screen.getByText('Click to select a .json or .csv file')).toBeInTheDocument()
    expect(screen.getByText('Import')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('shows the Trello link only when onSwitchToTrello is provided', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)
    expect(screen.queryByRole('button', { name: 'Import a Trello export' })).not.toBeInTheDocument()
    unmount()

    const onSwitch = vi.fn()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} onSwitchToTrello={onSwitch} />)
    await user.click(screen.getByRole('button', { name: 'Import a Trello export' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('has a hidden file input that accepts .json and .csv', () => {
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    expect(fileInput.accept).toBe('.json,.csv')
  })

  it('Import button is disabled when no file is selected', () => {
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const importBtn = screen.getByText('Import')
    expect(importBtn).toBeDisabled()
  })

  it('shows file name and size after selecting a valid file', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const file = new File(['{"name":"Test Board"}'], 'board.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)

    await waitFor(() => {
      expect(screen.getByText('board.json')).toBeInTheDocument()
    })
  })

  it('validates file type and shows error for unsupported formats', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    // Select a .txt file (unsupported) — applyAccept: false lets us bypass the HTML accept filter
    const file = new File(['hello world'], 'data.txt', { type: 'text/plain' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)

    // Click Import to trigger validation
    const importBtn = screen.getByText('Import')
    await user.click(importBtn)

    await waitFor(() => {
      expect(screen.getByText('Unsupported file format. Please upload a .json or .csv file.')).toBeInTheDocument()
    })

    expect(onImport).not.toHaveBeenCalled()
  })

  it('accepts a .csv file without error', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const file = new File(['col1,col2\nval1,val2'], 'export.csv', { type: 'text/csv' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)

    await waitFor(() => {
      expect(screen.getByText('export.csv')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith(file, undefined)
    })
  })

  it('shows error when file exceeds 10 MB', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    // Use a tiny file with a mocked size property — avoids allocating 11 MB in CI
    const file = Object.defineProperty(
      new File(['x'], 'huge.json', { type: 'application/json' }),
      'size',
      { value: 11 * 1024 * 1024 },
    )
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)
    await user.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(screen.getByText('File is too large. Maximum size is 10 MB.')).toBeInTheDocument()
    })

    expect(onImport).not.toHaveBeenCalled()
  })

  it('passes optional board name override to onImport', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const file = new File(['{}'], 'board.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)

    // Type a custom board name
    const nameInput = screen.getByPlaceholderText('Leave blank to use name from file')
    await user.type(nameInput, 'My Custom Board')

    await user.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith(file, 'My Custom Board')
    })
  })

  it('calls onCancel when Cancel button is clicked', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    await user.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onCancel when clicking the backdrop', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    // The outer div is the backdrop
    const backdrop = container.firstChild as HTMLElement
    await user.click(backdrop)

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows import error from failed API call', async () => {
    const user = userEvent.setup()
    onImport.mockRejectedValue({ response: { data: { detail: 'Invalid board format' } } })

    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const file = new File(['{}'], 'board.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(fileInput, file)
    await user.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(screen.getByText('Invalid board format')).toBeInTheDocument()
    })
  })

  // #1373 — handleSubmit's floating-promise call site is the board-name
  // input's Enter key (not the Import button, which is a plain function
  // reference and was never flagged). Exercise that exact site.
  it('shows import error when submitting via Enter on the board name field', async () => {
    const user = userEvent.setup()
    onImport.mockRejectedValue({ response: { data: { detail: 'Invalid board format' } } })

    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    const file = new File(['{}'], 'board.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, file)

    const nameInput = screen.getByPlaceholderText('Leave blank to use name from file')
    await user.type(nameInput, 'My Board{Enter}')

    expect(await screen.findByText('Invalid board format')).toBeInTheDocument()
    expect(onImport).toHaveBeenCalledTimes(1)
  })
})

describe('Export dropdown (BoardView)', () => {
  // The export dropdown is embedded in BoardView which requires extensive context.
  // We test the export API functions and the dropdown behavior conceptually via
  // unit tests of the export functions.

  it('exportBoardCsv opens correct URL', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    // Import after setting up the mock
    const { exportBoardCsv } = await import('../api/boards')
    exportBoardCsv(42)

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/boards/42/export/'),
      '_blank'
    )
    openSpy.mockRestore()
  })

  it('exportBoardJson opens correct URL with format=json', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    const { exportBoardJson } = await import('../api/boards')
    exportBoardJson(42)

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/boards/42/export/?format=json'),
      '_blank'
    )
    openSpy.mockRestore()
  })
})

describe('ImportBoardModal — keyboard (#1376)', () => {
  it('the file dropzone is a real button that opens the file chooser on Enter and Space', async () => {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /click to select a \.json or \.csv file/i })
    expect(zone).toHaveAttribute('type', 'button')
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click')
    zone.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(clickSpy).toHaveBeenCalledTimes(2)
    clickSpy.mockRestore()
  })
})

// #119 — selective import: the "Include" options.
describe('ImportBoardModal — Include options (#119)', () => {
  type OnImport = (file: File, name?: string, options?: ImportOptions) => Promise<void>
  let onImport: Mock<OnImport>

  beforeEach(() => {
    onImport = vi.fn<OnImport>().mockResolvedValue(undefined)
  })

  const jsonFile = () => new File(['{}'], 'board.json', { type: 'application/json' })
  const csvFile = () => new File(['Title,Column,Swimlane'], 'board.csv', { type: 'text/csv' })

  async function setup(file: File = jsonFile()) {
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={onImport} onCancel={vi.fn()} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)
    return { user, input, file }
  }

  const box = (name: string) => screen.getByRole('checkbox', { name })
  const summary = () => document.getElementById('import-summary')

  it('shows no Include options before a file is chosen', () => {
    render(<ImportBoardModal onImport={onImport} onCancel={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Include' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(summary()).toBeNull()
  })

  it('shows no Include options for an unsupported file', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<ImportBoardModal onImport={onImport} onCancel={vi.fn()} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['x'], 'data.txt', { type: 'text/plain' }))
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('shows five rows, all checked, for a JSON file in order', async () => {
    await setup()
    const group = screen.getByRole('group', { name: 'Include' })
    const names = within(group).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)
    expect(names).toEqual(['Cards', 'Comments', 'Checklist items', 'Card history', 'Labels'])
    within(group).getAllByRole('checkbox').forEach((c) => expect(c).toBeChecked())
    expect(group).toHaveAccessibleDescription('Board structure (name, columns, swimlanes) is always imported.')
  })

  it('shows only Cards and Labels for a CSV file', async () => {
    await setup(csvFile())
    const names = screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)
    expect(names).toEqual(['Cards', 'Labels'])
    expect(summary()).toHaveTextContent(/^Importing: everything$/)
  })

  it('calls onImport with two arguments when everything is included', async () => {
    const { user, file } = await setup()
    await user.click(screen.getByText('Import'))
    await waitFor(() => expect(onImport).toHaveBeenCalled())
    expect(onImport.mock.calls[0]).toEqual([file, undefined])
  })

  it('unchecking Labels shows its consequence, wired by aria-describedby', async () => {
    const { user, file } = await setup()
    const labels = box('Labels')
    expect(labels).toHaveAccessibleDescription('Label definitions and the labels on cards.')
    await user.click(labels)
    expect(labels).toHaveAccessibleDescription('Card labels are skipped')
    await user.click(screen.getByText('Import'))
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(file, undefined, {
        labels: false, cards: true, comments: true, checklist: true, history: true,
      }),
    )
  })

  it('unchecking Cards unchecks and disables its dependents and sends all four false', async () => {
    const { user, file } = await setup()
    await user.click(box('Cards'))
    for (const name of ['Comments', 'Checklist items', 'Card history']) {
      expect(box(name)).not.toBeChecked()
      expect(box(name)).toBeDisabled()
      expect(box(name)).toHaveAccessibleDescription('Requires Cards')
    }
    expect(box('Cards')).toHaveAccessibleDescription('Cards and everything on them are skipped')
    // Only the label text dims; the native disabled control dims itself.
    const historyLabel = box('Card history').closest('label') as HTMLElement
    expect(historyLabel.className).not.toMatch(/opacity-/)
    expect(within(historyLabel).getByText('Card history')).toHaveClass('text-fg-muted')
    expect(box('Labels')).toBeEnabled()
    await user.click(screen.getByText('Import'))
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(file, undefined, {
        labels: true, cards: false, comments: false, checklist: false, history: false,
      }),
    )
  })

  it('re-checking Cards restores a deliberate uncheck of Card history', async () => {
    const { user } = await setup()
    await user.click(box('Card history'))
    expect(box('Card history')).toHaveAccessibleDescription('Movements and activity are skipped')
    await user.click(box('Cards'))
    await user.click(box('Cards'))
    expect(box('Comments')).toBeChecked()
    expect(box('Checklist items')).toBeChecked()
    expect(box('Card history')).not.toBeChecked()
    expect(box('Card history')).toBeEnabled()
  })

  it('a disabled dependent is not reachable by Tab', async () => {
    const { user } = await setup()
    await user.click(box('Cards'))
    box('Cards').focus()
    await user.tab()
    expect(document.activeElement).toBe(box('Labels'))
  })

  it('summary line lists only what is selected', async () => {
    const { user } = await setup()
    expect(summary()).toHaveTextContent(/^Importing: everything$/)
    await user.click(box('Comments'))
    expect(summary()).toHaveTextContent('Importing: structure, cards, labels, checklist items, history')
    await user.click(box('Cards'))
    expect(summary()).toHaveTextContent(/^Importing: structure, labels$/)
    await user.click(box('Labels'))
    expect(summary()).toHaveTextContent(/^Importing: structure only$/)
    expect(screen.getByRole('button', { name: 'Import' })).toHaveAccessibleDescription('Importing: structure only')
  })

  it('has one status region that announces only the Cards cascade', async () => {
    const { user } = await setup()
    const regions = screen.getAllByRole('status')
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveAttribute('aria-live', 'polite')
    expect(regions[0]).toHaveTextContent('')
    await user.click(box('Labels'))
    expect(regions[0]).toHaveTextContent('')
    await user.click(box('Cards'))
    expect(regions[0]).toHaveTextContent(
      'Comments, checklist items, and card history are unavailable while Cards is unchecked',
    )
    await user.click(box('Cards'))
    expect(regions[0]).toHaveTextContent('Comments, checklist items, and card history are available again')
  })

  it('disables every checkbox while submitting', async () => {
    let resolve: () => void = () => {}
    onImport.mockImplementation(() => new Promise<void>((r) => { resolve = r }))
    const { user } = await setup()
    await user.click(screen.getByText('Import'))
    await waitFor(() => expect(screen.getByText('Importing...')).toBeInTheDocument())
    screen.getAllByRole('checkbox').forEach((c) => expect(c).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Importing...' })).not.toHaveAttribute('aria-describedby')
    resolve()
    await waitFor(() => expect(box('Labels')).toBeEnabled())
  })

  it('choosing a new file resets the selections', async () => {
    const { user, input } = await setup()
    await user.click(box('Cards'))
    await user.click(box('Labels'))
    await user.upload(input, new File(['{}'], 'other.json', { type: 'application/json' }))
    screen.getAllByRole('checkbox').forEach((c) => {
      expect(c).toBeChecked()
      expect(c).toBeEnabled()
    })
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('')
  })

  it('Cards copy names assignees for JSON but only due dates for CSV', async () => {
    const { user, input } = await setup()
    expect(box('Cards')).toHaveAccessibleDescription('Includes assignees and due dates.')
    await user.upload(input, csvFile())
    expect(box('Cards')).toHaveAccessibleDescription('Includes due dates.')
  })

  it('a CSV import does not announce a cascade for rows it does not show', async () => {
    const { user } = await setup(csvFile())
    const region = screen.getByRole('status')
    await user.click(box('Cards'))
    expect(region).toHaveTextContent('')
    await user.click(box('Cards'))
    expect(region).toHaveTextContent('')
  })

  it('a CSV import sends only cards and labels', async () => {
    const { user, file } = await setup(csvFile())
    await user.click(box('Cards'))
    expect(summary()).toHaveTextContent(/^Importing: structure, labels$/)
    await user.click(screen.getByText('Import'))
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(file, undefined, { cards: false, labels: true }))
  })
})

describe('formatImportSkipped (#119)', () => {
  const zero: ImportSkippedCounts = {
    cards: 0, comments: 0, checklist_items: 0, label_refs: 0, movements: 0, activities: 0,
  }
  const summaryOf = (skipped: Partial<ImportSkippedCounts>): ImportSummary => ({
    options_applied: { labels: true, cards: true, comments: true, checklist: true, history: true },
    skipped: { ...zero, ...skipped },
  })

  it('returns null when nothing was skipped', () => {
    expect(formatImportSkipped(summaryOf({}))).toBeNull()
    expect(formatImportSkipped(undefined)).toBeNull()
  })

  it('lists only non-zero counts, singular for one', () => {
    expect(formatImportSkipped(summaryOf({ cards: 12, comments: 30, label_refs: 4 }))).toBe(
      'Board imported. Skipped: 12 cards, 30 comments, 4 card labels.',
    )
    expect(formatImportSkipped(summaryOf({ cards: 1, checklist_items: 1, label_refs: 1 }))).toBe(
      'Board imported. Skipped: 1 card, 1 checklist item, 1 card label.',
    )
  })

  it('sums movements and activities into history entries', () => {
    expect(formatImportSkipped(summaryOf({ movements: 5, activities: 6 }))).toBe(
      'Board imported. Skipped: 11 history entries.',
    )
    expect(formatImportSkipped(summaryOf({ activities: 1 }))).toBe(
      'Board imported. Skipped: 1 history entry.',
    )
  })

  it('caps at three items then "and N more"', () => {
    expect(formatImportSkipped(summaryOf({ cards: 2, comments: 3, checklist_items: 4, label_refs: 1, movements: 5 }))).toBe(
      'Board imported. Skipped: 2 cards, 3 comments, 4 checklist items, and 2 more.',
    )
  })
})

describe('ImportSkippedToast (#119)', () => {
  const summary: ImportSummary = {
    options_applied: { labels: false, cards: true, comments: true, checklist: true, history: true },
    skipped: { cards: 0, comments: 0, checklist_items: 0, label_refs: 1, movements: 0, activities: 0 },
  }

  it('mounts the status region empty, fills it a tick later, and auto-dismisses after 8 seconds', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<ImportSkippedToast summary={summary} onDismiss={onDismiss} />)
      const region = screen.getByRole('status')
      expect(region).toHaveTextContent('')
      expect(region.className).toContain('w-max')
      expect(region.className).toContain('max-w-[min(24rem,calc(100%-2rem))]')
      act(() => { vi.advanceTimersByTime(0) })
      expect(region).toHaveTextContent('Board imported. Skipped: 1 card label.')
      act(() => { vi.advanceTimersByTime(7999) })
      expect(onDismiss).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses the auto-dismiss while hovered or focused', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<ImportSkippedToast summary={summary} onDismiss={onDismiss} />)
      act(() => { vi.advanceTimersByTime(0) })
      const region = screen.getByRole('status')
      fireEvent.mouseEnter(region)
      act(() => { vi.advanceTimersByTime(20000) })
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.mouseLeave(region)
      fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }))
      act(() => { vi.advanceTimersByTime(20000) })
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.blur(screen.getByRole('button', { name: 'Dismiss notification' }))
      act(() => { vi.advanceTimersByTime(8000) })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing when nothing was skipped', () => {
    const { container } = render(
      <ImportSkippedToast summary={{ ...summary, skipped: { ...summary.skipped, label_refs: 0 } }} onDismiss={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
