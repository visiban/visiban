# Deferred Security Follow-ups (`security::deferred`)

A security finding noticed during review (by `security-review`, `rbac-check`,
`completeness-check`, or a human) is sometimes deferred as a follow-up issue instead of
fixed on the branch. Without a signal, that issue can sit open while a release ships.

## The label

`security::deferred` marks issues filed as **deferred follow-ups from a review**. Apply it
in addition to `security`, and **assign the target milestone** (the audit also reports open `security::deferred` issues with no milestone as blockers). It is deliberately narrow: do not put it on tracking items,
dependency advisories waiting on an upstream fix, or general hardening ideas.

## What `/pre-release` does with it

Step 1.5 of `.claude/skills/pre-release/SKILL.md` lists every open `security::deferred`
issue in the target milestone, plus those with no milestone, and reports each as a 🔴 blocker unless it carries a valid,
unexpired accepted-risk note. A blocker stops `/release` for a `full` audit.

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
- The check fails closed: if the GitLab query fails, `/pre-release` reports a blocker rather than "0 issues".
- Add the note only on a maintainer's explicit decision. Resolving the issue (closing it) is
  the normal way out; the note is for knowingly shipping with the gap.

## Confidential issues

Many deferred security issues are confidential. The audit token sees them; reports that
leave the session (MR text, public issues, docs) cite the issue number only, never the
title or body.
