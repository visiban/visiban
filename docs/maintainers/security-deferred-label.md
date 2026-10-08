# Deferred Security Follow-ups (`security::deferred`)

A security finding noticed during review (by `security-review`, `rbac-check`,
`completeness-check`, or a human) is sometimes deferred as a follow-up issue instead of
fixed on the branch. Without a signal, that issue can sit open while a release ships.

## The label

`security::deferred` marks issues filed as **deferred follow-ups from a review**. Apply it
in addition to `security`. It is deliberately narrow: do not put it on tracking items,
dependency advisories waiting on an upstream fix, or general hardening ideas.

## What `/pre-release` does with it

Step 1.5 of `.claude/skills/pre-release/SKILL.md` lists every open `security::deferred`
issue in the target milestone and reports each as a 🔴 blocker unless it carries a valid,
unexpired accepted-risk note. A blocker stops `/release` for a `full` audit.

## Accepted-risk note

One line, in the issue description or any non-system comment:

```
Accepted risk: accepted-by: @<maintainer>; reason: <why shipping is acceptable>; expires: YYYY-MM-DD
```

- All three fields are required, separated by `;` (so `reason` cannot contain `;`).
- A note whose `expires` date is in the past does not count; the issue is a blocker again.
- Add the note only on a maintainer's explicit decision. Resolving the issue (closing it) is
  the normal way out; the note is for knowingly shipping with the gap.

## Confidential issues

Many deferred security issues are confidential. The audit token sees them; reports that
leave the session (MR text, public issues, docs) cite the issue number only, never the
title or body.
