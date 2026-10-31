#!/usr/bin/env node
// Did a Smart Brevity rewrite drop anything? (#1271)
//
// The style guide's one rule is "brevity cuts words, never facts". This makes
// the mechanical part of it checkable: for every page it compares the original
// with the rewrite and reports what was lost. What is and is not checked is
// listed in scripts/rewrite-facts.mjs; a fact stated only in plain prose still
// needs a human reader.
//
// Two modes.
//
// Prototype mode (default): old = docs/<section>/*.md in the working tree,
// new = docs-site/src/content/docs/<section>/, anchors resolved against the
// BUILT page in docs-site/dist/ (run `npm run build` first). With no section
// it checks the root page (docs/index.md) and getting-started.
//   node scripts/check-rewrite-facts.mjs [section ...]
//
// In-place mode, for a rewrite done in docs/ itself (the #2020-#2026 issues):
// old = docs/<section>/*.md at a git ref, new = the working tree; mkdocs
// syntax on both sides; anchors resolved from the new Markdown source (its
// headings' mkdocs ids plus its <a id> shims), so no build is needed.
//   node scripts/check-rewrite-facts.mjs --base origin/main <section|index> ...
//
// Exit 1 when anything is lost.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shimIds } from './anchors.mjs'
import { comparePage, anchorsOf, callouts, words, pageKey } from './rewrite-facts.mjs'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const base = baseIdx >= 0 ? args.splice(baseIdx, 2)[1] : null
const sections = args.length ? args : ['index', 'getting-started']
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

// ---------- pages ----------
function pagesOf(section) {
  if (section === 'index') return ['index.md']
  if (base) {
    return git('ls-tree', '-r', '--name-only', base, `docs/${section}/`)
      .split('\n')
      .filter((p) => p.endsWith('.md'))
      .map((p) => p.replace(/^docs\//, ''))
  }
  return readdirSync(join(repo, 'docs', section))
    .filter((n) => n.endsWith('.md'))
    .map((n) => `${section}/${n}`)
}
function loadPair(docsPath) {
  const old = base ? git('show', `${base}:docs/${docsPath}`) : readFileSync(join(repo, 'docs', docsPath), 'utf8')
  if (base) {
    const p = join(repo, 'docs', docsPath)
    return { old, neu: existsSync(p) ? readFileSync(p, 'utf8') : null }
  }
  const stem = join(site, 'src/content/docs', docsPath.replace(/\.md$/, ''))
  const nf = [stem + '.md', stem + '.mdx'].find(existsSync)
  return { old, neu: nf ? readFileSync(nf, 'utf8') : null }
}
function newIds(docsPath, neu) {
  if (base) return new Set([...anchorsOf(neu), ...shimIds(neu)])
  const rel = pageKey(docsPath) === 'index' ? '' : pageKey(docsPath)
  const html = join(site, 'dist', rel, 'index.html')
  if (!existsSync(html)) {
    console.error(`no ${html}: run \`npm run build\` first, or use --base <ref> for an in-place rewrite`)
    process.exit(2)
  }
  return new Set([...readFileSync(html, 'utf8').matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
}

// ---------- compare ----------
let problems = 0
const totals = { oldWords: 0, newWords: 0, anchors: 0, anchorsOk: 0 }
for (const section of sections) {
  for (const docsPath of pagesOf(section)) {
    const { old, neu } = loadPair(docsPath)
    if (neu === null) {
      console.log(`${docsPath}: NOT FOUND in the rewrite`)
      problems++
      continue
    }
    const lost = comparePage({ old, neu, docsPath, ids: newIds(docsPath, neu) })
    const oc = callouts(old), nc = callouts(neu)
    const nAnchors = anchorsOf(old).length
    totals.oldWords += words(old)
    totals.newWords += words(neu)
    totals.anchors += nAnchors
    totals.anchorsOk += nAnchors - lost.anchors.length
    const fmt = (c) => `n${c.note}/t${c.tip}/c${c.caution}/d${c.danger}`
    const counts = Object.entries(lost).map(([k, v]) => `${k} ${v.length}`).join(', ')
    console.log(
      `${docsPath}: words ${words(old)} -> ${words(neu)}; callouts ${fmt(oc)} -> ${fmt(nc)}; ` +
        `anchors ${nAnchors - lost.anchors.length}/${nAnchors}; lost: ${counts}`,
    )
    for (const [kind, items] of Object.entries(lost)) {
      for (const it of items) console.log(`   ${kind.toUpperCase()}: ${String(it).slice(0, 140)}`)
      problems += items.length
    }
  }
}
console.log(
  `${base ? `in-place vs ${base}` : 'prototype'} [${sections.join(', ')}]: prose words ${totals.oldWords} -> ${totals.newWords}; ` +
    `published anchors resolving ${totals.anchorsOk}/${totals.anchors}; problems ${problems}`,
)
process.exit(problems ? 1 : 0)
