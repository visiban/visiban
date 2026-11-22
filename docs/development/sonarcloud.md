# SonarCloud is an advisory second opinion that never blocks a merge
<a id="sonarcloud"></a>

[SonarCloud](https://sonarcloud.io/project/overview?id=visiban_visiban) gives a second, independent read of code quality: bugs, vulnerabilities, security hotspots, maintainability, duplication, and test coverage. It runs on a schedule and never blocks a merge request.

**Why it matters:** Contributors and maintainers need to know what Sonar checks, how coverage gets to it, and what the quality policy is.

**Go deeper:** For the operational side (the token, the pipeline schedule, and what to do when the nightly run breaks), see the [SonarCloud maintainer runbook](../maintainers/sonarcloud.md).

## What runs and when

| Piece | Where | Trigger |
|---|---|---|
| `sonar:scan` | `.gitlab-ci.yml`, `security` stage | Scheduled pipelines only, when the schedule sets `SONAR_SCHEDULED=true` |
| `sonar-scan-selftest` (member of `lint-selftests-alpine`) | `.gitlab-ci.yml`, `lint` stage | MRs that touch `scripts/sonar-scan.sh`, `sonar-project.properties`, or the CI file; also `main` |
| `lint:sonar-exclusions` (member of `lint-selftests-alpine`) | `.gitlab-ci.yml`, `lint` stage | MRs that touch `sonar-project.properties`, `scripts/check-sonar-exclusions.sh`, or the CI file; also `main` |
| `sonar:rules-check` | `.gitlab-ci.yml`, `security` stage | Scheduled pipelines only, when the schedule sets `SONAR_SCHEDULED=true`; advisory (`allow_failure`) |
| `sonar-open-issues-selftest` (member of `lint-selftests-alpine`) | `.gitlab-ci.yml`, `lint` stage | MRs that touch `scripts/sonar-open-issues.sh` or the CI file; also `main` |

`sonar:scan` runs on the **Nightly** pipeline schedule (03:00 ET), never on MR or push
pipelines, so day-to-day pipeline time is unchanged. It's `allow_failure: true`: a SonarCloud
or network problem shows as a yellow job in an otherwise green pipeline and doesn't turn the
nightly red. It doesn't wait for SonarCloud to finish computing the quality gate
(`-Dsonar.qualitygate.wait=false`), because it refreshes a dashboard and isn't a merge gate.

Because nothing alerts on a yellow `sonar:scan`, a broken scan is only noticed by looking at
the schedule's pipeline history or at the dashboard's last-analysis date. The
[runbook](../maintainers/sonarcloud.md#when-the-nightly-sonarscan-is-yellow) says how to check.

The schedule is shared with the other nightly jobs; see
[CI Gate Self-Tests](ci-gates.md) for the full schedule table.

## Checking touched files before you push

`scripts/sonar-open-issues.sh <file>...` asks SonarCloud's public API (no token) for open `BUG`, `VULNERABILITY`, and `TO_REVIEW` hotspot findings and prints the ones on the files you name. The `completeness-check` gate runs it on `git diff --name-only origin/main...HEAD`; a finding on a touched file is reported as a GAP to fix it on the branch or defer it to an open issue named in the MR.

```bash
git diff --name-only origin/main...HEAD | xargs scripts/sonar-open-issues.sh
```

**Watch out:** It sees only what the last nightly scan of `main` found. Findings your branch introduces appear after it merges. It exits 0 on every lookup outcome and prints `sonar: lookup unavailable (<reason>)` when SonarCloud cannot be reached, so read the output rather than the exit code.

## How coverage reaches Sonar

SonarCloud doesn't run tests. It imports the coverage reports that the `test` stage already
produces. `sonar:scan` declares `needs:` on both producer jobs with `artifacts: true`:

| Report | Produced by | Format | Imported through |
|---|---|---|---|
| `backend/coverage.xml` | `backend-test-coverage` | Cobertura XML | `sonar.python.coverage.reportPaths` |
| `frontend/coverage/lcov.info` | `frontend-test` | LCOV | `sonar.javascript.lcov.reportPaths` |

**Watch out:** The scanner runs from the repository root, and neither report resolves from there as emitted. Left alone, it reads the report, resolves zero files, and reports 0.0% coverage with no error. `scripts/sonar-scan.sh --prep-only` writes a rewritten copy of each report, and `sonar-project.properties` points at the copies:

| Original | Rewritten copy | Rewrite | Why |
|---|---|---|---|
| `backend/coverage.xml` | `backend/coverage.sonar.xml` | An empty `<source></source>` becomes `<source><repo>/backend</source>` | `backend/.coveragerc` sets `relative_files = true` so parallel test shards can combine. That makes the report list filenames relative to `backend/` with no source root. |
| `frontend/coverage/lcov.info` | `frontend/coverage/lcov.sonar.info` | `SF:src/...` becomes `SF:frontend/src/...` | Vitest records paths relative to `frontend/`. |

- The originals are never modified, because GitLab's coverage tooling still reads them.
- A missing report only prints a warning, so one failed producer doesn't abort the whole scan.
- The script prints how many class entries and `SF:` files each rewritten report lists and warns when the count is zero, so the nightly log shows whether paths resolved.
- `sh scripts/sonar-scan.sh --self-test` proves both rewrites against fixtures; the `sonar-scan-selftest` (member of `lint-selftests-alpine`) job runs it.

See [Testing § SonarCloud coverage import](testing.md#sonarcloud-coverage-import-1370).

## What Sonar does not count or flag

Two different lists control this, and they are easy to confuse.

**`sonar.exclusions`** removes files from analysis entirely: no issues, no duplication, no
coverage. It lists only test code, which Sonar reads through `sonar.tests` instead.

**`sonar.coverage.exclusions`** keeps files in analysis (issues and duplication are still
reported) but removes them from the coverage denominator. Each entry is justified in a comment
in `sonar-project.properties`:

| Entry | Why it's out of the coverage denominator |
|---|---|
| `**/tests/**`, `**/test_*.py`, `**/conftest.py`, `**/*.test.ts`, `**/*.test.tsx`, `frontend/src/test/**` | Test code is the measuring instrument, not the subject |
| `frontend/e2e/**` | Playwright specs assert flows; they aren't themselves covered |
| `**/migrations/**` | Auto-generated schema operations. Data-migration logic is tested through the function it calls |
| `scripts/**`, `backend/scripts/**` | Repo tooling (CI gate scripts, release helpers). None of it ships in an image or bundle, and no test runner instruments it |
| `backend/factories.py` | Test-data factory module |
| `backend/boards/seed_data/**` | Standalone fixture generators (`generate_seed_data.py`, `generate_seed_data_part2.py`) that write the `backend/boards/sample_boards/*.json` and `sample-boards/*.csv` fixtures checked into the repo; run by hand, never imported by any runtime path |

**Watch out:** Nothing under product source is excluded to reach a number. If you are tempted to add an exclusion because a file is hard to cover, write the test instead.

**`sonar.issue.ignore.multicriteria.*`** silences one rule for one path, for findings that were triaged and confirmed as false positives.

- Every criterion carries a comment saying why, and the comment must name its rule.
- The `lint:sonar-exclusions` (member of `lint-selftests-alpine`) job (`scripts/check-sonar-exclusions.sh`) fails when a criterion's glob matches no tracked file, which is what a rename looks like when it silently un-suppresses findings.
- The nightly `sonar:rules-check` job adds an online check that every rule key is still active in the project's quality profile (fail-open: no token or an API error warns and passes).

See [Suppression Markers § SonarCloud suppressions](suppressions.md#sonarcloud-suppressions).

**Yes, but:** These properties apply only to CI-based analysis (the `sonar:scan` job and a local `scripts/sonar-scan.sh` run). SonarCloud's Automatic Analysis ignores `sonar-project.properties`, so it must stay off for this project.

When you add a Django app that has a `tests/` directory, add that directory to `sonar.tests` and keep it in step with the `backend/*/tests/**` exclusion. The two lists are maintained by hand.

## Sonar rules mirrored in ESLint
<a id="sonar-rules-mirrored-in-eslint"></a>

Sonar scans `main` nightly, so a branch can't see the findings it introduces. Where a Sonar rule has an ESLint equivalent, a lint job enforces it on every MR instead.

| Sonar rule | What it flags | Lint rule | Config | CI job | Status |
|---|---|---|---|---|---|
| `typescript:S9383` | Floating promise | `@typescript-eslint/no-floating-promises` | `frontend/eslint.typeaware.config.js` | `frontend-lint-typeaware` | `error` (type-aware, `projectService`); the job is `allow_failure: true` for now, see below |
| `typescript:S1082` | Click handler with no key handler | `jsx-a11y/click-events-have-key-events` | `frontend/eslint.config.js` | `frontend-lint` | `error` |
| `typescript:S7727` | Function reference passed to an array callback method | `unicorn/no-array-callback-reference` | `frontend/eslint.config.js` | `frontend-lint` | `error` (only this rule, not the unicorn preset) |
| `python:S1244` | Float equality | none | none | none | Uncovered: ruff runs with its default rule set and has no equivalent enabled, and `scripts/` is not linted by ruff at all (`ruff check backend/`) |
| `python:S5332` | Clear-text `http://` literal | none | none | none | Uncovered: neither ruff (default rules) nor bandit flags a bare URL literal, and `scripts/` is not scanned by either (`ruff check backend/`, `bandit -r backend/ clients/python/`) |

### Why the floating-promise rule has its own config and job

`no-floating-promises` needs type information, so ESLint has to build the TypeScript program for all of `src/` (`parserOptions.projectService`). That costs several times the memory of the untyped lint. With the rule in `eslint.config.js`, `npm run lint` died with `Reached heap limit` under `frontend-lint`'s `--max-old-space-size=1024`, and `frontend-lint` cannot raise its cap: a 1500 MB cap was already OOM-killed (exit 137) on the 2 GB runner. So the rule lives in `eslint.typeaware.config.js`, which enables only that rule, and runs in `frontend-lint-typeaware` with its own heap. `npm run lint` and editors keep the fast untyped parse and never see the rule.

Measured on 2026-11-22 in `node:22-alpine` with `docker --memory=2g`, `src/` only:

| Run | Heap cap | Result | Peak RSS | Wall clock |
|---|---|---|---|---|
| `npm run lint` (main config) | 1024 MB | passes, 0 errors, 15 warnings | 0.61 GB | 21 s |
| `npm run lint:typeaware` | 1344 MB | `Reached heap limit` | 1.52 GB | 32 s |
| `npm run lint:typeaware` | 1408 MB | passes | 1.59 GB | 25 s |
| `npm run lint:typeaware` | 1536 MB (the job's cap) | passes | 1.66 GB | 19 s |
| `npm run lint:typeaware` | none (Node's default in a 2 GB container) | `Reached heap limit` | 1.18 GB | 13 s |

The job's 1536 MB cap is about 9% above the smallest one that passes. It is `allow_failure: true` until it has passed on the real runners: [CI Runners](../maintainers/ci-runners.md) records no runner's memory, and `frontend-lint`'s 1500 MB kill (that job also runs `tsc`) suggests the runner has less headroom than a 2 GB container. If the job reports `Reached heap limit` as `src/` grows, raise the cap only while it stays clear of the runner's limit. Past that, one option is to lint the two `allowDefaultProject` test files in a separate invocation: they open a second TypeScript program, and without them the rest passed at a 1280 MB cap (macOS, Node 24) instead of 1408 MB.

Run it locally from `frontend/`:

```bash
NODE_OPTIONS=--max-old-space-size=1536 npm run lint:typeaware
```

An `eslint-disable` comment for `no-floating-promises` is used by the type-aware run and unused by `npm run lint`. ESLint has no per-rule switch for unused-directive reporting, so `eslint.config.js` filters out only that rule's unused-directive warnings (`typeAwareDirectiveFilter`); an unused directive for any other rule still counts toward `frontend-lint`'s `--max-warnings 15`. The type-aware config turns unused-directive reporting off, because every other rule's directive is unused there. It also registers the other plugins (with no rules enabled) so their directives resolve; add a plugin there when `eslint.config.js` gains one.

`jsx-a11y/no-static-element-interactions` is deliberately not enabled: it is stricter than Sonar S1082 and would flag widespread existing sites.

Existing violations that couldn't be fixed mechanically carry a `// eslint-disable-next-line <rule> -- SUPPRESSED-UNTIL(#N): <reason>` marker; see [Suppression Markers](suppressions.md). The rules are pinned by `frontend/src/test/eslintSonarRules.test.ts`, which lints a Sonar-shaped example (must fire) and its fixed shape (must report nothing, not even a parse error) against the config that enforces each rule. It also checks that the main config neither enforces `no-floating-promises` nor reports its disable comments as unused, while still reporting an unused directive for any other rule.

## Quality policy

- **Ratings: A / A / A.** Security, Reliability, and Maintainability are each rated A on
  overall code, not only on new code. A rating below A is a defect to fix, not a number to
  explain.
- **No unreviewed security hotspots.** Every hotspot gets reviewed and marked Safe, Fixed, or
  Acknowledged, with a comment saying why. A hotspot is a prompt for a human decision, so
  "Security Review" below A means someone hasn't made one. The
  [runbook](../maintainers/sonarcloud.md#the-review-every-new-hotspot-rule) describes the
  routine.
- **Suppressions need a rationale and a narrow path.** An ignore criterion states why the
  finding is a false positive or not worth fixing, scopes to the specific file or directory,
  and never widens a glob to make a finding disappear or to make the guard pass. A suppression
  that waits on tracked work follows the `SUPPRESSED-UNTIL(#N)` convention in
  [Suppression Markers](suppressions.md); a permanent one carries a plain reason.
  `lint:sonar-exclusions` (member of `lint-selftests-alpine`) enforces the structural half of this.
- **Coverage targets.** Aim for at least 85% on Sonar, with 80% as the floor. The enforced
  gates are separate; see [Testing § Coverage targets](testing.md#coverage-targets).

Fix findings in code where you can. Suppress only a false positive, and say why in the same change.

## Running a scan locally

Use this to reproduce the nightly result or to check a fix before waiting for the next run.

1. Generate both coverage reports:

    ```bash
    cd backend && pytest --cov --cov-report=xml
    cd ../frontend && npm test -- --coverage
    ```

2. Install the scanner (`brew install sonar-scanner`) or use the `sonarsource/sonar-scanner-cli`
   Docker image.
3. Run the wrapper from the repository root with a SonarCloud token that can run analysis on
   the project:

    ```bash
    SONAR_TOKEN=<your-token> scripts/sonar-scan.sh
    ```

    `scripts/sonar-scan.sh --prep-only` writes only the rewritten reports and skips the scan,
    which is a quick way to confirm both resolve a non-zero number of files.

!!! warning "A local scan publishes to the shared project"
    A scan from your checkout publishes an analysis to the shared project. Depending on the
    SonarCloud plan, it may replace the project's latest analysis or may not be analyzed at all
    for a branch other than the main one. Run it only when you are happy to see the result on
    the dashboard, and never paste the token into a file or a shell history you share.

## Reading the dashboard

Open the [project page](https://sonarcloud.io/project/overview?id=visiban_visiban).

- **Overall Code vs New Code.** The policy above applies to **Overall Code**. The quality gate
  scores **New Code** only, so a gate that passes doesn't mean the ratings are healthy.
- **Ratings.** Security, Reliability, and Maintainability each show A to E.
- **Security Hotspots.** The "Security Review" rating reflects the share of hotspots reviewed.
  Open the Security Hotspots tab and review anything in the To Review state.
- **Coverage.** Use the Measures tab to see which files are uncovered. A coverage of exactly
  0.0% almost always means the import broke, not that nothing is tested; check the
  `sonar:scan` log for the "resolved" lines first.
- **Last analysis date.** It shows when the dashboard last refreshed. A date more than a day
  old means the nightly scan isn't publishing.

## Why GitLab's coverage badge and Sonar's differ

They are two unrelated measurements and aren't expected to match.

Two jobs declare a `coverage:` regex in `.gitlab-ci.yml`: `backend-test-coverage` (the `TOTAL` line of `coverage report`) and `frontend-test` (the `All files` line of Vitest's text report). GitLab averages the values it collects into the pipeline's coverage figure, which is what the README badge shows. Check the `coverage:` lines in `.gitlab-ci.yml` if this changes.

| | GitLab coverage badge | SonarCloud |
|---|---|---|
| Source | Regexes over the job logs of `backend-test-coverage` and `frontend-test` | The imported Cobertura and LCOV reports |
| Scope | Backend and frontend, as an **average of two percentages** | Backend and frontend, as **one combined figure weighted by lines** |
| Denominator | Whatever each tool reports: everything `backend/.coveragerc` doesn't omit (`backend-test-migrations` applies every migration to build its test database, so migrations count), and no Sonar-style exclusions on either side | Product source only: tests, migrations, scripts, seed-data generators, and factories are excluded |
| Updates | Every pipeline that runs the jobs | Nightly |

- The badge averages two percentages, so a small frontend and a large backend count equally. Sonar weights each file by its lines.
- The badge never reaches the scanner, and the scanner never feeds the badge.
- The backend gate (`--fail-under=90`) applies only to the backend number, not to either combined figure.
