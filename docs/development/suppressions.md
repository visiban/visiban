# Suppression markers

A suppression — `pytest.mark.skip`, `eslint-disable`, a coverage `omit`, an excluded a11y
rule — is added for a reason that is true *today*. Left alone, it stays true forever: nothing
ever revisits the suppression, so it silently outlives its reason and the gate it disables
stays green while hiding a real failure.

`#1090` is the concrete cost: `git_lens` code read as 0% covered for months because a job was
uninstrumented, and nothing flagged that the coverage number had stopped meaning anything.

## The convention

Every suppression falls into one of two buckets:

- **Permanent** — this will never be re-enabled; the exclusion is a deliberate, lasting design
  choice (e.g. a hook intentionally excludes a stable setter from its dependency array, or a
  test mock is intentionally typed loosely). Write a plain reason:

  ```ts
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setPreference is a stable useState setter; including it would re-fire the sync on every render
  ```

- **Temporary** — this is waiting on tracked work; once that work lands, the suppression should
  be removed. Cite the issue that would remove it with a `SUPPRESSED-UNTIL(#N)` marker:

  ```python
  @pytest.mark.skip(reason="SUPPRESSED-UNTIL(#1084): arm64 images unavailable")
  ```

  ```ts
  // eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#1057): deps churn until the token migration lands
  ```

A marker always names a **specific, already-filed** GitLab issue — never a placeholder, and
never an issue number invented on the spot. If a temporary suppression doesn't have a tracking
issue yet, file one first.

**Never force a marker onto a permanent suppression.** A `SUPPRESSED-UNTIL(#N)` on something
that's never coming back just produces noise the next time that issue happens to close for an
unrelated reason. If you're not prepared to say what event should make this suppression go
away, it's permanent — write a plain reason instead.

## What CI enforces

The `suppressions-check` CI job (`scripts/check-suppression-issues.sh`) greps the tree for
`SUPPRESSED-UNTIL(#N)`, looks up each cited issue via the GitLab API, and **fails — naming
file, line, and issue — if any cited issue is already closed.** An open issue passes silently.
A plain `-- reason` suppression with no marker is never touched.

This job runs on **merge requests, `main`, and scheduled pipelines** — deliberately not
MR-only. The triggering event is "an issue closed," not "a commit landed": the commit that
added the marker may have merged long before the cited issue closes, so a job that only ran on
that MR's pipeline would never fire again. Running on `main`/schedule is what makes the closed
issue actually get caught.

```bash
# Run it locally the same way CI does:
sh scripts/check-suppression-issues.sh
```

The gate fails **open** on an inconclusive GitLab API lookup (network hiccup, missing token
scope) rather than blocking the pipeline on a lookup that didn't complete — this is a hygiene
gate, not a security gate, and a false block on every pipeline would just teach people to
ignore it. It only blocks on a *confirmed* closed issue.

### Self-test

Per the meta-gate that derives the bespoke-gate list from `.gitlab-ci.yml` (#1093), every
gate here carries a `--self-test` mode: it builds a small fixture tree, mocks the issue-state
lookup (no network, no dependency on a real issue's state), and asserts the detection logic
fires on a closed-issue marker, passes an open-issue marker, and leaves a plain-reason
suppression alone.

```bash
sh scripts/check-suppression-issues.sh --self-test
```

The CI job runs `--self-test` immediately before the real invocation, on the same image, so a
regression in the gate itself fails the pipeline before the gate's real result can be trusted.

## Scope

The marker convention and this check apply to `frontend/src` (eslint-disable) and `backend/`
(pytest `skip`/`skipif`/`xfail`). Coverage `omit` entries in `backend/.coveragerc` are plain
path globs — `configparser` (the INI format `.coveragerc` uses) has no syntax for an inline
trailing comment on a list item, only a full-line `#` comment above it, so `SUPPRESSED-UNTIL(#N)`
doesn't read naturally there and `check-suppression-issues.sh` does not scan this file today. A
genuinely temporary `omit` entry should still get a plain `#` comment on the line above citing
the tracking issue, for a human reader; extending the automated check to `.coveragerc` is a
reasonable follow-up if these entries start accumulating the way the `eslint-disable` sites did.

## Filing a new temporary suppression

1. File the tracking issue first (or confirm one already exists for the blocking work).
2. Add the suppression with `SUPPRESSED-UNTIL(#N)` citing that issue's number.
3. When the issue closes, remove the suppression in the same MR that resolves it — don't leave
   it for `suppressions-check` to catch on `main` after the fact.
