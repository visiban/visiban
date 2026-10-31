#!/usr/bin/env node
// Which heading anchors change when docs/ moves from mkdocs to Starlight? (#1271)
//
// Two classes drift (see scripts/anchors.mjs):
//   - punctuation:  "Kubernetes / Helm"  #kubernetes-helm   -> #kubernetes--helm
//   - duplicates:   a second "Troubleshooting"  #troubleshooting_1 -> #troubleshooting-1
// This counts the H2-H6 headings in each class, and the in-repo links
// (relative .md links under docs/) that target a drifting anchor. Links from
// outside docs/ and from other sites are not countable from here, which is why
// the converter shims every drifting anchor rather than only the linked ones.
//
// Usage (from docs-site/): node scripts/measure-anchor-drift.mjs [docs-dir]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headings } from './anchors.mjs'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = resolve(process.argv[2] ?? join(site, '../docs'))
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })

const files = walk(docsDir)
const drift = new Map()
let total = 0, punct = 0, dups = 0
const dupFiles = new Set()
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const h of headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] })) {
    total++
    if (h.mkdocs === h.astro) continue
    if (h.dup) {
      dups++
      dupFiles.add(f)
    } else punct++
    if (!drift.has(f)) drift.set(f, new Set())
    drift.get(f).add(h.mkdocs)
    console.log(`${relative(docsDir, f)}: #${h.mkdocs} -> #${h.astro}`)
  }
}
let links = 0
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue
    const target = m[1] ? resolve(dirname(f), m[1]) : f
    if (drift.get(target)?.has(m[2])) links++
  }
}
console.log(
  `${files.length} files, ${total} H2-H6 headings; ${punct + dups} anchors change, in ${drift.size} files ` +
    `(${punct} punctuation, ${dups} duplicate-heading in ${dupFiles.size} files); ` +
    `${links} in-repo links target a changing anchor`,
)
