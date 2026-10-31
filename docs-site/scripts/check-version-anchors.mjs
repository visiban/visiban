#!/usr/bin/env node
// Does every anchor mike published still resolve in the archived versions? (#1271)
//
// For each archived version in docs-versions.mjs, takes the pages its snapshot
// covers (docs/index.md and docs/getting-started/*.md at the version's tag)
// and every H2-H6 anchor mike published for them, and requires an element
// with that id in the BUILT page under dist/<slug>/. A bookmark such as
// docs.visiban.com/v1.2/getting-started/installation/#prerequisites_1 must keep
// landing on its section after the cutover.
//
// Ground truth: when the gh-pages branch is fetched (git fetch origin gh-pages),
// the ids are read from the HTML mike actually published for that tag
// (origin/gh-pages:<tag>/...). Otherwise they are modeled from the Markdown at
// the tag with scripts/anchors.mjs, which test-anchor-model.mjs checks
// against a real mkdocs build. The output says which source it used.
//
// mike's published HTML for a version is not always its tag: the published
// /v1.1.0/ pages carry headings the v1.1.0 tag's Markdown does not have. A
// snapshot built from the tag cannot contain those sections, so those ids are
// reported separately ("not in the tag") and do not fail the check; every id
// whose heading IS in the tag's source must resolve.
//
// Usage (from docs-site/, after `npm run build`): node scripts/check-version-anchors.mjs
// Exit 1 on any miss.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headings } from './anchors.mjs'
import { versions } from '../docs-versions.mjs'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const tryGit = (...a) => {
  try {
    return git(...a)
  } catch {
    return null
  }
}
const ghPages = tryGit('rev-parse', '--verify', '--quiet', 'origin/gh-pages') ? 'origin/gh-pages' : null

let missing = 0
for (const { slug, tag } of versions) {
  const sources = [
    'docs/index.md',
    ...git('ls-tree', '--name-only', tag, 'docs/getting-started/').split('\n').filter((p) => p.endsWith('.md')),
  ]
  let total = 0, ok = 0, fromMike = 0, notInTag = 0
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
    // What mike published for this page, if gh-pages is here; else the model.
    const published = ghPages && tryGit('show', `${ghPages}:${tag}/${rel ? rel + '/' : ''}index.html`)
    const article = published && /<article\b[\s\S]*?<\/article>/.exec(published)?.[0]
    const expected = article
      ? [...article.matchAll(/<h([2-6])\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2])
      : headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] }).map((h) => h.mkdocs)
    if (article) fromMike++
    const inSource = new Set(headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] }).map((h) => h.mkdocs))
    for (const id of expected) {
      total++
      if (ids.has(id)) ok++
      else if (!inSource.has(id)) {
        notInTag++
        console.log(`NOT IN TAG ${slug}: /${slug}/${rel ? rel + '/' : ''}#${id} (published by mike, no such heading at ${tag})`)
      } else {
        missing++
        console.log(`MISSING ${slug}: /${slug}/${rel ? rel + '/' : ''}#${id}`)
      }
    }
  }
  console.log(
    `${slug} (from ${tag}): ${ok}/${total} mike-published anchors resolve; ${notInTag} not in the tag's source; ` +
      `${total - ok - notInTag} broken (${fromMike}/${sources.length} pages read from gh-pages HTML, the rest modeled)`,
  )
}
process.exit(missing ? 1 : 0)
