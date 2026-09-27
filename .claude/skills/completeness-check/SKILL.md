---
name: completeness-check
description: Pre-push completeness audit by a fresh agent that did not write the branch. Reads the issue (with comments), the diff, and the code, and returns a Requirements table plus BLOCKER / GAP / OK findings. Run once per branch, after the pre-MR gate batch and before `git push`.
---

# Completeness Check

Every other gate reads a diff for one class of defect (security, permissions,
queries, migrations). None asks the question that is left: **does the branch
actually deliver what the issue asked for, and every rule the repo already
writes down?** The author cannot answer it — the gaps live in the author's own
context, in what they forgot they had not done. So this gate is a **fresh agent
that did not write the branch**.

It is a serial step **after** the pre-MR gate batch on purpose: it audits the
branch the batch's fixes produced.

## When

- Every source-touching or docs branch, **before `git push`**, after the gate batch.
- Exempt: nothing that is going to a merge request. A one-line fix still gets it —
  it is cheap and the audit is proportional to the diff.
- Re-run it **narrowly** (only the requirement rows a fix touched) on commits made
  in response to it. Never re-run the whole audit after every fix.

## Step 1 — Preconditions

The branch is committed and **not yet pushed**, the working tree is clean, and the
gate batch has come back. If not, stop — auditing a moving branch wastes the run.
In `/batch`, implementers commit and stop here; the orchestrator runs this check,
then tells the implementer to push.

## Step 2 — Pick the model

**Sonnet by default.** Use **Opus** only when the branch meets one of `/batch`'s
escalation criteria (unknown root cause, cross-stack contract change, subtle
invariants such as broadcast semantics or git-lens derivation, or a design /
backward-compatibility judgment the issue did not settle). Record which one on the
ledger line. "It is important" is not a criterion.

## Step 3 — Spawn the fresh agent

Use the Agent tool with `subagent_type: "general-purpose"` and `model` per Step 2.
It must be **read-only** (it reports; it never edits, commits, or pushes) and its
brief must be self-contained. Give it, verbatim:

- the worktree path, branch name, and the exact diff command (`git diff origin/main...HEAD`);
- the issue number and the instruction to read it **with comments**
  (`glab issue view <n> --comments`) plus any issue it links;
- the repo rules it must check against: `CLAUDE.md` (and `frontend/CLAUDE.md` for UI
  work) — backward compatibility from 1.0, tests and docs in the same commit, US
  English, changelog fragment naming, `Closes #NNN`, `SUPPRESSED-UNTIL(#NNNN)`
  markers, the OSS/enterprise boundary;
- two or three sentences of what the change does, so it does not re-derive it.

Do **not** hand it your conclusions ("this is fine"). Hand it the question.

### What the agent must check

1. **Every acceptance criterion** in the issue and its comments is met, or is
   explicitly deferred to an **open** issue.
2. **Tests cover the new code paths** — the specific behavior added, including
   failure paths, empty states and permission boundaries — and every mock of a
   changed module is updated.
3. **Docs and API docs reflect user-visible changes** (`docs/`, `docs/api/`).
4. **Stale statements**: grep the repo (docs, `.claude/`, `CLAUDE.md`, CI config,
   tests) for wording the change has made false. A rename or behavior change with
   a surviving shadow copy is the most common gap.
5. **Backward compatibility**: nothing removed or renamed from a public serializer,
   endpoint, WebSocket payload, env var, or migration.
6. **Anything the author said they would do later** is an open issue, not a
   sentence in a description.
7. **Claims that were not verified** — a comment or description asserting something
   the diff does not show.

## Step 4 — The output contract

The agent returns exactly this, and nothing padded:

```markdown
## Requirements
| # | Requirement | Source | Evidence | Status |
|---|---|---|---|---|
| 1 | <what must be true> | issue #N / CLAUDE.md § / comment | file:line or test name | ✅ met / ❌ missing / ⏭ deferred → #M |

## Findings
- **BLOCKER** — <must fix before merge> — file:line — why
- **GAP** — <should fix, or defer to an open issue> — file:line — why
- **OK** — <checked and fine, only for a non-obvious check>
```

A finding with no `file:line` evidence is not a finding. "Consider adding…" style
observations are not findings.

## Step 5 — Act on it

- Every **BLOCKER** is fixed on the branch.
- Every **GAP** is either fixed on the branch or **deferred to an open issue that is
  named in the MR description** — verify it is open (`glab issue view <n>`); a
  follow-up written in prose with no issue behind it is the failure this gate exists
  to catch.
- Paste the `## Requirements` table into the MR description.
- Push only after this.

## Step 6 — Ledger

Record one line in the MR's `## Gates` section (format in
`.claude/skills/mr/SKILL.md`):

```
- gate: completeness-check — <N> findings (model: <sonnet|opus>)
```

`<N>` counts BLOCKERs and GAPs that **changed the branch or were consciously
deferred** — not rows in the table. `0` is a real outcome; record it. Never inflate.
