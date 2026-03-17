# Open Merge Request

You are creating a GitLab MR for the current branch. Every change — including docs, chores, and hotfixes — goes through an MR. Follow the project conventions exactly.

## What to do

Given the branch or change description in `$ARGUMENTS` (or infer from the current branch and git diff if no argument is provided):

### 1. Pre-flight checks

- [ ] On a feature branch (not `main`) — if on `main`, stop and create a branch first
- [ ] Branch name follows convention: `feat/`, `fix/`, `docs/`, or `chore/` prefix
- [ ] `CHANGELOG.md [Unreleased]` is updated — if not, run `/changelog` first
- [ ] All relevant skill checks have been run (see `SKILLS.md` for when each applies)

### 2. Gather context

Read:
- `git log main..HEAD --oneline` — all commits on this branch
- `git diff main...HEAD` — full diff for understanding scope
- The relevant issue number(s) if any (look for issue refs in commits or branch name)

### 3. Draft the MR

**Title format:** `<type>: <short description>` (matches the primary commit)
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `chore:` tooling, config, deps, refactor with no behaviour change

**Description must cover:**
- **Summary** — bullet points of what changed and why (user-visible impact, not implementation detail)
- **Test plan** — checklist of how to verify the change works; include both happy path and edge cases
- **Closes #N** — if this MR resolves a GitLab issue

### 4. Create the MR

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
  --yes
```

### 5. Run local tests and post results as an MR comment

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

### 6. Watch the CI pipeline and post its result as an MR comment

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

- Never use `--squash` or `--remove-source-branch` flags unless the user explicitly requests it
- Never merge an MR with a failing or pending pipeline
- Never push directly to `main` — if you find yourself on `main` with uncommitted changes, create a branch first
- Never skip the test comment step — both pass and fail results must be posted
