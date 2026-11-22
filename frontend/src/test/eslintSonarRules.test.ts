// #2527: negative controls for the ESLint rules that mirror Sonar findings
// (S9383, S1082, S7727). Each rule must fire on the Sonar-shaped example and
// stay quiet on the fixed shape, so a config edit can't silently disarm it.
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import path from 'node:path'

// The scratch path is not a real file, so it is linted through the type-aware
// default project rather than tsconfig.app.json.
const FILE = path.resolve(__dirname, 'scratchSonarMirror.tsx')
const eslint = new ESLint({
  cwd: path.resolve(__dirname, '../..'),
  overrideConfig: {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['src/test/scratchSonarMirror.tsx'] } },
    },
  },
})

async function rulesFired(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: FILE })
  return result.messages.map((m) => m.ruleId ?? 'parse-error')
}

const PRELUDE = `export const load = async (): Promise<number> => 1\n`

describe('Sonar-mirroring ESLint rules', () => {
  it('S9383: flags a floating promise, accepts an awaited or void one', async () => {
    const bad = PRELUDE + `export async function a() { load() }\n`
    const good = PRELUDE + `export async function a() { await load(); void load() }\n`
    expect(await rulesFired(bad)).toContain('@typescript-eslint/no-floating-promises')
    expect(await rulesFired(good)).not.toContain('@typescript-eslint/no-floating-promises')
  }, 60_000)

  it('S1082: flags click without key handler, accepts a paired one', async () => {
    const bad = `export const A = () => <div onClick={() => undefined}>x</div>\n`
    const good = `export const A = () => <div onClick={() => undefined} onKeyDown={() => undefined}>x</div>\n`
    expect(await rulesFired(bad)).toContain('jsx-a11y/click-events-have-key-events')
    expect(await rulesFired(good)).not.toContain('jsx-a11y/click-events-have-key-events')
  }, 60_000)

  it('S7727: flags a function reference in an array callback, accepts an arrow', async () => {
    const bad = `const f = (n: number) => n > 1\nexport const r = [1, 2].map(f)\n`
    const good = `const f = (n: number) => n > 1\nexport const r = [1, 2].map((n) => f(n))\n`
    expect(await rulesFired(bad)).toContain('unicorn/no-array-callback-reference')
    expect(await rulesFired(good)).not.toContain('unicorn/no-array-callback-reference')
  }, 60_000)
})
