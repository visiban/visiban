# Open Merge Request

You are creating a GitLab MR for the current branch. Every change — including docs, chores, and hotfixes — goes through an MR. Follow the project conventions exactly.

## What to do

Given the branch or change description in `$ARGUMENTS` (or infer from the current branch and git diff if no argument is provided):

### Step 1 — Parallel research (delegate to Sonnet agents)

Launch **2 sub-agents in parallel** (both with `model: "sonnet"`). Wait for both to complete before proceeding.

#### Agent 1: Branch and diff analysis
> Gather the full context of this branch:
> - Run `git log main..HEAD --oneline` to get all commits
> - Run `git diff main...HEAD --stat` to get a file-level summary
> - Run `git diff main...HEAD` to read the full diff
> - Identify which areas are touched: backend models, serializers, views, frontend components, tests, docs, migrations, config
> - Look for issue references in commit messages or the branch name
>
> Return: a structured summary with commit list, files changed by area, and any issue references found.

#### Agent 2: Pre-flight checks
> Verify branch readiness:
> - Confirm we are on a feature branch (not `main`)
> - Confirm branch name follows convention: `feat/`, `fix/`, `docs/`, or `chore/` prefix
> - Check if `CHANGELOG.md [Unreleased]` has been updated (read the file, look for entries that match this branch's changes)
> - Check if the branch has been pushed to origin (`git log origin/main..HEAD` vs `git log main..HEAD`)
> - Run `git status` to check for uncommitted changes
>
> Return: a checklist of pass/fail for each pre-flight item, and any blockers that must be fixed before the MR can be created.

### Step 2 — Test coverage check (you do this — do NOT delegate)

Before creating the MR, verify that every new or modified code path has test coverage:

1. From the diff analysis, identify all new/modified functions, methods, hooks, and components.
2. Check whether the relevant test files cover them:
   - Backend functions → `backend/*/tests/`
   - Frontend hooks/utils → `frontend/src/test/`
   - Frontend components → `frontend/src/test/`
3. **If any changed code lacks a test**, use the `test-scaffold` agent to generate the missing tests, then run the suite locally to confirm they pass before proceeding.
   - Exempt: pure documentation changes, migration-only changes with no logic, config/chore changes with no behaviour impact
4. If test coverage is complete, proceed to Step 3.

**Do not skip this step.** A routing test (asserting the right function is called) does not substitute for a state/behaviour test (asserting the result is correct).

### Steps 3–5 — MR creation (you do this — do NOT delegate)

#### 3. Fix any blockers
If pre-flight checks found issues (e.g. CHANGELOG not updated, uncommitted changes, not pushed), fix them or stop and report to the user.

#### 4. Draft the MR

**Title format:** `<type>: <short description>` (matches the primary commit)
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `chore:` tooling, config, deps, refactor with no behaviour change

**Description must cover:**
- **Summary** — bullet points of what changed and why (user-visible impact, not implementation detail)
- **Test plan** — checklist of how to verify the change works; include both happy path and edge cases
- **Closes #N** — if this MR resolves a GitLab issue

#### 5. Create the MR

Always use heredoc syntax — never inline `\n` literals:

```bash
glab mr create \
  --title "<type>: <description>" \
  --description "$(cat <<'EOF'
## Summary

- <bullet>

## Test plan

- [ ] <step>

Closes #N
EOF
)" \
  --target-branch main \
  --remove-source-branch \
  --yes
```

### 6. Run local tests and post results as an MR comment

Immediately after the MR is created, run the relevant local test suites and post the results as a comment on the MR. Do this whether tests pass or fail — both outcomes must be documented.

**Determine which suites to run** based on what the branch touches:
- Any `backend/` change → `docker compose exec backend python manage.py test <affected_apps> --verbosity=2`
- Any `frontend/` change → `cd frontend && npx vitest run`
- Both touched → run both

**Format the comment** using `glab mr note <MR_NUMBER> --message "$(cat <<'EOF' ... EOF)"` (heredoc — never inline `\n`).

**Pass comment format:**
```
## Local test run — ✅ all pass

**Command:** `<command run>`

```
<summary line from test output, e.g. "Ran 86 tests in 42.1s — OK" or "47 test files | 680 tests passed">
```

| Suite | Tests | Result |
|-------|-------|--------|
| <suite name> | <N> | ✅ |
```

**Fail comment format:**
```
## Local test run — ❌ failures detected

**Command:** `<command run>`

```
<summary line>
```

| Suite/Test | Result | Error |
|------------|--------|-------|
| <failing test name> | ❌ | <short error message> |

**Next step:** fix failures before this MR is reviewed.
```

After posting the test comment, **fix any failures** before proceeding. Re-run and re-comment until all tests pass. Each re-run must be posted as a new comment — do not edit previous comments.

### 7. Watch the CI pipeline and post its result as an MR comment

After the local test comment is posted, poll the GitLab pipeline until it completes, then post the result.

**Get the MR's pipeline:**
```bash
glab api "projects/<namespace>%2F<repo>/pipelines?ref=refs/merge-requests/<MR_IID>/head&order_by=id&sort=desc&per_page=1"
```

Poll every 60 seconds (use `sleep 60`) until `status` is no longer `running` or `pending`. Maximum wait: 15 minutes. If still running after 15 minutes, post a timeout comment and stop.

**Get job-level results:**
```bash
glab api "projects/<namespace>%2F<repo>/pipelines/<PIPELINE_ID>/jobs"
```

**Pass comment format:**
```
## CI pipeline — ✅ all jobs pass (pipeline #<ID>)

| Job | Status |
|-----|--------|
| <job_name> | ✅ |
```

**Fail comment format:**
```
## CI pipeline — ❌ pipeline failed (pipeline #<ID>)

| Job | Status |
|-----|--------|
| <passing_job> | ✅ |
| <failing_job> | ❌ |

**Failed jobs:** <comma-separated list>
**Next step:** run `/ci-debug <MR_NUMBER>` to investigate.
```

If the pipeline fails, run `/ci-debug` with the MR number, fix the root cause, push, and repeat from step 5 until the pipeline is green.

## What NOT to do

- Never use `--squash` unless the user explicitly requests it
- Never merge an MR with a failing or pending pipeline
- Never push directly to `main` — if you find yourself on `main` with uncommitted changes, create a branch first
- Never skip the test comment step — both pass and fail results must be posted
