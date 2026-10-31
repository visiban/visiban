// Heading anchors as mkdocs published them, and as Starlight generates them (#1271).
//
// mkdocs (Python-Markdown toc): slugify = NFKD, drop non-ASCII, drop
// [^\w\s-], trim, lowercase, collapse runs of [-\s] to one '-'; a repeated
// anchor on the same page gets `_1`, `_2`, ...
//
// Starlight (Astro): github-slugger over the heading text; every space becomes
// '-' with no collapsing; a repeated anchor gets `-1`, `-2`, ...
//
// So an anchor drifts in two ways: punctuation between spaces ("Kubernetes /
// Helm": #kubernetes-helm vs #kubernetes--helm), and every repeated heading
// (#troubleshooting_1 vs #troubleshooting-1). github-slugger is resolved
// through starlight-versions' own dependency tree, not a new dependency.

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(site, 'node_modules/starlight-versions/package.json'))
const { default: GithubSlugger } = await import(req.resolve('github-slugger'))

export function mkdocsSlug(v) {
  return v
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-')
}

/**
 * The heading's text as rendered, which is what both slugifiers see:
 * Python-Markdown's toc takes the heading element's text, and Astro takes the
 * heading node's text. So code spans keep their content verbatim (underscores
 * included: `## DJANGO_SECRET_KEY` publishes #django_secret_key), links and
 * inline HTML keep their text, images contribute nothing, emphasis markers go
 * but intraword underscores stay, backslash escapes yield the character, and
 * entities are decoded.
 */
export function headingText(src) {
  const held = []
  const hold = (t) => `\u0000${held.push(t) - 1}\u0000`
  let s = src
  s = s.replace(/(`+)\s?(.+?)\s?\1/g, (_, _t, code) => hold(code))
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!<>|~"])/g, (_, c) => hold(c))
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '')
  s = s.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
  s = s.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
  s = s.replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
  s = s
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[n])
  return s.trim()
}

/**
 * Every H2-H6 heading outside code fences, with its line index and both ids.
 * `h1` (the page title) takes part in mkdocs' duplicate counting, as it does
 * when mkdocs renders the page; Starlight renders the title outside the
 * content, so it does not take part there.
 */
export function headings(lines, { h1 } = {}) {
  const mkSeen = new Map()
  const unique = (id) => {
    const n = mkSeen.get(id)
    mkSeen.set(id, (n ?? -1) + 1)
    return n === undefined ? id : `${id}_${n + 1}`
  }
  if (h1) unique(mkdocsSlug(headingText(h1)))
  const slugger = new GithubSlugger()
  const out = []
  let fence = null
  lines.forEach((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (line.trim().startsWith(fence)) fence = null
      return
    }
    if (fence) return
    const m = /^(#{2,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) return
    const text = headingText(m[2])
    const base = mkdocsSlug(text)
    const mkdocs = unique(base)
    // dup: a repeated heading, whose mkdocs id carries the _N suffix.
    out.push({ line: i, text, mkdocs, astro: slugger.slug(text), dup: mkdocs !== base })
  })
  return out
}

/** ids of explicit `<a id="...">` shims in Markdown source. */
export const shimIds = (text) => [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1])
