#!/usr/bin/env node
// Is scripts/anchors.mjs right about mkdocs' heading ids? (#1271)
//
// Checks the model against every heading id a real mkdocs build published
// (scripts/fixtures/mkdocs-anchor-ids.json, made by build-anchor-fixture.mjs),
// page by page and in order: all of them, not a sample. Then runs negative
// controls, so a model that has regressed to the old underscore-stripping
// behavior fails here, not silently in a rewrite check.
//
// Usage (from docs-site/): node scripts/test-anchor-model.mjs   (npm run test:anchors)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headings, headingText, mkdocsSlug } from './anchors.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mkdocs-anchor-ids.json', import.meta.url), 'utf8'))
let total = 0, wrong = 0
for (const [page, { ids, lines }] of Object.entries(fixture.pages)) {
  const model = headings(lines, { h1: lines.find((l) => /^#\s/.test(l))?.replace(/^#\s+/, '') }).map((h) => h.mkdocs)
  total += ids.length
  if (model.length !== ids.length) {
    console.log(`COUNT ${page}: mkdocs rendered ${ids.length} H2-H6 ids, the model found ${model.length} headings`)
  }
  for (let i = 0; i < Math.max(ids.length, model.length); i++) {
    if (model[i] !== ids[i]) {
      wrong++
      console.log(`WRONG ${page}: mkdocs #${ids[i] ?? '(none)'}, model #${model[i] ?? '(none)'}`)
    }
  }
}
console.log(`model vs real mkdocs (${fixture.source}): ${total - wrong}/${total} heading ids match`)

// Negative controls: each of these must hold, or the model has regressed.
assert.equal(mkdocsSlug(headingText('`DJANGO_SECRET_KEY`')), 'django_secret_key')
assert.equal(mkdocsSlug(headingText('DJANGO_SECRET_KEY')), 'django_secret_key')
assert.equal(mkdocsSlug(headingText('Kubernetes / Helm')), 'kubernetes-helm')
assert.equal(mkdocsSlug(headingText('**Bold** and _em_ and [link](x.md)')), 'bold-and-em-and-link')
assert.equal(mkdocsSlug(headingText('OAuth &amp; OIDC')), 'oauth-oidc')
const dup = headings(['## Troubleshooting', '## Troubleshooting', '## Troubleshooting'])
assert.deepEqual(dup.map((h) => h.mkdocs), ['troubleshooting', 'troubleshooting_1', 'troubleshooting_2'])
assert.deepEqual(dup.map((h) => h.astro), ['troubleshooting', 'troubleshooting-1', 'troubleshooting-2'])
console.log('negative controls pass')
process.exit(wrong ? 1 : 0)
