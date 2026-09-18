#!/usr/bin/env node
// Guards against a blind spot in diff-cover (#1076): a brand-new source file
// with zero tests never appears in the coverage report at all. diff-cover
// (and any line-diff coverage tool) only scores rows it finds in the report;
// a file with no rows contributes nothing to the denominator, so it reads as
// 100% covered instead of 0%. The failure mode is exactly backwards — a file
// with *some* tests gets scrutinized, a file with *none* sails through.
//
// This is the per-MR sibling of #1090 (an uninstrumented CI job reading as
// 0% in the aggregate). Same root cause: unmeasured code being scored as if
// it were fine.
//
// What this checks: every file *added* (not modified) on this branch since
// it diverged from the target branch, filtered to backend/*.py and
// frontend/src/*.ts(x) source files (excluding tests, migrations, and
// anything already excluded from coverage config), must appear as a
// <class filename="..."> row in the Cobertura XML coverage report. A source
// file that isn't there was never executed by the test suite at all.
//
// Exclusion lists are read from the project's own coverage config so this
// script cannot drift from backend/.coveragerc or frontend/vitest.config.ts:
//   - backend/.coveragerc's [run] omit list (fnmatch patterns, relative to
//     backend/), plus */migrations/* and manage.py — the same two patterns
//     backend-diff-coverage passes to `diff-cover --exclude` (migrations
//     legitimately count toward the aggregate 90% per .coveragerc, but a
//     diff-coverage miss on a migration is schema, not behavior).
//   - frontend/vitest.config.ts's test.coverage.exclude list (glob patterns,
//     relative to frontend/).
//
// Usage:
//   node scripts/check-added-files-covered.mjs [options]
//
//   --target-ref <ref>        Git ref to diff against (default:
//                              origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
//                              or origin/main outside CI).
//   --no-fetch                 Skip `git fetch` of the target branch (assumes
//                              it is already up to date locally).
//   --backend-coverage <path>  Path to the backend Cobertura XML report
//                              (default: backend/coverage.xml).
//   --frontend-coverage <path> Path to the frontend Cobertura XML report
//                              (default: frontend/coverage/cobertura-coverage.xml).
//   --self-test                 Build a synthetic git repo in a temp
//                              directory, prove the check fires on known-bad
//                              input and stays clean on known-good input,
//                              then exit. Requires no database, no network,
//                              and no repository state — never touches the
//                              real working tree. Ignores all other flags.
//   -h, --help                  Print this message.
//
// Exit codes: 0 = every added source file is covered (or none were added),
// 1 = at least one added source file is missing from its coverage report,
// or a self-test assertion failed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

// ─── git helpers ──────────────────────────────────────────────────────────

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, stdout: '', stderr: result.stderr || result.error?.message || 'git failed' };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

function getAddedFiles(cwd, targetRef) {
  const base = git(['merge-base', targetRef, 'HEAD'], cwd);
  if (!base.ok || !base.stdout.trim()) {
    return { base: null, files: [] };
  }
  const baseSha = base.stdout.trim();
  const diff = git(['diff', '--diff-filter=A', '--name-only', baseSha, 'HEAD'], cwd);
  if (!diff.ok) {
    throw new Error(`git diff failed: ${diff.stderr}`);
  }
  const files = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { base: baseSha, files };
}

// ─── pattern matching ─────────────────────────────────────────────────────

// Python fnmatch semantics (used by coverage.py's `omit`): `*` matches any
// run of characters, including `/` — there is no path-segment boundary.
function fnmatchToRegex(pattern) {
  let re = '';
  for (const c of pattern) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if ('.\\+^$()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// minimatch-lite semantics (used by vitest's `coverage.exclude`): `**`
// crosses `/`, a single `*` stops at `/`.
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.\\+^$()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(relPath, regexes) {
  return regexes.some((re) => re.test(relPath));
}

// ─── config readers ───────────────────────────────────────────────────────

// Parses the `omit = ` list out of a coveragerc's [run] section. Returns
// fnmatch regexes, relative to the backend/ root (source = . in .coveragerc).
function readCoveragercOmit(coveragercPath) {
  if (!existsSync(coveragercPath)) return [];
  const text = readFileSyncSafe(coveragercPath);
  const lines = text.split('\n');
  const patterns = [];
  let inOmit = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*omit\s*=/.test(line)) {
      inOmit = true;
      const inline = line.replace(/^\s*omit\s*=\s*/, '').trim();
      if (inline) patterns.push(inline);
      continue;
    }
    if (inOmit) {
      if (/^\s+\S/.test(line)) {
        patterns.push(line.trim());
      } else if (line.trim() === '') {
        continue;
      } else {
        inOmit = false;
      }
    }
  }
  return patterns.filter(Boolean).map(fnmatchToRegex);
}

// Parses the `exclude: [...]` array out of vitest.config.ts's test.coverage
// block. Deliberately a simple string-literal scan, not a TS parser — the
// array is always a flat list of quoted globs in this project.
function readVitestExclude(vitestConfigPath) {
  if (!existsSync(vitestConfigPath)) return [];
  const text = readFileSyncSafe(vitestConfigPath);
  const match = text.match(/exclude\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  const items = [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return items.map(globToRegex);
}

function readFileSyncSafe(path) {
  return readFileSync(path, 'utf8');
}

// ─── Cobertura XML ────────────────────────────────────────────────────────

// Extracts every <class filename="..."> value. A file that coverage never
// imported/executed has no <class> row at all — that absence is exactly the
// signal this script exists to catch, so we don't need a full XML parser,
// just the filename attributes.
function parseCoberturaFilenames(xmlPath) {
  if (!existsSync(xmlPath)) return null;
  const text = readFileSyncSafe(xmlPath);
  const filenames = new Set();
  for (const m of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"/g)) {
    filenames.add(m[1].replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return filenames;
}

function isFileCovered(relPath, prefix, coberturaFilenames) {
  const stripped = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  for (const cov of coberturaFilenames) {
    if (cov === stripped || cov === relPath) return true;
    if (relPath.endsWith('/' + cov) || cov.endsWith('/' + stripped)) return true;
  }
  return false;
}

// ─── candidate filtering ──────────────────────────────────────────────────

const MIGRATIONS_RE = /(^|\/)migrations\/.*\.py$/;

function classifyCandidates(files, backendOmitRegexes, vitestExcludeRegexes) {
  const backend = [];
  const frontend = [];
  for (const f of files) {
    if (f.startsWith('backend/') && f.endsWith('.py')) {
      const rel = f.slice('backend/'.length);
      if (rel === 'manage.py') continue;
      if (MIGRATIONS_RE.test(rel)) continue;
      if (matchesAny(rel, backendOmitRegexes)) continue;
      backend.push(f);
    } else if (f.startsWith('frontend/src/') && (f.endsWith('.ts') || f.endsWith('.tsx'))) {
      const rel = f.slice('frontend/'.length);
      if (matchesAny(rel, vitestExcludeRegexes)) continue;
      frontend.push(f);
    }
  }
  return { backend, frontend };
}

// ─── core check ───────────────────────────────────────────────────────────

function runCheck({ cwd, targetRef, backendCoveragePath, frontendCoveragePath }) {
  const { base, files } = getAddedFiles(cwd, targetRef);
  if (base === null) {
    return { ok: true, violations: [], info: `could not determine merge base with ${targetRef}; skipping.` };
  }

  const backendOmitRegexes = readCoveragercOmit(join(cwd, 'backend', '.coveragerc'));
  const vitestExcludeRegexes = readVitestExclude(join(cwd, 'frontend', 'vitest.config.ts'));

  const { backend, frontend } = classifyCandidates(files, backendOmitRegexes, vitestExcludeRegexes);

  const violations = [];

  if (backend.length > 0) {
    const covPath = resolve(cwd, backendCoveragePath);
    const filenames = parseCoberturaFilenames(covPath);
    if (filenames === null) {
      violations.push({
        file: backendCoveragePath,
        message: `backend coverage report not found at ${backendCoveragePath}, but new backend source ` +
          `file(s) were added on this branch: ${backend.join(', ')}. Run the backend coverage job first, ` +
          'or pass --backend-coverage to point at the report.',
      });
    } else {
      for (const f of backend) {
        if (!isFileCovered(f, 'backend/', filenames)) {
          violations.push({
            file: f,
            message: `new file has no coverage data at all: ${f}. It does not appear in ` +
              `${backendCoveragePath}, meaning the test suite never imported or executed it — ` +
              'diff-cover finds no rows for it and reports it as 100% covered, which is exactly ' +
              'backwards. Add a test that exercises this file, or if it is intentionally untested ' +
              "(e.g. a generated or vendored file), add it to backend/.coveragerc's omit list so " +
              'it is excluded consistently everywhere, not silently skipped here.',
          });
        }
      }
    }
  }

  if (frontend.length > 0) {
    const covPath = resolve(cwd, frontendCoveragePath);
    const filenames = parseCoberturaFilenames(covPath);
    if (filenames === null) {
      violations.push({
        file: frontendCoveragePath,
        message: `frontend coverage report not found at ${frontendCoveragePath}, but new frontend source ` +
          `file(s) were added on this branch: ${frontend.join(', ')}. Run the frontend coverage job first, ` +
          'or pass --frontend-coverage to point at the report.',
      });
    } else {
      for (const f of frontend) {
        if (!isFileCovered(f, 'frontend/', filenames)) {
          violations.push({
            file: f,
            message: `new file has no coverage data at all: ${f}. It does not appear in ` +
              `${frontendCoveragePath}, meaning the test suite never imported or rendered it — ` +
              'diff-cover finds no rows for it and reports it as 100% covered, which is exactly ' +
              'backwards. Add a test that renders or exercises this file, or if it is intentionally ' +
              "untested, add it to frontend/vitest.config.ts's test.coverage.exclude list so it is " +
              'excluded consistently everywhere, not silently skipped here.',
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, info: null };
}

// ─── self-test ────────────────────────────────────────────────────────────

const COVERAGERC_FIXTURE = `[run]
source = .
relative_files = true
omit =
    */tests/*
    */management/commands/benchmark.py
    visiban/wsgi.py
    visiban/asgi.py
    boards/routing.py

[report]
skip_covered = true
`;

const VITEST_CONFIG_FIXTURE = `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'src/vite-env.d.ts'],
    },
  },
})
`;

function coberturaXml(classes) {
  const classRows = classes
    .map((f) => `        <class name="${f}" filename="${f}" line-rate="1"><lines/></class>`)
    .join('\n');
  return `<?xml version="1.0" ?>
<coverage line-rate="1">
  <packages>
    <package name="root">
      <classes>
${classRows}
      </classes>
    </package>
  </packages>
</coverage>
`;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function assert(condition, message, failures) {
  if (condition) {
    console.log(`  ok — ${message}`);
  } else {
    console.error(`  SELF-TEST FAILED — ${message}`);
    failures.push(message);
  }
}

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'check-added-files-covered-selftest-'));
  const failures = [];
  try {
    console.log(`=== self-test: building synthetic repo in ${tmp} ===`);

    const run = (args) => {
      const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };

    run(['init', '--quiet', '-b', 'main']);
    run(['config', 'user.email', 'self-test@example.com']);
    run(['config', 'user.name', 'self-test']);

    writeFile(join(tmp, 'backend', '.coveragerc'), COVERAGERC_FIXTURE);
    writeFile(join(tmp, 'frontend', 'vitest.config.ts'), VITEST_CONFIG_FIXTURE);
    writeFile(join(tmp, 'backend', 'testapp', '__init__.py'), '');
    run(['add', '-A']);
    run(['commit', '--quiet', '-m', 'initial']);

    run(['checkout', '--quiet', '-b', 'feature']);

    // Backend: one covered file, one uncovered (known-bad) file, one test
    // file (omitted via */tests/*), one migration (explicitly excluded).
    writeFile(join(tmp, 'backend', 'testapp', 'covered.py'), 'def ok():\n    return 1\n');
    writeFile(join(tmp, 'backend', 'testapp', 'uncovered.py'), 'def bad():\n    return 1\n');
    writeFile(join(tmp, 'backend', 'testapp', 'tests', 'test_covered.py'), '# test\n');
    writeFile(join(tmp, 'backend', 'testapp', 'migrations', '0002_add_field.py'), '# migration\n');

    // Frontend: one covered file, one uncovered (known-bad) file, one file
    // excluded via vitest's src/test/** pattern.
    writeFile(join(tmp, 'frontend', 'src', 'components', 'Covered.tsx'), 'export const Covered = () => null;\n');
    writeFile(join(tmp, 'frontend', 'src', 'components', 'Uncovered.tsx'), 'export const Uncovered = () => null;\n');
    writeFile(join(tmp, 'frontend', 'src', 'test', 'helper.ts'), 'export const helper = () => {};\n');

    run(['add', '-A']);
    run(['commit', '--quiet', '-m', 'feature: add covered, uncovered, test, and migration files']);

    // Coverage reports (as CI artifacts would produce them) mention only the
    // covered files — this is the fixture that must trigger a violation for
    // uncovered.py / Uncovered.tsx and stay silent for everything else.
    writeFile(join(tmp, 'backend', 'coverage.xml'), coberturaXml(['testapp/covered.py']));
    writeFile(join(tmp, 'frontend', 'coverage', 'cobertura-coverage.xml'), coberturaXml(['src/components/Covered.tsx']));

    console.log('--- Case: known-bad fixture (uncovered.py / Uncovered.tsx present, no coverage rows) ---');
    const result = runCheck({
      cwd: tmp,
      targetRef: 'main',
      backendCoveragePath: 'backend/coverage.xml',
      frontendCoveragePath: 'frontend/coverage/cobertura-coverage.xml',
    });

    assert(!result.ok, 'detection fires on the known-bad fixture (result.ok === false)', failures);
    const flagged = result.violations.map((v) => v.file);
    assert(flagged.includes('backend/testapp/uncovered.py'), 'flags backend/testapp/uncovered.py', failures);
    assert(flagged.includes('frontend/src/components/Uncovered.tsx'), 'flags frontend/src/components/Uncovered.tsx', failures);
    assert(!flagged.includes('backend/testapp/covered.py'), 'does not flag backend/testapp/covered.py', failures);
    assert(!flagged.includes('frontend/src/components/Covered.tsx'), 'does not flag frontend/src/components/Covered.tsx', failures);
    assert(!flagged.includes('backend/testapp/tests/test_covered.py'), 'does not flag a test file (omitted via */tests/*)', failures);
    assert(!flagged.includes('backend/testapp/migrations/0002_add_field.py'), 'does not flag a migration file', failures);
    assert(!flagged.includes('frontend/src/test/helper.ts'), 'does not flag a file excluded via src/test/**', failures);

    console.log('--- Case: clean fixture (uncovered files removed) ---');
    writeFileSync(join(tmp, 'backend', 'coverage.xml'), coberturaXml(['testapp/covered.py', 'testapp/uncovered.py']));
    writeFileSync(
      join(tmp, 'frontend', 'coverage', 'cobertura-coverage.xml'),
      coberturaXml(['src/components/Covered.tsx', 'src/components/Uncovered.tsx']),
    );
    const cleanResult = runCheck({
      cwd: tmp,
      targetRef: 'main',
      backendCoveragePath: 'backend/coverage.xml',
      frontendCoveragePath: 'frontend/coverage/cobertura-coverage.xml',
    });
    assert(cleanResult.ok, 'passes once every added source file has a coverage row', failures);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n=== self-test: FAILED (${failures.length} assertion(s)) ===`);
    process.exit(1);
  }
  console.log('\n=== self-test: PASSED ===');
  process.exit(0);
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    targetRef: null,
    noFetch: false,
    backendCoverage: 'backend/coverage.xml',
    frontendCoverage: 'frontend/coverage/cobertura-coverage.xml',
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target-ref') opts.targetRef = argv[++i];
    else if (a === '--no-fetch') opts.noFetch = true;
    else if (a === '--backend-coverage') opts.backendCoverage = argv[++i];
    else if (a === '--frontend-coverage') opts.frontendCoverage = argv[++i];
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      'Usage: node scripts/check-added-files-covered.mjs [--target-ref <ref>] [--no-fetch] ' +
      '[--backend-coverage <path>] [--frontend-coverage <path>] [--self-test]',
    );
    process.exit(0);
  }

  if (opts.selfTest) {
    selfTest();
    return;
  }

  const cwd = process.cwd();
  let targetRef = opts.targetRef;
  if (!targetRef) {
    const branch = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || 'main';
    targetRef = `origin/${branch}`;
    if (!opts.noFetch) {
      const fetch = spawnSync('git', ['fetch', 'origin', branch, '--depth=100'], { cwd, stdio: 'inherit' });
      if (fetch.status !== 0) {
        console.error(`ERROR — git fetch origin ${branch} failed.`);
        process.exit(1);
      }
    }
  }

  const result = runCheck({
    cwd,
    targetRef,
    backendCoveragePath: opts.backendCoverage,
    frontendCoveragePath: opts.frontendCoverage,
  });

  if (result.info) {
    console.log(`INFO — ${result.info}`);
    process.exit(0);
  }

  if (result.ok) {
    console.log('OK — every added backend/frontend source file appears in its coverage report.');
    process.exit(0);
  }

  console.error(`ERROR — ${result.violations.length} added file(s) are absent from the coverage report entirely:\n`);
  for (const v of result.violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.message}\n`);
  }
  process.exit(1);
}

main();
