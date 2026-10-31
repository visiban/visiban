#!/usr/bin/env node
// Negative controls for scripts/rewrite-facts.mjs (#1271).
//
// A "0 problems" from the fact check means something only if the check fails
// when a fact is dropped. Each control below takes a real rewrite that passes
// (the prototype's root page against docs/index.md), drops or alters one fact
// of the kind earlier review rounds caught by hand, and requires the check to
// report it in the right category. No build needed.
//
// Usage (from docs-site/): node scripts/test-rewrite-facts.mjs   (npm run test:facts)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { comparePage, anchorsOf } from './rewrite-facts.mjs'
import { shimIds } from './anchors.mjs'

const old = readFileSync(new URL('../../docs/index.md', import.meta.url), 'utf8')
const neu = readFileSync(new URL('../src/content/docs/index.md', import.meta.url), 'utf8')
const run = (o, n, docsPath = 'index.md') =>
  comparePage({ old: o, neu: n, docsPath, ids: new Set([...anchorsOf(n), ...shimIds(n)]) })
const count = (lost) => Object.values(lost).reduce((a, v) => a + v.length, 0)
const without = (text, re) => {
  const out = text.replace(re, '')
  assert.notEqual(out, text, `control did not apply: ${re}`)
  return out
}

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

t('baseline: the prototype root page loses nothing', () => assert.equal(count(run(old, neu)), 0, JSON.stringify(run(old, neu))))

for (const [name, re, kind] of [
  ['the Invite links bullet', /^- \*\*Invite links\.\*\*.*\n/m, 'terms'],
  ['the Custom fields *(1.2)* bullet', /^- \*\*Custom fields\*\*.*\n/m, 'terms'],
  ['the Groups bullet', /^- \*\*Groups\.\*\*.*\n/m, 'terms'],
  ['the MCP server *(1.2, off by default)* bullet', /^- \*\*MCP server\*\*.*\n/m, 'terms'],
  ['the Saved filters bullet', /^- \*\*Saved filters\.\*\*.*\n/m, 'terms'],
]) {
  t(`deleting ${name} is reported (${kind})`, () => {
    const lost = run(old, without(neu, re))
    assert.ok(lost[kind].length > 0, JSON.stringify(lost))
  })
}

t('"Five roles" -> "Several roles" is reported (counts)', () => {
  const lost = run(old, neu.replace('Five roles', 'Several roles'))
  assert.ok(lost.counts.includes('five roles'), JSON.stringify(lost.counts))
})

t('dropping "*(1.2, off by default)*" is reported (versions)', () => {
  const lost = run(old, without(neu, / \*\(1\.2, off by default\)\*/))
  assert.ok(lost.versions.some((v) => v.startsWith('(1.2, off by default)')), JSON.stringify(lost.versions))
})

t('dropping a Quick links row is reported (internal)', () => {
  const lost = run(old, without(neu, /^\| \[Analytics\].*\n/m))
  assert.ok(lost.internal.includes('features/analytics'), JSON.stringify(lost.internal))
})

t('flattening a warning into prose is reported (callouts)', () => {
  const o = '# P\n\n!!! warning "Back up first"\n    This deletes the database.\n'
  const lost = run(o, '# P\n\n**Back up first:** this deletes the database.\n', 'x/p.md')
  assert.deepEqual(lost.callouts, ['caution 1->0'])
})

t('a shim with the wrong id does not hide a broken underscore anchor (anchors)', () => {
  const o = '# P\n\n## DJANGO_SECRET_KEY\n\nSet it.\n'
  const n = '# P\n\n<a id="djangosecretkey"></a>\n\n## The secret key\n\nSet it.\n'
  assert.deepEqual(run(o, n, 'x/p.md').anchors, ['django_secret_key'])
  const fixed = n.replace('djangosecretkey', 'django_secret_key')
  assert.deepEqual(run(o, fixed, 'x/p.md').anchors, [])
})

t('a renamed duplicate heading must keep its _1 anchor (anchors)', () => {
  const o = '# P\n\n## Troubleshooting\n\n## Troubleshooting\n'
  const n = '# P\n\n## Troubleshooting\n\n## When production misbehaves\n'
  assert.deepEqual(run(o, n, 'x/p.md').anchors, ['troubleshooting_1'])
})

console.log(`${passed} tests passed`)
