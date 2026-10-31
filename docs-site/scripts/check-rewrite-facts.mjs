#!/usr/bin/env node
// Did a Smart Brevity rewrite drop anything? (#1271)
//
// The style guide's one rule is "brevity cuts words, never facts". This makes
// that checkable instead of a reviewer's impression. For each page of the
// original docs/<section>/ it compares the rewritten page and reports:
//
//   - code blocks missing from the rewrite (whitespace-normalized, dedented)
//   - inline-code tokens missing (every env var, path, flag, command)
//   - external link targets missing (http/https)
//   - callouts lost, per severity (mkdocs !!! note/info -> note,
//     tip -> tip, warning -> caution, danger -> danger; the rewrite must have
//     at least as many of each severity as the original)
//   - published anchors that no longer resolve: every H2-H6 anchor mkdocs
//     generated for the old page (Python-Markdown toc slugify, duplicates
//     suffixed _1, _2, ...) must be an id in the BUILT page, either as a
//     heading or as an <a id> shim
//
// Usage (from docs-site/, after `npm run build`):
//   node scripts/check-rewrite-facts.mjs [section]     # default: getting-started
// Exit 1 when anything is missing.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const section = process.argv[2] ?? 'getting-started'
const oldDir = join(repo, 'docs', section)
const newDir = join(site, 'src/content/docs', section)
const dist = join(site, 'dist', section)
if (!existsSync(dist)) {
  console.error(`no ${dist}: run \`npm run build\` first`)
  process.exit(2)
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()
function codeBlocks(text) {
  const out = []
  for (const m of text.matchAll(/^( *)```[^\n]*\n([\s\S]*?)^ *```/gm)) {
    const ind = m[1].length
    out.push(norm(m[2].split('\n').map((l) => l.slice(Math.min(ind, l.length - l.trimStart().length))).join('\n')))
  }
  return out
}
const stripFences = (t) => t.replace(/^ *```[\s\S]*?^ *```/gm, '')
const inlineCode = (t) => new Set([...stripFences(t).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
const extLinks = (t) => new Set([...t.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]))
const words = (t) => stripFences(t).replace(/<a id="[^"]*"><\/a>/g, "").split(/\s+/).filter(Boolean).length

const severity = { note: 'note', info: 'note', tip: 'tip', warning: 'caution', danger: 'danger', caution: 'caution' }
function callouts(text, re) {
  const c = { note: 0, tip: 0, caution: 0, danger: 0 }
  for (const m of stripFences(text).matchAll(re)) c[severity[m[1]] ?? 'note']++
  return c
}
const oldCallouts = (t) => callouts(t, /^\s*!!!\s+(\w+)/gm)
const newCallouts = (t) => callouts(t, /^:{3,}(note|tip|caution|danger)\b/gm)

// Python-Markdown toc.slugify + its uniquifier (the anchors mkdocs published).
function mkdocsAnchors(text) {
  const seen = new Set()
  const out = []
  for (const line of stripFences(text).split('\n')) {
    const m = /^#{2,6}\s+(.*)$/.exec(line)
    if (!m) continue
    let t = m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').trim()
    t = t.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^\w\s-]/g, '').trim().toLowerCase()
    let id = t.replace(/[-\s]+/g, '-')
    const base = id
    for (let n = 1; seen.has(id); n++) id = `${base}_${n}`
    seen.add(id)
    out.push(id)
  }
  return out
}

let problems = 0
const totals = { oldWords: 0, newWords: 0, anchors: 0, anchorsMissing: 0 }
for (const f of readdirSync(oldDir).filter((n) => n.endsWith('.md')).sort()) {
  const base = f.replace(/\.md$/, '')
  const nf = [base + '.md', base + '.mdx'].map((n) => join(newDir, n)).find(existsSync)
  if (!nf) {
    console.log(`${f}: NOT PORTED`)
    problems++
    continue
  }
  const o = readFileSync(join(oldDir, f), 'utf8')
  const n = readFileSync(nf, 'utf8')
  const missingBlocks = codeBlocks(o).filter((b) => !norm(n).includes(b))
  const missingInline = [...inlineCode(o)].filter((c) => !n.includes(c))
  const missingLinks = [...extLinks(o)].filter((u) => !n.includes(u))
  const oc = oldCallouts(o), nc = newCallouts(n)
  const lostCallouts = Object.keys(oc).filter((k) => nc[k] < oc[k]).map((k) => `${k} ${oc[k]}->${nc[k]}`)
  const html = readFileSync(join(dist, base === 'index' ? '' : base, 'index.html'), 'utf8')
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
  const anchors = mkdocsAnchors(o)
  const missingAnchors = anchors.filter((a) => !ids.has(a))
  totals.oldWords += words(o)
  totals.newWords += words(n)
  totals.anchors += anchors.length
  totals.anchorsMissing += missingAnchors.length
  const fmt = (c) => `n${c.note}/t${c.tip}/c${c.caution}/d${c.danger}`
  console.log(
    `${f}: words ${words(o)} -> ${words(n)}; callouts ${fmt(oc)} -> ${fmt(nc)}; ` +
      `anchors ${anchors.length - missingAnchors.length}/${anchors.length}; missing: blocks ${missingBlocks.length}, ` +
      `inline ${missingInline.length}, links ${missingLinks.length}, callouts ${lostCallouts.length}, anchors ${missingAnchors.length}`,
  )
  for (const b of missingBlocks) console.log('   BLOCK:', b.slice(0, 140))
  for (const c of missingInline) console.log('   CODE:', c)
  for (const u of missingLinks) console.log('   LINK:', u)
  for (const c of lostCallouts) console.log('   CALLOUT:', c)
  for (const a of missingAnchors) console.log('   ANCHOR: #' + a)
  problems += missingBlocks.length + missingInline.length + missingLinks.length + lostCallouts.length + missingAnchors.length
}
console.log(
  `section ${section}: prose words ${totals.oldWords} -> ${totals.newWords}; ` +
    `published anchors resolving ${totals.anchors - totals.anchorsMissing}/${totals.anchors}; problems ${problems}`,
)
process.exit(problems ? 1 : 0)
