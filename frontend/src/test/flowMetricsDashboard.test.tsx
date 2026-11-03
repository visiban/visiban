import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FlowMetricsDashboard from '../components/Board/flowMetrics/FlowMetricsDashboard'
import {
  ageMarkLabel, cumulativeFlowSummary, cycleTimeSummary, excludedNote, sparseNote, throughputSummary, wipAgeSummary,
} from '../components/Board/flowMetrics/flowFormat'
import type {
  FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowThroughput, FlowWipAge,
} from '../types'

vi.mock('../api/flowMetrics', () => ({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
}))
vi.mock('../api/cards', () => ({ getCardMovements: vi.fn() }))

import {
  getFlowCumulativeDay, getFlowCumulativeFlow, getFlowCycleTime, getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'
import { getCardMovements } from '../api/cards'

const cycleMock = vi.mocked(getFlowCycleTime)
const throughputMock = vi.mocked(getFlowThroughput)
const cumulativeMock = vi.mocked(getFlowCumulativeFlow)
const dayMock = vi.mocked(getFlowCumulativeDay)
const ageMock = vi.mocked(getFlowWipAge)
const movementsMock = vi.mocked(getCardMovements)

const owner = { id: 7, username: 'pat', display_name: 'Pat Lee', avatar_url: '' }
const cardA: FlowCard = { uid: 'a'.repeat(16), id: 1, title: 'Fix the login', archived: false, assignee: owner }
const cardB: FlowCard = { uid: 'b'.repeat(16), id: 2, title: 'Old archived job', archived: true, assignee: null }

const cycle: FlowCycleTime = {
  definition: 'cycle definition',
  sample_size: 7,
  excluded_incomplete_history: 2,
  percentiles: { p50: 4.04, p85: 8.14, p95: null },
  samples: [
    { card_uid: cardA.uid, value_days: 8.14, start: '2026-06-01T00:00:00Z', end: '2026-06-09T03:00:00Z', reopened: false },
    { card_uid: cardB.uid, value_days: 2.5, start: '2026-06-01T00:00:00Z', end: '2026-06-03T12:00:00Z', reopened: true },
  ],
  cards: [cardA, cardB],
}
const throughput: FlowThroughput = {
  definition: 'throughput definition',
  period: 'week',
  total: 2,
  median: 1,
  samples: [
    { start: '2026-06-01', count: 2, card_uids: [cardA.uid, cardB.uid] },
    { start: '2026-06-08', count: 0, card_uids: [] },
  ],
  cards: [cardA, cardB],
}
const cumulative: FlowCumulativeFlow = {
  definition: 'cumulative definition',
  columns: [
    { column_uid: 'col-doing', column_name: 'Doing', is_done: false },
    { column_uid: 'col-done', column_name: 'Done', is_done: true },
    { column_uid: null, column_name: null, is_done: false },
  ],
  days: [
    { date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0, null: 0 } },
    { date: '2026-06-02', counts: { 'col-doing': 2, 'col-done': 3, null: 0 } },
  ],
  bottleneck_column_uid: 'col-doing',
}
const age: FlowWipAge = {
  definition: 'age definition',
  sample_size: 1,
  excluded_incomplete_history: 0,
  cycle_time_percentiles: { p50: 4, p85: 8, p95: 12 },
  columns: [{ column_uid: 'col-doing', column_name: 'Doing' }, { column_uid: 'col-review', column_name: 'Review' }],
  samples: [{
    card_uid: cardA.uid,
    column_uid: 'col-doing',
    value_days: 15.44,
    start: '2026-06-01T00:00:00Z',
    dwell_by_column: [
      { column_uid: 'col-doing', value_days: 10 },
      { column_uid: null, value_days: 5.44 },
    ],
    is_blocked: true,
    blocked_days: 1.5,
  }],
  cards: [cardA],
}

function mockAll(overrides: Partial<{
  cycle: FlowCycleTime; throughput: FlowThroughput; cumulative: FlowCumulativeFlow; age: FlowWipAge
}> = {}) {
  cycleMock.mockResolvedValue(overrides.cycle ?? cycle)
  throughputMock.mockResolvedValue(overrides.throughput ?? throughput)
  cumulativeMock.mockResolvedValue(overrides.cumulative ?? cumulative)
  ageMock.mockResolvedValue(overrides.age ?? age)
}

const empty = {
  cycle: { ...cycle, sample_size: 0, excluded_incomplete_history: 0, percentiles: { p50: null, p85: null, p95: null }, samples: [], cards: [] },
  throughput: { ...throughput, total: 0, median: 0, samples: [{ start: '2026-06-01', count: 0, card_uids: [] }], cards: [] },
  cumulative: { ...cumulative, days: [{ date: '2026-06-01', counts: { 'col-doing': 0, 'col-done': 0, null: 0 } }], bottleneck_column_uid: null },
  age: { ...age, sample_size: 0, samples: [], cards: [], cycle_time_percentiles: { p50: null, p85: null, p95: null } },
}

const props = {
  boardId: 9,
  swimlanes: [{ id: 3, name: 'Customer A' }],
  labels: [{ id: 4, name: 'Urgent' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  movementsMock.mockResolvedValue([])
})

async function renderLoaded(extra: Partial<Parameters<typeof FlowMetricsDashboard>[0]> = {}) {
  render(<FlowMetricsDashboard {...props} {...extra} />)
  await screen.findByTestId('flow-cycle-time')
}

describe('FlowMetricsDashboard states', () => {
  it('shows skeleton panels with an sr status while loading', () => {
    cycleMock.mockReturnValue(new Promise(() => {}))
    throughputMock.mockReturnValue(new Promise(() => {}))
    cumulativeMock.mockReturnValue(new Promise(() => {}))
    ageMock.mockReturnValue(new Promise(() => {}))
    render(<FlowMetricsDashboard {...props} />)
    expect(screen.getByTestId('flow-loading')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Loading flow metrics')
  })

  it('shows the error state, and Retry refetches', async () => {
    mockAll()
    cycleMock.mockRejectedValueOnce(new Error('no'))
    render(<FlowMetricsDashboard {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load flow metrics.')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('flow-cycle-time')).toBeInTheDocument()
    expect(cycleMock).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state, and Go to board calls back', async () => {
    mockAll(empty)
    const onGoToBoard = vi.fn()
    render(<FlowMetricsDashboard {...props} onGoToBoard={onGoToBoard} />)
    expect(await screen.findByText('No flow history yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Go to board' }))
    expect(onGoToBoard).toHaveBeenCalled()
  })

  it('says the filters match nothing instead of "no history" when one is on', async () => {
    mockAll()
    await renderLoaded()
    mockAll(empty)
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    expect(await screen.findByText('No cards match these filters.')).toBeInTheDocument()
    expect(screen.queryByText('No flow history yet')).not.toBeInTheDocument()
  })

  it('renders four panels with a 90-day default request', async () => {
    mockAll()
    await renderLoaded()
    for (const id of ['flow-cycle-time', 'flow-throughput', 'flow-cumulative', 'flow-wip-age']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    const filters = { days: 90, swimlaneId: null, labelId: null }
    expect(cycleMock).toHaveBeenCalledWith(9, filters)
    expect(throughputMock).toHaveBeenCalledWith(9, filters)
    expect(cumulativeMock).toHaveBeenCalledWith(9, filters)
    expect(ageMock).toHaveBeenCalledWith(9, filters)
  })

  it('ignores an answer to a superseded request', async () => {
    mockAll()
    let release: (value: FlowCycleTime) => void = () => {}
    cycleMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    render(<FlowMetricsDashboard {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    const panel = await screen.findByTestId('flow-cycle-time')
    expect(panel).toHaveTextContent('85% of 7 cards')
    release({ ...cycle, sample_size: 99 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByTestId('flow-cycle-time')).not.toHaveTextContent('99 cards')
  })

  it('refetches with each filter, and the default range does not read as an active filter', async () => {
    mockAll()
    await renderLoaded()
    const range = screen.getByRole('button', { name: 'Date range: Last 90 days' })
    expect(range.className).not.toContain('border-info')
    await userEvent.click(range)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: null }))
    await screen.findByTestId('flow-cycle-time')
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: 4 }))
    await screen.findByTestId('flow-cycle-time')
    expect(screen.getByRole('button', { name: 'Date range: Last 30 days' }).className).toContain('border-info')
    // Clearing the date range falls back to the default rather than no range.
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: null, labelId: 4 }))
  })
})

describe('the panels', () => {
  beforeEach(() => mockAll())

  it('names each chart by its heading and summary, and quotes the definition', async () => {
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cycle-time'))
    expect(panel.getByRole('heading', { name: 'Cycle time' })).toBeInTheDocument()
    expect(panel.getByRole('img')).toHaveAccessibleName('Cycle time 85% of 7 cards finished within 8.1d.')
    expect(panel.getByText('Cycle time: cycle definition')).toBeInTheDocument()
  })

  it('draws a percentile line only for a percentile the server returned, labelled directly', async () => {
    await renderLoaded()
    const svg = within(screen.getByTestId('flow-cycle-time')).getByRole('img')
    expect(svg).toHaveTextContent('50th · 4.0d')
    expect(svg).toHaveTextContent('85th · 8.1d')
    expect(svg).not.toHaveTextContent('95th')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('Too few cards to draw the higher percentile lines.')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('2 cards left out for missing or broken history.')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('Hollow points were reopened after finishing.')
  })

  it('prints throughput values on the points and labels the median', async () => {
    await renderLoaded()
    const svg = within(screen.getByTestId('flow-throughput')).getByRole('img')
    expect(svg).toHaveTextContent('Median · 1')
    expect(within(screen.getByTestId('flow-throughput')).getAllByRole('button', { name: /^Week of/ })).toHaveLength(1)
  })

  it('hides the median line with a note when it is null', async () => {
    mockAll({ throughput: { ...throughput, median: null } })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-throughput')).getByRole('img')).not.toHaveTextContent('Median')
    expect(screen.getByTestId('flow-throughput')).toHaveTextContent('Too few whole weeks to draw a median.')
  })

  it('hatches the bottleneck, labels bands directly and hides an empty deleted band', async () => {
    await renderLoaded()
    const panel = screen.getByTestId('flow-cumulative')
    const svg = within(panel).getByRole('img')
    expect(svg).toHaveTextContent('Doing')
    expect(svg).toHaveTextContent('Done')
    expect(svg).not.toHaveTextContent('Deleted columns')
    const fill = panel.querySelector('[data-band="col-doing"] polygon')?.getAttribute('fill')
    expect(fill).toMatch(/^url\(#cfd-hatch-/)
    expect(panel.querySelector('[data-band="col-done"] polygon')?.getAttribute('fill')).toContain('--primary-emphasis')
    expect(panel).toHaveTextContent('The hatched band is the bottleneck.')
  })

  it('shows the deleted band when it holds cards', async () => {
    mockAll({
      cumulative: {
        ...cumulative,
        days: [{ date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0, null: 2 } }],
        bottleneck_column_uid: null,
      },
    })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-cumulative')).getByRole('img')).toHaveTextContent('Deleted columns')
  })

  it('squares blocked cards, rings cards past P85, and names them in column order', async () => {
    await renderLoaded()
    const panel = screen.getByTestId('flow-wip-age')
    expect(panel.querySelector('[data-blocked="true"] rect')).not.toBeNull()
    const dot = within(panel).getByRole('button', { name: 'Fix the login, 15.4 days in progress, beyond 95th percentile, blocked' })
    expect(dot).toHaveAttribute('tabindex', '0')
    expect(panel).toHaveTextContent('Squares are blocked cards.')
    expect(panel).toHaveTextContent('Ringed cards are past the 85th percentile.')
    expect(within(panel).getByRole('img')).toHaveTextContent('Fix the l…')
  })

  it('keeps only aging dots in the tab order: other marks are reached through the table', async () => {
    await renderLoaded()
    for (const id of ['flow-cycle-time', 'flow-throughput', 'flow-cumulative']) {
      for (const mark of within(screen.getByTestId(id)).getByRole('group', { name: 'Chart marks' }).querySelectorAll('[role="button"]')) {
        expect(mark).toHaveAttribute('tabindex', '-1')
      }
    }
  })

  it('toggles to a table with a pinned first column in a focusable region', async () => {
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cycle-time'))
    const chartToggle = panel.getByRole('button', { name: 'chart' })
    const tableToggle = panel.getByRole('button', { name: 'table' })
    expect(chartToggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(tableToggle)
    expect(tableToggle).toHaveAttribute('aria-pressed', 'true')
    expect(panel.queryByRole('img')).not.toBeInTheDocument()
    const region = panel.getByRole('region', { name: 'Cycle time per card' })
    expect(region).toHaveAttribute('tabindex', '0')
    const row = within(region).getByRole('button', { name: 'Fix the login' }).closest('tr') as HTMLElement
    expect(within(row).getAllByRole('cell')[0].className).toContain('sticky')
    expect(row).toHaveTextContent('8.1d')
    expect(row).toHaveTextContent('Pat Lee')
    const unowned = within(region).getByRole('button', { name: 'Old archived job' }).closest('tr') as HTMLElement
    expect(unowned).toHaveTextContent('—')
    expect(unowned).toHaveTextContent('Yes')
  })

  it('shows every panel table with its keyboard path', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: 'table' }))
    const weeks = within(screen.getByRole('region', { name: 'Cards finished per week' }))
    expect(weeks.getByRole('button', { name: /2 cards the week of/ })).toBeInTheDocument()
    expect(weeks.getByText('—')).toBeInTheDocument()

    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: 'table' }))
    const days = within(screen.getByRole('region', { name: 'Cards per column per day' }))
    expect(days.getByText('Doing (bottleneck)')).toBeInTheDocument()
    expect(days.queryByText('Deleted columns')).not.toBeInTheDocument()

    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: 'table' }))
    const aging = within(screen.getByRole('region', { name: 'Age per in-progress card' }))
    expect(aging.getByText('15.4d')).toBeInTheDocument()
    expect(aging.getByText('1.5d')).toBeInTheDocument()
    expect(aging.getByText('Pat Lee')).toBeInTheDocument()
  })

  it('an empty table says so', async () => {
    mockAll({ age: empty.age })
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: 'table' }))
    expect(within(screen.getByTestId('flow-wip-age')).getByText('No cards are in progress.', { selector: 'p.py-6' })).toBeInTheDocument()
  })
})

describe('the drill-down drawer', () => {
  beforeEach(() => mockAll())

  it('opens from an aging dot with Enter: age, P85, blocked time, dwell bars, transitions, Open card', async () => {
    movementsMock.mockResolvedValue([
      { id: 2, from_column_name: 'Doing', to_column_name: 'Review', movement_type: 'move', moved_at: '2026-06-02T00:00:00Z', moved_by: owner },
      { id: 1, from_column_name: '', to_column_name: 'Doing', movement_type: 'move', moved_at: '2026-06-01T00:00:00Z', moved_by: null },
    ] as never)
    const onOpenCard = vi.fn()
    await renderLoaded({ onOpenCard })
    const dot = within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ })
    fireEvent.keyDown(dot, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog', { name: 'Fix the login' })
    const body = within(dialog)
    expect(body.getByText('15.4d')).toBeInTheDocument()
    expect(body.getByText('8.0d')).toBeInTheDocument()
    expect(body.getByText('1.5d')).toBeInTheDocument()
    expect(body.getByText('Blocked')).toBeInTheDocument()
    expect(body.getByText('Pat Lee')).toBeInTheDocument()
    expect(body.getByText('Deleted column')).toBeInTheDocument()
    expect(body.getByRole('region', { name: 'Time per column' })).toHaveTextContent('Doing')
    const transitions = await body.findByRole('list', { name: 'Transitions' })
    const rows = within(transitions).getAllByRole('listitem')
    // Oldest first, though the endpoint answers newest first.
    expect(rows[0]).toHaveTextContent('Created in Doing')
    expect(rows[1]).toHaveTextContent('Doing → Review')
    expect(rows[1]).toHaveTextContent('Pat Lee')
    expect(movementsMock).toHaveBeenCalledWith(9, cardA.id)
    await userEvent.click(body.getByRole('button', { name: 'Open card' }))
    expect(onOpenCard).toHaveBeenCalledWith(cardA.id)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens from a cycle-time point; an archived card has no Open card', async () => {
    await renderLoaded({ onOpenCard: vi.fn() })
    await userEvent.click(within(screen.getByTestId('flow-cycle-time')).getByRole('button', { name: /^Old archived job/ }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Old archived job' }))
    expect(dialog.getByText('2.5d')).toBeInTheDocument()
    expect(dialog.getByText('Unassigned')).toBeInTheDocument()
    expect(dialog.getByText('Yes, after finishing')).toBeInTheDocument()
    expect(dialog.getByText('This card is archived.')).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open card' })).not.toBeInTheDocument()
    await dialog.findByText('No recorded transitions.')
  })

  it('lists a week of throughput, opens a card from it, and comes back', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: /^Week of/ }))
    const list = within(await screen.findByRole('dialog', { name: /^Finished the week of/ }))
    expect(list.getByText('Pat Lee')).toBeInTheDocument()
    await userEvent.click(list.getByRole('button', { name: /Fix the login/ }))
    const card = within(await screen.findByRole('dialog', { name: 'Fix the login' }))
    await card.findByText('No recorded transitions.')
    await userEvent.click(card.getByRole('button', { name: /Back/ }))
    expect(await screen.findByRole('dialog', { name: /^Finished the week of/ })).toBeInTheDocument()
  })

  it('fetches a cumulative-flow day with the current filters and groups its cards by column', async () => {
    dayMock.mockResolvedValue({
      definition: 'd',
      date: '2026-06-02',
      columns: [
        { column_uid: 'col-doing', card_uids: [cardA.uid] },
        { column_uid: 'col-done', card_uids: [] },
        { column_uid: null, card_uids: [cardB.uid] },
      ],
      cards: [cardA, cardB],
    })
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cumulative'))
    await userEvent.click(panel.getAllByRole('button', { name: /5 cards$/ })[0])
    const dialog = within(await screen.findByRole('dialog', { name: /^Cards on/ }))
    await dialog.findByRole('region', { name: 'Doing' })
    expect(dayMock).toHaveBeenCalledWith(9, { days: 90, swimlaneId: null, labelId: null }, '2026-06-02')
    expect(dialog.getByRole('region', { name: 'Deleted columns' })).toHaveTextContent('Old archived job')
    expect(dialog.queryByRole('region', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('reports a failed day list and retries it', async () => {
    dayMock.mockRejectedValueOnce(new Error('no'))
    dayMock.mockResolvedValueOnce({ definition: 'd', date: '2026-06-01', columns: [], cards: [] })
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: /1 card$/ }))
    const dialog = within(await screen.findByRole('dialog', { name: /^Cards on/ }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Failed to load these cards.')
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    expect(await dialog.findByText('No cards.')).toBeInTheDocument()
  })

  it('reports failed transitions and retries them', async () => {
    movementsMock.mockRejectedValueOnce(new Error('no'))
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Fix the login' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Failed to load transitions.')
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    expect(await dialog.findByText('No recorded transitions.')).toBeInTheDocument()
  })

  it('closes with Escape and the Close button, and is a modal dialog', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix the login' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await within(dialog).findByText('No recorded transitions.')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    await within(await screen.findByRole('dialog')).findByText('No recorded transitions.')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('labels transitions for archive, restore, swimlane moves and deleted columns', async () => {
    movementsMock.mockResolvedValue([
      { id: 4, from_column_name: 'Doing', to_column_name: '', movement_type: 'move', moved_at: '2026-06-04T00:00:00Z', moved_by: null },
      { id: 3, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'unarchived', moved_at: '2026-06-03T00:00:00Z', moved_by: null },
      { id: 2, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'archived', moved_at: '2026-06-02T00:00:00Z', moved_by: null },
      { id: 1, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'move', moved_at: '2026-06-01T00:00:00Z', moved_by: null },
    ] as never)
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const list = await within(await screen.findByRole('dialog')).findByRole('list', { name: 'Transitions' })
    const rows = within(list).getAllByRole('listitem').map((row) => row.textContent)
    expect(rows[0]).toContain('Changed swimlane in Doing')
    expect(rows[1]).toContain('Archived in Doing')
    expect(rows[2]).toContain('Restored in Doing')
    expect(rows[3]).toContain('Doing → a deleted column')
  })
})

describe('flow summaries', () => {
  it('cycle time says what the percentiles allow', () => {
    expect(cycleTimeSummary(empty.cycle)).toBe('No card with a measurable cycle time finished in this range.')
    expect(cycleTimeSummary({ ...cycle, sample_size: 5, percentiles: { p50: 2, p85: null, p95: null } }))
      .toBe('Half of 5 cards finished within 2.0d.')
    expect(cycleTimeSummary({ ...cycle, sample_size: 1, percentiles: { p50: null, p85: null, p95: null } }))
      .toBe('1 card finished in this range.')
  })

  it('throughput handles no periods, no completions, and a null median', () => {
    expect(throughputSummary({ ...throughput, samples: [] })).toBe('No whole week in this range yet.')
    expect(throughputSummary({ ...throughput, total: 0 })).toBe('No cards finished in the whole weeks of this range.')
    expect(throughputSummary({ ...throughput, median: null, samples: [{ start: 'x', count: 1, card_uids: [] }] }))
      .toBe('1 card finished in the last whole week.')
    expect(throughputSummary(throughput)).toBe('0 cards finished in the last whole week, against a median of 1.')
  })

  it('cumulative flow names the bottleneck or says none grew', () => {
    expect(cumulativeFlowSummary(cumulative)).toBe('Doing grew the most in this range.')
    expect(cumulativeFlowSummary({ ...cumulative, bottleneck_column_uid: null })).toBe('No column that is not done grew in this range.')
    expect(cumulativeFlowSummary({ ...cumulative, days: [] })).toBe('No whole day in this range yet.')
  })

  it('aging counts cards past P85 and copes with no zones', () => {
    expect(wipAgeSummary(empty.age)).toBe('No cards are in progress.')
    expect(wipAgeSummary(age)).toBe('1 of 1 card in progress is past the 85th percentile.')
    expect(wipAgeSummary({ ...age, cycle_time_percentiles: { p50: null, p85: null, p95: null } })).toBe('1 card in progress.')
  })

  it('notes name no number and are absent when not needed', () => {
    expect(sparseNote({ p50: 1, p85: 2, p95: 3 })).toBeNull()
    expect(sparseNote({ p50: null, p85: null, p95: null })).toBe('Too few cards to draw percentile lines.')
    expect(excludedNote(0)).toBeNull()
    expect(excludedNote(1)).toBe('1 card left out for missing or broken history.')
  })

  it('names a mark by its zone', () => {
    const sample = age.samples[0]
    expect(ageMarkLabel({ ...sample, is_blocked: false, value_days: 9 }, 'T', age.cycle_time_percentiles))
      .toBe('T, 9.0 days in progress, beyond 85th percentile')
    expect(ageMarkLabel({ ...sample, is_blocked: false, value_days: 1 }, 'T', age.cycle_time_percentiles))
      .toBe('T, 1.0 days in progress')
  })
})
