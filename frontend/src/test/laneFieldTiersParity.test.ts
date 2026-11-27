import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LANE_DETAILS_CAP_OPTIONS, isLegacyTiers, laneTierFields, resolveLaneTiers } from '../utils/laneBand'
import type { LaneTier, Swimlane, SwimlaneCustomFieldDefinition } from '../types'

// Shared with backend boards/tests/test_lane_field_tiers_2439.py (#2439): both sides must give
// the same tier for every case, so a rule change on one side fails until the other follows.
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../backend/boards/tests/fixtures/lane_field_tiers.json'), 'utf8'),
) as { cases: { name: string; cap: number; defs: [number, number, LaneTier | null][]; expected: Record<string, LaneTier> }[] }

const def = (id: number, position: number, band_visibility: LaneTier | null, extra: Partial<SwimlaneCustomFieldDefinition> = {}) =>
  ({ id, uid: `sf${id}`, name: `F${id}`, field_type: 'text', choices: [], position, show_on_row: false, is_admin_only: false, choice_colors: {}, band_visibility, ...extra }) as SwimlaneCustomFieldDefinition

describe('resolveLaneTiers parity (#2439)', () => {
  it('matches the shared fixture', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(4)
    for (const c of fixture.cases) {
      const got = Object.fromEntries([...resolveLaneTiers(c.defs.map(([id, p, bv]) => def(id, p, bv)), c.cap)].map(([k, v]) => [String(k), v]))
      expect(got, c.name).toEqual(c.expected)
    }
  })

  it('offers the server cap choices', () => {
    expect([...LANE_DETAILS_CAP_OPTIONS]).toEqual([4, 6, 9, 12, 16])
  })
})

describe('laneTierFields (#2439)', () => {
  const lane = { id: 1, name: 'North', custom_field_values: [{ field_definition: 1, value: '' }, { field_definition: 2, value: 'x' }] } as unknown as Swimlane

  it('is null on a legacy board and on an absent definition list', () => {
    expect(laneTierFields(lane, [def(1, 0, null)], true, 6)).toBeNull()
    expect(laneTierFields(lane, undefined, true, 6)).toBeNull()
    expect(isLegacyTiers([{ id: 1, position: 0 }])).toBe(true)
  })

  it('drops an empty Band value and keeps empty Details values', () => {
    const out = laneTierFields(lane, [def(1, 0, 'band'), def(2, 1, 'band'), def(3, 2, 'details')], true, 6)!
    expect(out.band.map((f) => f.def.id)).toEqual([2])
    expect(out.details.map((f) => [f.def.id, f.value])).toEqual([[3, '']])
  })

  it('leaves admin-only fields out of every tier for a non-admin (and an unknown role)', () => {
    const defs = [def(1, 0, 'band'), def(2, 1, 'hidden', { is_admin_only: true }), def(3, 2, 'hidden')]
    const out = laneTierFields(lane, defs, false, 6)!
    expect(out.hidden.map((f) => f.def.id)).toEqual([3])
    expect(laneTierFields(lane, defs, true, 6)!.hidden.map((f) => f.def.id)).toEqual([2, 3])
  })
})

describe('laneTierFields band slots (#2663)', () => {
  const defs = [1, 2, 3, 4, 5, 6].map((id) => def(id, id, 'band')).concat(def(7, 7, 'details'))
  const lane = { id: 1, name: 'North', custom_field_values: [1, 3, 4, 5, 6, 7].map((id) => ({ field_definition: id, value: `v${id}` })) } as unknown as Swimlane
  const ids = (list: { def: { id: number } }[]) => list.map((f) => f.def.id)

  it('shows two when no slot count is given', () => {
    const out = laneTierFields(lane, defs, true, 6)!
    expect(ids(out.band)).toEqual([1])
    expect(ids(out.details)).toEqual([3, 4, 5, 6, 7])
  })

  it('counts slots over definitions, drops an empty one inline, and puts the rest first in details', () => {
    const out = laneTierFields(lane, defs, true, 6, 4)!
    expect(ids(out.band)).toEqual([1, 3, 4])
    expect(ids(out.details)).toEqual([5, 6, 7])
    // An empty value past the slots stays listed, so every lane counts the same N.
    expect(ids(laneTierFields(lane, defs, true, 6, 1)!.details)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('never exceeds six, and a field over the limit still shows in details', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((id) => def(id, id, 'band'))
    const out = laneTierFields(lane, seven, true, 6, 99)!
    expect(ids(out.band)).toEqual([1, 3, 4, 5, 6])
    expect(ids(out.details)).toEqual([7])
  })

  it('gives an admin-only band field no slot and no count for a non-admin (#1075)', () => {
    const mixed = [def(1, 1, 'band', { is_admin_only: true }), def(3, 3, 'band'), def(4, 4, 'band'), def(5, 5, 'band')]
    const out = laneTierFields(lane, mixed, false, 6, 2)!
    expect(ids(out.band)).toEqual([3, 4])
    expect(ids(out.details)).toEqual([5])
    expect(out.hidden).toEqual([])
  })
})
