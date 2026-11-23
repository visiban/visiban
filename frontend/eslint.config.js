import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import unicorn from 'eslint-plugin-unicorn'
import { defineConfig, globalIgnores } from 'eslint/config'

// #2527: rules that eslint.typeaware.config.js enforces and this config does
// not. An eslint-disable comment for one of them is used by that run and
// unused by this one, and ESLint has no per-rule switch for unused-directive
// reporting, so without this filter each such comment would add a warning to
// frontend-lint's --max-warnings 15 budget. Every other unused directive is
// still reported.
const TYPE_AWARE_ONLY_RULES = ['@typescript-eslint/no-floating-promises']
const isTypeAwareOnlyUnusedDirective = (m) =>
  m.ruleId === null &&
  TYPE_AWARE_ONLY_RULES.some((rule) => m.message === `Unused eslint-disable directive (no problems were reported from '${rule}').`)
const typeAwareDirectiveFilter = {
  meta: { name: 'visiban/type-aware-directive-filter' },
  preprocess: (text) => [text],
  postprocess: ([messages]) => messages.filter((m) => !isTypeAwareOnlyUnusedDirective(m)),
  supportsAutofix: true,
}

export default defineConfig([
  globalIgnores(['dist', '.vite']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // React Compiler rules added in react-hooks v7 — opt-in only when using the compiler
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      // Non-component exports in component files are used for testing utilities
      'react-refresh/only-export-components': 'warn',
      // Allow _-prefixed names to indicate intentionally unused variables/args
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // #1319: a timer whose id is thrown away cannot be cleared on unmount, so it
  // can fire after the component is gone. That is how a ProfileTab save
  // navigated during a later test (`setTimeout(() => navigate(...), 1500)`),
  // a flake vitest's CI retry could not absorb. This flags a setTimeout /
  // setInterval call (bare, `window.` or `globalThis.`) with a delay other than
  // a literal 0 when its return value is visibly discarded: the call is a
  // whole statement, the expression body of an arrow (`() => setTimeout(...)`,
  // `.then(() => setTimeout(...))`), or the operand of `void`. Zero-delay hops
  // (focus after render, resetting a ref) are allowed: they fire before
  // anything can unmount.
  // Not caught, so review still has to check: an id that is stored but never
  // cleared (`const t = setTimeout(...)` with no clearTimeout(t), or a ref
  // whose unmount cleanup is missing, the #1304/#1305 shape), and a call
  // discarded some other way (`cond && setTimeout(...)`, a comma expression).
  {
    files: [
      'src/components/**/*.{ts,tsx}',
      'src/pages/**/*.{ts,tsx}',
      'src/hooks/**/*.{ts,tsx}',
      'src/context/**/*.{ts,tsx}',
      'src/contexts/**/*.{ts,tsx}',
      'src/App.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error',
        ...[
          'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
          'CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name=/^(setTimeout|setInterval)$/]',
        ].map((call) => ({
          selector: `:matches(ExpressionStatement, ArrowFunctionExpression, UnaryExpression[operator="void"]) > ${call}[arguments.length>1]:not([arguments.1.value=0])`,
          message: 'Discarded timer with a delay: it can fire after unmount. Hold the id in a ref and clear it on unmount (#1319).',
        })),
      ],
    },
  },
  // #2527: lint rules that mirror Sonar findings SonarCloud only reports on
  // main (nightly), so a branch otherwise cannot see them. See
  // docs/development/sonarcloud.md#sonar-rules-mirrored-in-eslint.
  //   typescript:S1082 click, no key     -> jsx-a11y/click-events-have-key-events
  //   typescript:S7727 fn ref to array cb -> unicorn/no-array-callback-reference
  // The third, typescript:S9383 (floating promise ->
  // @typescript-eslint/no-floating-promises), is type-aware and lives in
  // eslint.typeaware.config.js instead (`npm run lint:typeaware`, CI job
  // frontend-lint-typeaware): building the TypeScript program for src/ pushes
  // this run past frontend-lint's 1024 MB heap cap on the 2 GB runner.
  // Its eslint-disable comments are therefore unused here; the processor
  // drops only those unused-directive warnings (typeAwareDirectiveFilter).
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, unicorn },
    processor: typeAwareDirectiveFilter,
    rules: {
      'jsx-a11y/click-events-have-key-events': 'error',
      'unicorn/no-array-callback-reference': 'error',
    },
  },
  // Security SAST rules — scoped to src/ to keep the scan focused and avoid
  // OOM in memory-constrained CI runners scanning config/test infrastructure.
  // detect-object-injection is off: TypeScript types already constrain property
  // access, so the rule produces false positives on typed enum/const indexing.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { security },
    rules: {
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-possible-timing-attacks': 'warn',
    },
  },
])
