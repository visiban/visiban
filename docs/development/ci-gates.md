# CI gate self-tests

A bespoke CI gate that stops detecting anything does not fail — it goes **green**,
permanently, and looks exactly like a codebase with no violations. There is no signal
distinguishing "the check passed" from "the check is broken." This is the house rule that
closes that gap, and the record of which scripts follow it.

## The rule

**Every bespoke gate script under `scripts/` ships a `--self-test` mode** that constructs a
known-bad input, runs its own detection logic against it, and asserts the detection fires.
CI runs `<script> --self-test` on the same image, immediately before the real invocation, so
a change that silently broke detection (a tooling upgrade, a refactor, a BusyBox-vs-GNU
behavior difference) is caught before its verdict is trusted on that same run.

```bash
# The shape every wired gate follows, e.g. dep-scan-osv:
- sh scripts/osv-severity-gate.sh --self-test
- sh scripts/osv-severity-gate.sh osv-report.json
```

A self-test failure must hard-block regardless of the real check's own exit-code contract —
see `osv-severity-gate.sh`'s self-test, which always exits 0 (pass) or 1 (fail), never the
non-blocking `2` the real gate uses for a MEDIUM/LOW warning.

## The meta-gate: `gate-selftest-parity`

Nothing above is self-enforcing on its own — a new script can be added to `.gitlab-ci.yml`
without a self-test, or a self-test can be written and never wired into the job that would
run it (exactly what happened to `migration-numbering-check` before #1093: the script had a
working `--self-test`, but the job never called it with that flag).

`scripts/check-gate-selftest-parity.sh` closes that gap. It derives its list of gate scripts
by scanning `.gitlab-ci.yml` **at run time** for every literal `scripts/<name>.(sh|py|mjs)`
reference on a non-comment line, and fails if any of them:

- has no `--self-test` mode at all, or
- has one, but no job in `.gitlab-ci.yml` actually invokes it with that flag.

Nothing here is hardcoded: when a new bespoke script is wired into the CI file (for example
`check-suppression-issues.sh`), the parity check picks it up automatically the next run — no
edit to the checker itself. Wired as its own job (`gate-selftest-parity`, `lint` stage),
which runs `check-gate-selftest-parity.sh --self-test` before the real scan, same pattern as
every gate it audits.

```bash
bash scripts/check-gate-selftest-parity.sh            # scan the real .gitlab-ci.yml
bash scripts/check-gate-selftest-parity.sh --self-test # prove the scanner still fires
```

### Scope

Only `scripts/*.sh`, `*.py`, and `*.mjs` files referenced by literal path in
`.gitlab-ci.yml`. It does **not** reach into:

- the inline `- |` shell blocks scattered across the CI file (there is no script file to
  point `--self-test` at),
- Django management commands such as `manage.py check_migration_concurrency` (not a file
  under `scripts/`),
- scripts that are never invoked from `.gitlab-ci.yml` at all (e.g. `assemble-changelog.sh`
  and `close-milestone-issues.sh`, called only from `scripts/release.sh` at release time).

Extending the meta-gate to any of these is future work, not silently assumed to be covered —
see [Known gaps](#known-gaps-and-deferred-work) below.

## The escape hatch: `gate-selftest-exempt:`

Some scripts genuinely cannot build a synthetic known-bad input cheaply — most often a live
smoke test whose entire value is exercising real infrastructure. Rather than let the parity
check hardcode a list of exceptions (the same anti-pattern the meta-gate exists to avoid),
an exempt script documents its own exemption, the same escape-hatch shape as
`migration-check`'s `# concurrency-exempt:` comment and the OSV gate's `IgnoredVulns` entries:

```bash
# gate-selftest-exempt: <reason>
```

The comment must start the line (only leading whitespace and a single `#` before the marker)
so that prose *describing* the marker — like this page, or `check-gate-selftest-parity.sh`'s
own header — is never mistaken for a real exemption.

### Currently exempt

| Script | Why |
|---|---|
| `scripts/helm-install-drill.sh` | Live kind-cluster boot drill — a synthetic self-test would need to boot a second real cluster. Its own NEGATIVE case (a placeholder-`SECRET_KEY` install must be rejected) already is a known-bad-input assertion, run against the real chart. |
| `scripts/helm-netpol-drill.sh` | Live Calico kind-cluster NetworkPolicy enforcement drill, same reasoning — its NEGATIVE/CONTROL pairs are the known-bad/known-good proof, against real Calico rather than a fixture. |
| `scripts/prod-compose-drill.sh` | Live Docker Compose boot drill for the production stack — a synthetic self-test would need to boot a second real stack. Its own NEGATIVE cases are the known-bad-input assertions, run against the real `init-prod.sh` and `docker-compose.prod.yml` instead of a fixture: a boot with the placeholder `DJANGO_SECRET_KEY` must be rejected, and `init-prod.sh` must reject a `/`-bearing `DB_PASSWORD` or `REDIS_PASSWORD` before anything boots, with the specific error message ([#1229](https://gitlab.com/visiban/visiban/-/issues/1229)). A static check also asserts `init-prod.sh` restarts nginx after its final `up -d`. See [#1152](https://gitlab.com/visiban/visiban/-/issues/1152). |
| `scripts/oidc_provision.py` | Provisioning against a live Keycloak Admin REST API — setup, not detection logic. Its correctness is exercised end-to-end by `oidc_smoke_test.py`. |
| `scripts/oidc_smoke_test.py` | End-to-end smoke test against a live Keycloak instance — a synthetic self-test would need a mock IdP and would not exercise the real risk (discovery/token-exchange/claim-mapping drift). |

## Self-tested today

| Script | CI job | Notes |
|---|---|---|
| `scripts/check-added-files-covered.mjs` | `added-files-coverage-check` (+ its own `added-files-coverage-check-self-test` job) | First adopter, predates #1093's general rule. |
| `scripts/helm-structure-check.sh` | `helm-lint` | `--self-test` injects each defect class into a throwaway copy of the chart. |
| `scripts/lock-backend-requirements.sh` | `backend-lock-check` | Network-free self-test swaps in a stub `uv` and a synthetic `backend/` tree, then proves a fresh lock passes `--check`, a drifted `requirements.txt` makes `--check` exit non-zero, and an unknown argument is rejected ([#1378](https://gitlab.com/visiban/visiban/-/issues/1378)). |
| `scripts/check-migration-numbering.sh` | `migration-numbering-check` | Self-test builds a synthetic two-branch git repo and reproduces a numbering collision. Wiring the invocation into the job was itself a #1093 fix — the script had the mode, the job just never called it. |
| `scripts/osv-severity-gate.sh` | `dep-scan-osv` | Covers the block/warn/clean/fail-safe boundary with synthetic OSV-Scanner JSON. Full 11-case regression suite lives in `scripts/tests/osv-severity-gate.test.sh`; the in-script self-test is the smaller, CI-wired proof. |
| `scripts/check-issue-collision.sh` | pre-push git hook only (not a CI job — see [Known gaps](#known-gaps-and-deferred-work)) | Offline self-test against stubbed forge responses. |
| `scripts/check-memory-index.sh` | not currently a CI job | Self-test builds a synthetic memory store. |
| `scripts/check-gate-selftest-parity.sh` | `gate-selftest-parity` | The meta-gate itself — see above. |
| `scripts/check-compose-image-pins.sh` | `compose-hygiene` | Self-test plants an untagged image, an explicit `:latest`, a ported-registry reference (`host:5000/img`, whose colon must not read as a tag separator), and a first-party `${VAR}` reference that must NOT be reported. |
| `scripts/check-compose-project-names.sh` | `compose-hygiene` | Self-test plants a missing `name:`, a duplicate name, a `${VAR:-default}` colliding on its *default* (the exact shape of the original defect), and an overlay that wrongly declares a name. |
| `scripts/check-docs-version-accuracy.sh` | `docs-version-accuracy` (MRs, `main`, and tag pipelines) | Self-test plants a stale "Coming in" claim naming the just-released version, the same in `README.md`, an RC banner on a GA version, a wrong banner version, stale `APP_VERSION=` / README image pins, and a tag that disagrees with `frontend/package.json`; it must spare a "Coming in" claim for a future version and a "new in" label. See the [release checklist](../maintainers/index.md#release-checklist). |
| `scripts/resolve-docs-version.sh` | `docs-deploy` | Resolves and v-prefix-normalizes the mike deploy VERSION from `DOCS_VERSION` / `CI_COMMIT_TAG` / `.env.example`'s `APP_VERSION=`, unconditionally across all three sources. `#1270`: a single manually-typed `DOCS_VERSION` missing the `v` prefix created a duplicate unprefixed version entry that mike/verspec's loose-version sort ranked above every real version in the docs dropdown, undetected for months. 6-case self-test plus a 9-case regression suite in `scripts/tests/resolve-docs-version.test.sh`. |
| `scripts/classify-release-tag.sh` | `backend-manifest` and `frontend-manifest` (each runs the self-test independently — the two jobs have no `needs:` on each other and run in parallel, so a self-test in only one would let the other race ahead unguarded) | Single source of truth for whether a release tag is stable (gets the `:latest`/`:MAJOR.MINOR` registry aliases) or pre-release (gets neither). `github-release` also calls it (no self-test of its own; it runs after both manifest jobs) so the GitHub Release `--prerelease` badge uses the same classification — any tag that is not strictly `vX.Y.Z` is a pre-release (#1410). A 2026-10 incident: the stable-vs-pre-release regex used to gate `:MAJOR.MINOR` alone while the alias list defaulted to including `:latest` unconditionally, so every alpha/beta/rc tag silently re-pointed `backend:latest`/`frontend:latest` at that pre-release build, on both registries, for about three days before anyone noticed — the second time this exact duplicated-regex shape has bitten this file (cf. `resolve-docs-version.sh` above, #1270). 13-case self-test, including the exact alpha/beta/rc shapes `scripts/release.sh` produces and several malformed/partial tags that must not be misread as stable. |
| `scripts/check-latest-tag-stability.sh` | `latest-tag-stability-check` (release tags, `needs: [backend-manifest, frontend-manifest]`) | Fails the tag pipeline itself if `backend:latest`/`frontend:latest` on either registry does not match the newest STABLE release's digest — the automatic version of the manual check that caught the incident above. "Stable" is resolved via `classify-release-tag.sh`, never re-implemented, so this can't drift out of sync with the jobs it's checking. 10-case self-test over a stubbed `DIGEST_PROBE`, including the resolver correctly skipping a newer-but-pre-release tag and reproducing the actual incident shape (one registry's `:latest` drifted, the other healthy). `scripts/release.sh` also runs this same check read-only **before** it branches or tags (`check_latest_not_drifted`), so drift that predates the cut stops the release instead of turning the tag pipeline red afterward. Only a reported `MISMATCH` blocks; an unreachable registry or missing `crane`/`docker buildx` warns and continues, and `RELEASE_SKIP_LATEST_CHECK=1` bypasses it. See [Container image retention](../administration/container-image-retention.md). |
| `scripts/check-rbac-coverage.py` | `rbac-coverage` | 12-case self-test over a synthetic view tree: a dropped auth gate, a missing role gate, a write that never resolves a role, an unscoped board-child lookup, a raw membership lookup, and a stale entry in each recorded-exception table. See [RBAC and broadcast gates](rbac-and-broadcast-gates.md). |
| `scripts/security-deferred-verdict.sh` | `security-deferred-verdict-selftest` | Accepted-risk verdict for `security::deferred` issues, used by `/pre-release` Step 1.5. 23-case self-test: valid, expired, blank fields, impossible dates, duplicate `expires`, `;` in reason, no note, multiple lines, and the 1-year cap boundary. Runs on alpine busybox in CI and on BSD/GNU awk locally. See [Deferred security follow-ups](../maintainers/security-deferred-label.md) ([#1521](https://gitlab.com/visiban/visiban/-/issues/1521)).
| `scripts/check-broadcast-deferral.py` | `broadcast-deferral` | 9-case self-test: a write that broadcasts nothing, a broadcast outside `on_commit`, a commit hook holding an ORM instance, an emit in a loop, and a stale entry in each recorded-exception table. |
| `scripts/check-release-images.sh` | `check-release-images` (scheduled pipelines only) | Ported from TruePPM's beta-readiness incident #0 (#1074): a registry cleanup policy with no keep-regex deleted a released image days after it shipped, with no commit to review and no job that went red on its own. 19-check self-test over stubbed `RELEASE_IMAGE_PROBE` / `RELEASE_ARCH_PROBE` — both registries missing, one registry healthy, both healthy, a present tag whose manifest silently dropped `arm64` (#1197), a manifest that cannot be read (reported `PROBE-ERROR`, not `ARCH-MISSING`), an explicit empty `RELEASE_REGISTRIES` override, no resolvable `v*` tag, and `ACCEPTED_GAPS` skipping only the named reference. Unlike `osv-severity-gate.sh`, there is no separate `scripts/tests/` regression file — the in-script self-test already exercises every branch of the (small) decision logic, so a second copy of the same fixtures would just be duplicate maintenance. See [Container image retention](../administration/container-image-retention.md). |
| `scripts/docker-push-retry.sh` | sourced in the `script:` of `backend-docker-push-arm64` / `frontend-docker-push-arm64`; self-test runs in `arm64-runner-preflight` (release tags) | Bounded retry around `docker push` for the persistent arm64 shell runner, whose daemon can hit a transient cross-repo blob-mount failure a fresh kaniko container never sees (#1205, ported from TruePPM). 3-case self-test with a stubbed `docker` (the stub hook is honored only under `--self-test`, never from a CI variable): succeeds on a later attempt, gives up after exactly the max, and never re-pushes a clean push. Needs no daemon, so it runs on the preflight's plain alpine image. |
| `scripts/check-pipeline-schedules.sh` | `schedule-config-check` (scheduled pipelines only) | #1213: `nightly-load-test`'s GitLab pipeline schedule was never configured, and nothing asserted it existed — same failure shape as `check-release-images`. Self-test stubs `SCHEDULE_PROBE` with fixed JSON covering a covered variable, one with no schedule at all, one on an `active:false` schedule, one set to `"false"`, an `SCHEDULE_AUDIT_ACCEPTED_GAPS` entry, a probe failure (must fail open, not report a false MISSING), a CI file with no schedule-gated rules at all, and (#1383) the real probe falling through from a rejected `CI_JOB_TOKEN` to `GITLAB_API_TOKEN`. See [Nightly load test § The schedule](nightly-load-test.md#the-schedule). |
| `scripts/check_mutation_score.py` | `mutation-score-selftest` (MRs touching the script, the CI file or any `backend/**/*.py`; also main) and `backend-mutation-report` (Nightly schedule only, with `MUTATION_TEST=true`) | #1384, ported from TruePPM's `check_mutation_score.py`. Exports mutmut 2.5.1's `.mutmut-cache` to a stats JSON (2.x has no `export-cicd-stats`), sums the parallel shards (`--expect-shards N`: fewer files than expected is exit 2, so a dead shard is never summed into a smaller complete run; shards must also agree on `total` and their non-skipped mutants must add up to it), and judges the score. Reports a **raw** and an **adjusted** score (#1503): adjusted leaves out mutants proven equivalent with `# pragma: no mutate -- <reason>`, which mutmut never generates, so `--export-cache` counts them from the source (`excluded`, module-wide like `total`); `MUTATION_MIN` gates the adjusted number. `--check-pragmas backend` (also run by `mutation-score-selftest`) fails any pragma with no reason and exits 2 on a missing path or a tree with no `.py` files; `--export-cache` exits 2 if a file with pragmas yields equal mutant counts. Report-only while `MUTATION_MIN` is unset; exit 2 (not measured: missing, malformed or inconsistent shard stats, untested mutants, or zero scoreable mutants) applies even then, and a floor outside (0, 1], such as `95` or `0`, is also exit 2 (a config error, raised before any stats are read, so no merged file is written). 81-check self-test (89 with mutmut importable; the nightly `backend-mutation` job runs it with mutmut installed) (run on MRs by `mutation-score-selftest`, and in the nightly `script:` before the real call): above, at and one mutant below a floor, a floor of exactly 1, timeouts counted as killed, `suspicious` not, `skipped` excluded, shards summed, a missing shard, shards with unequal totals, an uncovered or doubly covered mutant, a shard with no `total`, malformed and missing inputs, unfinished and empty runs, report-only, out-of-range floors from `--min` and `MUTATION_MIN`, `--write-merged` writing the real module total and still writing (with a `not_measured` reason) on a not-measured run and a missing shard, raw versus adjusted scores and the pragma reason rule, a cache export from a SQLite fixture in mutmut's schema (including a path containing `?`, `#`, `%` and spaces, to prove the read-only URI is percent-quoted), and path containment (a stats, `--write-merged` or `--export-cache` path outside the allowed roots, or reached through an escaping symlink, is exit 2 with nothing written). |
| `scripts/fuzz_deep_file_issue.py` | `backend-schema-fuzz-deep` (Nightly schedule only) | #1383: the deep fuzz job is `allow_failure: true`, so a finding shows as a yellow job in a green pipeline and emails nobody. This script, run from `after_script` on failure, keeps one open tracking issue: it files it, or comments on it when it is already open. Self-test (run in `script:` before the fuzz) covers report-only with no token (no API call at all), a comment on an existing exact-title match (a near-miss search hit must not count), a new issue via the `KAIZEN_API_TOKEN` fallback, failing open on an API error, and quick-action smuggling: a multi-line `FUZZ_SEED` becomes `invalid`, and no CI-variable text can start a body line with `/`. The job files only when a marker written after the self-test exists, so a self-test or setup failure is never reported as a schema-fuzz finding. |
| `scripts/resolve_fuzz_seed.py` | `backend-schema-fuzz` (and the deep nightly via `extends:`) | #1207: MR pipelines cannot take pipeline variables, so the documented `FUZZ_SEED` replay was impossible on a feature branch. The script picks the seed: explicit `FUZZ_SEED` variable, then a `Fuzz-Seed: <n>` trailer on the MR head commit (`CI_COMMIT_MESSAGE`, merge request pipelines only), then random, and logs which. Every value is validated as a plain non-negative integer below 2**64 because it comes from a commit message. Self-test (run in `script:` before the fuzz) covers trailer parsing, case-insensitivity, last-trailer-wins, variable precedence, ignoring the trailer off MR pipelines, and rejecting non-integer, shell-metacharacter, negative, empty, unicode-digit and oversized values. |
| `scripts/sonar-scan.sh` | `sonar-scan-selftest` (MRs touching the script, `sonar-project.properties`, or CI file; also main) | #1370: the rewrites that make SonarCloud resolve backend/frontend coverage paths; a regression silently reads 0.0%. Self-test fixtures the backend `<source>` injection (and a non-empty `<source>` no-op), the lcov `SF:src/` prefix, untouched originals, and missing-report tolerance. Runs `sh` on alpine; the scan itself is the scheduled `sonar:scan`. |
| `scripts/check-sonar-exclusions.sh` | `lint:sonar-exclusions` (MRs touching `sonar-project.properties`, the script, or the CI file; also main) | #1380, ported from TruePPM's `check-sonar-exclusions.sh`: a `sonar.issue.ignore.multicriteria` glob that matches no tracked file is dead or has silently drifted (a rename un-suppresses findings with nothing going red). Pure `git ls-files` matching, no network or `SONAR_TOKEN`. Globs use real Ant semantics (`**/est/**` is dead). Self-test plants a dead glob, an Ant-dead glob, `*.ts` globs (literal, `**/` and mid-`**` spellings) over a directory that also holds `.tsx`, an unlisted criterion, an orphan `.resourceKey`, an indexed criterion with no `.resourceKey`, and a ghost index id; each case must fail with its own check's message, and the real file must pass. #1425 added check 4b (each criterion's own comment must name its rule by S-number or RULE_TITLES title; self-test: rule not named, wrong rule named, title accepted) and an opt-in `--online` check 5 (every `ruleKey` is active in the SonarCloud quality profile) run nightly by `sonar:rules-check`, never on MRs; it fails open on no token, network error or unparseable or empty response, and its self-test drives it from fixture JSON (`SONAR_API_FIXTURE_DIR`) for rule-inactive, no-token, API-error, unparseable, zero-rules and token-not-leaked cases. |

`scripts/assemble-changelog.sh` also ships a `--self-test` (added alongside this page,
covering the exact version-dotted-slug incident that motivated #1093), but is not wired into
any CI job — see below.

## Path containment for CLI arguments

Gate scripts that open files named on the command line or via `--root` do so through `scripts/_paths.py::resolve_within` (#1377). It canonicalizes the path (collapsing `..` and following symlinks) and only then checks it sits under an allowed root, so a symlink that leaves the tree is rejected too. A rejected path is a "cannot run" outcome (exit 2 for the rbac, ws-event and broadcast gates), never a clean result.

- `--root`-based gates (`check-rbac-coverage.py`, `check-ws-event-reachability.py`, `check-broadcast-deferral.py`) confine every read to `--root`.
- Other file arguments (`--input`, `--state`, `--declined`, `--write-state`, `--token-file`, `--budget-file`, `--output`, `--schema`, `--types`) must resolve under the repository, the current directory, or the system temp directory (`/tmp`). The temp roots are trusted only on ephemeral single-tenant runners; there is no ownership check. A filesystem-root working directory is never treated as a root.
- `kaizen_gate_ledger.py` validates `--window` (1..100) and `--project` (an allowlist: `visiban/visiban` or `visiban/visiban-enterprise`) before they reach the `glab` argv.
- `check-added-files-covered.mjs` rejects a `--target-ref` that starts with `-`.

Run `python scripts/_paths.py --self-test` to exercise the helper (`..` traversal, symlink escape, filesystem-root cwd); the `rbac-coverage` job runs it.

## Scheduled pipelines

A scheduled pipeline on `main` runs the **whole** pipeline, not just the schedule-gated jobs:
the `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` rules match a schedule, and `changes:` rules
evaluate true on one. Every extra schedule therefore costs a full pipeline (about 48 jobs).
So the project keeps **two** schedules (#1383), not one per job:

| Schedule (id) | Cron (UTC) | Variables | Owner | Jobs it adds | What red means |
|---|---|---|---|---|---|
| Nightly (CVE/OSV, Sonar, deep fuzz, kaizen) (4176726) | `0 5 * * *` | `CVE_SCAN`, `OSV_SCAN`, `SONAR_SCHEDULED`, `FUZZ_DEEP`, `KAIZEN_YIELD_WATCH` (all `true`), plus `MUTATION_TEST=true` once a maintainer adds it (#1384) | maintainers (schedule owner: `kellyhair`) | `backend-dep-scan`, `frontend-dep-scan` (blocking); `dep-scan-osv` (blocking on HIGH/CRITICAL, warns otherwise); `sonar:scan`, `backend-schema-fuzz-deep`, `kaizen-yield-watch`, `backend-mutation` and `backend-mutation-report` (all `allow_failure: true`) | **Red:** a dependency on `main` has a new HIGH/CRITICAL advisory, or an ordinary `main` job failed. Fix or document it (an expiring `IgnoredVulns` entry for OSV). **Yellow `backend-schema-fuzz-deep`:** a real API contract defect, never a flake (#1165); see its tracking issue. **Yellow `backend-mutation-report`:** the mutation run was not measured (a shard died or finished with untested mutants); a low *score* is not red or yellow, it is only reported, see [Mutation testing](mutation-testing.md). **Yellow `sonar:scan`:** the SonarCloud dashboard did not refresh that night. |
| Nightly load test (#1082) (4463581) | `0 3 * * *` | `LOAD_TEST_SCHEDULE=true` | maintainers (schedule owner: `kellyhair`) | `nightly-load-test` (blocking) | A p95 budget was exceeded; see [Nightly load test](nightly-load-test.md). |

Both schedules also run every ordinary `main` job, plus the jobs that use any scheduled
pipeline as their slot: `schedule-config-check`, `check-release-images`,
`cleanup-merged-branches`. The helm and compose drills (`helm-install`, `helm-netpol`,
`compose-prod-drill`) skip any schedule that sets `SONAR_SCHEDULED`, so they run on the
load-test schedule only. The load test keeps its own schedule, two hours earlier, because its
latency budgets are noisy on a busy runner. `backend-schema-fuzz`, the MR job, never runs on
a schedule; `backend-schema-fuzz-deep` replaces it there.

`seed-demo-data` has no schedule on purpose (#1232): it is manual-only on `main`, because the
try.visiban.com demo now runs from the Helm chart's demo mode (see
[Demo deployment](../maintainers/demo-deploy.md)) rather than a weekly CI reseed.
`SCHEDULE_AUDIT_ACCEPTED_GAPS` is otherwise empty, so every schedule-gated variable must have
an active schedule. The one temporary exception is `MUTATION_TEST` (#1384), until a maintainer
adds it to the Nightly schedule.

### Changing a schedule

Schedules are GitLab project configuration (**Build → Pipeline schedules**), not files in this
repository. `schedule-config-check` runs on every scheduled pipeline. It fails if any
`$CI_PIPELINE_SOURCE == "schedule" && $VAR == "true"` rule in `.gitlab-ci.yml` has no
active schedule setting `VAR=true`, unless the variable is listed in
`SCHEDULE_AUDIT_ACCEPTED_GAPS`.

!!! warning "The check only asserts anything when `GITLAB_API_TOKEN` is configured"
    A job's `CI_JOB_TOKEN` cannot read pipeline schedules. Without a `GITLAB_API_TOKEN` CI
    variable (project access token, Reporter role or above, `read_api` scope), the lookup is
    inconclusive and the job **warns and passes**. As of #1383 no such variable exists on the
    project or the group, so the check is currently a warning only. Until it is configured, a
    schedule missing a variable goes unreported, which is the gap #1213 was filed over. Before
    #1383 the script also stopped at the rejected job token instead of trying
    `GITLAB_API_TOKEN`. It now falls through to it.

Once `GITLAB_API_TOKEN` is configured, the order of a change matters:

- **Adding a schedule-gated job:** add the variable to a schedule **first**. Extra variables
  that no rule reads are harmless. Then merge the rule. In the reverse order, the next
  scheduled pipeline reports the variable `MISSING`.
- **Removing a schedule-gated job:** merge the removal first, then drop the variable from the
  schedule.

The check only reads `.gitlab-ci.yml` from the commit the schedule runs, so it never fails an
MR or push pipeline. It fails the next scheduled pipeline on `main` after the merge.

### The README pipeline badge

**Decision (#1383): the README badge keeps tracking the latest `main` pipeline, schedules
included.** A red scheduled pipeline turns the badge red, which is deliberate. Both schedules
feed it, including the 03:00 load-test pipeline. GitLab's pipeline badge
can filter by ref and `ignore_skipped` but not by pipeline source, and the shields.io GitLab
pipeline badge reads the same latest-pipeline-per-ref data. A schedule-free badge would mean
running and maintaining a new endpoint, a service this project does not have. More
importantly, every reason the badge can go red is a real problem with `main`, not a stochastic
or external blip. Visiban is self-hosted, so for someone deciding whether to deploy `main`,
that is exactly what a public status badge should show.

The badge can go red for three reasons:

- `nightly-load-test` goes over a latency budget. It is blocking and the noisiest of the
  three, because budgets move on a busy shared runner. The 2026-09-30 red was this.
- A real HIGH/CRITICAL CVE or OSV advisory lands against a dependency of `main`.
- An ordinary `main` job really fails in a scheduled run (for example, the 2026-10-01
  `frontend-test` red).

Deep fuzz, Sonar and kaizen are `allow_failure: true` and **cannot** turn the badge red. The
load test is the case most likely to reopen this decision. If its noise starts making the
badge meaningless, the fix belongs in the load test's budgets, not in the badge. To revisit the
decision, change this section and `README.md` together.

## Known gaps and deferred work

Not every bespoke script called out when #1093 was filed got a self-test in the same pass.
Deferred deliberately, not silently:

- **`scripts/close-milestone-issues.sh`** — an action script (closes GitLab issues via
  `glab`), not a detection/gate script: there is no pass/fail verdict to prove still fires.
  A meaningful self-test would need to mock the `glab` API surface, which is a larger lift
  than this issue's scope. Not wired into `.gitlab-ci.yml` either, so the parity meta-gate
  does not (and should not yet) flag it.
- **`manage.py check_migration_concurrency`** — the Django management command described in
  `docs/development/database-migrations.md`. Real detection logic with the same silent-green
  failure mode as everything else on this page, but it is not a file under `scripts/`, so
  today's meta-gate cannot point at it. Giving it a `--self-test` subcommand and extending
  the meta-gate to management commands is follow-up work, not assumed done here.
- **The ~19 inline `- |` shell blocks in `.gitlab-ci.yml`** (e.g. `changelog-check`'s
  `git merge-base` / label-lookup / path-stripping logic) are the same risk class but have no
  script file to self-test. Extracting the highest-risk ones into standalone scripts (which
  would then fall under this rule automatically) is the natural next step, evaluated
  case-by-case rather than as a single sweep.

## Why this matters here specifically

Several CI jobs in this repo run on `alpine:3.19`, whose `grep`/`sed` are BusyBox, not GNU —
no `--exclude-dir`, and subtly different behavior under `set -o pipefail` (a `grep -q`
short-circuit sends `SIGPIPE` upstream, which `pipefail` turns into a false pipeline
failure — found and fixed in `check-gate-selftest-parity.sh` itself while writing it; see the
comment above `set -eu` in that script). `backend-lint` already ends a line with `|| true`
(on its secondary Code Quality report step, not its blocking `ruff check` line — but the
shape is exactly the hazard this page exists to guard against elsewhere). Write and test
gate scripts assuming BusyBox and a bare `set -eu`, not GNU tools or `pipefail`, unless you
have verified the specific behavior you rely on.
