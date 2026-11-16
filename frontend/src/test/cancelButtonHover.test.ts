/**
 * #484: every Cancel button (modal footers and inline Confirm/Cancel prompts) uses the
 * secondary variant, which includes the `hover:bg-surface-hover` fill and `rounded`
 * (frontend/CLAUDE.md § Buttons). The fill was dropped on dozens of Cancel buttons one at a
 * time, so this source scan covers every `.tsx` file under `src/` rather than a list of
 * modals: a new Cancel button without the fill fails here.
 *
 * The scan resolves `className="..."` literals and `className={CONST}` /
 * `className={`${CONST} ...`}` references to a string constant in the same file. A Cancel
 * whose classes are built some other way is reported as unresolved so it gets looked at.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(__dirname, '..')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : tsxFiles(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

interface CancelButton { where: string; classes: string | null }

function cancelButtons(): CancelButton[] {
  const found: CancelButton[] = []
  for (const file of tsxFiles(SRC)) {
    const src = readFileSync(file, 'utf8')
    const constant = (name: string): string | null => {
      const at = src.indexOf(`const ${name} =`)
      const m = at === -1 ? null : /^const \w+ =\s*"([^"]*)"/.exec(src.slice(at))
      return m ? m[1] : null
    }
    for (let at = src.indexOf('<button'); at !== -1; at = src.indexOf('<button', at + 1)) {
      const end = src.indexOf('</button>', at)
      if (end === -1) break
      const body = src.slice(at, end)
      if (body.indexOf('<button', 1) !== -1) continue
      // The visible label is Cancel: as the text content, or as a string literal in either branch
      // of a label expression (`{editable ? "Cancel" : "Close"}`).
      if (!/>\s*Cancel\s*$|"Cancel"/.test(body)) continue
      const where = `${relative(SRC, file)}:${src.slice(0, at).split('\n').length}`
      const literal = /className="([^"]*)"/.exec(body)
      const ref = /className=\{`?\$?\{?([A-Za-z_]\w*)/.exec(body)
      found.push({ where, classes: literal ? literal[1] : ref ? constant(ref[1]) : null })
    }
  }
  return found
}

describe('Cancel buttons use the secondary variant hover fill (#484)', () => {
  const buttons = cancelButtons()

  it('scans a Cancel label that is the first branch of a ternary (HealthStatusPopover)', () => {
    expect(buttons.some((b) => b.where.startsWith('components/Common/HealthStatusPopover.tsx'))).toBe(true)
  })

  it('finds the Cancel buttons (guards against a scan that silently matches nothing)', () => {
    expect(buttons.length).toBeGreaterThan(40)
  })

  it('every Cancel button resolves to classes with hover:bg-surface-hover and rounded', () => {
    const bad = buttons
      .filter((b) => b.classes === null || !b.classes.includes('hover:bg-surface-hover') || !/\brounded\b|\brounded-md\b/.test(b.classes))
      .map((b) => `${b.where} ${b.classes ?? '(className not resolvable)'}`)
    expect(bad).toEqual([])
  })

  it('every Cancel button carries the secondary text color and its hover:text-fg', () => {
    const bad = buttons
      .filter((b) => b.classes !== null && (!/(^|\s)text-fg-secondary(\s|$)/.test(b.classes) || !/(^|\s)hover:text-fg(\s|$)/.test(b.classes)))
      .map((b) => `${b.where} ${b.classes}`)
    expect(bad).toEqual([])
  })

  it('no Cancel button uses the tertiary text color instead of the secondary variant', () => {
    const tertiary = buttons
      .filter((b) => b.classes !== null && /(^|\s)text-fg-tertiary(\s|$)/.test(b.classes))
      .map((b) => b.where)
    expect(tertiary).toEqual([])
  })
})
