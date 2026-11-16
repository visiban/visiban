/**
 * #2113: the dwell overlay's fixed steps (#459) must tell cells apart on the shipped
 * sample boards. A sample board is often the first place someone sees the overlay; a
 * sample whose measured cells all land on one step reads as a uniform grid.
 *
 * Each sample is read the way an import reads it: every date shifts so the file's
 * `date_anchor` (noon) becomes noon on the import day, and `column_entered_at` is the
 * newest move that opened a visit in the card's current column (the server's rule in
 * `_annotate_column_entered_at`; a swimlane-only move does not reset it). The steps come
 * from the overlay itself, through `buildGridOverlayState`, not from a copy of them.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dwellOverlay } from '../gridOverlays/builtin/dwell'
import { buildGridOverlayState } from '../gridOverlays/slot'
import type { Card, Column, Swimlane } from '../types'

const SAMPLE_DIR = resolve(__dirname, '../../../backend/boards/sample_boards')
const HOUR = 3_600_000

interface SampleMove { from_column: string | null; to_column: string | null; moved_at: string }
interface SampleCard { title: string; column: string; archived_at?: string | null; movements: SampleMove[] }
interface Sample {
  date_anchor: string
  columns: { name: string; is_done: boolean }[]
  swimlanes: { name: string }[]
  cards: (SampleCard & { swimlane: string })[]
}

const samples = readdirSync(SAMPLE_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
  .sort()

/** The start of the card's open visit, or null when it has none (the server's rule). */
function enteredAt(card: SampleCard, doneColumns: Set<string>): string | null {
  if (card.archived_at || doneColumns.has(card.column)) return null
  const opener = [...card.movements].reverse().find((m) => m.to_column !== null && m.from_column !== m.to_column)
  return opener && opener.to_column === card.column ? opener.moved_at : null
}

/** The number of distinct dwell steps the sample's measured cells land on. */
function stepsUsed(sample: Sample, importOffsetHours: number): number {
  const anchorNoon = Date.parse(`${sample.date_anchor}T12:00:00+00:00`)
  const done = new Set(sample.columns.filter((c) => c.is_done).map((c) => c.name))
  const columns = sample.columns.map((c, i) => ({ id: i + 1, uid: `c${i}`, name: c.name, is_done: c.is_done }) as unknown as Column)
  const swimlanes = sample.swimlanes.map((s, i) => ({ id: i + 1, uid: `s${i}`, name: s.name }) as unknown as Swimlane)
  const cards = sample.cards.map((c, i) => ({
    id: i + 1,
    column: sample.columns.findIndex((col) => col.name === c.column) + 1,
    swimlane: sample.swimlanes.findIndex((s) => s.name === c.swimlane) + 1,
    column_entered_at: enteredAt(c, done),
    archived_at: c.archived_at ?? null,
  }) as unknown as Card)
  // Dates shift by (import day noon - anchor noon), so "now" relative to the file is
  // the anchor plus the hours into the import day.
  const state = buildGridOverlayState(dwellOverlay, {
    columns, swimlanes, cards, isFiltered: false, now: anchorNoon + importOffsetHours * HOUR,
  })!
  return new Set([...state.cells.values()].map((cell) => cell.encoding.level)).size
}

describe('sample boards on the dwell overlay (#2113)', () => {
  it('finds the samples', () => {
    expect(samples.length).toBeGreaterThanOrEqual(12)
  })

  it.each(samples)('%s spreads its measured cells across more than one step', (file) => {
    const sample = JSON.parse(readFileSync(resolve(SAMPLE_DIR, file), 'utf8')) as Sample
    // Importing at noon, and nine hours into the afternoon: the spread must not hinge on the hour.
    for (const offset of [0, 9]) {
      expect(stepsUsed(sample, offset), `${file} at +${offset}h`).toBeGreaterThan(1)
    }
  })
})
