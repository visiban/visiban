import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import TimeBar from '../components/Board/flowMetrics/TimeBar'
import type { FlowRowColumn } from '../components/Board/flowMetrics/flowRowData'

const col = (uid: string, medianWait: number | null, over: Partial<FlowRowColumn> = {}): FlowRowColumn => ({
  uid, name: uid.toUpperCase(), count: 1, limit: null, medianWait, enteredPerWeek: null, queueDelta: null, note: '', bottleneck: false, ...over,
})

describe('Where the time goes: the sum of medians is not a silent total (#2293)', () => {
  it('says how many columns were left out of the ungrouped bar', () => {
    render(<TimeBar columns={[col('a', 2), col('b', null), col('c', 0), col('d', 3)]} />)
    expect(screen.getByTestId('time-total')).toHaveTextContent('5.0d')
    // Only the null median is withheld; the 0-day median had enough data.
    expect(screen.getByTestId('time-omitted')).toHaveTextContent('1 column without enough data left out')
    expect(screen.getByTestId('time-omitted')).not.toHaveTextContent('2 columns')
    expect(screen.getByRole('list', { name: 'Time bar legend' })).toHaveTextContent('A 2.0d')
    expect(screen.getByRole('img')).toHaveAccessibleName(/Sum of medians 5\.0d, 1 column without enough data left out/)
    expect(screen.getByTestId('time-footnote')).toHaveTextContent('not the cycle time')
  })

  it('adds no omitted note when every column has a median, and uses the singular for one', () => {
    const { rerender } = render(<TimeBar columns={[col('a', 2), col('b', 3)]} />)
    expect(screen.queryByTestId('time-omitted')).toBeNull()
    rerender(<TimeBar columns={[col('a', 2), col('b', null)]} />)
    expect(screen.getByTestId('time-omitted')).toHaveTextContent('1 column without enough data left out')
  })

  it('says it for each group in the grouped bar', () => {
    const columns = [col('a', 2), col('b', 3), col('c', 1)]
    const groups = [
      { name: 'Platform', color: 'red', medians: new Map<string, number | null>([['a', 2], ['b', 3], ['c', 1]]) },
      { name: 'Growth', color: 'blue', medians: new Map<string, number | null>([['a', 2], ['b', null]]) },
    ]
    render(<TimeBar columns={columns} groups={groups} />)
    const rows = screen.getAllByTestId('time-bar-group')
    expect(within(rows[0]).queryByTestId('time-group-omitted')).toBeNull()
    expect(within(rows[0]).getByTestId('time-group-total')).toHaveTextContent('6.0d')
    expect(within(rows[1]).getByTestId('time-group-omitted')).toHaveTextContent('2 columns without enough data left out')
    expect(within(rows[1]).getByRole('img')).toHaveAccessibleName(/Sum of medians 2\.0d, 2 columns without enough data left out/)
    expect(screen.getByTestId('time-footnote')).toHaveTextContent('not the cycle time')
  })

  it('sizes segments by their median, with no minimum width, and drops the number from a sliver', () => {
    render(<TimeBar columns={[col('a', 0.1), col('b', 10)]} />)
    const segments = screen.getAllByTestId('time-segment')
    expect(segments.map((s) => s.style.flexGrow)).toEqual(['0.1', '10'])
    segments.forEach((s) => expect(s.className).not.toContain('min-w-[2.25rem]'))
    expect(segments[0]).toHaveTextContent('')
    expect(segments[1]).toHaveTextContent('10.0')
    // The sliver's number stays reachable in the legend.
    expect(screen.getByRole('list', { name: 'Time bar legend' })).toHaveTextContent('A 0.1d')
  })

  it('names a narrow segment on hover and in the accessible name, in the single and the grouped bar', () => {
    const columns = [col('a', 0.1), col('b', 10)]
    const { unmount } = render(<TimeBar columns={columns} />)
    expect(screen.getAllByTestId('time-segment')[0]).toHaveAttribute('title', 'A 0.1d')
    expect(screen.getByRole('img')).toHaveAccessibleName(/A 0\.1d, B 10\.0d/)
    unmount()
    const groups = [{ name: 'Platform', color: 'red', medians: new Map<string, number | null>([['a', 0.1], ['b', 10]]) }]
    render(<TimeBar columns={columns} groups={groups} />)
    const sliver = screen.getAllByTestId('time-segment')[0]
    expect(sliver).toHaveTextContent('')
    expect(sliver).toHaveAttribute('title', 'A 0.1d')
    expect(screen.getByRole('img')).toHaveAccessibleName(/A 0\.1d, B 10\.0d/)
  })

  it('names only the columns in the legend under a breakdown, not the all-cards medians (#2287)', () => {
    const groups = [{ name: 'Platform', color: 'red', medians: new Map<string, number | null>([['a', 7], ['b', 9]]) }]
    render(<TimeBar columns={[col('a', 2), col('b', 3)]} groups={groups} />)
    const legend = screen.getByRole('list', { name: 'Time bar legend' })
    expect(legend).toHaveTextContent('A')
    expect(legend).not.toHaveTextContent('2.0d')
    expect(legend).not.toHaveTextContent('3.0d')
  })
})

describe('time bar surfaces (#2311)', () => {
  it('uses the panel surface for the gutter, a shadowed chip and a secondary-ink legend', () => {
    render(<TimeBar columns={[col('a', 5), col('b', 5)]} />)
    expect(screen.getByRole('img').className).toContain('bg-surface')
    expect(screen.getByRole('img').className).not.toContain('bg-line')
    expect(screen.getAllByText('5.0')[0].className).toContain('shadow-sm')
    expect(screen.getByRole('list', { name: 'Time bar legend' }).className).toContain('text-fg-secondary')
  })
})
