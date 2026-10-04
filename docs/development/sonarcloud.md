# SonarCloud

Visiban uses [SonarCloud](https://sonarcloud.io/project/overview?id=visiban_visiban) as a
second, independent read of code quality: bugs, vulnerabilities, security hotspots,
maintainability, duplication, and test coverage. It is advisory tooling that runs on a
schedule. It never blocks a merge request.

This page is for contributors and maintainers who need to understand what Sonar checks, how
coverage gets to it, and what the quality policy is. For the operational side (the token, the
pipeline schedule, and what to do when the nightly run breaks), see the
[SonarCloud maintainer runbook](../maintainers/sonarcloud.md).

## What runs and when

| Piece | Where | Trigger |
|---|---|---|
| `sonar:scan` | `.gitlab-ci.yml`, `security` stage | Scheduled pipelines only, when the schedule sets `SONAR_SCHEDULED=true` |
| `sonar-scan-selftest` | `.gitlab-ci.yml`, `lint` stage | MRs that touch `scripts/sonar-scan.sh`, `sonar-project.properties`, or the CI file; also `main` |
| `lint:sonar-exclusions` | `.gitlab-ci.yml`, `lint` stage | MRs that touch `sonar-project.properties`, `scripts/check-sonar-exclusions.sh`, or the CI file; also `main` |
| `sonar:rules-check` | `.gitlab-ci.yml`, `security` stage | Scheduled pipelines only, when the schedule sets `SONAR_SCHEDULED=true`; advisory (`allow_failure`) |

`sonar:scan` runs on the **Nightly** pipeline schedule (05:00 UTC), never on MR or push
pipelines, so day-to-day pipeline time is unchanged. It is `allow_failure: true`: a SonarCloud
or network problem shows as a yellow job in an otherwise green pipeline and does not turn the
nightly red. It also does not wait for SonarCloud to finish computing the quality gate
(`-Dsonar.qualitygate.wait=false`), because it refreshes a dashboard and is not a merge gate.

Because nothing alerts on a yellow `sonar:scan`, a broken scan is only noticed by looking at
the schedule's pipeline history or at the dashboard's last-analysis date. The
[runbook](../maintainers/sonarcloud.md#when-the-nightly-sonarscan-is-yellow) says how to check.

The schedule is shared with the other nightly jobs; see
[CI Gate Self-Tests](ci-gates.md) for the full schedule table.

## How coverage reaches Sonar

SonarCloud does not run tests. It imports the coverage reports that the `test` stage already
produces. `sonar:scan` declares `needs:` on both producer jobs with `artifacts: true`:

| Report | Produced by | Format | Imported through |
|---|---|---|---|
| `backend/coverage.xml` | `backend-test-coverage` | Cobertura XML | `sonar.python.coverage.reportPaths` |
| `frontend/coverage/lcov.info` | `frontend-test` | LCOV | `sonar.javascript.lcov.reportPaths` |

The scanner runs from the repository root, and neither report resolves from there as emitted.
Left alone, the scanner reads the report, resolves zero files, and reports 0.0% coverage with
no error. `scripts/sonar-scan.sh --prep-only` writes a rewritten copy of each report, and
`sonar-project.properties` points at the copies:

| Original | Rewritten copy | Rewrite | Why |
|---|---|---|---|
| `backend/coverage.xml` | `backend/coverage.sonar.xml` | An empty `<source></source>` becomes `<source><repo>/backend</source>` | `backend/.coveragerc` sets `relative_files = true` so parallel test shards can combine. That makes the report list filenames relative to `backend/` with no source root. |
| `frontend/coverage/lcov.info` | `frontend/coverage/lcov.sonar.info` | `SF:src/...` becomes `SF:frontend/src/...` | Vitest records paths relative to `frontend/`. |

The originals are never modified, because GitLab's coverage tooling still reads them. A
missing report only prints a warning, so one failed producer does not abort the whole scan.
The script prints how many class entries and `SF:` files each rewritten report lists and warns
when the count is zero, so the nightly log shows whether paths resolved. `sh
scripts/sonar-scan.sh --self-test` proves both rewrites against fixtures; the
`sonar-scan-selftest` job runs it. See
[Testing § SonarCloud coverage import](testing.md#sonarcloud-coverage-import-1370).

## What Sonar does not count or flag

Two different lists control this, and they are easy to confuse.

**`sonar.exclusions`** removes files from analysis entirely: no issues, no duplication, no
coverage. It lists only test code, which Sonar reads through `sonar.tests` instead.

**`sonar.coverage.exclusions`** keeps files in analysis (issues and duplication are still
reported) but removes them from the coverage denominator. Each entry is justified in a comment
in `sonar-project.properties`:

| Entry | Why it is out of the coverage denominator |
|---|---|
| `**/tests/**`, `**/test_*.py`, `**/conftest.py`, `**/*.test.ts`, `**/*.test.tsx`, `frontend/src/test/**` | Test code is the measuring instrument, not the subject |
| `frontend/e2e/**` | Playwright specs assert flows; they are not themselves covered |
| `**/migrations/**` | Auto-generated schema operations. Data-migration logic is tested through the function it calls |
| `scripts/**`, `backend/scripts/**` | Repo tooling (CI gate scripts, release helpers). None of it ships in an image or bundle, and no test runner instruments it |
| `backend/factories.py` | Test-data factory module |
| `backend/boards/seed_data/**` | Standalone fixture generators (`generate_seed_data.py`, `generate_seed_data_part2.py`) that write the `backend/boards/sample_boards/*.json` and `sample-boards/*.csv` fixtures checked into the repo; run by hand, never imported by any runtime path |

Nothing under product source is excluded to reach a number. If you are tempted to add an
exclusion because a file is hard to cover, write the test instead.

**`sonar.issue.ignore.multicriteria.*`** silences one rule for one path, for findings that were
triaged and confirmed as false positives. Every criterion carries a comment saying why. The
`lint:sonar-exclusions` job (`scripts/check-sonar-exclusions.sh`) fails when a criterion's glob
matches no tracked file, which is what a rename looks like when it silently un-suppresses
findings. Each criterion's comment must also name its rule. The nightly `sonar:rules-check` job
adds an online check that every rule key is still active in the project's quality profile
(fail-open: no token or an API error warns and passes). See [Suppression Markers § SonarCloud suppressions](suppressions.md#sonarcloud-suppressions).

These properties apply only to CI-based analysis (the `sonar:scan` job and a local
`scripts/sonar-scan.sh` run). SonarCloud's Automatic Analysis ignores
`sonar-project.properties`, so it must stay off for this project.

When you add a Django app that has a `tests/` directory, add that directory to `sonar.tests`
and keep it in step with the `backend/*/tests/**` exclusion. The two lists are maintained by
hand.

## Quality policy

- **Ratings: A / A / A.** Security, Reliability, and Maintainability are each rated A on
  overall code, not only on new code. A rating below A is a defect to fix, not a number to
  explain.
- **No unreviewed security hotspots.** Every hotspot gets reviewed and marked Safe, Fixed, or
  Acknowledged, with a comment saying why. A hotspot is a prompt for a human decision, so
  "Security Review" below A means someone has not made one. The
  [runbook](../maintainers/sonarcloud.md#the-review-every-new-hotspot-rule) describes the
  routine.
- **Suppressions need a rationale and a narrow path.** An ignore criterion states why the
  finding is a false positive or not worth fixing, scopes to the specific file or directory,
  and never widens a glob to make a finding disappear or to make the guard pass. A suppression
  that waits on tracked work follows the `SUPPRESSED-UNTIL(#N)` convention in
  [Suppression Markers](suppressions.md); a permanent one carries a plain reason.
  `lint:sonar-exclusions` enforces the structural half of this.
- **Coverage targets.** Aim for at least 85% on Sonar, with 80% as the floor. The enforced
  gates are separate; see [Testing § Coverage targets](testing.md#coverage-targets).

Fix findings in code where you can. Reach for a suppression only when the finding is a false
positive, and say why in the same change.

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
  scores **New Code** only, so a gate that passes does not mean the ratings are healthy.
- **Ratings.** Security, Reliability, and Maintainability each show A to E.
- **Security Hotspots.** The "Security Review" rating reflects the share of hotspots reviewed.
  Open the Security Hotspots tab and review anything in the To Review state.
- **Coverage.** Use the Measures tab to see which files are uncovered. A coverage of exactly
  0.0% almost always means the import broke, not that nothing is tested; check the
  `sonar:scan` log for the "resolved" lines first.
- **Last analysis date.** It shows when the dashboard last refreshed. A date more than a day
  old means the nightly scan is not publishing.

## Why GitLab's coverage badge and Sonar's differ

They are two unrelated measurements and are not expected to match.

Two jobs declare a `coverage:` regex in `.gitlab-ci.yml`: `backend-test-coverage` (the `TOTAL`
line of `coverage report`) and `frontend-test` (the `All files` line of Vitest's text report).
GitLab averages the values it collects into the pipeline's coverage figure, which is what the
README badge shows. Check the `coverage:` lines in `.gitlab-ci.yml` if this changes.

| | GitLab coverage badge | SonarCloud |
|---|---|---|
| Source | Regexes over the job logs of `backend-test-coverage` and `frontend-test` | The imported Cobertura and LCOV reports |
| Scope | Backend and frontend, as an **average of two percentages** | Backend and frontend, as **one combined figure weighted by lines** |
| Denominator | Whatever each tool reports: everything `backend/.coveragerc` does not omit (Django imports every migration to build the test database, so migrations count), and no Sonar-style exclusions on either side | Product source only: tests, migrations, scripts, seed-data generators, and factories are excluded |
| Updates | Every pipeline that runs the jobs | Nightly |

Because the badge averages two percentages, a small frontend and a large backend count equally,
while Sonar weights each file by its lines. The badge never reaches the scanner, and the
scanner never feeds the badge. The backend gate (`--fail-under=90`) applies only to the
backend number, not to either combined figure.
