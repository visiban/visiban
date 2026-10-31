#!/usr/bin/env node
// Record the heading ids a REAL mkdocs build publishes, as ground truth for
// scripts/anchors.mjs (#1271).
//
// The anchor checks model mkdocs' slugs instead of running mkdocs. A model can
// be wrong in ways its own tests never notice (it once stripped underscores,
// so `## DJANGO_SECRET_KEY` modeled as #djangosecretkey while mkdocs publishes
// #django_secret_key). This records, for every page in docs/, the ids mkdocs
// actually rendered, plus the lines the model needs to recompute them (heading
// and code-fence lines only, so the fixture stays small and does not go stale
// when a page's prose changes). test-anchor-model.mjs then checks the model
// against every recorded heading.
//
// Usage (from docs-site/; needs mkdocs and the plugins in docs/requirements.txt):
//   mkdocs build -f ../mkdocs.yml -d /tmp/site && node scripts/build-anchor-fixture.mjs /tmp/site
// Regenerate whenever docs/ headings change and the test says the fixture is stale.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const built = process.argv[2]
if (!built || !existsSync(join(built, 'index.html'))) {
  console.error('usage: build-anchor-fixture.mjs <mkdocs-site-dir>   (run `mkdocs build -d <dir>` first)')
  process.exit(2)
}
const docs = join(repo, 'docs')
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })

const pages = {}
let headings = 0
for (const file of walk(docs).sort()) {
  const rel = relative(docs, file)
  // changelog.md's headings come from ../CHANGELOG.md via include-markdown.
  if (rel === 'changelog.md') continue
  const out = rel === 'index.md' ? 'index.html' : rel.replace(/(^|\/)index\.md$/, '$1index.html').replace(/\.md$/, '/index.html')
  const html = readFileSync(join(built, out), 'utf8')
  const article = /<article\b[\s\S]*?<\/article>/.exec(html)?.[0] ?? ''
  const ids = [...article.matchAll(/<h([2-6])\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2])
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^\s*(`{3,}|~{3,})/.test(l) || /^\s*#{1,6}\s/.test(l))
  pages[rel] = { ids, lines }
  headings += ids.length
}
const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const version = execFileSync('mkdocs', ['--version'], { encoding: 'utf8' }).trim().split(' from ')[0]
const dir = join(site, 'scripts/fixtures')
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'mkdocs-anchor-ids.json'),
  JSON.stringify({ source: `${version}, docs/ at ${sha} (+ working tree)`, pages }, null, 1) + '\n',
)
console.log(`${Object.keys(pages).length} pages, ${headings} H2-H6 ids recorded`)
