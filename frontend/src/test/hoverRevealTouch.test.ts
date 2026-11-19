/**
 * #2347: a control that is `opacity-0 group-hover:opacity-100` is invisible on a device with no
 * hover (phone, tablet) unless it also carries `[@media(hover:none)]:opacity-100`. One source scan
 * over every `.tsx` file, like cancelButtonHover.test.ts, instead of an assertion per site.
 *
 * Exempt: non-interactive tooltips (`pointer-events-none`, nothing to reach), the Chart hover
 * marker, and CardItem.tsx (the card selection checkbox; its fix is owned by #2279's branch, so
 * #2347 stays open for that one site, remove this exemption when it lands).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(__dirname, '..')
const EXEMPT_FILES = new Set(['components/Card/CardItem.tsx', 'components/Common/Chart.tsx'])

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : tsxFiles(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

describe('hover-revealed controls have a touch reveal (#2347)', () => {
  it('every opacity-0 group-hover:opacity-100 class string also has [@media(hover:none)]:opacity-100', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file)
      if (EXEMPT_FILES.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
        const s = m[0]
        if (!/\bopacity-0\b/.test(s) || !/group-hover[^\s"`]*:opacity-100/.test(s)) continue
        if (s.includes('pointer-events-none') || s.includes('[@media(hover:none)]:opacity-100')) continue
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
