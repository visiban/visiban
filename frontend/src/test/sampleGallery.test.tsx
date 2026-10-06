import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportBoardModal from '../components/Board/ImportBoardModal'
import { getSampleBoardFile, listSampleBoards } from '../api/boards'
import type { ImportOptions, SampleBoardSummary } from '../types'

vi.mock('../api/boards', () => ({
  listSampleBoards: vi.fn(),
  getSampleBoardFile: vi.fn(),
}))

const mockList = listSampleBoards as Mock
const mockFile = getSampleBoardFile as Mock

// Six samples: four fit the collapsed view, two sit behind "Show all".
const SAMPLES: SampleBoardSummary[] = [
  ['sales_overlay', 'Sales Overlay', 'account', 42],
  ['simple_kanban', 'Simple Kanban', 'team', 113],
  ['sales_pipeline', 'Sales Pipeline', 'region', 60],
  ['product_roadmap', 'Product Roadmap', 'quarter', 50],
  ['customer_support', 'Customer Support', 'priority', 70],
  ['content_production', 'Content Production', 'channel', 55],
].map(([id, title, theme, count], i) => ({
  id: id as string,
  title: title as string,
  description: `${title} description.`,
  swimlane_theme: theme as string,
  card_count: count as number,
  includes: ['labels', 'checklists', 'comments', 'history'],
  order: i + 1,
  schema_version: 2,
  date_anchor: '2026-03-15',
}))

/** A promise the test settles by hand, so a sample can be "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const blob = () => new Blob(['{"name":"Sales Overlay"}'], { type: 'application/json' })

async function renderModal(overrides: { onImport?: Mock; onCancel?: Mock } = {}) {
  const onImport = overrides.onImport ?? vi.fn().mockResolvedValue(undefined)
  const onCancel = overrides.onCancel ?? vi.fn()
  const user = userEvent.setup()
  render(<ImportBoardModal onImport={onImport} onCancel={onCancel} />)
  // The heading renders while the list is still loading; wait for the cards too.
  await screen.findAllByRole('button', { name: /^Use this sample: / })
  return { user, onImport, onCancel }
}

const card = (title: string) => screen.getByRole('button', { name: `Use this sample: ${title}` })
const cardTitles = () => screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)

function stubNarrowViewport(narrow: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: narrow && query.includes('max-width: 559px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  mockList.mockReset().mockResolvedValue(SAMPLES)
  mockFile.mockReset().mockResolvedValue(blob())
})

afterEach(() => {
  // jsdom has no matchMedia; remove the stub so other tests see the real absence.
  // @ts-expect-error — test cleanup of an optional browser API
  delete window.matchMedia
})

describe('SampleGallery — layout (#1452)', () => {
  it('shows the first four samples, the count, and a Show all expander', async () => {
    await renderModal()
    expect(screen.getByText('6 samples')).toBeInTheDocument()
    expect(cardTitles()).toEqual(['Sales Overlay', 'Simple Kanban', 'Sales Pipeline', 'Product Roadmap'])
    expect(screen.getByRole('button', { name: /Show all 6 samples/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders each card from the manifest: count, theme and one-line description', async () => {
    await renderModal()
    const item = card('Sales Overlay').closest('li') as HTMLElement
    expect(within(item).getByText('~42 cards')).toBeInTheDocument()
    expect(within(item).getByText('Swimlanes by account')).toBeInTheDocument()
    expect(within(item).getByText('Sales Overlay description.')).toBeInTheDocument()
  })

  it('shows identical Includes badges once, not on every card', async () => {
    await renderModal()
    expect(screen.getByText('Every sample includes')).toBeInTheDocument()
    const groups = screen.getAllByRole('group', { name: 'Includes' })
    expect(groups).toHaveLength(1)
    expect(within(groups[0]).getAllByText(/Labels|Checklists|Comments|History/)).toHaveLength(4)
  })

  it('shows per-card Includes badges as soon as one sample differs', async () => {
    mockList.mockResolvedValue(SAMPLES.map((x, i) => (i === 1 ? { ...x, includes: ['labels' as const] } : x)))
    await renderModal()
    expect(screen.queryByText('Every sample includes')).not.toBeInTheDocument()
    const item = card('Simple Kanban').closest('li') as HTMLElement
    expect(within(within(item).getByRole('group', { name: 'Includes' })).getAllByText(/Labels|Checklists|Comments|History/)).toHaveLength(1)
    expect(screen.getAllByRole('group', { name: 'Includes' })).toHaveLength(4)
  })

  it('pluralizes the count', async () => {
    mockList.mockResolvedValue(SAMPLES.slice(0, 1))
    await renderModal()
    expect(screen.getByText('1 sample')).toBeInTheDocument()
  })

  it('shows only three samples below 560px', async () => {
    stubNarrowViewport(true)
    await renderModal()
    expect(cardTitles()).toEqual(['Sales Overlay', 'Simple Kanban', 'Sales Pipeline'])
    expect(screen.getByRole('button', { name: /Show all 6 samples/ })).toBeInTheDocument()
  })

  it('hides the expander when every sample already fits', async () => {
    mockList.mockResolvedValue(SAMPLES.slice(0, 4))
    await renderModal()
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('keeps the upload dropzone and its divider below the gallery', async () => {
    await renderModal()
    expect(screen.getByText('or upload your own file')).toBeInTheDocument()
    expect(screen.getByText('Click to select a .json or .csv file')).toBeInTheDocument()
  })
})

describe('SampleGallery — expand and collapse focus', () => {
  it('Show all reveals the rest and moves focus to card 5; Show fewer keeps focus on the toggle', async () => {
    const { user } = await renderModal()
    await user.click(screen.getByRole('button', { name: /Show all 6 samples/ }))
    expect(cardTitles()).toHaveLength(6)
    await waitFor(() => expect(card('Customer Support')).toHaveFocus())

    const toggle = screen.getByRole('button', { name: /Show fewer samples/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    toggle.focus()
    await user.click(toggle)
    expect(cardTitles()).toHaveLength(4)
    expect(screen.getByRole('button', { name: /Show all 6 samples/ })).toHaveFocus()
  })

  it('falls back to card 4 as the tab stop when the remembered card is hidden again', async () => {
    const { user } = await renderModal()
    await user.click(screen.getByRole('button', { name: /Show all 6 samples/ }))
    await waitFor(() => expect(card('Customer Support')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: /Show fewer samples/ }))
    expect(card('Product Roadmap')).toHaveAttribute('tabindex', '0')
    expect(card('Sales Overlay')).toHaveAttribute('tabindex', '-1')
  })
})

describe('SampleGallery — keyboard', () => {
  it('opens with focus on the first card and makes the gallery one Tab stop', async () => {
    await renderModal()
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
    const stops = screen.getAllByRole('button', { name: /^Use this sample: / }).filter((b) => b.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
  })

  it('arrow keys move in two dimensions without selecting, and Home/End jump', async () => {
    const { user } = await renderModal()
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
    await user.keyboard('{ArrowRight}')
    expect(card('Simple Kanban')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(card('Product Roadmap')).toHaveFocus() // same column, next row
    await user.keyboard('{ArrowLeft}')
    expect(card('Sales Pipeline')).toHaveFocus() // previous in reading order
    await user.keyboard('{ArrowUp}')
    expect(card('Sales Overlay')).toHaveFocus()
    await user.keyboard('{End}')
    expect(card('Product Roadmap')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(card('Sales Overlay')).toHaveFocus()
    expect(mockFile).not.toHaveBeenCalled()
  })

  it('moves the roving tab stop with focus', async () => {
    const { user } = await renderModal()
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
    await user.keyboard('{ArrowRight}')
    expect(card('Simple Kanban')).toHaveAttribute('tabindex', '0')
    expect(card('Sales Overlay')).toHaveAttribute('tabindex', '-1')
  })

  it('in a single column, Up and Down step one card', async () => {
    stubNarrowViewport(true)
    const { user } = await renderModal()
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(card('Simple Kanban')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(card('Sales Overlay')).toHaveFocus()
  })

  it('Enter on a focused card uses the sample', async () => {
    const { user } = await renderModal()
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(mockFile).toHaveBeenCalledWith('sales_overlay', expect.any(AbortSignal))
  })
})

describe('SampleGallery — choosing a sample', () => {
  it('fetches the file and lands on the include step with a source row', async () => {
    const { user } = await renderModal()
    await user.click(screen.getByRole('button', { name: 'Use this sample: Sales Overlay' }))

    await screen.findByText(/From sample:/)
    expect(screen.getByText('Sales Overlay', { selector: 'span.font-medium' })).toBeInTheDocument()
    expect(screen.getByText(/~42 cards/, { selector: 'span.text-sm' })).toBeInTheDocument()
    // The gallery and the dropzone give way to the source row; the include step is shown.
    expect(screen.queryByRole('heading', { name: 'Start from a sample' })).not.toBeInTheDocument()
    expect(screen.queryByText('Click to select a .json or .csv file')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Include' })).toBeInTheDocument()
    // Focus lands in the step, not on <body>.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Cards' })).toHaveFocus())
  })

  it('imports the fetched file through onImport with the date anchor and no name', async () => {
    const { user, onImport } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByText(/From sample:/)
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [file, name, options] = onImport.mock.calls[0] as [File, string | undefined, ImportOptions]
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('sales_overlay.json')
    expect(file.type).toBe('application/json')
    // No name: an explicit name would skip the "Imported: <title>" duplicate numbering.
    expect(name).toBeUndefined()
    expect(options).toEqual({ shift_dates_from: '2026-03-15' })
  })

  it('keeps the include choices alongside the date shift', async () => {
    const { user, onImport } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByText(/From sample:/)
    await user.click(screen.getByRole('checkbox', { name: 'Comments' }))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(onImport).toHaveBeenCalled())
    expect(onImport.mock.calls[0][2]).toEqual({
      labels: true, cards: true, comments: false, checklist: true, history: true,
      shift_dates_from: '2026-03-15',
    })
  })

  it('a hand-picked file never carries the date shift', async () => {
    const { user, onImport } = await renderModal()
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['{}'], 'board.json', { type: 'application/json' }),
    )
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onImport).toHaveBeenCalled())
    expect(onImport.mock.calls[0]).toHaveLength(2) // (file, name) — the pre-#1452 call
  })

  it('Change returns to the picker with focus on that sample, even from behind Show all', async () => {
    const { user } = await renderModal()
    await user.click(screen.getByRole('button', { name: /Show all 6 samples/ }))
    await user.click(card('Content Production'))
    await screen.findByText(/From sample:/)
    await user.click(screen.getByRole('button', { name: /Change sample/ }))

    await screen.findByRole('heading', { name: 'Start from a sample' })
    await waitFor(() => expect(card('Content Production')).toHaveFocus())
    expect(screen.getByText('Click to select a .json or .csv file')).toBeInTheDocument()
    expect(screen.queryByText(/From sample:/)).not.toBeInTheDocument()
    // Back in step one: nothing is selected, so there is nothing to import.
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })
})

describe('SampleGallery — loading and cancel', () => {
  it('shows one status, disables the other samples, and keeps the dropzone usable', async () => {
    const d = deferred<Blob>()
    mockFile.mockReturnValue(d.promise)
    const { user } = await renderModal()
    await user.click(card('Sales Overlay'))

    expect(await screen.findByText('Loading sample…')).toBeInTheDocument()
    // Announced once, by the modal's single live region; the card text is visual only.
    expect(screen.getByRole('status')).toHaveTextContent('Loading the Sales Overlay sample.')
    expect(screen.getByText('Loading sample…')).toHaveAttribute('aria-hidden', 'true')
    expect(card('Simple Kanban')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /Click to select a \.json or \.csv file/ })).toBeEnabled()

    // A blocked card does not start a second request.
    await user.click(card('Simple Kanban'))
    expect(mockFile).toHaveBeenCalledTimes(1)
  })

  it('Escape aborts the request, keeps the modal open, announces once, and refocuses the card', async () => {
    const d = deferred<Blob>()
    mockFile.mockReturnValue(d.promise)
    const { user, onCancel } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByText('Loading sample…')
    const signal = mockFile.mock.calls[0][1] as AbortSignal

    await user.keyboard('{Escape}')

    expect(signal.aborted).toBe(true)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryByText('Loading sample…')).not.toBeInTheDocument()
    expect(screen.getAllByText('Loading canceled.')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Loading canceled.')
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())

    // A late response from the aborted request must not open the next step.
    await act(async () => d.resolve(blob()))
    expect(screen.queryByText(/From sample:/)).not.toBeInTheDocument()
  })

  it('Escape in the board name field cancels the load instead of closing the modal', async () => {
    const d = deferred<Blob>()
    mockFile.mockReturnValue(d.promise)
    const { user, onCancel } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByText('Loading sample…')

    await user.click(screen.getByPlaceholderText(/Leave blank for/))
    await user.keyboard('{Escape}')

    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText('Loading canceled.')).toBeInTheDocument()
  })

  it('Escape with nothing loading still closes the modal', async () => {
    const { user, onCancel } = await renderModal()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('choosing a file aborts the sample load and uses the file', async () => {
    const d = deferred<Blob>()
    mockFile.mockReturnValue(d.promise)
    const { user } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByText('Loading sample…')
    const signal = mockFile.mock.calls[0][1] as AbortSignal

    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['{}'], 'mine.json', { type: 'application/json' }),
    )

    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('Loading sample…')).not.toBeInTheDocument()
    expect(screen.getByText('mine.json')).toBeInTheDocument()
    await act(async () => d.resolve(blob()))
    expect(screen.getByText('mine.json')).toBeInTheDocument()
    expect(screen.queryByText(/From sample:/)).not.toBeInTheDocument()
  })

  it('unmounting aborts an in-flight sample request', async () => {
    mockFile.mockReturnValue(deferred<Blob>().promise)
    const user = userEvent.setup()
    const { unmount } = render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Use this sample: Sales Overlay' }))
    const signal = mockFile.mock.calls[0][1] as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
  })
})

describe('SampleGallery — errors', () => {
  it('a failed sample shows one alert and Try again with focus; the rest keeps working', async () => {
    mockFile.mockRejectedValueOnce(new Error('network'))
    const { user } = await renderModal()
    await user.click(card('Sales Overlay'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load this sample.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const retry = screen.getByRole('button', { name: /Try again, Sales Overlay sample/ })
    expect(retry).toHaveTextContent('Try again')
    await waitFor(() => expect(retry).toHaveFocus())

    // The upload path and the other samples are untouched.
    expect(screen.getByRole('button', { name: /Click to select a \.json or \.csv file/ })).toBeEnabled()
    expect(card('Simple Kanban')).not.toHaveAttribute('aria-disabled')

    // Try again succeeds and opens the next step.
    await user.click(retry)
    await screen.findByText(/From sample:/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a sample failure does not surface as an import error', async () => {
    mockFile.mockRejectedValueOnce(new Error('network'))
    const { user } = await renderModal()
    await user.click(card('Sales Overlay'))
    await screen.findByRole('alert')
    expect(screen.queryByText(/Import failed/)).not.toBeInTheDocument()
  })

  it('shows a banner with Retry when the list is unavailable, and recovers on Retry', async () => {
    mockList.mockRejectedValueOnce(new Error('503'))
    const user = userEvent.setup()
    render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('Samples aren’t available right now.')).toBeInTheDocument()
    expect(screen.getByText('You can still upload your own file below.')).toBeInTheDocument()
    expect(screen.getByText('Upload your own file')).toBeInTheDocument() // no "or"
    expect(screen.queryByText('or upload your own file')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Click to select a \.json or \.csv file/ })).toBeEnabled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('6 samples')
    expect(mockList).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(card('Sales Overlay')).toHaveFocus())
  })

  it('treats an empty list as unavailable rather than hiding the section', async () => {
    mockList.mockResolvedValue([])
    render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Samples aren’t available right now.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Start from a sample' })).toBeInTheDocument()
  })

  it('does not steal focus from a control the user already reached', async () => {
    mockList.mockRejectedValueOnce(new Error('503'))
    render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /Click to select a \.json or \.csv file/ })
    zone.focus()
    await screen.findByText('Samples aren’t available right now.')
    expect(zone).toHaveFocus()
  })

  it('aborts the list request on unmount', async () => {
    mockList.mockReturnValue(deferred<SampleBoardSummary[]>().promise)
    const { unmount } = render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    const signal = mockList.mock.calls[0][0] as AbortSignal
    expect(screen.getByText('Loading samples…')).toBeInTheDocument()
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
