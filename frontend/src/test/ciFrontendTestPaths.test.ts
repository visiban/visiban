// A test that reads a file outside frontend/ only guards against drift if CI
// runs it when that file changes (#2613). This fails when such a read is not in
// the `changes:` list of the `frontend-test` job.
//
// It sees quoted relative paths ('../../../backend/x'), resolved both against
// the file's directory (imports, resolve(__dirname, ...)) and against
// frontend/, the cwd of a bare readFileSync('../backend/x'). A path built from
// separate segments (resolve(__dirname, '..', '..', ...)) is not seen, so write
// out-of-tree reads as one string.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND = resolve(__dirname, '../..')
const REPO = resolve(FRONTEND, '..')

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )

/** Repo-relative paths outside frontend/ that `source` (at `file`) refers to. */
function outOfTreeReads(file: string, source: string): string[] {
  return [...source.matchAll(/['"`]((?:\.\.\/)+[^'"`$\n]+)['"`]/g)]
    .flatMap((m) => [dirname(file), FRONTEND].map((base) => resolve(base, m[1])))
    .filter(
      (target) =>
        relative(FRONTEND, target).startsWith('..') &&
        // Climbing from frontend/ can leave the repository; that is not a read of it.
        !relative(REPO, target).startsWith('..') &&
        existsSync(target),
    )
    .map((target) => relative(REPO, target).split(sep).join('/') + (statSync(target).isDirectory() ? '/' : ''))
}

/** The merge-request `changes:` entries of the frontend-test job. */
function changesList(ci: string): string[] {
  const job = /^frontend-test:\n((?:[ \t].*\n|\n)*)/m.exec(ci)?.[1] ?? ''
  const block = /- changes:\n((?: {8}.*\n)+)/.exec(job)?.[1] ?? ''
  return [...block.matchAll(/^ {8}- (\S+)$/gm)].map((m) => m[1])
}

const covered = (path: string, entries: string[]) =>
  entries.some((e) => (e.endsWith('/**/*') ? path.startsWith(e.slice(0, -'**/*'.length)) : e === path))

const entries = changesList(readFileSync(resolve(__dirname, '../../../.gitlab-ci.yml'), 'utf8'))

describe('frontend-test changes: list', () => {
  it('lists every file the frontend sources read from outside frontend/', () => {
    const reads = walk(join(FRONTEND, 'src'))
      .filter((f) => f !== __filename) // its negative control names an unlisted path
      .flatMap((f) => outOfTreeReads(f, readFileSync(f, 'utf8')))
    // Guard against the scan silently finding nothing.
    expect(reads).toContain('backend/accounts/registration_tokens.py')
    expect(reads).toContain('backend/boards/sample_boards/')
    expect([...new Set(reads.filter((r) => !covered(r, entries)))]).toEqual([])
  })

  it('reports a read that no entry covers', () => {
    const file = join(FRONTEND, 'src/test/x.test.ts')
    const reads = outOfTreeReads(file, "readFileSync('../../../backend/manage.py')")
    expect(reads).toEqual(['backend/manage.py'])
    expect(covered(reads[0], entries)).toBe(false)
  })

  it('reports a cwd-relative read from a nested test file', () => {
    const file = join(FRONTEND, 'src/test/x.test.ts')
    expect(outOfTreeReads(file, "readFileSync('../backend/manage.py')")).toEqual(['backend/manage.py'])
  })

  it('covers nothing when the job or its list is missing', () => {
    expect(changesList('other-job:\n  stage: test\n')).toEqual([])
    expect(covered('backend/manage.py', [])).toBe(false)
  })
})
