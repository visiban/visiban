import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ default: { get: vi.fn() } }))

import { OVERVIEW_LIST_LIMIT } from '../api/analyticsLimits'
import client from '../api/client'
import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeDay, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell,
  getFlowOverview, getFlowSwimlanes, getFlowThroughput, getFlowWipAge,
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
    ['dwell', getFlowDwell],
    ['blocked', getFlowBlocked],
    ['attention', getFlowAttention],
  ])('%s sends only the filters that are set', async (metric, call) => {
    await expect(call(3, { days: 90, swimlaneId: null, labelId: null })).resolves.toEqual({ ok: true })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, { params: { days: 90 } })
    await call(3, { days: 30, swimlaneId: 5, labelId: 6 })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, {
      params: { days: 30, swimlane_id: 5, label_id: 6 },
    })
  })

  it.each([
    ['cycle-time', getFlowCycleTime],
    ['throughput', getFlowThroughput],
    ['wip-age', getFlowWipAge],
    ['dwell', getFlowDwell],
  ])('%s sends a breakdown only when one is asked for', async (metric, call) => {
    const filters = { days: 30, swimlaneId: 5, labelId: null }
    await call(3, filters, { by: 'label' })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, {
      params: { days: 30, swimlane_id: 5, group_by: 'label' },
    })
    await call(3, filters, { by: 'custom_field', fieldId: 9 })
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, {
      params: { days: 30, swimlane_id: 5, group_by: 'custom_field', group_by_field_id: 9 },
    })
    await call(3, filters, undefined)
    expect(get).toHaveBeenLastCalledWith(`/api/v1/boards/3/metrics/${metric}/`, {
      params: { days: 30, swimlane_id: 5 },
    })
  })

  it('asks for the whole overview in one request, with the filters and any breakdown (#2426)', async () => {
    await expect(getFlowOverview(3, { days: 90, swimlaneId: null, labelId: null })).resolves.toEqual({ ok: true })
    // The Overview caps its per-card lists by default (#2429).
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/overview/', { params: { days: 90, limit: OVERVIEW_LIST_LIMIT } })
    await getFlowOverview(3, { days: 30, swimlaneId: 5, labelId: 6 }, { by: 'custom_field', fieldId: 9 })
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/overview/', {
      params: { days: 30, swimlane_id: 5, label_id: 6, group_by: 'custom_field', group_by_field_id: 9, limit: OVERVIEW_LIST_LIMIT },
    })
    await getFlowOverview(3, { days: 30, swimlaneId: null, labelId: null }, undefined, 12)
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/overview/', { params: { days: 30, limit: 12 } })
  })

  it('asks for one cumulative-flow day under the same filters', async () => {
    await getFlowCumulativeDay(3, { days: 30, swimlaneId: 5, labelId: null }, '2026-06-02')
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/cumulative-flow/', {
      params: { days: 30, swimlane_id: 5, date: '2026-06-02' },
    })
  })

  it('swimlanes sends no swimlane filter and only the params that are set', async () => {
    await getFlowSwimlanes(3, { days: 90, labelId: null })
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/swimlanes/', { params: { days: 90 } })
    await getFlowSwimlanes(3, { days: 30, labelId: 6 }, 9)
    expect(get).toHaveBeenLastCalledWith('/api/v1/boards/3/metrics/swimlanes/', {
      params: { days: 30, label_id: 6, group_by_field_id: 9 },
    })
  })
})
