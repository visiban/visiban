# Security Scanners (CI)

Which CI security scanner blocks a merge, what it covers, and how to accept a finding
without turning the scanner off. All of them run on merge-request pipelines and on `main`.

| Job | Source | Blocks? | Scope |
|---|---|---|---|
| `secret_detection` | GitLab `secret-detection` component (pinned) | Yes, any finding | MR diff (shallow clone) |
| `secret_detection_history` | Same component job, `extends` | Yes, any finding | **Full git history**, `main` only |
| `gitleaks-scan` | Pinned gitleaks binary | Yes, any finding | Whole working tree |
| `semgrep-sast` + `sast-severity-gate` | GitLab `sast` component (pinned) | Yes at **High/Critical** only | Python and TypeScript/JavaScript |
| `backend-sast` | bandit | Yes, medium+ | `backend/` |
| `frontend-sast` | eslint-plugin-security | Yes, `error` rules (object-injection and timing rules are `warn`) | `frontend/src` |
| `trivy-scan` | Trivy | Tracked separately in #1072 | Container images |

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
(`scripts/sast-severity-gate.py`) reads `gl-sast-report.json` and fails on any unsuppressed
High or Critical finding. Low, Medium, and Info findings stay visible in the MR security
widget and do not fail the pipeline.

To accept a High/Critical finding, add an entry to `.gitlab/sast-suppressions.json`:

```json
{
  "rule": "semgrep rule id or finding name",
  "file": "path/prefix/",
  "reason": "why this is safe, with an issue link",
  "expires": "2026-12-31"
}
```

`expires` is required and may be at most 90 days out. An expired entry **fails the gate**,
so a temporary acceptance has to be revisited. Prefer fixing the code.

## Secret detection allowlist

`gitleaks-scan` uses `.gitleaks.toml`, which carries one commented allowlist entry per
known-safe fixture (lockfile hashes, API doc examples, test mocks). Add an entry there only
for a value that is provably not a credential, and say why in the comment. Never
allowlist a directory wholesale. The component's `secret_detection` job uses its own default
ruleset and had no findings on `main` when this policy was adopted.

If `secret_detection_history` flags an old commit, treat the credential as compromised:
rotate it first, because the history is public on the GitHub and enterprise mirrors. Rewriting
history does not un-leak it.

## Verifying a scanner still blocks

Never push a planted credential to check this; branches mirror to public GitHub. Run the
scanner locally against a throwaway directory instead:

```bash
mkdir /tmp/plant && printf 'aws_secret_access_key = "%s"\n' 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEYab' > /tmp/plant/leak.py
gitleaks dir /tmp/plant --config .gitleaks.toml --redact --exit-code 1   # must exit 1
```
