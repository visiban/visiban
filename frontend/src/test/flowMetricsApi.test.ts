import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ default: { get: vi.fn() } }))

import client from '../api/client'
import {
  getFlowCumulativeDay, getFlowCumulativeFlow, getFlowCycleTime, getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'

const get = vi.mocked(client.get)

describe('flow metrics API', () => {
  beforeEach(() => {
    get.mockReset()
    get.mockResolvedValue({ data: { ok: true } })
  })

  it.each([
    ['cycle-time', getFlowCycleTime],
    ['throughput', getFlowThroughput],
    ['cumulative-flow', getFlowCumulativeFlow],
    ['wip-age', getFlowWipAge],
  ])('%s sends only the filters that are set', async (metric, call) => {
    await expect(call(3, { days: 90, swimlaneId: null, labelId: null })).resolves.toEqual({ ok: true })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, { params: { days: 90 } })
    await call(3, { days: 30, swimlaneId: 5, labelId: 6 })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, {
      params: { days: 30, swimlane_id: 5, label_id: 6 },
    })
  })

  it('asks for one cumulative-flow day under the same filters', async () => {
    await getFlowCumulativeDay(3, { days: 30, swimlaneId: 5, labelId: null }, '2026-06-02')
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/cumulative-flow/', {
      params: { days: 30, swimlane_id: 5, date: '2026-06-02' },
    })
  })
})
