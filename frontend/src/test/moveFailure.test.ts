import { describe, it, expect } from 'vitest'
import { failureReason, isLimitFailure } from '../utils/moveFailure'

const axiosErr = (status?: number, data: unknown = {}) =>
  Object.assign(new Error('x'), { isAxiosError: true, response: status ? { status, data } : undefined })

describe('failureReason', () => {
  it('blames the network when there is no response or the error is not axios', () => {
    expect(failureReason(axiosErr())).toBe('a network error occurred')
    expect(failureReason(new Error('x'))).toBe('a network error occurred')
  })
  it('uses limit wording only for limit codes', () => {
    for (const code of ['wip_limit_exceeded', 'wip_hard_blocked', 'weight_limit_exceeded']) {
      expect(failureReason(axiosErr(409, { code }))).toBe('a column limit was reached')
    }
    expect(failureReason(axiosErr(409, { code: 'version_conflict' }))).toBe('someone else changed a card')
  })
  it('names a swimlane limit as a swimlane limit (#1150)', () => {
    for (const code of ['swimlane_wip_limit_exceeded', 'swimlane_wip_hard_blocked', 'swimlane_weight_limit_exceeded']) {
      expect(failureReason(axiosErr(409, { code }))).toBe('a swimlane limit was reached')
      expect(isLimitFailure(axiosErr(409, { code }))).toBe(true)
    }
  })
  it('names maintenance mode', () => {
    expect(failureReason(axiosErr(503, { code: 'maintenance_mode' }))).toBe('maintenance mode is active')
  })
  it('maps 403, 404 and other statuses', () => {
    expect(failureReason(axiosErr(403))).toBe('you do not have permission')
    expect(failureReason(axiosErr(403), 'custom')).toBe('custom')
    expect(failureReason(axiosErr(404))).toBe('not found')
    expect(failureReason(axiosErr(500))).toBe('something went wrong')
  })
})
