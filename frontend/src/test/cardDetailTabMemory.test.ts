import { describe, it, expect } from 'vitest'
import { cardDetailTabsFor, getRememberedCardDetailTab, parseCardDetailTab, rememberCardDetailTab } from '../components/Card/cardDetailTabMemory'
import { lastActivitySummary } from '../utils/cardTimelineLabels'

describe('card detail tab memory (#967)', () => {
  it('parses known tab values and rejects everything else', () => {
    expect(parseCardDetailTab('details')).toBe('details')
    expect(parseCardDetailTab('comments')).toBe('comments')
    expect(parseCardDetailTab('history')).toBe('history')
    expect(parseCardDetailTab('children')).toBe('children')
    expect(parseCardDetailTab('activity')).toBeNull()
    expect(parseCardDetailTab('')).toBeNull()
    expect(parseCardDetailTab(null)).toBeNull()
    expect(parseCardDetailTab(undefined)).toBeNull()
  })

  it('offers Children, after Details, only on a parent-tier board (#2209)', () => {
    expect(cardDetailTabsFor({ cards_can_have_children: true })).toEqual(['details', 'children', 'comments', 'history'])
    expect(cardDetailTabsFor({ cards_can_have_children: false })).toEqual(['details', 'comments', 'history'])
    expect(cardDetailTabsFor({})).toEqual(['details', 'comments', 'history'])
  })

  it('remembers the last tab in memory, never in storage', () => {
    rememberCardDetailTab('history')
    expect(getRememberedCardDetailTab()).toBe('history')
    expect(Object.keys(localStorage).some((k) => k.includes('tab'))).toBe(false)
    rememberCardDetailTab('details')
  })
})

describe('lastActivitySummary (#967)', () => {
  const actor = { id: 1, username: 'jordan', display_name: 'Jordan', avatar_url: '' }
  const base = { id: 1, ts: '2026-01-01T00:00:00Z', imported_from_username: null }

  it('describes a move, a creation and an activity', () => {
    expect(lastActivitySummary({ ...base, kind: 'move', actor, event_type: 'move', data: { from_column: 1, to_column_name: 'Review' } }))
      .toBe('Jordan moved to Review')
    expect(lastActivitySummary({ ...base, kind: 'move', actor, event_type: 'move', data: { from_column: null, to_column_name: 'Backlog' } }))
      .toBe('Jordan created it in Backlog')
    expect(lastActivitySummary({ ...base, kind: 'activity', actor: null, event_type: 'priority_change', data: { from_value: 'low', to_value: 'high' } }))
      .toBe('Someone: Priority: low → high')
  })
})
