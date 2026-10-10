/// <reference types="node" />
import { readFileSync } from 'node:fs'
import tw from '../../tailwind.config.js?raw'
import { describe, expect, it } from 'vitest'
import { INVITE_STATUS_STYLES } from '../constants/invites'

// #1550: every on-tint text token must be declared in both theme blocks of index.css and exposed
// to Tailwind. Read from disk: Vitest stubs CSS imports (`?raw` on a .css file comes back empty).
const css = readFileSync('src/index.css', 'utf8')
const darkBlock = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="light"] {'))
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'))
const tokens = ['danger', 'warning', 'success', 'info', 'muted']

describe('on-tint text tokens', () => {
  it.each(tokens)('%s-on-tint is declared in both the dark and light theme blocks', (t) => {
    expect(darkBlock).toContain(`--${t}-on-tint:`)
    expect(lightBlock).toContain(`--${t}-on-tint:`)
  })

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
