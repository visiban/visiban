import tw from '../../tailwind.config.js?raw'
import { describe, expect, it } from 'vitest'
import { INVITE_STATUS_STYLES } from '../constants/invites'

// #1550: every on-tint text token must be exposed to Tailwind. (Vitest stubs CSS imports, so the
// per-theme `--*-on-tint` declarations in index.css are covered by the measured table in CLAUDE.md.)
const tokens = ['danger', 'warning', 'success', 'info', 'muted']

describe('on-tint text tokens', () => {
  it.each(tokens)('%s-on-tint is exposed in the tailwind config', (t) => {
    expect(tw).toContain(`"${t}-on-tint": "rgb(var(--${t}-on-tint) / <alpha-value>)"`)
  })
})

describe('INVITE_STATUS_STYLES', () => {
  it('uses on-tint text and never a high-alpha same-hue fill', () => {
    expect(INVITE_STATUS_STYLES.pending).toBe('bg-success/20 text-success-on-tint')
    expect(INVITE_STATUS_STYLES.expired).toBe('bg-danger/20 text-danger-on-tint')
    expect(INVITE_STATUS_STYLES.revoked).toContain('line-through')
    expect(INVITE_STATUS_STYLES.used).not.toContain('line-through')
    for (const cls of Object.values(INVITE_STATUS_STYLES)) expect(cls).not.toMatch(/\/(40|50|60)/)
  })
})
