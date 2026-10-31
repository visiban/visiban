#!/usr/bin/env node
// Does every anchor mike published still resolve in the archived versions? (#1271)
//
// For each archived version, reads the pages it was backfilled from at their
// git tag (docs/index.md and docs/getting-started/*.md, the snapshot's scope),
// computes every H2-H6 anchor mkdocs published for them (duplicates suffixed
// _1, _2, ...; see scripts/anchors.mjs), and requires an element with that id
// in the BUILT page under dist/<slug>/. A bookmark such as
// docs.visiban.com/v1.2/getting-started/installation/#prerequisites_1 must keep
// landing on its section after the cutover.
//
// Usage (from docs-site/, after `npm run build`):
//   node scripts/check-version-anchors.mjs [slug=tag ...]
// Default: the versions this prototype backfills. Exit 1 on any miss.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headings } from './anchors.mjs'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const pairs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['v1.2=v1.2.0', 'v1.2.0-alpha.1=v1.2.0-alpha.1', 'v1.1=v1.1.0']
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

let missing = 0
for (const pair of pairs) {
  const [slug, tag] = pair.split('=')
  const sources = [
    'docs/index.md',
    ...git('ls-tree', '--name-only', tag, 'docs/getting-started/').split('\n').filter((p) => p.endsWith('.md')),
  ]
  let total = 0, ok = 0
  for (const src of sources) {
    const text = git('show', `${tag}:${src}`)
    const rel = src.replace(/^docs\//, '').replace(/\.md$/, '').replace(/(^|\/)index$/, '')
    const page = join(site, 'dist', slug, rel, 'index.html')
    if (!existsSync(page)) {
      console.log(`MISSING PAGE ${slug}: /${slug}/${rel}`)
      missing++
      continue
    }
    const ids = new Set([...readFileSync(page, 'utf8').matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
    for (const h of headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] })) {
      total++
      if (ids.has(h.mkdocs)) ok++
      else {
        missing++
        console.log(`MISSING ${slug}: /${slug}/${rel ? rel + '/' : ''}#${h.mkdocs}`)
      }
    }
  }
  console.log(`${slug} (from ${tag}): ${ok}/${total} mike-published anchors resolve`)
}
process.exit(missing ? 1 : 0)
