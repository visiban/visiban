---
name: ci-debug
description: Diagnose a failing GitLab CI pipeline and prescribe a specific fix.
argument-hint: "<pipeline ID, MR number, or job name>"
---

# CI Debug

You are diagnosing a failing GitLab CI pipeline for the visiban project. Your job is to identify the root cause, not just describe the symptom, and give a specific fix.

## What to do

Given the pipeline ID, MR number, job name, or error description in `$ARGUMENTS` (or ask the user if nothing is provided):

### 1. Fetch the failure
Use `glab` to get the relevant job log:
```bash
glab pipeline list --repo visiban/visiban          # find recent pipelines
glab ci view <pipeline-id> --repo visiban/visiban  # see job statuses
glab ci trace <job-id> --repo visiban/visiban      # get full job log
```

Or if an MR number is given:
```bash
glab mr view <mr-number> --repo visiban/visiban    # get branch name
# then find pipeline for that branch
```

### 2. Identify the stage and job
Map the failure to one of the known CI jobs:

| Stage | Job | Common failures |
|---|---|---|
| lint | `backend-lint` | Ruff violations — fix in source, not config |
| lint | `frontend-lint` | ESLint errors or TypeScript type errors |
| lint | `changelog-check` | Missing CHANGELOG.md entry — run `/changelog` |
| test | `backend-test` | Failing Django tests or coverage < 90% |
| test | `migration-check` | Model changed without migration — run `/migration-check` |
| test | `frontend-test` | Failing Vitest tests or coverage threshold |
| test | `backend-docker-build` | Dockerfile syntax or dependency install failure |
| test | `frontend-docker-build` | Dockerfile syntax, Vite build error, or TS compile error |
| security | `backend-dep-scan` | New dependency with known CVE |
| security | `frontend-dep-scan` | npm audit high/critical vulnerability |
| security | `backend-license-check` | GPL-licensed dependency added |

### 3. Diagnose the root cause
- For test failures: identify the specific test(s) failing and why — look for assertion errors, import errors, fixture issues, or database state problems
- For lint failures: identify the specific rule violation and the file/line
- For type errors: identify the type mismatch and where the type annotation is wrong or missing
- For coverage failures: identify which files have insufficient coverage and what branches/lines are untested
- For build failures: identify the build step that failed (dependency install, compilation, Docker layer)

### 4. Do not retry blindly
- Never suggest re-running the pipeline without a code change unless the failure is clearly infrastructure-related (runner timeout, MinIO cache miss, network flake)
- If the failure is a flaky test, identify why it is flaky (ordering dependency, time-sensitive assertion, missing mock) and fix the underlying issue

### 5. Prescribe a specific fix
- Give the exact file and change needed
- If it is a test failure, determine whether the test is wrong or the code is wrong before recommending a fix
- If it is a changelog failure, invoke `/changelog` to write the entry
- If it is a migration failure, invoke `/migration-check` to audit the model changes

### 6. Verify locally (if possible)
Suggest the local command to reproduce and verify the fix before pushing:
- Backend tests: `cd backend && python manage.py test <app> --verbosity=2`
- Frontend tests: `cd frontend && npm test -- --run`
- Lint: `ruff check backend/` or `cd frontend && npx eslint src/`
- Type check: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
- Migration check: `cd backend && python manage.py makemigrations --check --dry-run`
