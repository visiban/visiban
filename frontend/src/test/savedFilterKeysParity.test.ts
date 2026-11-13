import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMPTY_FILTER, type FilterState } from '../components/Board/FilterBar'

// #2213 — the backend pins the same fixture against
// SavedFilterSerializer._STATE_V1_KEYS (test_saved_filters.py), so a
// FilterState key added without teaching the serializer fails CI on one side.
//
// #2205 — FilterState now has an optional key (laneFilter) that EMPTY_FILTER
// leaves out, so the list is pinned through a Record over keyof FilterState:
// adding a key to FilterState without listing it here is a type error, and
// tsc runs in CI.
const FILTER_STATE_KEYS: Record<keyof FilterState, true> = {
  search: true,
  assigneeIds: true,
  labelIds: true,
  priorities: true,
  dueDate: true,
  customFields: true,
  visibleCustomFieldFilterIds: true,
  blockedOnly: true,
  laneFilter: true,
}

describe('FilterState keys parity with backend', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, '../../../backend/boards/tests/fixtures/filter_state_keys.json'), 'utf8'),
  ) as { keys: string[] }

  it('every FilterState key matches the shared fixture', () => {
    expect(Object.keys(FILTER_STATE_KEYS).sort()).toEqual([...fixture.keys].sort())
  })

  it('EMPTY_FILTER carries every required key and nothing outside FilterState', () => {
    for (const k of Object.keys(EMPTY_FILTER)) expect(fixture.keys).toContain(k)
    expect(Object.keys(EMPTY_FILTER)).not.toContain('laneFilter')
  })
})
