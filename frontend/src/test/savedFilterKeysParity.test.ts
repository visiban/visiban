import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMPTY_FILTER } from '../components/Board/FilterBar'

// #2213 — the backend pins the same fixture against
// SavedFilterSerializer._STATE_V1_KEYS (test_saved_filters.py), so a
// FilterState key added without teaching the serializer fails CI on one side.
describe('FilterState keys parity with backend', () => {
  it('EMPTY_FILTER keys match the shared fixture', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, '../../../backend/boards/tests/fixtures/filter_state_keys.json'), 'utf8'),
    ) as { keys: string[] }
    expect(Object.keys(EMPTY_FILTER).sort()).toEqual([...fixture.keys].sort())
  })
})
