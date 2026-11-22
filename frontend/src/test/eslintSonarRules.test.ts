// #2527: negative controls for the ESLint rules that mirror Sonar findings
// (S9383, S1082, S7727). Each rule must fire on the Sonar-shaped example and
// report nothing on the fixed shape, so a config edit can't silently disarm it.
// The type-aware rule is checked against eslint.typeaware.config.js (the
// frontend-lint-typeaware job); the two syntactic rules against
// eslint.config.js (`npm run lint`, the frontend-lint job).
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
// The scratch path is not a real file, so the type-aware run lints it through
// the default project rather than tsconfig.app.json.
const FILE = path.resolve(__dirname, 'scratchSonarMirror.tsx')

const mainLint = new ESLint({ cwd: ROOT })
const typeAwareLint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, 'eslint.typeaware.config.js'),
  overrideConfig: {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['src/test/scratchSonarMirror.tsx'] } },
    },
  },
})

// A message with no ruleId is a parse failure ('parse-error') or an unused
// disable directive ('unused-directive'), so a fixed-shape snippet that fails
// to parse fails toEqual([]) instead of passing it vacuously.
async function rulesFired(eslint: ESLint, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: FILE })
  return result.messages.map((m) => m.ruleId ?? (m.fatal ? 'parse-error' : 'unused-directive'))
}

const PRELUDE = `export const load = async (): Promise<number> => 1\n`

describe('Sonar-mirroring ESLint rules', () => {
  it('S9383 (type-aware config): flags a floating promise, accepts an awaited or void one', async () => {
    const bad = PRELUDE + `export async function a() { load() }\n`
    const good = PRELUDE + `export async function a() { await load(); void load() }\n`
    expect(await rulesFired(typeAwareLint, bad)).toContain('@typescript-eslint/no-floating-promises')
    expect(await rulesFired(typeAwareLint, good)).toEqual([])
  }, 60_000)

  it('S9383 stays out of the main config, and its disable comments are not reported unused there', async () => {
    const bad = PRELUDE + `export async function a() { load() }\n`
    const disabled =
      PRELUDE +
      `export async function a() {\n  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- test\n  load()\n}\n`
    expect(await rulesFired(mainLint, bad)).toEqual([])
    expect(await rulesFired(mainLint, disabled)).toEqual([])
  }, 60_000)

  it('main config still reports an unused disable comment for any other rule', async () => {
    const code = `// eslint-disable-next-line no-control-regex -- test\nexport const x = 1\n`
    expect(await rulesFired(mainLint, code)).toEqual(['unused-directive'])
  }, 60_000)

  it('S1082 (main config): flags click without key handler, accepts a paired one', async () => {
    const bad = `export const A = () => <div onClick={() => undefined}>x</div>\n`
    const good = `export const A = () => <div onClick={() => undefined} onKeyDown={() => undefined}>x</div>\n`
    expect(await rulesFired(mainLint, bad)).toContain('jsx-a11y/click-events-have-key-events')
    expect(await rulesFired(mainLint, good)).toEqual([])
  }, 60_000)

  it('S7727 (main config): flags a function reference in an array callback, accepts an arrow', async () => {
    const bad = `const f = (n: number) => n > 1\nexport const r = [1, 2].map(f)\n`
    const good = `const f = (n: number) => n > 1\nexport const r = [1, 2].map((n) => f(n))\n`
    expect(await rulesFired(mainLint, bad)).toContain('unicorn/no-array-callback-reference')
    expect(await rulesFired(mainLint, good)).toEqual([])
  }, 60_000)
})
