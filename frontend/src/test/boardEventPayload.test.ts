import { describe, it, expect } from 'vitest'
import { stripPerUserBoardFields, neutralizePerUserBoardFields, shareLinkIssuedAtFromEvent, shareLinkPatchFromEvent } from '../utils/boardEventPayload'

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

  it('a payload without is_starred (non-actor recipient, #1705) keeps the local star state', () => {
    const local = { id: 1, name: 'Old', is_starred: true }
    const merged = { ...local, ...stripPerUserBoardFields({ id: 1, name: 'New' }) }
    expect(merged).toEqual({ id: 1, name: 'New', is_starred: true })
    expect(neutralizePerUserBoardFields({ id: 2, name: 'B' })).toEqual({ id: 2, name: 'B', is_starred: false })
  })

  it('neutralizePerUserBoardFields defaults the creator star to false', () => {
    expect(neutralizePerUserBoardFields({ id: 2, name: 'B', is_starred: true })).toEqual({ id: 2, name: 'B', is_starred: false })
  })
})

describe('shareLinkPatchFromEvent (#1967)', () => {
  it('maps the wire names onto the /full/ share fields', () => {
    expect(shareLinkPatchFromEvent({ board_uid: 'b1', active: true, expires_at: '2999-01-01T00:00:00Z' }))
      .toEqual({ share_link_active: true, share_token_expires_at: '2999-01-01T00:00:00Z' })
    expect(shareLinkPatchFromEvent({ board_uid: 'b1', active: true, expires_at: null }))
      .toEqual({ share_link_active: true, share_token_expires_at: null })
  })

  it('fails closed: anything but active true reads as no link, with no expiry', () => {
    const off = { share_link_active: false, share_token_expires_at: null }
    expect(shareLinkPatchFromEvent({ board_uid: 'b1', active: false, expires_at: null })).toEqual(off)
    // An expiry on an inactive link is ignored.
    expect(shareLinkPatchFromEvent({ active: false, expires_at: '2999-01-01T00:00:00Z' })).toEqual(off)
    expect(shareLinkPatchFromEvent({ active: 'yes' as unknown as boolean })).toEqual(off)
    expect(shareLinkPatchFromEvent(null)).toEqual(off)
    expect(shareLinkPatchFromEvent(undefined)).toEqual(off)
  })

  it('drops a non-string expiry on an active link', () => {
    expect(shareLinkPatchFromEvent({ active: true, expires_at: 42 as unknown as string }))
      .toEqual({ share_link_active: true, share_token_expires_at: null })
  })

  it('never carries anything but the two share fields', () => {
    const out = shareLinkPatchFromEvent({ board_uid: 'b1', active: true, expires_at: null, share_token: 'tok' } as never)
    expect(Object.keys(out).sort()).toEqual(['share_link_active', 'share_token_expires_at'])
  })
})

describe('shareLinkIssuedAtFromEvent (#1967)', () => {
  it('returns issued_at for an active link that was just issued', () => {
    expect(shareLinkIssuedAtFromEvent({ active: true, expires_at: null, issued_at: '2026-11-01T10:00:00+00:00' }))
      .toBe('2026-11-01T10:00:00+00:00')
  })

  it('fails closed to null', () => {
    expect(shareLinkIssuedAtFromEvent({ active: true, expires_at: null, issued_at: null })).toBeNull()
    expect(shareLinkIssuedAtFromEvent({ active: false, issued_at: '2026-11-01T10:00:00+00:00' })).toBeNull()
    expect(shareLinkIssuedAtFromEvent({ active: true, issued_at: 5 as unknown as string })).toBeNull()
    expect(shareLinkIssuedAtFromEvent({ active: true })).toBeNull()
    expect(shareLinkIssuedAtFromEvent(null)).toBeNull()
    expect(shareLinkIssuedAtFromEvent(undefined)).toBeNull()
  })
})
