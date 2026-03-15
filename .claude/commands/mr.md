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

### 5. After creation

- Confirm the pipeline starts — if it doesn't trigger within 30 seconds, check the branch was pushed
- Do not merge until the pipeline is green — `only_allow_merge_if_pipeline_succeeds = true` is enforced
- If the pipeline fails, run `/ci-debug` with the MR number

## What NOT to do

- Never use `--squash` or `--remove-source-branch` flags unless the user explicitly requests it
- Never merge an MR with a failing or pending pipeline
- Never push directly to `main` — if you find yourself on `main` with uncommitted changes, create a branch first
