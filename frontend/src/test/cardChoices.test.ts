import { describe, it, expect } from 'vitest'
import { assignChoices, moveChoices, priorityChoices } from '../utils/cardActions'
import type { BoardFull, Column } from '../types'

const user = (id: number, name: string) => ({ id, username: name, display_name: name, email: '', first_name: name, last_name: '', avatar_url: '' })

describe('shared card choice lists (#2103)', () => {
  it('moveChoices maps columns to value=id with the column color as dot', () => {
    const cols = [{ id: 1, name: 'To Do', color: '#111111' }, { id: 2, name: 'Done', color: '#222222' }] as Column[]
    expect(moveChoices(cols)).toEqual([
      { key: 'col-1', label: 'To Do', value: 1, dot: '#111111' },
      { key: 'col-2', label: 'Done', value: 2, dot: '#222222' },
    ])
  })

  it('assignChoices leads with Unassign and omits viewers', () => {
    const members = [
      { id: 1, user: user(10, 'ann'), role: 'member', is_moderator: false, joined_at: '' },
      { id: 2, user: user(11, 'vic'), role: 'viewer', is_moderator: false, joined_at: '' },
    ] as unknown as BoardFull['members']
    const out = assignChoices(members)
    expect(out.map((c) => c.value)).toEqual([null, 10])
    expect(out[0]).toMatchObject({ label: 'Unassign', italic: true })
  })

  it('priorityChoices lists low to urgent with capitalized labels and colors', () => {
    const out = priorityChoices()
    expect(out.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'urgent'])
    expect(out[3].label).toBe('Urgent')
    expect(out.every((c) => !!c.dot)).toBe(true)
  })
})
