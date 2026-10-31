#!/usr/bin/env node
// Tests for scripts/version-slugs.mjs, with negative controls (#1271).
// Usage (from docs-site/): node scripts/test-version-slugs.mjs   (npm run test:versions)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SLUG_PATTERN, assertVersions } from './version-slugs.mjs'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}
const v = (...slugs) => slugs.map((slug) => ({ slug }))

t('accepts GA minor lines and pre-releases', () => {
  for (const s of ['v1.2', 'v0.9', 'v10.0', 'v1.2.0-alpha.1', 'v1.2.0-beta.3', 'v1.2.0-rc.10', 'v2.0.1-rc.0']) {
    assert.ok(SLUG_PATTERN.test(s), s)
  }
})

t('refuses malformed slugs (negative controls)', () => {
  for (const s of [
    '1.2', // the exact #1270 shape: no v prefix
    'v01.2', // leading zero, major
    'v1.02', // leading zero, minor
    'v1.2.00-rc.1', // leading zero, patch
    'v1.2.0-rc.01', // leading zero, pre-release number
    'v1.2.0', // a GA patch is not a slug: GA docs are versioned per minor
    'v1.2x',
    'v1.2.0-preview.1',
    'v1.2.0-rc',
    'V1.2',
    ' v1.2',
    'v1.2/',
  ]) {
    assert.ok(!SLUG_PATTERN.test(s), s)
    assert.throws(() => assertVersions(v(s)), /must be vMAJOR/, s)
  }
})

t('accepts a newest-first list', () => {
  assertVersions(v('v1.3', 'v1.3.0-rc.1', 'v1.2', 'v1.2.0-beta.2', 'v1.2.0-beta.1', 'v1.2.0-alpha.1', 'v1.1', 'v1.0'))
})

t('refuses a duplicate (negative control)', () => {
  assert.throws(() => assertVersions(v('v1.2', 'v1.2')), /listed twice/)
})

t('refuses ascending or shuffled order (negative controls)', () => {
  assert.throws(() => assertVersions(v('v1.1', 'v1.2')), /newest first/)
  assert.throws(() => assertVersions(v('v1.2.0-alpha.1', 'v1.2')), /newest first/) // GA ranks above its pre-releases
  assert.throws(() => assertVersions(v('v1.2.0-alpha.2', 'v1.2.0-beta.1')), /newest first/)
  assert.throws(() => assertVersions(v('v1.10', 'v1.9', 'v1.11')), /newest first/)
})

t('compares numerically, not as strings (the #1270 sort bug)', () => {
  assertVersions(v('v1.10', 'v1.9')) // a string sort would put v1.9 first
  assert.throws(() => assertVersions(v('v1.9', 'v1.10')), /newest first/)
})

t('astro.config.mjs uses this module and its list passes', () => {
  const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8')
  assert.match(config, /from '\.\/scripts\/version-slugs\.mjs'/)
  assert.match(config, /assertVersions\(versions\)/)
  const block = /const versions = \[([\s\S]*?)\n\]/.exec(config)?.[1] ?? ''
  const list = [...block.matchAll(/\{ slug: '([^']+)'/g)].map((m) => m[1])
  assert.ok(list.length > 0)
  assertVersions(v(...list))
})

console.log(`${passed} tests passed`)
