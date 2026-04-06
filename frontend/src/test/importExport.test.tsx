import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportBoardModal from '../components/Board/ImportBoardModal'

describe('ImportBoardModal', () => {
  let onImport: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onImport = vi.fn().mockResolvedValue(undefined)
    onCancel = vi.fn()
  })

  it('renders with a file input and Import button', () => {
    render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)

    expect(screen.getByText('Import Board')).toBeInTheDocument()
    expect(screen.getByText('Click to select a .json or .csv file')).toBeInTheDocument()
    expect(screen.getByText('Import')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
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
