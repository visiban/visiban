# CI gate self-tests

A bespoke CI gate that stops detecting anything does not fail — it goes **green**,
permanently, and looks exactly like a codebase with no violations. There is no signal
distinguishing "the check passed" from "the check is broken." This page is the house rule
that closes that gap, and the record of which scripts follow it.

## The rule

**Every bespoke gate script under `scripts/` ships a `--self-test` mode** that constructs a
known-bad input, runs its own detection logic against it, and asserts the detection fires.
CI runs `<script> --self-test` on the same image, immediately before the real invocation, so
a change that silently broke detection (a tooling upgrade, a refactor, a BusyBox-vs-GNU
behavior difference) is caught before its verdict is trusted on that same run.

```bash
# The shape every wired gate follows, e.g. dep-scan-osv:
- sh scripts/osv-severity-gate.sh --self-test
- sh scripts/osv-severity-gate.sh osv-report.json
```

A self-test failure must hard-block regardless of the real check's own exit-code contract —
see `osv-severity-gate.sh`'s self-test, which always exits 0 (pass) or 1 (fail), never the
non-blocking `2` the real gate uses for a MEDIUM/LOW warning.

## The meta-gate: `gate-selftest-parity`

Nothing above is self-enforcing on its own — a new script can be added to `.gitlab-ci.yml`
without a self-test, or a self-test can be written and never wired into the job that would
run it (exactly what happened to `migration-numbering-check` before #1093: the script had a
working `--self-test`, but the job never called it with that flag).

`scripts/check-gate-selftest-parity.sh` closes that gap. It derives its list of gate scripts
by scanning `.gitlab-ci.yml` **at run time** for every literal `scripts/<name>.(sh|py|mjs)`
reference on a non-comment line, and fails if any of them:

- has no `--self-test` mode at all, or
- has one, but no job in `.gitlab-ci.yml` actually invokes it with that flag.

Nothing here is hardcoded: when a new bespoke script is wired into the CI file (for example
`check-suppression-issues.sh`), the parity check picks it up automatically the next run — no
edit to the checker itself. Wired as its own job (`gate-selftest-parity`, `lint` stage),
which runs `check-gate-selftest-parity.sh --self-test` before the real scan, same pattern as
every gate it audits.

```bash
bash scripts/check-gate-selftest-parity.sh            # scan the real .gitlab-ci.yml
bash scripts/check-gate-selftest-parity.sh --self-test # prove the scanner still fires
```

### Scope

Only `scripts/*.sh`, `*.py`, and `*.mjs` files referenced by literal path in
`.gitlab-ci.yml`. It does **not** reach into:

- the inline `- |` shell blocks scattered across the CI file (there is no script file to
  point `--self-test` at),
- Django management commands such as `manage.py check_migration_concurrency` (not a file
  under `scripts/`),
- scripts that are never invoked from `.gitlab-ci.yml` at all (e.g. `assemble-changelog.sh`
  and `close-milestone-issues.sh`, called only from `scripts/release.sh` at release time).

Extending the meta-gate to any of these is future work, not silently assumed to be covered —
see [Known gaps](#known-gaps-and-deferred-work) below.

## The escape hatch: `gate-selftest-exempt:`

Some scripts genuinely cannot build a synthetic known-bad input cheaply — most often a live
smoke test whose entire value is exercising real infrastructure. Rather than let the parity
check hardcode a list of exceptions (the same anti-pattern the meta-gate exists to avoid),
an exempt script documents its own exemption, the same escape-hatch shape as
`migration-check`'s `# concurrency-exempt:` comment and the OSV gate's `IgnoredVulns` entries:

```bash
# gate-selftest-exempt: <reason>
```

The comment must start the line (only leading whitespace and a single `#` before the marker)
so that prose *describing* the marker — like this page, or `check-gate-selftest-parity.sh`'s
own header — is never mistaken for a real exemption.

### Currently exempt

| Script | Why |
|---|---|
| `scripts/helm-install-drill.sh` | Live kind-cluster boot drill — a synthetic self-test would need to boot a second real cluster. Its own NEGATIVE case (a placeholder-`SECRET_KEY` install must be rejected) already is a known-bad-input assertion, run against the real chart. |
| `scripts/helm-netpol-drill.sh` | Live Calico kind-cluster NetworkPolicy enforcement drill, same reasoning — its NEGATIVE/CONTROL pairs are the known-bad/known-good proof, against real Calico rather than a fixture. |
| `scripts/oidc_provision.py` | Provisioning against a live Keycloak Admin REST API — setup, not detection logic. Its correctness is exercised end-to-end by `oidc_smoke_test.py`. |
| `scripts/oidc_smoke_test.py` | End-to-end smoke test against a live Keycloak instance — a synthetic self-test would need a mock IdP and would not exercise the real risk (discovery/token-exchange/claim-mapping drift). |

## Self-tested today

| Script | CI job | Notes |
|---|---|---|
| `scripts/check-added-files-covered.mjs` | `added-files-coverage-check` (+ its own `added-files-coverage-check-self-test` job) | First adopter, predates #1093's general rule. |
| `scripts/helm-structure-check.sh` | `helm-lint` | `--self-test` injects each defect class into a throwaway copy of the chart. |
| `scripts/check-migration-numbering.sh` | `migration-numbering-check` | Self-test builds a synthetic two-branch git repo and reproduces a numbering collision. Wiring the invocation into the job was itself a #1093 fix — the script had the mode, the job just never called it. |
| `scripts/osv-severity-gate.sh` | `dep-scan-osv` | Covers the block/warn/clean/fail-safe boundary with synthetic OSV-Scanner JSON. Full 11-case regression suite lives in `scripts/tests/osv-severity-gate.test.sh`; the in-script self-test is the smaller, CI-wired proof. |
| `scripts/check-issue-collision.sh` | pre-push git hook only (not a CI job — see [Known gaps](#known-gaps-and-deferred-work)) | Offline self-test against stubbed forge responses. |
| `scripts/check-memory-index.sh` | not currently a CI job | Self-test builds a synthetic memory store. |
| `scripts/check-gate-selftest-parity.sh` | `gate-selftest-parity` | The meta-gate itself — see above. |
| `scripts/check-compose-image-pins.sh` | `compose-hygiene` | Self-test plants an untagged image, an explicit `:latest`, a ported-registry reference (`host:5000/img`, whose colon must not read as a tag separator), and a first-party `${VAR}` reference that must NOT be reported. |
| `scripts/check-compose-project-names.sh` | `compose-hygiene` | Self-test plants a missing `name:`, a duplicate name, a `${VAR:-default}` colliding on its *default* (the exact shape of the original defect), and an overlay that wrongly declares a name. |

`scripts/assemble-changelog.sh` also ships a `--self-test` (added alongside this page,
covering the exact version-dotted-slug incident that motivated #1093), but is not wired into
any CI job — see below.

## Known gaps and deferred work

Not every bespoke script called out when #1093 was filed got a self-test in the same pass.
Deferred deliberately, not silently:

- **`scripts/close-milestone-issues.sh`** — an action script (closes GitLab issues via
  `glab`), not a detection/gate script: there is no pass/fail verdict to prove still fires.
  A meaningful self-test would need to mock the `glab` API surface, which is a larger lift
  than this issue's scope. Not wired into `.gitlab-ci.yml` either, so the parity meta-gate
  does not (and should not yet) flag it.
- **`manage.py check_migration_concurrency`** — the Django management command described in
  `docs/development/database-migrations.md`. Real detection logic with the same silent-green
  failure mode as everything else on this page, but it is not a file under `scripts/`, so
  today's meta-gate cannot point at it. Giving it a `--self-test` subcommand and extending
  the meta-gate to management commands is follow-up work, not assumed done here.
- **The ~19 inline `- |` shell blocks in `.gitlab-ci.yml`** (e.g. `changelog-check`'s
  `git merge-base` / label-lookup / path-stripping logic) are the same risk class but have no
  script file to self-test. Extracting the highest-risk ones into standalone scripts (which
  would then fall under this rule automatically) is the natural next step, evaluated
  case-by-case rather than as a single sweep.

## Why this matters here specifically

Several CI jobs in this repo run on `alpine:3.19`, whose `grep`/`sed` are BusyBox, not GNU —
no `--exclude-dir`, and subtly different behavior under `set -o pipefail` (a `grep -q`
short-circuit sends `SIGPIPE` upstream, which `pipefail` turns into a false pipeline
failure — found and fixed in `check-gate-selftest-parity.sh` itself while writing it; see the
comment above `set -eu` in that script). `backend-lint` already ends a line with `|| true`
(on its secondary Code Quality report step, not its blocking `ruff check` line — but the
shape is exactly the hazard this page exists to guard against elsewhere). Write and test
gate scripts assuming BusyBox and a bare `set -eu`, not GNU tools or `pipefail`, unless you
have verified the specific behavior you rely on.
