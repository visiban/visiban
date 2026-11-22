import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { useRef } from 'react'
import type { ComponentProps } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsOverview from '../components/Board/flowMetrics/AnalyticsOverview'
import { useAnalyticsFilters } from '../components/Board/flowMetrics/useAnalyticsFilters'
import {
  breakdownFields, breakdownKey, breakdownNote, breakdownNoun, breakdownParams, cardGroupColor, groupIndexOf, groupName,
  groupNamesOf, inGroup, markOpacity,
} from '../components/Board/flowMetrics/breakdown'
import ThroughputChart from '../components/Board/flowMetrics/ThroughputChart'
import WipAgeChart from '../components/Board/flowMetrics/WipAgeChart'
import CycleTimeChart from '../components/Board/flowMetrics/CycleTimeChart'
import AnalyticsFilterBar from '../components/Board/flowMetrics/AnalyticsFilterBar'
import { GROUP_COLORS, groupColor, groupTint } from '../utils/chartScale'
import type {
  FlowAttention, FlowBlocked, FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowGroupBase, FlowThroughput, FlowWipAge,
} from '../types'

vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).withOverview({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
  getFlowDwell: vi.fn(),
  getFlowBlocked: vi.fn(),
  getFlowAttention: vi.fn(),
}))
vi.mock('../api/cards', () => ({ getCardMovements: vi.fn() }))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))

import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell, getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'
import { getCardMovements } from '../api/cards'
import { getBoardAnalytics } from '../api/boards'

const cycleMock = vi.mocked(getFlowCycleTime)
const throughputMock = vi.mocked(getFlowThroughput)
const ageMock = vi.mocked(getFlowWipAge)
const dwellMock = vi.mocked(getFlowDwell)

const cardA: FlowCard = { uid: 'a'.repeat(16), id: 1, title: 'Fix the login', archived: false, assignee: null, swimlane: { id: 1, name: 'Lane' } }
const cardB: FlowCard = { uid: 'b'.repeat(16), id: 2, title: 'Ship the docs', archived: false, assignee: null, swimlane: { id: 1, name: 'Lane' } }

const group = (key: string | null, name: string | null): FlowGroupBase => ({ key, name, member_keys: key === null ? ['x', 'y'] : [key] })
const THREE = [group('1', 'Platform'), group('2', 'Growth'), group('3', 'Support')]
const WITH_OTHER = [...THREE, group('4', 'Mobile'), group('5', 'Web'), group(null, null)]

const baseCycle: FlowCycleTime = {
  definition: 'cycle definition', sample_size: 7, excluded_incomplete_history: 0,
  percentiles: { p50: 4, p85: 8, p95: null },
  samples: [
    { card_uid: cardA.uid, value_days: 8, start: '2026-06-01T00:00:00Z', end: '2026-06-09T03:00:00Z', reopened: false },
    { card_uid: cardB.uid, value_days: 3, start: '2026-06-01T00:00:00Z', end: '2026-06-04T12:00:00Z', reopened: false },
  ],
  cards: [cardA, cardB],
}
const baseThroughput: FlowThroughput = {
  definition: 'tp', period: 'week', total: 3, median: 1,
  samples: [{ start: '2026-06-01', count: 3, card_uids: [cardA.uid, cardB.uid], started: 1 }, { start: '2026-06-08', count: 0, card_uids: [], started: 0 }],
  cards: [cardA, cardB],
}
const cumulative: FlowCumulativeFlow = {
  definition: 'cf',
  columns: [
    { column_uid: 'col-doing', column_name: 'Doing', is_done: false, start_count: 0, end_count: 0, entered: 0, left: 0, entered_per_week: 0, left_per_week: 0 },
    { column_uid: 'col-done', column_name: 'Done', is_done: true, start_count: 0, end_count: 0, entered: 0, left: 0, entered_per_week: 0, left_per_week: 0 },
  ],
  days: [{ date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0 } }, { date: '2026-06-02', counts: { 'col-doing': 2, 'col-done': 3 } }],
  bottleneck_column_uid: null,
}
const baseAge: FlowWipAge = {
  definition: 'age', sample_size: 2, excluded_incomplete_history: 0,
  cycle_time_percentiles: { p50: 4, p85: 8, p95: 12 },
  columns: [{ column_uid: 'col-doing', column_name: 'Doing' }],
  samples: [
    { card_uid: cardA.uid, column_uid: 'col-doing', value_days: 10, start: '2026-06-01T00:00:00Z', dwell_by_column: [], is_blocked: false, blocked_days: 0 },
    { card_uid: cardB.uid, column_uid: 'col-doing', value_days: 2, start: '2026-06-01T00:00:00Z', dwell_by_column: [], is_blocked: false, blocked_days: 0 },
  ],
  cards: [cardA, cardB],
}
const baseDwell: FlowDwell = {
  definition: 'dwell', sample_size: 7, excluded_incomplete_history: 0,
  columns: [{ column_uid: 'col-doing', column_name: 'Doing', sample_size: 7, percentiles: { p50: 2.1, p85: 5, p95: null } }],
}
const blocked: FlowBlocked = { definition: 'b', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0 }
const attention: FlowAttention = { definition: 'a', stalled_threshold_days: 7, cycle_time_percentiles: { p50: 4, p85: 8, p95: 12 }, items: [], cards: [] }

/** Every endpoint answers grouped when called with a grouping (third argument), plain otherwise. */
function mockEndpoints(groups: FlowGroupBase[] = THREE, by: 'swimlane' | 'label' | 'custom_field' = 'swimlane', fieldId: number | null = null) {
  const grouping = <G extends FlowGroupBase>(extra: (g: FlowGroupBase, i: number) => G) => ({ by, field_id: fieldId, excluded: 0, overlapping: false, groups: groups.map((group, i) => extra(group, i)) })
  cycleMock.mockImplementation(async (_b, _f, g) => g ? {
    ...baseCycle,
    samples: [{ ...baseCycle.samples[0], group_keys: ['1'] }, { ...baseCycle.samples[1], group_keys: ['2'] }],
    grouping: grouping((x) => ({ ...x, sample_size: 3, percentiles: baseCycle.percentiles })),
  } : baseCycle)
  throughputMock.mockImplementation(async (_b, _f, g) => g ? {
    ...baseThroughput,
    samples: [
      { ...baseThroughput.samples[0], by_group: groups.map((x, i) => ({ key: x.key, count: i === 0 ? 2 : i === 1 ? 1 : 0, card_uids: [] })) },
      { ...baseThroughput.samples[1], by_group: groups.map((x) => ({ key: x.key, count: 0, card_uids: [] })) },
    ],
    grouping: grouping((x) => ({ ...x, total: 1, median: 1 })),
  } : baseThroughput)
  ageMock.mockImplementation(async (_b, _f, g) => g ? {
    ...baseAge,
    samples: [{ ...baseAge.samples[0], group_keys: ['1'] }, { ...baseAge.samples[1], group_keys: ['2'] }],
    grouping: grouping((x) => ({ ...x, sample_size: 1 })),
  } : baseAge)
  dwellMock.mockImplementation(async (_b, _f, g) => g ? {
    ...baseDwell,
    grouping: grouping((x, i) => ({ ...x, sample_size: 3, columns: [{ ...baseDwell.columns[0], percentiles: { p50: 1 + i, p85: 5, p95: null } }] })),
  } : baseDwell)
  vi.mocked(getFlowCumulativeFlow).mockResolvedValue(cumulative)
  vi.mocked(getFlowBlocked).mockResolvedValue(blocked)
  vi.mocked(getFlowAttention).mockResolvedValue(attention)
  vi.mocked(getBoardAnalytics).mockResolvedValue(null)
}

function Host(extra: Partial<ComponentProps<typeof AnalyticsOverview>>) {
  const { filters, setFilters } = useAnalyticsFilters()
  const headingRef = useRef<HTMLHeadingElement>(null)
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>Analytics</h1>
      <AnalyticsOverview boardId={9} swimlanes={[{ id: 3, name: 'Customer A' }]} labels={[{ id: 4, name: 'Urgent' }]}
        {...extra} filters={filters} onFiltersChange={setFilters} headingRef={headingRef} />
    </>
  )
}

const FIELDS = [
  { id: 11, name: 'Size', field_type: 'dropdown' as const, position: 1 },
  { id: 12, name: 'Notes', field_type: 'text' as const, position: 0 },
  { id: 13, name: 'Urgent?', field_type: 'checkbox' as const, position: 2 },
]

async function renderLoaded(extra: Partial<ComponentProps<typeof AnalyticsOverview>> = {}) {
  render(<Host customFields={FIELDS} {...extra} />)
  await screen.findByTestId('flow-cycle-time')
}
const pick = (name: string) => userEvent.click(screen.getByRole('button', { name: `Break down by ${name}` }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCardMovements).mockResolvedValue([])
  mockEndpoints()
})

describe('Break down by control (#2268)', () => {
  it('offers None, Swimlane, Label and one entry per dropdown or checkbox card field, None active with its mark', async () => {
    await renderLoaded()
    const group = screen.getByRole('group', { name: 'Break down by' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['None', 'Swimlane', 'Label', 'Size', 'Urgent?'])
    // A bordered control with a hover fill rests on bg-surface so the page ground never shows through it (#2311).
    expect(group.className).toContain('bg-surface')
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
    expect(within(buttons[0]).getByTestId('active-mark')).toBeInTheDocument()
    expect(within(buttons[1]).queryByTestId('active-mark')).toBeNull()
  })

  it('with None the requests carry no grouping and there is no legend, colored summary or group column', async () => {
    await renderLoaded()
    expect(cycleMock).toHaveBeenCalledWith(9, { days: 90, swimlaneId: null, labelId: null })
    expect(screen.queryByTestId('group-legend')).toBeNull()
    expect(screen.queryByTestId('time-bar-groups')).toBeNull()
    expect(screen.getByTestId('flow-throughput').querySelector('[data-stacked-week]')).toBeNull()
    expect(screen.getByTestId('flow-cycle-time')).not.toHaveTextContent(/colored by/i)
  })

  it('breaking down by swimlane refetches the four breakdown endpoints with the grouping and moves the mark', async () => {
    await renderLoaded()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
    for (const mock of [cycleMock, throughputMock, ageMock, dwellMock]) {
      expect(mock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: null, labelId: null }, { by: 'swimlane' })
    }
    expect(screen.getByRole('button', { name: 'Break down by swimlane' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Break down by none' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(screen.getByTestId('group-legend')).getAllByTestId('group-chip').map((c) => c.textContent)).toEqual(['Platform', 'Growth', 'Support'])
  })

  it('a custom field entry sends its id and names the field in the legend', async () => {
    mockEndpoints(THREE, 'custom_field', 11)
    await renderLoaded()
    await pick('size')
    const legend = await screen.findByTestId('group-legend')
    expect(cycleMock).toHaveBeenLastCalledWith(9, expect.anything(), { by: 'custom_field', fieldId: 11 })
    expect(legend).toHaveTextContent('Colored by Size')
    expect(legend).toHaveTextContent('Cards with no value for this field are left out.')
  })

  it('a member sees the same card-field entries: card fields carry no admin-only flag', async () => {
    await renderLoaded({ currentUserRole: 'member' })
    expect(within(screen.getByRole('group', { name: 'Break down by' })).getAllByRole('button').map((b) => b.textContent))
      .toContain('Size')
  })

  it('a label breakdown says a card is counted once in each label', async () => {
    mockEndpoints(THREE, 'label')
    await renderLoaded()
    await pick('label')
    expect(await screen.findByTestId('group-legend')).toHaveTextContent('counted once in each')
  })

  it('more than five groups show five plus a neutral Other chip', async () => {
    mockEndpoints(WITH_OTHER)
    await renderLoaded()
    await pick('swimlane')
    const chips = await screen.findAllByTestId('group-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Platform', 'Growth', 'Support', 'Mobile', 'Web', 'Other'])
    const dot = (chip: HTMLElement) => (chip.querySelectorAll('span[aria-hidden]')[1] as HTMLElement).style.backgroundColor
    expect(dot(chips[5])).toBe('rgb(var(--fg-tertiary))')
    expect(dot(chips[0])).toBe('rgb(var(--chart-cat-1))')
  })
})

describe('what each chart does under a breakdown (#2268)', () => {
  beforeEach(async () => {
    await renderLoaded()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
  })

  it('Where the time goes draws one bar per group with its dot, on one scale', () => {
    const rows = screen.getAllByTestId('time-bar-group')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Platform'), expect.stringContaining('Growth'), expect.stringContaining('Support')])
    expect(within(screen.getAllByTestId('time-bar-group')[0]).getByRole('img').parentElement).toBeTruthy()
    expect(screen.getAllByTestId('time-group-total').map((t) => t.textContent)).toEqual(['1.0d', '2.0d', '3.0d'])
  })

  it('Throughput stacks one segment per group and names the stack in its summary and table', async () => {
    const panel = screen.getByTestId('flow-throughput')
    expect(panel).toHaveTextContent('Bars are stacked by swimlane.')
    expect(panel.querySelectorAll('[data-stacked-week="2026-06-01"] rect')).toHaveLength(2)
    await userEvent.click(within(panel).getByRole('button', { name: /table/i }))
    expect(within(panel).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['Platform (swimlane)', 'Growth (swimlane)', 'Support (swimlane)']))
  })

  it('Aging and Cycle time take the group color and gain a group column in the table', async () => {
    const age = screen.getByTestId('flow-wip-age')
    expect(age).toHaveTextContent('Marks are colored by swimlane.')
    expect([...age.querySelectorAll('[data-group-color]')].map((e) => e.getAttribute('data-group-color')))
      .toEqual(['rgb(var(--chart-cat-1))', 'rgb(var(--chart-cat-2))'])
    const cycle = screen.getByTestId('flow-cycle-time')
    expect(cycle).toHaveTextContent('Dots are colored by swimlane.')
    expect([...cycle.querySelectorAll('circle[data-group-color]')].map((e) => e.getAttribute('data-group-color')))
      .toEqual(['rgb(var(--chart-cat-1))', 'rgb(var(--chart-cat-2))'])
    await userEvent.click(within(cycle).getByRole('button', { name: /table/i }))
    expect(within(cycle).getByRole('columnheader', { name: 'Group (swimlane)' })).toBeInTheDocument()
    expect(within(cycle).getAllByRole('row')[1]).toHaveTextContent('Platform')
  })

  it('Cumulative flow does not change with a breakdown', () => {
    expect(vi.mocked(getFlowCumulativeFlow)).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: null, labelId: null })
  })
})

describe('marks and fallbacks under a breakdown (#2268)', () => {
  it('Aging keeps the ring past P85 and the square for blocked, and draws a card in no group neutral', async () => {
    ageMock.mockImplementation(async (_b, _f, g) => g ? {
      ...baseAge,
      samples: [
        { ...baseAge.samples[0], group_keys: ['1'], is_blocked: true, blocked_days: 2 },
        { ...baseAge.samples[1], group_keys: ['nobody'] },
      ],
      grouping: { by: 'swimlane', field_id: null, excluded: 0, overlapping: false, groups: THREE.map((x) => ({ ...x, sample_size: 1 })) },
    } : baseAge)
    await renderLoaded()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
    const marks = [...screen.getByTestId('flow-wip-age').querySelectorAll('g[data-group-color]')]
    expect(marks.map((m) => m.getAttribute('data-group-color'))).toEqual(['rgb(var(--chart-cat-1))', 'neutral'])
    // 10 days is past P85 (8): ringed, and blocked: a square. The 2-day card is a plain dot.
    expect(marks[0].querySelector('rect')).not.toBeNull()
    expect(marks[0].querySelectorAll('circle')).toHaveLength(1)
    expect(marks[1].querySelector('rect')).toBeNull()
    expect(marks[1].querySelectorAll('circle')).toHaveLength(1)
  })

  it('Cycle time keeps its percentile lines and one dot per card under a breakdown', async () => {
    await renderLoaded()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
    expect(screen.getByTestId('flow-cycle-time').querySelectorAll('circle[data-group-color]')).toHaveLength(2)
  })

  it('Where the time goes says so when a group has no finished-card medians', async () => {
    dwellMock.mockImplementation(async (_b, _f, g) => g ? {
      ...baseDwell,
      grouping: { by: 'swimlane', field_id: null, excluded: 0, overlapping: false, groups: THREE.map((x, i) => ({ ...x, sample_size: 3, columns: i === 2 ? [] : [{ ...baseDwell.columns[0], percentiles: { p50: 1 + i, p85: 5, p95: null } }] })) },
    } : baseDwell)
    await renderLoaded()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
    const rows = screen.getAllByTestId('time-bar-group')
    expect(rows).toHaveLength(3)
    expect(rows[2]).toHaveTextContent('Too few finished cards.')
    expect(rows[0]).not.toHaveTextContent('Too few finished cards.')
  })
})

describe('a breakdown with no groups (#2268)', () => {
  it.each([['swimlane', 'swimlane', 'swimlane'], ['label', 'label', 'label'], ['size', 'Size', 'custom_field']] as const)(
    'says so in the legend\'s place for %s, politely, instead of drawing like None', async (entry, noun, by) => {
      mockEndpoints([], by, by === 'custom_field' ? 11 : null)
      await renderLoaded()
      await pick(entry)
      const note = await screen.findByTestId('group-legend-empty')
      expect(note).toHaveAttribute('role', 'status')
      expect(note).toHaveTextContent(`No cards in this view have a ${noun} to break down by.`)
      expect(screen.queryByTestId('group-legend')).toBeNull()
    })

  it('shows no such line with None or with groups', async () => {
    await renderLoaded()
    expect(screen.queryByTestId('group-legend-empty')).toBeNull()
    await pick('swimlane')
    await screen.findByTestId('group-legend')
    expect(screen.queryByTestId('group-legend-empty')).toBeNull()
  })
})

describe('isolating a group (#2268)', () => {
  const opacityOf = (el: Element) => el.getAttribute('opacity')

  it('selecting a chip keeps that group and drops the rest to 20%, selecting it again shows all, and a new breakdown clears it', async () => {
    await renderLoaded()
    await pick('swimlane')
    const chips = await screen.findAllByTestId('group-chip')
    await userEvent.click(chips[0])
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true')
    expect(within(chips[0]).getByTestId('active-mark')).toBeInTheDocument()
    const cycle = screen.getByTestId('flow-cycle-time')
    expect([...cycle.querySelectorAll('circle[data-group-color]')].map((element) => opacityOf(element))).toEqual(['1', '0.2'])
    const rects = [...screen.getByTestId('flow-throughput').querySelectorAll('[data-stacked-week="2026-06-01"] rect')]
    expect(rects.map((rect) => opacityOf(rect))).toEqual(['1', '0.2'])
    const rows = screen.getAllByTestId('time-bar-group')
    // Only the bar dims; the name and total stay readable.
    expect(within(rows[1]).getByRole('region')).toHaveStyle({ opacity: '0.2' })
    expect(within(rows[0]).getByRole('region').style.opacity).toBe('')
    expect(rows[1].style.opacity).toBe('')
    expect(screen.getByTestId('group-legend')).toHaveTextContent('Select it again')

    await userEvent.click(chips[0])
    expect(chips[0]).toHaveAttribute('aria-pressed', 'false')
    expect([...cycle.querySelectorAll('circle[data-group-color]')].map((element) => opacityOf(element))).toEqual([null, null])

    await userEvent.click(chips[1])
    await pick('label')
    await screen.findByTestId('group-legend')
    expect(screen.getAllByTestId('group-chip').every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true)
  })
})

describe('breakdown helpers', () => {
  it('maps a breakdown to request parameters and a stable key', () => {
    expect(breakdownParams({ by: 'none' })).toBeUndefined()
    expect(breakdownParams({ by: 'label' })).toEqual({ by: 'label' })
    expect(breakdownParams({ by: 'custom_field', fieldId: 5, fieldName: 'Size' })).toEqual({ by: 'custom_field', fieldId: 5 })
    expect(breakdownKey({ by: 'custom_field', fieldId: 5, fieldName: 'Size' })).toBe('custom_field:5')
    expect(breakdownKey({ by: 'swimlane' })).toBe('swimlane')
  })
  it('keeps only dropdown and checkbox fields, in board order', () => {
    expect(breakdownFields(FIELDS).map((f) => f.id)).toEqual([11, 13])
  })
  it('names the color, the groups and the notes', () => {
    expect(breakdownNoun({ by: 'label', field_id: null })).toBe('label')
    expect(breakdownNoun({ by: 'custom_field', field_id: 1 }, 'Size')).toBe('Size')
    expect(breakdownNoun({ by: 'custom_field', field_id: 1 })).toBe('field')
    expect(groupName(group('true', null))).toBe('Yes')
    expect(groupName(group('false', null))).toBe('No')
    expect(groupName(group('weird', null))).toBe('weird')
    expect(groupName(group(null, null))).toBe('Other')
    expect(breakdownNote('swimlane')).toBeNull()
  })
  it('finds a card group, counting a multi-label card in each', () => {
    expect(groupIndexOf(WITH_OTHER, ['2', '1'])).toBe(0)
    expect(groupIndexOf(WITH_OTHER, ['x'])).toBe(5)
    expect(groupIndexOf(WITH_OTHER, [])).toBe(-1)
    expect(groupIndexOf(WITH_OTHER, undefined)).toBe(-1)
    expect(inGroup(WITH_OTHER, 1, ['2', '1'])).toBe(true)
    expect(inGroup(WITH_OTHER, 2, ['2', '1'])).toBe(false)
    expect(groupNamesOf(WITH_OTHER, ['2', '1'])).toEqual(['Platform', 'Growth'])
    expect(groupNamesOf(WITH_OTHER, undefined)).toEqual([])
    expect(cardGroupColor(WITH_OTHER, ['x'])).toBe('rgb(var(--fg-tertiary))')
    expect(cardGroupColor(WITH_OTHER, ['none'])).toBeNull()
    // A multi-label card takes the isolated group's color so its mark agrees with the chip.
    expect(cardGroupColor(WITH_OTHER, ['1', '2'], 1)).toBe('rgb(var(--chart-cat-2))')
    expect(cardGroupColor(WITH_OTHER, ['1', '2'], 2)).toBe('rgb(var(--chart-cat-1))')
    expect(markOpacity(WITH_OTHER, null, ['1'])).toBe(1)
    expect(markOpacity(WITH_OTHER, 1, ['1'])).toBe(0.2)
  })
  it('colors by index, neutral for Other, wrapping after five', () => {
    expect(GROUP_COLORS).toHaveLength(5)
    expect(groupColor(0)).toBe('rgb(var(--chart-cat-1))')
    expect(groupColor(5)).toBe('rgb(var(--chart-cat-1))')
    expect(groupColor(5, true)).toBe('rgb(var(--fg-tertiary))')
    expect(groupTint(1, 0.5)).toBe('rgb(var(--chart-cat-2) / 0.5)')
  })
})

// The five tokens are drawn on the chart panel (surface), the page behind the legend (canvas or sunken) and
// hover fills; each must hold the 3:1 non-text contrast of WCAG 1.4.11 on every one, in both themes.
const css = readFileSync('src/index.css', 'utf8')
const darkBlock = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="light"] {'))
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'))
const hueOf = ([r, g, b]: number[]) => {
  const max = Math.max(r, g, b); const d = max - Math.min(r, g, b)
  return ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360
}
const rgbOf = (block: string, name: string): number[] => {
  const line = block.split('\n').find((l) => l.trim().startsWith(`--${name}:`))
  if (!line) throw new Error(`--${name} missing`)
  return line.slice(line.indexOf(':') + 1).split(';')[0].trim().split(/\s+/).map(Number)
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

describe('--chart-cat-* tokens (#2268)', () => {
  const surfaces = ['surface', 'surface-sunken', 'surface-page', 'canvas', 'surface-hover']
  const names = [1, 2, 3, 4, 5].map((n) => `chart-cat-${n}`)
  it.each([['dark', darkBlock], ['light', lightBlock]])('clears 3:1 on every surface in the %s theme', (_t, block) => {
    for (const n of names) for (const s of surfaces) {
      expect(ratio(rgbOf(block, n), rgbOf(block, s)), `${n} on ${s}`).toBeGreaterThanOrEqual(3)
    }
  })
  it('is distinct from every other group color, and none is orange, red or green', () => {
    for (const block of [darkBlock, lightBlock]) {
      const vals = names.map((n) => rgbOf(block, n))
      expect(new Set(vals.map((v) => v.join(','))).size).toBe(5)
      for (const [r, g, b] of vals) {
        // Hue in degrees: red sits at 0 (350 to 20), green between 80 and 165. Yellow and pink fall outside both.
        const max = Math.max(r, g, b); const min = Math.min(r, g, b)
        const d = max - min
        const hue = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360
        expect(hue >= 350 || hue < 20 || (hue >= 80 && hue <= 165), `${r} ${g} ${b} hue ${hue}`).toBe(false)
      }
      // Orange (about 10 to 45 degrees) reads as the warning tint, so no token sits there ...
      for (const n of names.filter((x) => x !== 'chart-cat-5')) {
        const hue = hueOf(rgbOf(block, n))
        expect(hue >= 10 && hue < 45, `${n} hue ${hue}`).toBe(false)
      }
      // ... except cat-5, spec-mandated (analytics-redesign.md § Chart colors): it is a yellow-orange kept apart
      // from the warning tint by contrast alone, and a group's name never relies on color.
      const cat5 = hueOf(rgbOf(block, 'chart-cat-5'))
      expect(cat5 >= 30 && cat5 < 70, `chart-cat-5 hue ${cat5}`).toBe(true)
    }
  })
  it('is exposed to Tailwind', () => {
    const tw = readFileSync('tailwind.config.js', 'utf8')
    for (const n of names) expect(tw).toContain(`"${n}": "rgb(var(--${n}) / <alpha-value>)"`)
  })
})

describe('isolation follows the groups on screen (#2268)', () => {
  it('drops the isolation when a filter changes which groups come back', async () => {
    await renderLoaded()
    await pick('swimlane')
    const chips = await screen.findAllByTestId('group-chip')
    await userEvent.click(chips[1])
    expect(chips[1]).toHaveAttribute('aria-pressed', 'true')
    mockEndpoints([group('9', 'Other team'), ...THREE])
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await screen.findByRole('button', { name: 'Other team' })
    expect(screen.getAllByTestId('group-chip').every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true)
  })
})

describe('marks stay legible and None renders the pre-breakdown DOM (#2268)', () => {
  const noop = () => {}
  const g = (key: string, name: string): FlowGroupBase => ({ key, name, member_keys: [key] })
  const two = [g('1', 'Platform'), g('2', 'Growth')]
  const tp = (count: number, parts: number[], started = 0) => ({
    definition: 'tp', period: 'week', total: count, median: null, cards: [],
    samples: [{ start: '2026-06-01', count, card_uids: [], started, by_group: parts.map((n, i) => ({ key: String(i + 1), count: n, card_uids: [] })) }],
    grouping: { by: 'label', field_id: null, excluded: 0, overlapping: true, groups: two },
  }) as unknown as FlowThroughput
  const stackBox = (c: HTMLElement) => {
    const rects = [...c.querySelectorAll('[data-stacked-week] rect')]
    const ys = rects.map((r) => Number(r.getAttribute('y')))
    const bottoms = rects.map((r) => Number(r.getAttribute('y')) + Number(r.getAttribute('height')))
    return { top: Math.min(...ys), bottom: Math.max(...bottoms), label: Number(c.querySelector('[data-stacked-week] text')!.getAttribute('y')) }
  }

  it('Throughput scales to a stack that sums above the count (a card counts once per label) and labels above it', () => {
    const { container } = render(<ThroughputChart data={tp(2, [2, 2])} labelledBy="x" onSelect={noop} />)
    const { top, label } = stackBox(container)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(label).toBeLessThan(top)
    expect(label).toBeGreaterThan(0)
    expect(screen.queryAllByText('2').length).toBeGreaterThan(0)
  })

  it('Throughput scales and labels a stack shorter than the printed total (excluded cards)', () => {
    const { container } = render(<ThroughputChart data={tp(5, [1, 1])} labelledBy="x" onSelect={noop} />)
    const { top, label } = stackBox(container)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(label).toBeLessThan(top)
  })

  const cards = [cardA]
  const age = () => ({
    definition: 'a', sample_size: 1, excluded_incomplete_history: 0, cycle_time_percentiles: { p50: 1, p85: 2, p95: 3 },
    columns: [{ column_uid: 'c', column_name: 'Doing' }], cards,
    samples: [{ card_uid: cardA.uid, column_uid: 'c', value_days: 9, start: '2026-06-01T00:00:00Z', dwell_by_column: [], is_blocked: false, blocked_days: 0, group_keys: ['1'] }],
    grouping: { by: 'swimlane', field_id: null, excluded: 0, overlapping: false, groups: two },
  }) as unknown as FlowWipAge
  const renderAge = (data: FlowWipAge, isolated: number | null) =>
    render(<WipAgeChart data={data} cards={new Map(cards.map((c) => [c.uid, c]))} labelledBy="x" onSelect={noop} isolated={isolated} />)

  it('Aging dims the mark of an isolated-out card but keeps its printed name at full strength', () => {
    const { container } = renderAge(age(), 1)
    const text = container.querySelector('text.fill-fg')!
    expect(text).toHaveTextContent(/Fix the/)
    expect(text.closest('[opacity]')).toBeNull()
    expect(container.querySelector('g[data-age-color] > g[opacity="0.2"] circle')).not.toBeNull()
  })

  it('None emits no opacity attribute on Aging and Cycle time marks', () => {
    const plain = age(); delete (plain as { grouping?: unknown }).grouping
    const a = renderAge(plain, null)
    expect(a.container.querySelector('[opacity]')).toBeNull()
    const cycle = {
      definition: 'c', sample_size: 1, excluded_incomplete_history: 0, percentiles: { p50: 1, p85: 2, p95: null }, cards,
      samples: [{ card_uid: cardA.uid, value_days: 3, start: '2026-06-01T00:00:00Z', end: new Date().toISOString(), reopened: false }],
    } as unknown as FlowCycleTime
    const c = render(<CycleTimeChart data={cycle} cards={new Map()} days={30} labelledBy="y" onSelect={noop} />)
    expect(c.container.querySelector('[opacity]')).toBeNull()
  })

  it('None keeps the Export wrapper right-aligned as before', () => {
    render(<AnalyticsFilterBar filters={{ days: 90, swimlaneId: null, labelId: null }} onFiltersChange={noop} swimlanes={[]} labels={[]}
      breakdown={{ by: 'none' }} onBreakdownChange={noop} actions={<span data-testid="act" />} />)
    expect(screen.getByTestId('act').parentElement!.className).toBe('ml-auto flex items-center gap-2')
  })
})
