// #2527: the type-aware half of the Sonar-mirroring lint rules, run by
// `npm run lint:typeaware` and the frontend-lint-typeaware CI job.
//   typescript:S9383 floating promise -> @typescript-eslint/no-floating-promises
// It is a separate config, not a block in eslint.config.js, because the rule
// needs the TypeScript program (parserOptions.projectService), and building it
// for all of src/ costs several times the memory of the untyped lint: under
// frontend-lint's 1024 MB heap cap the combined run dies with "Reached heap
// limit". Splitting keeps `npm run lint` (and editors) on the fast untyped
// parse and gives this rule its own measured heap. Only this one rule is
// enabled here; every other rule is in eslint.config.js.
// See docs/development/sonarcloud.md#sonar-rules-mirrored-in-eslint.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import security from 'eslint-plugin-security'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import unicorn from 'eslint-plugin-unicorn'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.vite']),
  {
    files: ['src/**/*.{ts,tsx}'],
    // Registered (no rules enabled) so an eslint-disable comment naming one of
    // their rules resolves instead of failing with "Definition for rule ...
    // was not found". Add a plugin here when eslint.config.js gains one.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      security,
      'jsx-a11y': jsxA11y,
      unicorn,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // cardPeek.test.tsx / groupTree.test.tsx share a stem with a .ts file,
        // so tsc (and thus the project service) skips them; lint them via the
        // default project instead of failing to parse.
        projectService: {
          allowDefaultProject: ['src/test/cardPeek.test.tsx', 'src/test/groupTree.test.tsx'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Files carry eslint-disable comments for rules this config does not
    // enable (react-hooks, jsx-a11y, ...). Those are only meaningful to
    // eslint.config.js, which reports its own unused directives, so do not
    // report them here.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
])
