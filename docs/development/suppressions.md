# Tag every temporary suppression with the issue that ends it

Mark a temporary suppression with `SUPPRESSED-UNTIL(#N)`, and CI fails when issue `#N` closes. Mark a permanent one with a plain reason and no marker.

**Why it matters:** A suppression (`pytest.mark.skip`, `eslint-disable`, a coverage `omit`, an excluded a11y rule) is added for a reason that's true *today*. Left alone, it stays true forever: nothing revisits it, so it silently outlives its reason and the gate it disables stays green while hiding a real failure.

**The big picture:** `#1090` is the concrete cost. `git_lens` code read as 0% covered for months because a job was uninstrumented, and nothing flagged that the coverage number had stopped meaning anything.

## The convention

Every suppression falls into one of two buckets:

- **Permanent** — this will never be re-enabled; the exclusion is a deliberate, lasting design choice (e.g. a hook intentionally excludes a stable setter from its dependency array, or a test mock is intentionally typed loosely). Write a plain reason:

  ```ts
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setPreference is a stable useState setter; including it would re-fire the sync on every render
  ```

- **Temporary** — this is waiting on tracked work; once that work lands, the suppression should be removed. Cite the issue that would remove it with a `SUPPRESSED-UNTIL(#N)` marker:

  ```python
  @pytest.mark.skip(reason="SUPPRESSED-UNTIL(#1084): arm64 images unavailable")
  ```

  ```ts
  // eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#1057): deps churn until the token migration lands
  ```

A marker always names a **specific, already-filed** GitLab issue. Never use a placeholder or an issue number invented on the spot. If a temporary suppression has no tracking issue yet, file one first.

**Watch out:** Never force a marker onto a permanent suppression. A `SUPPRESSED-UNTIL(#N)` on something that's never coming back produces noise the next time that issue closes for an unrelated reason. If you can't say what event should make the suppression go away, it's permanent: write a plain reason instead.

## Filing a new temporary suppression

1. File the tracking issue first (or confirm one already exists for the blocking work).
2. Add the suppression with `SUPPRESSED-UNTIL(#N)` citing that issue's number.
3. When the issue closes, remove the suppression in the same MR that resolves it. Don't leave it for `suppressions-check` to catch on `main` after the fact.

## What CI enforces

The `suppressions-check` CI job (`scripts/check-suppression-issues.sh`) greps the tree for `SUPPRESSED-UNTIL(#N)` and collects the *unique* issue numbers cited. It resolves all of them in one batched GitLab API call via the shared `scripts/lib/gitlab-issues.sh` helper.

- **Fails**, naming file, line, and issue, if any cited issue is already closed, or if the tracker didn't return it at all (it doesn't exist, or it's confidential and not visible to the token or anonymous request used).
- **Passes silently** on an open issue.
- **Never touches** a plain `-- reason` suppression with no marker.

The same job also scans `backend/nightly-load-test-baseline.json` for pending budgets (#1812). An `endpoints` entry with `"budget_p95_ms": null` and `"pending_budget": "#NNNN"` is measured nightly but not gated (see [Pending budgets](nightly-load-test.md#pending-budgets)). That makes it a temporary exemption exactly like a `SUPPRESSED-UNTIL` marker, so the check applies the same rules:

- It fails, naming the endpoint and the issue, when the cited issue is closed or not returned by the tracker, and fails open on an inconclusive lookup.
- The marker shape matches `_pending_budget()` in `scripts/nightly_load_test.py`. An entry whose budget isn't null is gated normally, so a leftover `pending_budget` on it is ignored, and so is a value that isn't `#NNNN` (the load-test self-test rejects that case).
- A missing or unparseable baseline file fails the check instead of reporting a clean scan.
- When it fires, assign the budget and delete `pending_budget` in the whole-file NUC re-derivation, or re-point it at a new tracked issue.

This job runs on **merge requests, `main`, and scheduled pipelines**, deliberately not MR-only. The triggering event is "an issue closed," not "a commit landed." The commit that added the marker may have merged long before the cited issue closes, so a job that only ran on that MR's pipeline would never fire again.

```bash
# Run it locally the same way CI does:
bash scripts/check-suppression-issues.sh
```

**Authentication (#1694).** The lookup uses `GITLAB_API_TOKEN` if set, else `ISSUES_API_TOKEN`, else an anonymous request. This project is public, so an anonymous call already sees every non-confidential issue.

- It **never** sends `CI_JOB_TOKEN`. The Issues API answers 401 to *any* job token, including a valid one, while the identical request with no auth header at all answers 200.
- An earlier version sent `JOB-TOKEN` and had `curl -sf` silently swallow that 401 into the same "inconclusive" state as a genuinely unreachable tracker, so it had never blocked a closed-issue citation in CI.
- If a configured token *is* rejected (expired, wrong scope), the gate warns once and retries anonymously rather than treating the whole lookup as inconclusive.

**Fail-open vs fail-closed.** This is a hygiene gate, not a security gate, and a false block on every pipeline would just teach people to ignore it.

- It fails **open** only on a lookup that genuinely never got a usable response (network failure, every retry exhausted, a malformed body).
- It fails **closed** on anything the tracker *did* answer conclusively: a confirmed closed issue, or a cited issue the tracker's response didn't contain.

### Self-test

Per the meta-gate that derives the bespoke-gate list from `.gitlab-ci.yml` (#1093), every gate here carries a `--self-test` mode. It builds a small fixture tree, mocks the issue-state lookup (no network, no dependency on a real issue's state), and asserts the detection logic fires on a closed-issue marker, passes an open-issue marker, and leaves a plain-reason suppression alone.

```bash
bash scripts/check-suppression-issues.sh --self-test
```

The CI job runs `--self-test` immediately before the real invocation, on the same image, so a regression in the gate itself fails the pipeline before the gate's real result can be trusted.

`--self-test` only drives the `CHECK_SUPPRESSION_MOCK_CLOSED` mock. `scripts/tests/gitlab-issues.test.sh` and `scripts/tests/check-suppression-issues.test.sh`, both also run in this job, exercise the *real* fetch path against a fake `curl` on `PATH`, with no network access. They cover batching, retries, the never-send-`JOB-TOKEN` guarantee, and the 401-falls-back-to-anonymous behavior.

## Scope

The marker convention and this check apply to `frontend/src` (eslint-disable) and `backend/` (pytest `skip`/`skipif`/`xfail`), plus the `pending_budget` entries in `backend/nightly-load-test-baseline.json` described above.

**Yes, but:** Coverage `omit` entries in `backend/.coveragerc` are plain path globs. `configparser` (the INI format `.coveragerc` uses) has no syntax for an inline trailing comment on a list item, only a full-line `#` comment above it, so `SUPPRESSED-UNTIL(#N)` doesn't read naturally there and `check-suppression-issues.sh` doesn't scan this file today. A genuinely temporary `omit` entry should still get a plain `#` comment on the line above citing the tracking issue, for a human reader. Extending the automated check to `.coveragerc` is a reasonable follow-up if these entries start accumulating the way the `eslint-disable` sites did.

## SonarCloud suppressions

`sonar.issue.ignore.multicriteria.*` criteria in `sonar-project.properties` follow the same two buckets. Each existing criterion is **permanent**: it carries a plain rationale comment and a narrow path, with no marker. A criterion that waits on tracked work would carry a `SUPPRESSED-UNTIL(#N)` comment above it, exactly like any other suppression. Never widen a glob to hide a finding. The same policy is stated in the header of the properties file.

The `lint:sonar-exclusions` job (`scripts/check-sonar-exclusions.sh`) keeps those criteria honest. It's pure `git ls-files` matching, with no network and no `SONAR_TOKEN`. It fails when:

- a criterion's glob matches no tracked file (dead or silently drifted),
- the `multicriteria=` index and the `.ruleKey`/`.resourceKey` definitions disagree, or
- a glob is pinned to `*.ts`/`*.js` in a directory that also holds `.tsx`/`.jsx`.

Each criterion's own comment block must name its rule: cite its `S<NNNN>` number or quote its title from the script's `RULE_TITLES` table. A criterion under a shared header needs its own naming line, because the check can't otherwise tell a copy-pasted wrong key from a right one.

The nightly `sonar:rules-check` job runs `bash scripts/check-sonar-exclusions.sh --online`, which additionally asks SonarCloud whether each `ruleKey` is still active in the project's quality profile. MR pipelines never run it.

- It needs `SONAR_TOKEN` and fails open: with no token, no network, no active rules returned, or an unparseable response it prints a warning and exits 0, so only a rule that's inactive turns the job yellow.
- A key missing from the bulk rule search is re-checked with `api/rules/show` before it's reported, because the search can omit a rule that's active in the project's profile.
- The job then reports either "does not exist in SonarCloud" (the key was never valid, or the rule was removed) or "is not active in any quality profile" (the rule was deactivated).

```bash
bash scripts/check-sonar-exclusions.sh
bash scripts/check-sonar-exclusions.sh --self-test
```

These properties apply only to CI-based analysis (the `sonar:scan` job), not to SonarCloud Automatic Analysis.

## Trivy suppressions

The `trivy-scan` CI job is blocking: an unsuppressed HIGH or CRITICAL vulnerability, IaC misconfiguration or secret finding fails the pipeline (`--scanners vuln,config,secret --exit-code 1`, no `allow_failure`). A second, non-blocking pass writes the full `trivy-report.json` artifact.

The scanner image is pinned by digest (the comment in `.gitlab-ci.yml` records the version). Bump the version and digest together in a reviewed commit. Before #1072 the image tag was already pinned to a version, but not to a digest, and the job was advisory (`--exit-code 0` plus `allow_failure: true`).

Accepted risks go in `.trivyignore.yaml`. Every entry needs:

- an `expired_at` date (`YYYY-MM-DD`), at most 366 days from today (the checker fails a later date, so suppressions are renewed at least yearly), ideally about one minor release out;
- a `statement` explaining why it's accepted, with a `#NNNN` link to the issue that would remove the entry. CI checks only that an issue number is present; **reviewers must confirm the issue is open** and covers the finding.

Each entry must start with `- id:` in block style. The checker fails closed on any other entry-level list item (for example `- paths:` first, or flow style `- {id: ...}`), because such an entry would otherwise escape the checks. Comment-only lines inside a `statement` are ignored, so a `# see #12` comment doesn't satisfy the issue-reference rule. Every top-level section (`misconfigurations:`, `vulnerabilities:`, `secrets:`, ...) is checked, including ones that use a different list indent.

A suppression for a finding that's itself a deferred security risk needs its tracking issue labeled `security::deferred` (for example #1541). That label puts it through the accepted-risk review described in [Deferred security follow-ups](../maintainers/security-deferred-label.md).

**Yes, but:** trivy's config scanner currently skips the Helm chart because of placeholder values, so chart misconfigurations aren't caught by this job (#1536).

Trivy itself only stops honoring an expired entry, which would resurface as a confusing red scan. `scripts/check-trivyignore-expiry.sh` makes the policy explicit: it fails the job when an entry is past its date, has no valid date, has no `#NNNN` reference, or doesn't start with `- id:`. It doesn't look the issue up, so it can't tell whether the issue is open. It has a `--self-test` (run in the job before the real check) and a unit test:

```bash
sh scripts/check-trivyignore-expiry.sh
sh scripts/check-trivyignore-expiry.sh --self-test
bash scripts/tests/check-trivyignore-expiry.test.sh
```

When an entry expires, fix the finding and delete the entry, or renew the date in a commit that cites the issue's current status.
