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
  ['the Custom fields 1.2+ bullet', /^- \*\*Custom fields\.\*\*.*\n/m, 'terms'],
  ['the Groups bullet', /^- \*\*Groups\.\*\*.*\n/m, 'terms'],
  ['the MCP server 1.2+ bullet', /^- \*\*MCP server\.\*\*.*\n/m, 'terms'],
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

const badge = (v) => `<span class="vb-version" title="Added in ${v}">${v}+</span>`

t('the original *(1.2)* notes are satisfied by 1.2+ badges in the rewrite (versions)', () => {
  assert.ok(neu.includes(badge('1.2')))
  assert.deepEqual(run(old, neu).versions, [])
})

t('removing one 1.2+ badge is reported (versions)', () => {
  const lost = run(old, neu.replace(` ${badge('1.2')} Off by default.`, ' Off by default.'))
  assert.ok(lost.versions.some((v) => v.startsWith('added in 1.2:')), JSON.stringify(lost.versions))
})

t('changing a badge from 1.2+ to 1.1+ is reported (versions)', () => {
  const lost = run(old, neu.replace(badge('1.2'), badge('1.1')))
  assert.ok(lost.versions.some((v) => v.startsWith('added in 1.2:')), JSON.stringify(lost.versions))
  assert.deepEqual(lost.badges, [])
})

t('a 1.0 badge is rejected (badges)', () => {
  const lost = run(old, neu.replace('**Swimlanes.**', `**Swimlanes.** ${badge('1.0')}`))
  assert.deepEqual(lost.badges, ['1.0+ (title "Added in 1.0")'])
})

t('a malformed or mistitled badge is rejected (badges)', () => {
  const lost = run(old, neu.replace(badge('1.2'), '<span class="vb-version" title="Added in 1.2">v1.2</span>').replace('title="Added in 1.2">1.2+', 'title="Added in 1.1">1.2+'))
  assert.equal(lost.badges.length, 2, JSON.stringify(lost.badges))
})

t('a version-only callout ("Added in 1.2") may become a badge; other notes may not (callouts, versions)', () => {
  const o = '# P\n\n### From the app\n\n!!! note "Added in 1.2"\n    The gallery.\n\n!!! note "Changed in 1.2"\n    Dates move.\n'
  const asBadge = `# P\n\n### From the app\n\n${badge('1.2')}\n\nThe gallery.\n\n:::note[Changed in 1.2]\nDates move.\n:::\n`
  assert.equal(count(run(o, asBadge, 'x/p.md')), 0, JSON.stringify(run(o, asBadge, 'x/p.md')))
  const changedAsBadge = `# P\n\n### From the app\n\n${badge('1.2')}\n\nThe gallery.\n\n${badge('1.2')}\n\nDates move.\n`
  const lost = run(o, changedAsBadge, 'x/p.md')
  assert.deepEqual(lost.callouts, ['note 1->0'])
  assert.deepEqual(lost.versions, ['changed in 1.2'])
})

t('a badge inside a sentence is rejected (badges)', () => {
  const lost = run(old, neu.replace('scopes are new in 1.2.', `scopes are new in 1.2 ${badge('1.2')}.`))
  assert.ok(lost.badges.some((b) => b.startsWith('badge inside prose')), JSON.stringify(lost.badges))
})

t('a prose note can not be replaced by a badge (versions)', () => {
  const swapped = neu
    .replace('scopes are new in 1.2.', 'with scopes.')
    .replace('- **Personal access tokens.**', `- **Personal access tokens.** ${badge('1.2')}`)
  const lost = run(old, swapped)
  assert.ok(lost.versions.includes('new in 1.2'), JSON.stringify(lost.versions))
  assert.deepEqual(lost.badges, [])
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
