# Security Scanners (CI)

Which CI security scanner can fail a pipeline, what it covers, and how to accept a finding
without turning the scanner off. Where each job runs is in the table; it is not uniform.

| Job | Source | Blocks? | Runs | Scope |
|---|---|---|---|---|
| `gitleaks-scan` | Pinned gitleaks binary, `.gitleaks.toml` | Yes, any finding | MR + `main` | Whole working tree |
| `gitleaks-history` | Pinned gitleaks binary, `.gitleaks.toml` | Yes, any finding, but it runs **after merge on `main`**, so it is a post-merge tripwire, not a merge gate | `main` only | **Full git history** |
| `secret_detection` | GitLab `secret-detection` component (pinned) | **No for findings.** Reports only; fails only if the analyzer itself crashes. Gating on it is #1537 | MR + `main` | MR diff (shallow clone) |
| `semgrep-sast` + `sast-severity-gate` | GitLab `sast` component (pinned) | Yes at **High/Critical** only | MR + `main` | Python and TypeScript/JavaScript |
| `backend-sast` | bandit | Yes, medium+ | MR + `main` when `backend/**/*.py` changed | `backend/` |
| `frontend-sast` | eslint-plugin-security | Yes, `error` rules (object-injection and timing rules are `warn`) | MR + `main` when `frontend/src/**/*.{ts,tsx}` changed | `frontend/src` |
| `trivy-scan` | Trivy | Tracked separately in #1072 | | Container images |

`dep-scan-osv`, `pip-audit`, and the license checks are deliberately outside this policy.

The secret scanners that actually gate are `gitleaks-scan` and `gitleaks-history`. GitLab's
analyzers exit 0 even when they find something, so `allow_failure: false` on the component's
`secret_detection` job only turns an analyzer crash into a red job; it does not stop a leak.

Component-generated jobs (`secret_detection`, `semgrep-sast`) are not literal job keys
in a plain reading of `.gitlab-ci.yml`; they come from the `include:` block, and the
"Scanner blocking policy" section of `.gitlab-ci.yml` overrides them. Look there when
changing whether either one blocks.

## Component versions are pinned

Both components are pinned to an exact version, never `@~latest`. To bump one, confirm the
version exists (`glab api "projects/components%2Fsast/releases"`), read its release notes,
and change it in its own MR.

## Semgrep: severity gate and expiring suppressions

The SAST component cannot gate by severity, so `sast-severity-gate`
(`scripts/sast-severity-gate.py`, which has a `--self-test` run before each real
invocation) reads `gl-sast-report.json` and fails on any unsuppressed High or Critical
finding. Low, Medium, and Info findings stay visible in the MR security
widget and do not fail the pipeline.

To accept a High/Critical finding, add an entry to `.gitlab/sast-suppressions.json`:

```json
{
  "rule": "exact finding name or exact identifier value (e.g. a semgrep rule id)",
  "file": "exact/path.py  or a glob such as scripts/*.py",
  "reason": "why this is safe, with an issue link",
  "expires": "2026-12-31"
}
```

Matching is exact: `rule` must equal the finding's name or one of its identifier values, and
`file` must equal the path or match the glob (`*` also crosses `/`). Substrings and bare
directory prefixes do not match, and entries that are empty or wildcard-only (`*`, `**/*`)
are rejected. `expires` is required and may be at most 90 days out. An expired entry **fails the gate**,
so a temporary acceptance has to be revisited. Prefer fixing the code.

## Secret detection allowlist

`gitleaks-scan` (working tree) and `gitleaks-history` (every commit on `main`) both use
`.gitleaks.toml`, which carries commented path allowlist entries for known-safe fixtures
(lockfile hashes, API doc examples, test mocks) and one commit-scoped entry for a single
historical test password. Add an entry only for a value that is provably not a credential,
and say why in the comment. Prefer the narrowest scope: an exact file, or a commit for a
one-off hit in history. The issue's suggested directory allowlists (`backend/*/tests/`,
`sample-boards/`, `oidc/`) were intentionally not added: a directory-wide exemption would
mask real leaks in the blocking scanners. `sample-boards/` and `oidc/keycloak-realm.json`
both scan clean without one.

The component's `secret_detection` job uses its own default ruleset and ignores
`.gitleaks.toml`. It reports findings but cannot gate on them (see #1537). Full history is
covered by `gitleaks-history`; the existing history was triaged locally before it became
blocking.

If `gitleaks-history` flags an old commit, treat the credential as compromised: rotate it
first, because the history is public on the GitHub and enterprise mirrors. Rewriting history
does not un-leak it.

## Blocking scanners fail closed

Because `semgrep-sast` is blocking, an analyzer crash or registry timeout blocks MRs and
`main`. Retry the job; do not flip `allow_failure` back to `true`. `sast-severity-gate`
fails if the report is missing or unparsable. `gitleaks-history` fails if the clone is
shallow, so it can never report green on a partial history.

To disable semgrep deliberately, add `semgrep` to the SAST component's `excluded_analyzers`
input **and remove `sast-severity-gate` in the same change**. (The component has no
`SAST_DISABLED` variable in the pinned version.) Excluding it without removing the gate
leaves the gate failing closed on the missing report.

## Verifying a scanner still blocks

Never push a planted credential to check this; branches mirror to public GitHub. Run the
scanner locally, in memory, instead:

```bash
# Built from pieces at runtime so no credential-shaped literal is committed here.
printf 'aws_access_key_id = "%s%s"\n' AKIA QYLPMN5HHHFPZAM2 \
  | gitleaks stdin --config .gitleaks.toml --redact --exit-code 1   # must exit 1
```

This is the planted-credential check for the issue's first acceptance criterion: a leaked
key fails `gitleaks-scan` (and, on `main`, `gitleaks-history`). It does not fail the
component's `secret_detection` job (#1537).
