import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HelpLink from '../components/Common/HelpLink'
import { DEFAULT_DOCS_BASE_URL, docsUrl, docsVersionSegment } from '../help/docsUrl'
import { HELP_TOPICS, type HelpTopicKey } from '../help/topics'

describe('docsVersionSegment', () => {
  it('maps a release to its minor path', () => {
    expect(docsVersionSegment('1.3.2')).toBe('v1.3')
    expect(docsVersionSegment('v1.3.0')).toBe('v1.3')
  })
  it('maps a prerelease to next', () => {
    expect(docsVersionSegment('1.3.0-beta.1')).toBe('next')
  })
  it.each(['dev', 'test', '', undefined, 'latest'])('falls back to latest for %s', (v) => {
    expect(docsVersionSegment(v)).toBe('latest')
  })
})

// #2612: the segment must name a directory docs-deploy actually publishes. The
// deploy side v-prefixes every version; if that stops, this fails with it.
describe('docs version segment matches docs-deploy', () => {
  it('both carry the v prefix', () => {
    const script = readFileSync(resolve(__dirname, '../../../scripts/resolve-docs-version.sh'), 'utf-8')
    expect(script).toMatch(/^\s*\*\) v="v\$\{v\}" ;;$/m)
    expect(docsVersionSegment('1.3.0')).toBe('v1.3')
  })
})

describe('docsUrl', () => {
  it('builds a versioned URL with the anchor', () => {
    expect(docsUrl('analytics.bottleneck', { version: '1.3.0' })).toBe(`${DEFAULT_DOCS_BASE_URL}/v1.3/features/analytics/#bottleneck`)
  })
  it('falls back to latest', () => {
    expect(docsUrl('webhooks', { version: 'dev' })).toBe(`${DEFAULT_DOCS_BASE_URL}/latest/features/webhooks/`)
  })
  it('home has no path', () => {
    expect(docsUrl('home', { version: '1.3.0' })).toBe(`${DEFAULT_DOCS_BASE_URL}/v1.3/`)
  })
  it('uses an override verbatim, trimming trailing slashes', () => {
    expect(docsUrl('webhooks', { base: 'https://docs.corp.example/visiban//', version: '1.3.0' })).toBe('https://docs.corp.example/visiban/features/webhooks/')
  })
  it('ignores a non-http override', () => {
    expect(docsUrl('webhooks', { base: 'javascript:alert(1)', version: '1.3.0' })).toBe(`${DEFAULT_DOCS_BASE_URL}/v1.3/features/webhooks/`)
  })
  it('every registry path ends in a slash and every anchor has no hash', () => {
    for (const t of Object.values(HELP_TOPICS) as { path: string; anchor?: string }[]) {
      expect(t.path === '' || t.path.endsWith('/')).toBe(true)
      expect(t.anchor ?? '').not.toContain('#')
    }
  })
})

describe('HelpLink', () => {
  it('icon variant names where it goes and opens a new tab safely', () => {
    render(<HelpLink topic="webhooks" />)
    const link = screen.getByRole('link', { name: 'Learn more about webhooks, opens docs' })
    expect(link).toHaveAttribute('href', docsUrl('webhooks'))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).not.toHaveAttribute('title')
  })
  it('text variant keeps the visible words first in the name', () => {
    render(<HelpLink topic="analytics.bottleneck" variant="text" />)
    const link = screen.getByRole('link', { name: 'Learn more about bottleneck detection, opens docs' })
    expect(link).toHaveTextContent(/^Learn more/)
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
  it('renders nothing for an unknown topic at runtime', () => {
    const { container } = render(<HelpLink topic={'nope' as HelpTopicKey} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('docsUrl build-time VITE_DOCS_BASE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  it('uses the env base verbatim with no version segment', () => {
    vi.stubEnv('VITE_DOCS_BASE_URL', 'https://docs.example.test')
    expect(docsUrl('webhooks')).toBe('https://docs.example.test/features/webhooks/')
  })
  it('falls back to the default host for an unsafe env value', () => {
    vi.stubEnv('VITE_DOCS_BASE_URL', 'javascript:alert(1)')
    const url = docsUrl('webhooks')
    expect(url.startsWith(`${DEFAULT_DOCS_BASE_URL}/`)).toBe(true)
    expect(url.endsWith('/features/webhooks/')).toBe(true)
  })
})

describe('WebhooksOffNotice', () => {
  it('carries one help link in its heading row', async () => {
    const { WebhooksOffNotice } = await import('../components/Board/webhooks/WebhookServiceNotice')
    render(<WebhooksOffNotice />)
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Learn more about webhooks, opens docs' })).toHaveAttribute('href', docsUrl('webhooks'))
  })
})
