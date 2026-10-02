# SonarCloud Runbook

Operational reference for the nightly SonarCloud scan: the token, the pipeline schedule, and
what to do when something breaks. For what Sonar checks and the quality policy, see
[SonarCloud](../development/sonarcloud.md).

SonarCloud organization `visiban`, project key `visiban_visiban`
(`sonar.projectKey` / `sonar.organization` in `sonar-project.properties`).

## At a glance

| Item | Value |
|---|---|
| Job | `sonar:scan` (`.gitlab-ci.yml`, `security` stage), `allow_failure: true` |
| Trigger | A scheduled pipeline whose variables include `SONAR_SCHEDULED=true` |
| Schedule | The **Nightly (CVE/OSV, Sonar, deep fuzz, kaizen)** schedule, cron `0 5 * * *` (05:00 UTC), target branch `main` |
| Schedule variable | `SONAR_SCHEDULED=true` |
| Credential | `SONAR_TOKEN`, a masked, protected GitLab CI/CD variable |
| Token owner | **TBD.** Not recorded anywhere in this repository; see [below](#sonar_token) |
| Token expiry | **UNKNOWN.** Not recorded anywhere in this repository; see [below](#sonar_token) |

## `SONAR_TOKEN`

`sonar-scanner` reads `SONAR_TOKEN` from the environment. There is no other credential: the
host defaults to sonarcloud.io, so `SONAR_HOST_URL` is not set.

| Property | Value |
|---|---|
| Type | SonarCloud user token |
| Needed permission | A user token inherits its owner's permissions, so the owner needs permission to run analysis on the project (the "Execute Analysis" permission in the current SonarCloud UI) |
| Stored | GitLab → Settings → CI/CD → Variables, key `SONAR_TOKEN`, **masked** and **protected** |
| Used by | `sonar:scan`, and a local `scripts/sonar-scan.sh` run if a maintainer exports their own token |
| Owner | **TBD.** A SonarCloud user token belongs to the person who generated it and stops working if that person loses access to the organization |
| Expiry | **UNKNOWN.** Record it here and in the [Tokens and Rotation](tokens-and-rotation.md#inventory) inventory the day the token is created or rotated |

!!! warning "The owner and expiry are not recorded yet"
    Neither value can be read from GitLab's API or from this repository, so this page does not
    guess them. Whoever holds the token must open SonarCloud → My Account → Security, find
    it, and write the expiry date in both places. Until then, treat the token as one that could
    expire at any time. The first symptom is a yellow `sonar:scan` on the nightly pipeline, and
    nothing alerts on it.

`SONAR_TOKEN` is **protected**, so GitLab injects it only into pipelines on a protected branch
or tag. That is why the schedule must target `main`: a schedule on an unprotected branch runs
`sonar:scan` with no token.

### Create the token

1. Sign in to SonarCloud as a member of the `visiban` organization with permission to run
   analysis. Prefer a dedicated service account over a personal one, so the token outlives any
   one person's access.
2. In the current SonarCloud UI, go to **My Account → Security** and generate a token. Name it so its purpose is obvious (for
   example `visiban-gitlab-nightly`), choose an expiry if the UI offers one, and generate it. Copy the value now;
   SonarCloud shows it once.
3. In GitLab, open **Settings → CI/CD → Variables → Add variable**. Key `SONAR_TOKEN`, paste
   the value, enable **Mask variable** and **Protect variable**, and leave the environment scope
   as `*`.
4. Record the owner and the expiry in the
   [Tokens and Rotation](tokens-and-rotation.md#inventory) inventory.
5. Run the scan once by hand to confirm it works; see [Verify](#verify).

### Rotate the token

Follow the [general rotation procedure](tokens-and-rotation.md#rotation-procedure-general).
For this token:

1. Generate the replacement in SonarCloud **before** the old one expires, as above.
2. Edit the existing `SONAR_TOKEN` variable and replace its value. Do not create a second
   variable.
3. Trigger the schedule by hand (see [Verify](#verify)) and confirm `sonar:scan` publishes.
4. Revoke the old token in SonarCloud, and update the expiry in the inventory in the same MR.

## The pipeline schedule

Schedules are GitLab project configuration, not files in the repository, so a deleted or
deactivated schedule leaves no commit to review. The Sonar job rides on the **Nightly**
schedule shared with the CVE/OSV scans, the deep schema fuzz, and kaizen. The full table of
what each schedule runs is in [CI Gate Self-Tests](../development/ci-gates.md).

### Create or restore it

**Build → Pipeline schedules → New schedule**:

| Field | Value |
|---|---|
| Description | `Nightly (CVE/OSV, Sonar, deep fuzz, kaizen)` |
| Interval pattern | Custom: `0 5 * * *` |
| Cron timezone | `UTC` |
| Target branch | `main` |
| Variables (type: Variable) | `CVE_SCAN=true`, `OSV_SCAN=true`, `SONAR_SCHEDULED=true`, `FUZZ_DEEP=true`, `KAIZEN_YIELD_WATCH=true` |
| Activated | Yes |

If the schedule already exists, only confirm that `SONAR_SCHEDULED=true` is among its
variables. The Sonar job needs only that one variable; the others belong to the neighboring
jobs. The nightly load test has its own separate schedule (`LOAD_TEST_SCHEDULE=true`) and is
unrelated.

A schedule runs as the user who owns it. If that user is removed from the project, GitLab can
stop running their schedules, so after any membership change check that the schedule still
shows a next-run time, and use **Take ownership** if it does not.

### Verify

Use the play button on the schedule row (**Run schedule**), or **Build → Pipelines → New
pipeline** on `main` with `SONAR_SCHEDULED=true`. Then:

1. Open the pipeline and check that `sonar:scan` ran. It is a late job: it waits for
   `backend-test-coverage` and `frontend-test`.
2. In its log, find the two lines from `scripts/sonar-scan.sh`:
   `backend/coverage.sonar.xml resolved: N class entries` and
   `frontend/coverage/lcov.sonar.info resolved: N SF files`. Both counts must be above zero.
3. Confirm the SonarCloud dashboard's last-analysis date is current and Coverage is above 0%.

!!! note "The schedule is audited only when a read token exists"
    `schedule-config-check` fails the next scheduled pipeline when a `schedule && $VAR ==
    "true"` rule has no active schedule setting `VAR=true`. It can only read schedules when a
    `GITLAB_API_TOKEN` variable is configured; without one it warns and passes. See
    [CI Gate Self-Tests § Scheduled pipelines](../development/ci-gates.md#scheduled-pipelines).
    Do not rely on it to catch a deleted schedule until that token exists.

## When the nightly `sonar:scan` is yellow

`sonar:scan` is `allow_failure: true`, so it never makes the pipeline red, and nothing alerts
on it. Check the schedule's pipeline history periodically, or the dashboard's last-analysis
date. To diagnose a yellow job, read its log and match the symptom:

| Symptom in the log | Likely cause | Fix |
|---|---|---|
| `Not authorized`, `401`, or a token error | `SONAR_TOKEN` expired, was revoked, or its owner lost access | [Rotate the token](#rotate-the-token) |
| `SONAR_TOKEN` empty, or no token error but no analysis | The variable is missing, or the pipeline ran on a ref where a protected variable is not injected | Confirm the variable exists and the schedule targets `main` |
| An error saying CI analysis cannot run while Automatic Analysis is enabled (exact wording varies) | Someone turned on Automatic Analysis in SonarCloud | Turn it off in the project's administration settings (in the current SonarCloud UI this is under **Administration → Analysis Method**). Automatic Analysis also ignores `sonar-project.properties`, so all the suppressions would stop applying |
| `resolved: 0 class entries` or `0 SF files`, or Coverage reads 0.0% | A report rewrite regressed, or a producer job failed and its report is missing | Check `sonar-scan-selftest`, then run `scripts/sonar-scan.sh --prep-only` locally against fresh reports |
| `! backend/coverage.xml not found` or `! frontend/coverage/lcov.info not found` | `backend-test-coverage` or `frontend-test` failed on `main` that night | Fix that job first; the scan still ran for the other half |
| Image pull failure, or a network or timeout error | A transient registry or SonarCloud problem | Re-run the job. If it persists, check the pinned `sonar-scanner-cli` image in `.gitlab-ci.yml` |
| Job did not appear in the pipeline at all | The schedule is missing, inactive, or lacks `SONAR_SCHEDULED=true` | [Create or restore the schedule](#create-or-restore-it) |

A red `lint:sonar-exclusions` is a different problem: a suppression glob matches no tracked
file. Delete the criterion or repoint it at the new path. Never widen the glob to make the
guard pass.

## The "review every new hotspot" rule

SonarCloud security hotspots are code that is security-sensitive but not necessarily wrong. A
human must decide, and the dashboard counts unreviewed ones against the Security Review
rating. The policy is **no unreviewed hotspots**.

1. When a hotspot appears (the dashboard or a new-code notification shows it), open **Security
   Hotspots** and read the finding and its guidance.
2. Decide: **Fix** it in code, or mark it **Safe** or **Acknowledged** if the code is
   deliberate.
3. Always add a comment saying why. "Safe" with no reason is the same as unreviewed.
4. If the safe call is a recurring pattern in specific files, prefer a narrowly scoped
   `sonar.issue.ignore.multicriteria` criterion with a rationale comment, per the
   [suppression policy](../development/sonarcloud.md#quality-policy).
5. Do this when it appears, not at release time. Hotspots reviewed late are reviewed from
   memory.

Reviewing a hotspot needs a specific project permission in SonarCloud (called "Administer
Security Hotspots" in the current UI). If you cannot see the status controls, ask an
organization admin.

!!! note "SonarCloud UI details are not yet verified"
    The SonarCloud menu paths, permission names, and error wording on this page were written
    from general knowledge of the product and were last verified: not yet. SonarCloud changes
    its UI and plans; if a step does not match what you see, trust the UI and fix this page.
