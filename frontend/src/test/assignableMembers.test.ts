import { describe, expect, it } from 'vitest'
import { isAssignableMember } from '../utils/assignableMembers'

// Mirrors boards.utils._get_assignable_member_ids (#1905).
describe('isAssignableMember', () => {
  it.each(['admin', 'member', 'collaborator', 'site_admin'])('offers a %s row', (role) => {
    expect(isAssignableMember({ role })).toBe(true)
  })

  it('skips a viewer row', () => {
    expect(isAssignableMember({ role: 'viewer' })).toBe(false)
  })

  it('skips a row whose stored role is outside the enum', () => {
    expect(isAssignableMember({ role: 'bogus' })).toBe(false)
    expect(isAssignableMember({ role: 'bogus', has_all_content_access: false })).toBe(false)
  })

  it('offers an all-content row whatever it stores', () => {
    expect(isAssignableMember({ role: 'viewer', has_all_content_access: true })).toBe(true)
    expect(isAssignableMember({ role: 'bogus', has_all_content_access: true })).toBe(true)
  })
})
