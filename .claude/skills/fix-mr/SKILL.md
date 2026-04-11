---
name: fix-mr
description: Watch a failing MR pipeline and iteratively fix it until green (max 3 attempts).
disable-model-invocation: true
argument-hint: "[MR number]"
---

# Fix MR Pipeline

Watch a failing MR pipeline, diagnose the failure, fix it, and re-check. Repeats up to 3 times.

## What to do

Given the MR number in `$ARGUMENTS` (or the current branch's MR if omitted):

### Step 1 — Gather failure context (parallel sub-agents)

Launch **2 sub-agents in parallel** (both with `model: "sonnet"`). Wait for both.

**Sub-agent 1 — Pipeline logs:**
> Run `glab ci view` or fetch the failing job logs for the MR.
> Identify the specific failing job(s) and extract the relevant error output.
> Return: job name, stage, and the last 100 lines of each failing job's log.

**Sub-agent 2 — Branch context:**
> Run `git log main..HEAD --oneline` and `git diff main...HEAD --stat`.
> Read any files that appear in the diff and are likely related to the failure.
> Return: summary of changes on the branch and relevant file contents.

### Step 2 — Diagnose

Analyze the failure logs against the branch changes. Identify the root cause.
Common categories:
- Lint/format errors
- Type errors
- Test failures (assertion mismatch, missing mock update, import error)
- Missing migration
- Missing changelog fragment

### Step 3 — Fix

Apply the minimal fix for the root cause. Do not refactor or improve unrelated code.

### Step 4 — Commit and push

```bash
git add <changed files>
git commit -m "fix(ci): <description of fix>"
git push
```

### Step 5 — Verify

Wait for the pipeline to start, then monitor it:
```bash
glab ci view
```

If it fails again and this is attempt < 3, go back to Step 1.
If it fails after 3 attempts, report the findings and stop.

## Rules

- Maximum 3 fix attempts — do not loop forever
- Each fix must be a separate commit with a clear message
- Do not force-push unless explicitly asked
- Do not modify code unrelated to the pipeline failure
- If the failure is infrastructure-related (runner timeout, registry error), tell the user to retry manually
