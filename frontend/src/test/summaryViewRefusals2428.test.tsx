import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../api/boards', () => ({ getBoardSummary: vi.fn() }))

import { getBoardSummary } from '../api/boards'
import SummaryView from '../components/Board/SummaryView'

const summaryMock = vi.mocked(getBoardSummary)
const tooLarge = { response: { status: 422, data: { code: 'analytics_too_large', detail: 'x' } } }
const busy = { response: { status: 503, headers: { 'retry-after': '1' }, data: { code: 'analytics_busy', detail: 'x' } } }
const summary = { swimlanes: [], totals: {} } as unknown as Awaited<ReturnType<typeof getBoardSummary>>

describe('the Summary tab and the analytics limits (#2428)', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('explains too much history with no period advice and no Retry, and is not retried', async () => {
    summaryMock.mockRejectedValue(tooLarge)
    render(<SummaryView boardId={1} columns={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This board has more history than this server is set up to analyze. Ask your administrator.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('shorter period')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(summaryMock).toHaveBeenCalledTimes(1)
  })

  it('explains a timed-out request with no period advice and no Retry (#2645)', async () => {
    summaryMock.mockRejectedValue({ response: { status: 503, data: { code: 'analytics_timeout', detail: 'x' } } })
    render(<SummaryView boardId={1} columns={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This took longer than the server allows. Ask your administrator.')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(summaryMock).toHaveBeenCalledTimes(1)
  })

  it('retries a busy server once, then explains it with a Retry that refetches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    summaryMock.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockRejectedValueOnce(new Error('no'))
    render(<SummaryView boardId={1} columns={[]} />)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics is busy right now. Try again in a moment.')
    expect(summaryMock).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Failed to load summary.')).toBeInTheDocument()
    expect(summaryMock).toHaveBeenCalledTimes(3)
  })

  it('keeps keyboard focus on the tab region when Retry unmounts itself', async () => {
    summaryMock.mockRejectedValueOnce(new Error('no')).mockResolvedValue(summary)
    render(<SummaryView boardId={1} columns={[]} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toContainElement(screen.getByRole('table'))
  })

  it('drops a pending busy retry on unmount', async () => {
    vi.useFakeTimers()
    summaryMock.mockRejectedValueOnce(busy).mockResolvedValue(summary)
    const { unmount } = render(<SummaryView boardId={1} columns={[]} />)
    await vi.advanceTimersByTimeAsync(100)
    unmount()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(summaryMock).toHaveBeenCalledTimes(1)
  })
})
