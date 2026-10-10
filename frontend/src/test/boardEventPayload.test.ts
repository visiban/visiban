import { describe, it, expect } from 'vitest'
import { stripPerUserBoardFields, neutralizePerUserBoardFields } from '../utils/boardEventPayload'

describe('boardEventPayload (#1559)', () => {
  it('stripPerUserBoardFields drops is_starred and keeps everything else', () => {
    const out = stripPerUserBoardFields({ id: 1, name: 'Renamed', is_starred: true })
    expect(out).toEqual({ id: 1, name: 'Renamed' })
    expect('is_starred' in out).toBe(false)
  })

  it('stripPerUserBoardFields does not mutate its input', () => {
    const input = { id: 1, is_starred: true }
    stripPerUserBoardFields(input)
    expect(input.is_starred).toBe(true)
  })

  it('merging a stripped payload leaves the local star state unchanged', () => {
    const local = { id: 1, name: 'Old', is_starred: false }
    const merged = { ...local, ...stripPerUserBoardFields({ id: 1, name: 'New', is_starred: true }) }
    expect(merged).toEqual({ id: 1, name: 'New', is_starred: false })
  })

  it('neutralizePerUserBoardFields defaults the creator star to false', () => {
    expect(neutralizePerUserBoardFields({ id: 2, name: 'B', is_starred: true })).toEqual({ id: 2, name: 'B', is_starred: false })
  })
})
