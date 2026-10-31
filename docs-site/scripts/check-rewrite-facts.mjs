#!/usr/bin/env node
// Did a Smart Brevity rewrite drop anything? (#1271)
//
// The style guide's one rule is "brevity cuts words, never facts". This makes
// it checkable instead of a reviewer's impression. For every page it compares
// the original with the rewrite and reports anything the rewrite lost:
//
//   blocks    code blocks (whitespace-normalized, dedented)
//   inline    inline-code tokens: every env var, path, flag, command
//   links     external link targets (http/https)
//   internal  internal link targets, as page + anchor (a relative .md link, a
//             same-page #anchor, an absolute /path/ in docs-site/, and a
//             docs.visiban.com/<version>/path/ link all reduce to the same key)
//   callouts  admonitions per severity (mkdocs note/info -> note, tip -> tip,
//             warning -> caution, danger -> danger; Starlight :::note/tip/
//             caution/danger): the rewrite needs at least as many of each
//   labels    blockquote callouts such as "> **Added in 1.2**", "> **Tested:**",
//             "> **Visiban Enterprise**": the label text must survive somewhere
//   versions  version notes ("Added in 1.2", "Changed in 1.2", "new in 1.2",
//             "since 1.2", "(1.2+)", "removed in 1.1", "Reflects 1.2")
//   anchors   every H2-H6 anchor mkdocs published for the old page (duplicates
//             suffixed _1, _2, ...) must still resolve: as a heading id or an
//             <a id="..."> shim
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
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headings, shimIds } from './anchors.mjs'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const base = baseIdx >= 0 ? args.splice(baseIdx, 2)[1] : null
const sections = args.length ? args : ['index', 'getting-started']
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

// ---------- extractors ----------
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const stripFences = (t) => t.replace(/^ *(```|~~~)[\s\S]*?^ *\1/gm, '')
function codeBlocks(text) {
  const out = []
  for (const m of text.matchAll(/^( *)```[^\n]*\n([\s\S]*?)^ *```/gm)) {
    const ind = m[1].length
    out.push(norm(m[2].split('\n').map((l) => l.slice(Math.min(ind, l.length - l.trimStart().length))).join('\n')))
  }
  return out
}
const inlineCode = (t) => new Set([...stripFences(t).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
const extLinks = (t) =>
  new Set([...t.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^https:\/\/docs\.visiban\.com\//.test(u)))
const words = (t) => stripFences(t).replace(/<a id="[^"]*"><\/a>/g, '').split(/\s+/).filter(Boolean).length

const severity = { note: 'note', info: 'note', tip: 'tip', warning: 'caution', caution: 'caution', danger: 'danger' }
function callouts(text) {
  const c = { note: 0, tip: 0, caution: 0, danger: 0 }
  const body = stripFences(text)
  for (const m of body.matchAll(/^\s*!!!\s+(\w+)/gm)) c[severity[m[1]] ?? 'note']++
  for (const m of body.matchAll(/^:{3,}(note|tip|caution|danger)\b/gm)) c[m[1]]++
  return c
}
// "> **Label**" blockquote callouts; the label, letters and digits only.
const labelKey = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s*\.\s*$/, '').trim()
const quoteLabels = (t) => [...stripFences(t).matchAll(/^>\s*\*\*([^*]+)\*\*/gm)].map((m) => m[1].replace(/:\s*$/, '').trim())
const versionNotes = (t) =>
  new Set(
    [
      ...stripFences(t).matchAll(
        /\b(?:added|changed|new|removed|deprecated|since|reflects|before|as of)\s+(?:in\s+)?\d+\.\d+(?:\.\d+)?(?:\.x)?|\(\d+\.\d+\+\)|\d+\.\d+\+/gi,
      ),
    ].map((m) => m[0].toLowerCase()),
  )

// Internal link targets, reduced to "<docs path without .md>#<anchor>".
function pageKey(docsPath) {
  return docsPath.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '').replace(/\/$/, '') || 'index'
}
function internalLinks(text, docsPath) {
  const out = new Set()
  for (const m of stripFences(text).matchAll(/\]\(([^)\s]+)\)/g)) {
    let target = m[1]
    let key
    const [path, anchor] = target.split('#')
    const live = /^https:\/\/docs\.visiban\.com\/[^/]+\/(.*)$/.exec(path)
    if (live) key = pageKey(live[1])
    else if (/^[a-z]+:|^\/\//i.test(target)) continue
    else if (!path) key = pageKey(docsPath)
    else if (path.startsWith('/')) key = pageKey(path.replace(/^\/+/, ''))
    else if (/\.mdx?$/.test(path)) key = pageKey(posix.normalize(posix.join(posix.dirname(docsPath), path)))
    else continue
    out.add(anchor ? `${key}#${anchor}` : key)
  }
  return out
}

function anchorsOf(text) {
  return headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] }).map((h) => h.mkdocs)
}

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
    const neuNorm = norm(neu)
    const neuLower = neu.toLowerCase()
    const ids = newIds(docsPath, neu)
    const newInternal = internalLinks(neu, docsPath)
    const oc = callouts(old), nc = callouts(neu)
    const neuLabelText = labelKey(neu)
    const lost = {
      blocks: codeBlocks(old).filter((b) => !neuNorm.includes(b)),
      inline: [...inlineCode(old)].filter((c) => !neu.includes(c)),
      links: [...extLinks(old)].filter((u) => !neu.includes(u)),
      internal: [...internalLinks(old, docsPath)].filter((k) => !newInternal.has(k)),
      callouts: Object.keys(oc).filter((k) => nc[k] < oc[k]).map((k) => `${k} ${oc[k]}->${nc[k]}`),
      labels: quoteLabels(old).filter((l) => !neuLabelText.includes(labelKey(l))),
      versions: [...versionNotes(old)].filter((v) => !neuLower.includes(v)),
      anchors: anchorsOf(old).filter((a) => !ids.has(a)),
    }
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
