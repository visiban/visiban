#!/usr/bin/env node
// Which heading anchors change when docs/ moves from mkdocs to Starlight? (#1271)
//
// mkdocs (Python-Markdown toc.slugify) collapses runs of '-' and whitespace to
// one '-'; Starlight's heading ids follow github-slugger, which turns every
// space into '-' and keeps the result, so "Kubernetes / Helm" goes from
// #kubernetes-helm to #kubernetes--helm. This counts the H2-H6 headings whose
// anchor differs, and the in-repo links (relative .md links under docs/) that
// target one of them. Links from outside docs/ and from other sites are not
// countable from here.
//
// Usage (from docs-site/): node scripts/measure-anchor-drift.mjs [docs-dir]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = resolve(process.argv[2] ?? join(site, '../docs'))
const req = createRequire(join(site, 'node_modules/starlight-versions/package.json'))
const { slug: githubSlug } = await import(req.resolve('github-slugger'))

const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })
const mkdocsSlug = (v) =>
  v.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-')
const headingText = (h) => h.replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').trim()

const files = walk(docsDir)
const drift = new Map()
let headings = 0, differing = 0
for (const f of files) {
  let fence = false
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const m = !fence && /^(#{2,6})\s+(.*)$/.exec(line)
    if (!m) continue
    headings++
    const t = headingText(m[2])
    if (mkdocsSlug(t) !== githubSlug(t)) {
      differing++
      if (!drift.has(f)) drift.set(f, new Set())
      drift.get(f).add(mkdocsSlug(t))
      console.log(`${relative(docsDir, f)}: #${mkdocsSlug(t)} -> #${githubSlug(t)}`)
    }
  }
}
let links = 0
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
    const target = m[1] ? resolve(dirname(f), m[1]) : f
    if (drift.get(target)?.has(m[2])) links++
  }
}
console.log(
  `${files.length} files, ${headings} H2-H6 headings; ${differing} anchors change, in ${drift.size} files; ` +
    `${links} in-repo links target a changing anchor`,
)
