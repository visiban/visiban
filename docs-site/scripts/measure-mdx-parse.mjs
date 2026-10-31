#!/usr/bin/env node
// Which pages would abort a starlight-versions version cut? (#1271)
//
// When a new version is added, the plugin copies the current tree and runs
// every page (.md included) through remark + remark-directive + remark-mdx +
// remark-frontmatter. A page that is fine Markdown but not valid MDX (an HTML
// comment, a bare <word>, a `{` in prose) throws, and the cut aborts halfway.
// This runs the same processor, resolved through starlight-versions' own
// dependency tree, so it parses exactly as the cut does.
//
// Usage (from docs-site/):
//   node scripts/measure-mdx-parse.mjs [dir ...]   # default: ../docs and src/content/docs
// Reports file:line and the parser's reason. Exit 1 if any file fails.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(site, 'node_modules/starlight-versions/package.json'))
const mod = async (name) => import(req.resolve(name))
const { remark } = await mod('remark')
const proc = remark()
  .use((await mod('remark-directive')).default)
  .use((await mod('remark-mdx')).default)
  .use((await mod('remark-frontmatter')).default)

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [join(site, '../docs'), join(site, 'src/content/docs')]
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : /\.mdx?$/.test(p) ? [p] : []
  })

let failing = 0
for (const dir of dirs.map((d) => resolve(d)).filter(existsSync)) {
  const files = walk(dir)
  let bad = 0
  for (const f of files) {
    try {
      proc.parse(readFileSync(f, 'utf8'))
    } catch (e) {
      bad++
      // Report the offending construct's line. For an unclosed tag the
      // message's own position is the enclosing paragraph's start, and the
      // tag's position is only in the reason text as "(line:col-line:col)".
      const inReason = /\((\d+):\d+-\d+:\d+\)/.exec(String(e.reason ?? ''))
      const line = inReason?.[1] ?? e.place?.start?.line ?? e.place?.line ?? e.line ?? '?'
      console.log(`FAIL ${relative(site, f)}:${line}  ${String(e.reason ?? e.message).split('\n')[0].slice(0, 110)}`)
    }
  }
  console.log(`${relative(site, dir) || '.'}: ${bad} of ${files.length} files fail the MDX parse`)
  failing += bad
}
process.exit(failing ? 1 : 0)
