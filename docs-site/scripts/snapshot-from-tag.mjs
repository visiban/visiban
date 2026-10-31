#!/usr/bin/env node
// Backfill a starlight-versions snapshot from a git tag (#1271 spike).
//
// Why this exists: starlight-versions cuts a version by copying the CURRENT
// docs tree into src/content/docs/<slug>/ the first time a new entry appears in
// the `versions` array. That is the right model going forward (cut at the
// release tag, commit the snapshot), but it cannot reach back in time. Releases
// that already shipped under mike have to be backfilled from their tags, and
// their source is mkdocs Markdown, so it is converted on the way in.
//
// Usage (from docs-site/):
//   node scripts/snapshot-from-tag.mjs <git-tag> <version-slug> [mike-url-version]
//   node scripts/snapshot-from-tag.mjs v1.1.0 v1.1
//
// Writes:
//   src/content/docs/<slug>/index.md            (from docs/index.md)
//   src/content/docs/<slug>/getting-started/*   (from docs/getting-started/)
//   src/content/versions/<slug>.json            (sidebar, from the tag's mkdocs.yml nav)
//
// Scope is deliberately the spike's scope: docs/index.md and
// docs/getting-started/. Links to any other page point at the same version on
// the live mike site (https://docs.visiban.com/<mike-version>/...), so the
// snapshot never links into a page this prototype does not have.
//
// Conversions (mkdocs-material -> Starlight):
//   - first `# H1`                        -> front matter `title:`
//   - `!!! type "Title"` + 4-space body   -> `:::type[Title]` ... `:::` (recursive)
//   - `=== "Label"` + 4-space body        -> <Tabs><TabItem> (file becomes .mdx)
//   - `[x](page.md#a)` relative links     -> absolute Starlight or mike URLs
//   - `#anchor` written as a mkdocs slug  -> the slug Astro generates
//   - in .mdx only: `{` `}` `<` in prose escaped, HTML comments -> MDX comments

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const siteRoot = join(here, '..')
const repoRoot = join(siteRoot, '..')

const [tag, slug, mikeArg] = process.argv.slice(2)
if (!tag || !slug) {
  console.error('usage: snapshot-from-tag.mjs <git-tag> <version-slug> [mike-url-version]')
  process.exit(2)
}
// Same guard astro.config.mjs applies: the #1270 failure was an unvalidated
// version identifier, so a malformed slug never reaches the filesystem.
if (!/^v\d+\.\d+(\.\d+-(alpha|beta|rc)\.\d+)?$/.test(slug)) {
  console.error(`refusing version slug "${slug}": expected vMAJOR.MINOR or vMAJOR.MINOR.PATCH-(alpha|beta|rc).N`)
  process.exit(2)
}
// mike publishes GA releases under their vMAJOR.MINOR alias and pre-releases
// under the exact tag; mirror that so out-of-scope links land on the same
// version of the live site.
const mikeVersion = mikeArg ?? (/^v\d+\.\d+\.\d+$/.test(tag) ? tag.replace(/\.\d+$/, '') : tag)

const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })

const sources = [
  'docs/index.md',
  ...git('ls-tree', '--name-only', `${tag}`, 'docs/getting-started/')
    .split('\n')
    .filter((p) => p.endsWith('.md')),
]
const inScope = new Set(sources)

// ---------- slugs ----------
// Python-Markdown toc.slugify, which is what every existing #anchor was written against.
function mkdocsSlug(v) {
  v = v.normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
  v = v.replace(/[^\w\s-]/g, '').trim().toLowerCase()
  return v.replace(/[-\s]+/g, '-')
}
// github-slugger's algorithm (what Starlight's heading anchors follow): lowercase,
// strip punctuation, every space becomes '-', no collapsing.
function astroSlug(v) {
  return v
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}
const headingText = (h) =>
  h.replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').trim()

// mkdocs anchor -> Astro anchor, per in-scope source file.
const anchorMaps = new Map()
const contents = new Map()
for (const src of sources) {
  const text = git('show', `${tag}:${src}`)
  contents.set(src, text)
  const map = new Map()
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const m = !fence && /^#{2,6}\s+(.*)$/.exec(line)
    if (m) map.set(mkdocsSlug(headingText(m[1])), astroSlug(headingText(m[1])))
  }
  anchorMaps.set(src, map)
}

const pageUrl = (src) => {
  const rel = src.replace(/^docs\//, '').replace(/\.md$/, '')
  const path = rel === 'index' ? '' : rel.replace(/\/index$/, '') + '/'
  return `/${slug}/${path}`
}

function rewriteLink(target, fromSrc) {
  if (/^[a-z]+:|^\/\//i.test(target)) return target // absolute URL
  const [pathPart, anchor] = target.split('#')
  if (!pathPart) {
    const mapped = anchor && anchorMaps.get(fromSrc)?.get(anchor)
    return '#' + (mapped ?? anchor)
  }
  if (!pathPart.endsWith('.md')) return target
  const resolved = posix.normalize(posix.join(posix.dirname(fromSrc), pathPart))
  if (inScope.has(resolved)) {
    const mapped = anchor && anchorMaps.get(resolved)?.get(anchor)
    return pageUrl(resolved) + (anchor ? '#' + (mapped ?? anchor) : '')
  }
  const rel = resolved.replace(/^docs\//, '').replace(/\.md$/, '').replace(/(^|\/)index$/, '')
  return `https://docs.visiban.com/${mikeVersion}/${rel ? rel + '/' : ''}${anchor ? '#' + anchor : ''}`
}

// ---------- block conversion ----------
const asideType = { note: 'note', info: 'note', tip: 'tip', warning: 'caution', danger: 'danger' }

function dedent4(lines) {
  return lines.map((l) => (l.startsWith('    ') ? l.slice(4) : l.trimStart() === '' ? '' : l))
}

// Collect the indented body that follows an `!!!` / `===` opener.
function takeBody(lines, i) {
  const body = []
  let j = i + 1
  while (j < lines.length && (lines[j].startsWith('    ') || lines[j].trim() === '')) {
    body.push(lines[j])
    j++
  }
  while (body.length && body.at(-1).trim() === '') {
    body.pop()
    j--
  }
  return { body: dedent4(body), next: j }
}

function convertBlocks(lines, state) {
  const out = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[2]
      else if (line.trim().startsWith(fence)) fence = null
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      continue
    }
    const adm = /^!!!\s+(\w+)(?:\s+"(.*)")?\s*$/.exec(line)
    if (adm) {
      const { body, next } = takeBody(lines, i)
      const inner = convertBlocks(body, state)
      const depth = Math.max(3, ...inner.map((l) => (/^(:{3,})/.exec(l)?.[1].length ?? 0) + 1))
      const colons = ':'.repeat(depth)
      const type = asideType[adm[1]] ?? 'note'
      out.push(`${colons}${type}${adm[2] ? `[${adm[2]}]` : ''}`, ...inner, colons)
      i = next - 1
      continue
    }
    if (/^===\s+"(.*)"\s*$/.test(line)) {
      state.tabs = true
      out.push('<Tabs>')
      let j = i
      while (j < lines.length) {
        const t = /^===\s+"(.*)"\s*$/.exec(lines[j])
        if (!t) break
        const { body, next } = takeBody(lines, j)
        out.push(`<TabItem label="${t[1].replace(/"/g, '&quot;')}">`, '', ...convertBlocks(body, state), '', '</TabItem>')
        j = next
        while (j < lines.length && lines[j].trim() === '' && /^===\s/.test(lines[j + 1] ?? '')) j++
      }
      out.push('</Tabs>')
      i = j - 1
      continue
    }
    out.push(line)
  }
  return out
}

// Inline pass over prose (outside fences and code spans).
function mapProse(lines, fn) {
  let fence = null
  return lines.map((line) => {
    const f = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[2]
      else if (line.trim().startsWith(fence)) fence = null
      return line
    }
    if (fence) return line
    return line
      .split(/(`+[^`]*`+)/)
      .map((part, k) => (k % 2 ? part : fn(part)))
      .join('')
  })
}

function convert(src) {
  const raw = contents.get(src)
  let lines = raw.replace(/\r\n/g, '\n').split('\n')
  // Front matter: none of the in-scope pages carry any; H1 becomes the title.
  const h1 = lines.findIndex((l) => /^#\s+/.test(l))
  const title = h1 >= 0 ? lines[h1].replace(/^#\s+/, '').trim() : posix.basename(src, '.md')
  if (h1 >= 0) lines.splice(h1, 1)

  const state = { tabs: false }
  lines = convertBlocks(lines, state)
  lines = mapProse(lines, (s) => s.replace(/\]\(([^)\s]+)\)/g, (_, t) => `](${rewriteLink(t, src)})`))

  const mdx = state.tabs
  if (mdx) {
    const generated = /^<\/?(Tabs|TabItem)\b/
    // Single-line HTML comments only (the only kind the in-scope pages use).
    const comments = []
    lines = mapProse(lines, (s) => {
      if (generated.test(s.trim())) return s
      s = s.replace(/<!--(.*?)-->/g, (_, c) => `\u0000${comments.push(c) - 1}\u0000`)
      s = s.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/</g, '&lt;')
      return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `{/*${comments[n]}*/}`)
    })
  }
  const fm = ['---', `title: ${JSON.stringify(title)}`, '---', '']
  const imports = mdx ? ["import { Tabs, TabItem } from '@astrojs/starlight/components';", ''] : []
  const body = lines.join('\n').replace(/^\n+/, '')
  return { ext: mdx ? '.mdx' : '.md', text: [...fm, ...imports, body].join('\n') }
}

// ---------- write ----------
const outDir = join(siteRoot, 'src/content/docs', slug)
rmSync(outDir, { recursive: true, force: true })
for (const src of sources) {
  const { ext, text } = convert(src)
  const rel = src.replace(/^docs\//, '').replace(/\.md$/, ext)
  const dest = join(outDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, text)
}

// Sidebar from the tag's own mkdocs nav, so the snapshot keeps that release's order.
const mkdocs = git('show', `${tag}:mkdocs.yml`).split('\n')
const start = mkdocs.findIndex((l) => /^\s*- Getting Started:\s*$/.test(l))
const items = []
for (let i = start + 1; i < mkdocs.length; i++) {
  const m = /^\s{4}- (?:(.+): )?getting-started\/(.+)\.md\s*$/.exec(mkdocs[i])
  if (!m) break
  const page = m[2] === 'index' ? 'getting-started' : `getting-started/${m[2]}`
  items.push(m[1] ? { slug: page, label: m[1] } : { slug: page, label: 'Overview' })
}
const sidebar = [{ label: 'Home', link: '/' }, { label: 'Getting Started', items }]
const versionsDir = join(siteRoot, 'src/content/versions')
mkdirSync(versionsDir, { recursive: true })
writeFileSync(join(versionsDir, `${slug}.json`), JSON.stringify({ sidebar }, null, 2) + '\n')

console.log(`snapshot ${tag} -> src/content/docs/${slug}/ (${sources.length} pages, links to mike ${mikeVersion})`)
