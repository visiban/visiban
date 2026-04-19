import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardExportModal from '../components/Board/BoardExportModal'

vi.mock('../api/boards', () => ({
  exportBoardJson: vi.fn(),
  exportBoardCsv: vi.fn(),
}))

import { exportBoardJson, exportBoardCsv } from '../api/boards'

const mockExportBoardJson = exportBoardJson as ReturnType<typeof vi.fn>
const mockExportBoardCsv = exportBoardCsv as ReturnType<typeof vi.fn>

describe('BoardExportModal', () => {
  const defaultProps = { boardId: 42, onClose: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: export functions succeed silently (they call window.open, return void)
    mockExportBoardJson.mockImplementation(() => undefined)
    mockExportBoardCsv.mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // --- Rendering ---

  it('renders with the "Export Board" title', () => {
    render(<BoardExportModal {...defaultProps} />)
    expect(screen.getByText('Export Board')).toBeInTheDocument()
  })

  it('renders JSON and CSV radio options', () => {
    render(<BoardExportModal {...defaultProps} />)
    expect(screen.getByRole('radio', { name: /json/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /csv/i })).toBeInTheDocument()
  })

  it('JSON radio is selected by default', () => {
    render(<BoardExportModal {...defaultProps} />)
    expect(screen.getByRole('radio', { name: /json/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /csv/i })).not.toBeChecked()
  })

  it('export button label reads "Export JSON" when JSON is selected by default', () => {
    render(<BoardExportModal {...defaultProps} />)
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })

  it('always renders the status line container (prevents layout shift)', () => {
    render(<BoardExportModal {...defaultProps} />)
    // The <p className="text-xs h-4"> is always present — text is empty when idle
    const statusContainer = document.querySelector('p.text-xs.h-4')
    expect(statusContainer).toBeInTheDocument()
    expect(statusContainer?.textContent).toBe('')
  })

  // --- Format selection ---

  it('selecting CSV changes the button label to "Export CSV"', async () => {
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /csv/i }))

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export JSON' })).not.toBeInTheDocument()
  })

  it('selecting CSV checks the CSV radio and unchecks JSON', async () => {
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /csv/i }))

    expect(screen.getByRole('radio', { name: /csv/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /json/i })).not.toBeChecked()
  })

  // --- Export actions ---

  it('clicking export with JSON selected calls exportBoardJson with the correct boardId', async () => {
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(mockExportBoardJson).toHaveBeenCalledOnce()
    expect(mockExportBoardJson).toHaveBeenCalledWith(42)
    expect(mockExportBoardCsv).not.toHaveBeenCalled()
  })

  it('clicking export with CSV selected calls exportBoardCsv with the correct boardId', async () => {
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /csv/i }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(mockExportBoardCsv).toHaveBeenCalledOnce()
    expect(mockExportBoardCsv).toHaveBeenCalledWith(42)
    expect(mockExportBoardJson).not.toHaveBeenCalled()
  })

  // --- Success state ---
  // handleExport is synchronous (window.open + setState), so we use fireEvent + act
  // per the project convention for fake-timer tests (see boardView.test.tsx line 505,
  // settingsPage.test.tsx line 182): await act(async () => { vi.advanceTimersByTime(n) })
  // flushes React state updates triggered by the timer, then assert synchronously.

  it('"Download started" appears in green after a successful export', () => {
    vi.useFakeTimers()
    render(<BoardExportModal {...defaultProps} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
    })

    const span = screen.getByText('Download started')
    expect(span).toBeInTheDocument()
    expect(span.className).toContain('text-success')
  })

  it('"Download started" disappears after 3 seconds', async () => {
    vi.useFakeTimers()
    render(<BoardExportModal {...defaultProps} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
    })

    expect(screen.getByText('Download started')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(3000) })

    expect(screen.queryByText('Download started')).not.toBeInTheDocument()
  })

  it('status line is empty again after the 3-second timer clears', async () => {
    vi.useFakeTimers()
    render(<BoardExportModal {...defaultProps} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
    })

    await act(async () => { vi.advanceTimersByTime(3000) })

    const statusContainer = document.querySelector('p.text-xs.h-4')
    expect(statusContainer?.textContent).toBe('')
  })

  // --- Error state ---

  it('error message appears in red when exportBoardJson throws', async () => {
    mockExportBoardJson.mockImplementation(() => { throw new Error('network error') })
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    const errorSpan = screen.getByText('Export failed — please try again')
    expect(errorSpan).toBeInTheDocument()
    expect(errorSpan.className).toContain('text-danger')
  })

  it('error message appears when exportBoardCsv throws', async () => {
    mockExportBoardCsv.mockImplementation(() => { throw new Error('network error') })
    const user = userEvent.setup()
    render(<BoardExportModal {...defaultProps} />)

    await user.click(screen.getByRole('radio', { name: /csv/i }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(screen.getByText('Export failed — please try again')).toBeInTheDocument()
  })

  // --- onClose behaviour ---

  it('onClose is NOT called automatically after a successful export', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<BoardExportModal boardId={42} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('onClose is called when the close button (aria-label="Close") is clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<BoardExportModal boardId={42} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  // --- Accessibility ---

  it('export format options are grouped in a fieldset', () => {
    render(<BoardExportModal {...defaultProps} />)
    expect(document.querySelector('fieldset')).toBeInTheDocument()
  })

  it('radio inputs are keyboard-reachable by role', () => {
    render(<BoardExportModal {...defaultProps} />)
    // Both radios must be findable via accessible role — sr-only inputs are still in the
    // accessibility tree and reachable by arrow keys
    expect(screen.getByRole('radio', { name: /json/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /csv/i })).toBeInTheDocument()
  })
})
