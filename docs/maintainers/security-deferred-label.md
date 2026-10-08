# Deferred Security Follow-ups (`security::deferred`)

A security finding noticed during review (by `security-review`, `rbac-check`,
`completeness-check`, or a human) is sometimes deferred as a follow-up issue instead of
fixed on the branch. Without a signal, that issue can sit open while a release ships.

## The label

`security::deferred` marks issues filed as **deferred follow-ups from a review**. Apply it
in addition to `security`, and **assign the target milestone** for planning (the check itself ignores milestones; see below). It is deliberately narrow: do not put it on tracking items,
dependency advisories waiting on an upstream fix, or general hardening ideas.

## What `/pre-release` does with it

Step 1.5 of `.claude/skills/pre-release/SKILL.md` lists every open `security::deferred`
issue and reports each as a 🔴 blocker unless it carries a valid, unexpired accepted-risk
note. A blocker stops `/release` for a `full` audit.

## What `/release` does with it (pre-tag gate)

`/pre-release full` runs about a sprint before the tag, so a deferral filed since then would
never be checked. `scripts/release.sh` therefore re-runs the same check
(`check_security_deferred_clear`, after the `:latest` drift guard and before it branches) and
refuses to cut the tag while any blocker remains. `RELEASE_SKIP_SECURITY_DEFERRED_CHECK=1`
bypasses it deliberately; it still prints the open-issue list to stderr as a trace and never changes the outcome.

### Milestone scope: all open issues, any milestone

The check scans **every open `security::deferred` issue regardless of milestone**. The unfixed
gap is in `main` and ships with the tag whichever milestone the issue sits on; an issue moved to
a later milestone, or left open in an already-closed one, must not drop out of the check.
This replaced the earlier "target milestone plus `milestone=None`" scope (#1519) so
`/pre-release` and `/release` agree. Both call the single implementation,
`scripts/check-security-deferred.sh` (`--self-test` covers closed-, later- and no-milestone
issues, the query shape, and each fail-closed path). A deliberate deferral to a later release
is expressed with an accepted-risk note, not by moving the milestone.

## Accepted-risk note

One line, in the issue description or any non-system comment:

```
Accepted risk: accepted-by: @<maintainer>; reason: <why shipping is acceptable>; expires: YYYY-MM-DD
```

- Fields appear in exactly this order, separated by `; `.
- `accepted-by` is `@` plus `[A-Za-z0-9_.-]+`; `reason` is non-blank with no `;`.
- `expires` is a real calendar date and the last field on the line (two `expires` fields never match).
- A note whose `expires` date is in the past does not count; the issue is a blocker again. An expiry more than 1 year out is rejected too (`expiry too far out`).
- Any ONE valid line accepts the issue. The note is honor-system: nothing verifies that
  `accepted-by` is a maintainer or that the commenter is not the filer, so the release
  owner must read it before tagging (the audit output prints the note author, handle and expiry).
- The check fails closed in both `/pre-release` and `release.sh`: if `glab`/`jq` is missing or the GitLab query fails, it reports a blocker rather than "0 issues" (unlike the `:latest` guard, which fails open, nothing backstops this one).
- Add the note only on a maintainer's explicit decision. Resolving the issue (closing it) is
  the normal way out; the note is for knowingly shipping with the gap.

## Verdict script and its self-test

The accepted-risk verdict (the note regex plus the calendar and expiry check) is
`scripts/security-deferred-verdict.sh`, not inline shell. It reads candidate lines
(`<author>|Accepted risk: ...`) on stdin, with `TODAY` and `CAP` (latest allowed expiry)
from the environment, and prints `ACCEPTED note-by=... accepted-by=... expires=...`
(exit 0) or `BLOCKER` / `BLOCKER (expiry too far out; max 1 year)` (exit 1). It is POSIX
`sh`/`awk`, so it runs on macOS (BSD awk) and Linux.

`sh scripts/security-deferred-verdict.sh --self-test` (44 cases) covers valid, expired, blank
`accepted-by` / `reason`, impossible dates (`2099-13-45`, `2099-02-30`, non-leap Feb 29),
two `expires` fields, `;` in `reason`, no note, multiple lines, month/day ranges, leap-year rules (2000, 2028, 2100), and handle/author shape. CI runs it in the
`security-deferred-verdict-selftest` job.

`bash scripts/check-security-deferred.sh --self-test` (stubbed `glab`, no network) covers the
query/loop around the verdict; CI runs it in the same `security-deferred-verdict-selftest` job.

## Confidential issues

Many deferred security issues are confidential. The audit token sees them; reports that
leave the session (MR text, public issues, docs) cite the issue number only, never the
title or body.
