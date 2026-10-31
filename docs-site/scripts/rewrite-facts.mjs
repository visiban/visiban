// What a rewrite of one docs page lost, compared with the original (#1271).
// Shared by check-rewrite-facts.mjs (the CLI) and test-rewrite-facts.mjs.
//
// What is checked mechanically, per page:
//   blocks    code blocks (whitespace-normalized, dedented)
//   inline    inline-code tokens: every env var, path, flag, command
//   links     external link targets (http/https)
//   internal  internal link targets, as page + anchor (a relative .md link, a
//             same-page #anchor, an absolute /path/ in docs-site/, and a
//             docs.visiban.com/<version>/path/ link all reduce to one key)
//   callouts  admonitions per severity (mkdocs note/info -> note, tip -> tip,
//             warning -> caution, danger -> danger; Starlight :::note/tip/
//             caution/danger): the rewrite needs at least as many of each
//   labels    blockquote callout labels ("> **Added in 1.2**", "> **Tested:**",
//             "> **Visiban Enterprise**"): the label text must survive
//   terms     the bold lead term of every bullet ("- **Invite links** ..."):
//             it must still be a bold term in the rewrite
//   counts    number phrases in list items and table rows ("five roles",
//             "10 MB"): the same phrase must survive
//   versions  version notes: "Added in 1.2", "Changed in 1.2", "new in 1.2",
//             "since 1.2", "Reflects 1.2", "(1.2+)", "*(1.2)*",
//             "*(1.2, off by default)*"
//   anchors   every H2-H6 anchor mkdocs published (duplicates _1, _2, ...)
//             must still resolve, as a heading id or an <a id> shim
//
// What is NOT checked, and needs a human: a fact stated only in plain prose
// (not code, not a bold bullet term, not a number phrase in a list or table)
// can be reworded into something false, or dropped, and none of the above
// will notice. Neither will a version note whose number is kept but whose
// meaning changes.

import { posix } from 'node:path'
import { headings } from './anchors.mjs'

export const norm = (s) => s.replace(/\s+/g, ' ').trim()
export const stripFences = (t) => t.replace(/^ *(```|~~~)[\s\S]*?^ *\1/gm, '')
export const words = (t) =>
  stripFences(t).replace(/<a id="[^"]*"><\/a>/g, '').split(/\s+/).filter(Boolean).length

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

const severity = { note: 'note', info: 'note', tip: 'tip', warning: 'caution', caution: 'caution', danger: 'danger' }
export function callouts(text) {
  const c = { note: 0, tip: 0, caution: 0, danger: 0 }
  const body = stripFences(text)
  for (const m of body.matchAll(/^\s*!!!\s+(\w+)/gm)) c[severity[m[1]] ?? 'note']++
  for (const m of body.matchAll(/^:{3,}(note|tip|caution|danger)\b/gm)) c[m[1]]++
  return c
}

// Letters, digits and dots only; '&' reads as 'and'.
const key = (s) =>
  s.toLowerCase().replace(/&amp;|&/g, ' and ').replace(/[^a-z0-9.]+/g, ' ').replace(/\s*\.\s*$/, '').trim()
const quoteLabels = (t) => [...stripFences(t).matchAll(/^>\s*\*\*([^*]+)\*\*/gm)].map((m) => m[1].replace(/:\s*$/, '').trim())
const bulletTerms = (t) =>
  [...stripFences(t).matchAll(/^\s*(?:[-*+]|\d+\.)\s+\*\*([^*]+)\*\*/gm)].map((m) => m[1].replace(/[.:]\s*$/, '').trim())
const boldTerms = (t) => new Set([...stripFences(t).matchAll(/\*\*([^*]+)\*\*/g)].map((m) => key(m[1].replace(/[.:]\s*$/, ''))))
const NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+(?:[.,]\\d+)?)'
// Function words after a number say nothing about a quantity ("one to three").
const STOP = new Set(['to', 'of', 'or', 'and', 'the', 'a', 'an', 'in', 'on', 'for', 'is', 'are', 'at', 'per', 'by', 'with', 'than', 'that'])
const flat = (s) => norm(s.replace(/`[^`]*`/g, ' ')).toLowerCase()
const countPhrases = (t) =>
  new Set(
    stripFences(t)
      .split('\n')
      .filter((l) => /^\s*(?:[-*+]|\d+\.)\s|^\s*\|/.test(l))
      .flatMap((l) => [...flat(l).matchAll(new RegExp(`\\b${NUM}\\s+([a-z][a-z-]+)`, 'g'))])
      .filter((m) => !STOP.has(m[1]) && !/^\d+\.\d+\s/.test(m[0])) // version numbers are checked as version notes
      .map((m) => m[0]),
  )
export const versionNotes = (t) =>
  new Set(
    [
      ...stripFences(t).matchAll(
        /\b(?:added|changed|new|removed|deprecated|since|reflects|before|as of)\s+(?:in\s+)?\d+\.\d+(?:\.\d+)?(?:\.x)?|\(\d+\.\d+\+\)|\d+\.\d+\+|\(\d+\.\d+(?:\)|,[^)\n]*\))/gi,
      ),
    ].map((m) => m[0].toLowerCase()),
  )

export function pageKey(docsPath) {
  return docsPath.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '').replace(/\/$/, '') || 'index'
}
function internalLinks(text, docsPath) {
  const out = new Set()
  for (const m of stripFences(text).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    let k
    const [path, anchor] = target.split('#')
    const live = /^https:\/\/docs\.visiban\.com\/[^/]+\/(.*)$/.exec(path)
    if (live) k = pageKey(live[1])
    else if (/^[a-z]+:|^\/\//i.test(target)) continue
    else if (!path) k = pageKey(docsPath)
    else if (path.startsWith('/')) k = pageKey(path.replace(/^\/+/, ''))
    else if (/\.mdx?$/.test(path)) k = pageKey(posix.normalize(posix.join(posix.dirname(docsPath), path)))
    else continue
    out.add(anchor ? `${k}#${anchor}` : k)
  }
  return out
}

export const anchorsOf = (text) =>
  headings(text.split('\n'), { h1: /^#\s+(.*)$/m.exec(text)?.[1] }).map((h) => h.mkdocs)

/**
 * Everything `neu` lost relative to `old`. `ids` is the set of anchors the new
 * page resolves (from its build, or from its source's headings and shims).
 */
export function comparePage({ old, neu, docsPath, ids }) {
  const neuNorm = norm(neu)
  const neuLower = neu.toLowerCase()
  const neuKey = key(neu)
  const neuBold = boldTerms(neu)
  const newInternal = internalLinks(neu, docsPath)
  const newCounts = flat(stripFences(neu))
  const oc = callouts(old), nc = callouts(neu)
  return {
    blocks: codeBlocks(old).filter((b) => !neuNorm.includes(b)),
    inline: [...inlineCode(old)].filter((c) => !neu.includes(c)),
    links: [...extLinks(old)].filter((u) => !neu.includes(u)),
    internal: [...internalLinks(old, docsPath)].filter((k) => !newInternal.has(k)),
    callouts: Object.keys(oc).filter((k) => nc[k] < oc[k]).map((k) => `${k} ${oc[k]}->${nc[k]}`),
    labels: quoteLabels(old).filter((l) => !neuKey.includes(key(l))),
    terms: bulletTerms(old).filter((t) => !neuBold.has(key(t))),
    counts: [...countPhrases(old)].filter((p) => !newCounts.includes(p)),
    versions: [...versionNotes(old)].filter((v) => !neuLower.includes(v)),
    anchors: anchorsOf(old).filter((a) => !ids.has(a)),
  }
}
