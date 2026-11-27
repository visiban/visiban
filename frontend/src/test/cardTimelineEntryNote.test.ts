import { describe, expect, it } from 'vitest'
import { movementEntryNote } from '../utils/cardTimelineLabels'

const item = {
  requirement_uid: 'r1', operator: 'filled' as const, operand: null, field_uid: 'f1',
  field_name: 'Amount', field_set_uid: null, field_set_name: null,
}

describe('movementEntryNote (#2655)', () => {
  it('counts the Warn record', () => {
    expect(movementEntryNote({ entry_unmet: [item] })).toBe('1 entry requirement not met')
    expect(movementEntryNote({ entry_unmet: [item, item, item] })).toBe('3 entry requirements not met')
  })

  it('is null with no record, an empty one, or an older server', () => {
    expect(movementEntryNote({ entry_unmet: null })).toBeNull()
    expect(movementEntryNote({ entry_unmet: [] })).toBeNull()
    expect(movementEntryNote({})).toBeNull()
  })
})
