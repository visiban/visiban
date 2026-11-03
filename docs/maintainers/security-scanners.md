# Security Scanners (CI)

Which CI security scanner can fail a pipeline, what it covers, and how to accept a finding
without turning the scanner off. Where each job runs is in the table; it is not uniform.

| Job | Source | Blocks? | Runs | Scope |
|---|---|---|---|---|
| `gitleaks-scan` | Pinned gitleaks binary, `.gitleaks.toml` | Yes, any finding | MR + `main` | Whole working tree |
| `gitleaks-commits` | Pinned gitleaks binary, `.gitleaks.toml` | Yes, any finding (#1612). The per-commit merge gate | MR only | **Every commit the MR adds** (`merge-base..HEAD`), so a secret added in one commit and removed or annotated in a later one is still caught |
| `gitleaks-history` | Pinned gitleaks binary, `.gitleaks.toml` | Yes, any finding, but it runs **after merge on `main`**, so it is a post-merge tripwire, not a merge gate | `main` only | **Full history reachable from the pipeline commit** (`--log-opts="$CI_COMMIT_SHA"`); other refs in a reused runner clone are ignored |
| `secret_detection` + `secret-detection-gate` | GitLab `secret-detection` component (pinned) | Yes, any unsuppressed finding (#1537). The component job itself only reports; the gate reads its report | MR + `main` | MR diff (shallow clone) |
| `semgrep-sast` + `sast-severity-gate` | GitLab `sast` component (pinned) | Yes at **High/Critical** only | MR + `main` | Python and TypeScript/JavaScript |
| `backend-sast` | bandit | Yes, medium+ | MR + `main` when `backend/**/*.py` or `clients/**/*.py` changed | `backend/`, `clients/python/` |
| `frontend-sast` | eslint-plugin-security | Yes, `error` rules (object-injection and timing rules are `warn`) | MR + `main` when `frontend/src/**/*.{ts,tsx}` changed | `frontend/src` |
| `clients-typescript-sast` | eslint-plugin-security (same rule set) | Yes, `error` rules | MR + `main` when `clients/typescript/**` changed | `clients/typescript/src` |
| `trivy-scan` | Trivy (pinned by digest) | Yes, HIGH/CRITICAL vulnerability, misconfiguration and secret findings (#1072) | MR when its inputs change (Dockerfiles, lockfiles, Helm, the scan's own files) + the Nightly schedule (`CVE_SCAN=true`); **not** every `main` push (#1267) | Repo filesystem (lockfiles, Dockerfile IaC, secrets); not built images |

`dep-scan-osv`, `pip-audit`, and the license checks are deliberately outside this policy.

The secret scanners that gate are `gitleaks-scan`, `gitleaks-commits`, `gitleaks-history`, and
`secret-detection-gate`. GitLab's analyzers exit 0 even when they find something, so
`allow_failure: false` on the component's `secret_detection` job only turns an analyzer crash
into a red job; it does not stop a leak. `secret-detection-gate` (`scripts/secret-detection-gate.py`,
with a `--self-test` run before each real invocation) reads `gl-secret-detection-report.json`
and fails on any unsuppressed finding of any severity, or if the report is missing or unusable.

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

`gitleaks-scan` (working tree), `gitleaks-commits` (the MR's commits) and `gitleaks-history` (every commit on `main`) all use
`.gitleaks.toml`, which carries commented path allowlist entries for known-safe fixtures
(lockfile hashes, API doc examples, test mocks) and one commit-scoped entry for a single
historical test password. Add an entry only for a value that is provably not a credential,
and say why in the comment. Prefer the narrowest scope: an exact file, or a commit for a
one-off hit in history. The issue's suggested directory allowlists (`backend/*/tests/`,
`sample-boards/`, `oidc/`) were intentionally not added: a directory-wide exemption would
mask real leaks in the blocking scanners. `sample-boards/` and `oidc/keycloak-realm.json`
both scan clean without one.

The component's `secret_detection` job uses its own default ruleset and ignores
`.gitleaks.toml`, so its fixture and example hits are allowlisted separately, in
`.gitlab/secret-detection-suppressions.json` (read by `secret-detection-gate`). Entries use the
same format and matching rules as the semgrep suppressions above (exact `rule`, exact path or
glob `file`, `expires` at most 90 days out, expired entries fail the gate), and additionally the
`reason` must cite a tracking issue as `#NNNN`. The gate prints only the rule name and
`file:line`, never the matched value. Prefer fixing the file to suppressing it. Full history is
covered by `gitleaks-history`, and an MR's own commits by `gitleaks-commits`; the existing history was triaged locally before it became
blocking.

If `gitleaks-commits` flags an intermediate commit, do not just annotate the final tree: with
`merge_method=merge` every commit enters `main`'s history, so rewrite the branch to drop the
literal (or add a narrow commit-scoped entry in `.gitleaks.toml`) before merging. In an MR pipeline `gitleaks-commits` reads the MR branch's own `.gitleaks.toml`, so an allowlist entry added on the branch takes effect for that MR; this is the same trust model as `gitleaks-scan`, so reviewers must scrutinize `.gitleaks.toml` diffs.

If `gitleaks-history` flags an old commit, treat the credential as compromised: rotate it
first, because the history is public on the GitHub and enterprise mirrors. Rewriting history
does not un-leak it.

## Blocking scanners fail closed

Because `semgrep-sast` is blocking, an analyzer crash or registry timeout blocks MRs and
`main`. Retry the job; do not flip `allow_failure` back to `true`. `sast-severity-gate`
fails if the report is missing or unparsable. `gitleaks-history` and `gitleaks-commits` fail if the
clone is shallow (or, for `gitleaks-commits`, the MR diff base is missing), so they can never
report green on a partial scan.

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
key fails `gitleaks-scan` (and, on `main`, `gitleaks-history`; on an MR, `gitleaks-commits` for a key in any of its commits). The component's
`secret_detection` job does not fail on it; `secret-detection-gate` does, when the component
reports it.

## npm `overrides` pins in `frontend/package.json`

`package.json` cannot hold comments, so this page is the record. This section documents only
the `postcss-selector-parser` pin below; the other entries in the `overrides` block
(`axios`, `follow-redirects`, `markdown-it`) are not recorded here; that is tracked in #1649.

### `postcss-selector-parser` pinned to 7.1.6 (GHSA-rj75-hqrm-r3gf, #1488, !1197)

- **What it does:** forces every copy of `postcss-selector-parser` to 7.1.6, including the
  copies that `tailwindcss` (`^6.1.2`), `postcss-nested` 6.x (`^6.1.1`) and
  `@tailwindcss/typography` (exact `6.0.10`) request on the vulnerable 6.x line.
- **Why it is still needed (checked 2026-10-14):** `tailwindcss` 3.4.19 is the latest 3.x
  release (the `v3-lts` dist-tag; no further 3.x release is expected) and depends on `postcss-selector-parser ^6.1.2`. It also
  requires `postcss-nested ^6.2.0`, whose latest 6.x (6.2.0) depends on `^6.1.1`, so a
  `^7` `postcss-nested` is not reachable from Tailwind 3. `@tailwindcss/typography` latest
  0.5.20 pins exactly `6.0.10`; the locked 0.5.19 pins exactly `6.0.10` too. No compatible
  release resolves a fixed parser on its own, so in practice the override stays until #1420
  lands, and after that until typography stops pinning 6.x.
- **Removal condition:** #1420 (migrate Tailwind CSS v3 to v4, milestone 1.3) is the trigger.
  Tailwind v4 has no `postcss-selector-parser` dependency, so it removes the `tailwindcss`
  and `postcss-nested` dependents. `@tailwindcss/typography` 0.5.20 accepts v4 (peer
  `>=4.0.0`) but still pins exactly `6.0.10`, so after #1420 typography is the only
  remaining blocker. Remove the override once no dependent requests a vulnerable range.
- **How to check:**

  ```bash
  npm view @tailwindcss/typography@latest dependencies.postcss-selector-parser
  npm view tailwindcss@3 dependencies.postcss-selector-parser | tail -1   # until #1420 lands
  ```

  After #1420 only the typography line applies. When no dependent requests a vulnerable
  range, remove the override in a branch, then run `cd frontend && npm install` so the
  installed tree and lockfile are regenerated. Check that the `package-lock.json` diff
  shows only `postcss-selector-parser` tree changes with no remaining 6.x entry, then
  confirm `npm ls postcss-selector-parser` lists only fixed versions.
