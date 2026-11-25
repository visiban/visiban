import { describe, it, expect, vi } from 'vitest'
import { cardMovedActivity, leaveWarningForMove, notifyLeaveWarning } from '../utils/stages'
import { moveChoices, moveCardsToColumn, parseMoveChoice } from '../utils/cardActions'
import { mergeSwimlaneFromBroadcast } from '../utils/swimlaneMerge'
import type { Card, Column, Swimlane } from '../types'

vi.mock('../api/cards', () => ({ moveCard: vi.fn(), updateCard: vi.fn(), archiveCard: vi.fn() }))
import { moveCard } from '../api/cards'

const col = (id: number, name: string, sub_columns: Column['sub_columns'] = []) => ({
  id, uid: `c${id}`, name, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null, sub_columns, tracks: [],
}) as unknown as Column
const plain = col(1, 'To Do')
const stage = col(2, 'Review', [{ id: 1, uid: 'sub1', position: 0, name: 'Doing' }, { id: 2, uid: 'sub2', position: 1, name: 'Ready' }])
const done = col(3, 'Done')
const card = (id: number, column: number, gates_passed = 0) => ({ id, column, swimlane: 7, gates_passed, title: `Card ${id}`, position: 0 }) as unknown as Card

describe('leave warning (#1102): one helper for every Move surface', () => {
  it('names the stage and sub-columns for one card leaving early', () => {
    expect(leaveWarningForMove([card(1, 2, 0)], [plain, stage, done], 3)).toBe('Left Review in Doing, before Ready')
  })
  it('counts several cards, and is null when none left early or the move stays in the stage', () => {
    expect(leaveWarningForMove([card(1, 2, 0), card(2, 2, 0)], [plain, stage, done], 3)).toBe('2 cards left a stage before its last sub-column')
    expect(leaveWarningForMove([card(1, 2, 1)], [plain, stage, done], 3)).toBeNull()
    expect(leaveWarningForMove([card(1, 2, 0)], [plain, stage, done], 2)).toBeNull()
    expect(leaveWarningForMove([card(1, 1)], [plain, stage, done], 3)).toBeNull()
  })
  it('raises a keyed warning toast, never anything else, and says sub-column not gate', () => {
    const notify = vi.fn(() => 1)
    notifyLeaveWarning(notify, [card(1, 2, 0)], [plain, stage, done], 3)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'gates-open-warning', variant: 'warning', testId: 'gates-open-warning' }))
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(/gate(?!s-open-warning)/i)
    notify.mockClear()
    notifyLeaveWarning(notify, [card(1, 2, 1)], [plain, stage, done], 3)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('Move to… stops (card menu, bulk toolbar, card detail)', () => {
  it('offers a split stage once per sub-column and a plain column once', () => {
    expect(moveChoices([plain, stage]).map((c) => [c.label, c.value])).toEqual([
      ['To Do', 1], ['Review: Doing', 'stop:2:0'], ['Review: Ready', 'stop:2:1'],
    ])
  })
  it('parses a stop into gatesPassed and a column into none', () => {
    expect(parseMoveChoice('stop:2:1')).toEqual({ columnId: 2, gatesPassed: 1 })
    expect(parseMoveChoice(1)).toEqual({ columnId: 1 })
    expect(parseMoveChoice('3')).toEqual({ columnId: 3 })
    expect(parseMoveChoice('sub-next')).toBeNull()
    expect(parseMoveChoice(null)).toBeNull()
  })
  it('sends gates_passed only for a chosen sub-column', async () => {
    vi.mocked(moveCard).mockResolvedValue({ card: card(1, 2, 1) } as never)
    await moveCardsToColumn(1, [card(1, 1)], stage, undefined, 1)
    expect(moveCard).toHaveBeenLastCalledWith(1, 1, { column_id: 2, swimlane_id: 7, position: 9999, gates_passed: 1 })
    await moveCardsToColumn(1, [card(1, 1)], done)
    expect(moveCard).toHaveBeenLastCalledWith(1, 1, { column_id: 3, swimlane_id: 7, position: 9999 })
  })
})

describe('activity drawer row for card.moved (#1102)', () => {
  it('names the sub-column from gate_transitions when movement is absent', () => {
    const row = cardMovedActivity({
      card: { title: 'Fix login' },
      gate_transitions: [{ kind: 'pass', actor: 'jordan', sub_column_name: 'Ready', from_index: 0, to_index: 1 }],
    })
    expect(row).toEqual({ actor: 'jordan', headline: 'moved Fix login to Ready', subject: 'Fix login', detail: 'On to Ready' })
  })
  it('says back to on a reopen, and never leaves the detail blank', () => {
    expect(cardMovedActivity({ card: { title: 'X' }, gate_transitions: [{ kind: 'reopen', actor: 'sam', sub_column_name: 'Doing' }] }).headline).toBe('moved X back to Doing')
    expect(cardMovedActivity({ card: { title: 'X' } }).detail).toBe('Reordered within its cell')
  })
  it('keeps the column move wording when movement is present', () => {
    const row = cardMovedActivity({ card: { title: 'X' }, movement: { from_column_name: 'A', to_column_name: 'B', moved_by: { display_name: 'Maya' } } })
    expect(row).toMatchObject({ actor: 'Maya', headline: 'moved X', detail: 'A → B' })
  })
})

describe('swimlane.updated merge carries not_applicable_field_ids (#1921)', () => {
  it('takes the broadcast list over the prior copy', () => {
    const prior = { id: 4, name: 'Lane', custom_field_values: [], not_applicable_field_ids: [] } as unknown as Swimlane
    const incoming = { ...prior, not_applicable_field_ids: [9] } as Swimlane
    expect(mergeSwimlaneFromBroadcast([prior], incoming, []).not_applicable_field_ids).toEqual([9])
  })
})
