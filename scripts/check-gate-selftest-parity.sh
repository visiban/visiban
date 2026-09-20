#!/usr/bin/env bash
# scripts/check-gate-selftest-parity.sh — meta-gate for issue #1093.
#
# A bespoke CI gate that stops detecting anything does not fail — it goes
# green, permanently, and looks exactly like a codebase with no violations.
# #1093's house rule is that every such script ships a `--self-test` mode
# that builds a known-bad input and proves the script still fires on it, run
# in CI immediately before the real invocation. This script is the meta-gate
# that keeps that rule from quietly stopping being applied: it derives the
# list of bespoke gate scripts FROM `.gitlab-ci.yml` ITSELF (every literal
# `scripts/<name>.(sh|py|mjs)` reference on a non-comment line) and fails if
# any of them either (a) has no `--self-test` mode, or (b) has one but no job
# in the CI file actually invokes it with that flag — the exact gap this
# script found in `migration-numbering-check` (see #1093's MR: the script had
# self-test support the job never called).
#
# Deliberately NOT a hardcoded gate list: nothing here needs editing when a
# new bespoke script is wired into `.gitlab-ci.yml` (e.g. #1092's
# check-suppression-issues.sh) — it is picked up automatically the next time
# this runs, which is the entire point (a hardcoded list is just a second
# place the pattern can quietly stop being applied).
#
# Escape hatch, same shape as migration-check's `# concurrency-exempt:` and
# the OSV gate's `IgnoredVulns` entries: a script that cannot reasonably
# self-test (e.g. a live-cluster smoke test) carries a one-line comment
# containing the literal text `gate-selftest-exempt:` followed by a reason,
# anywhere in the script file. This gate skips it — but the comment is
# grep-able in the script itself, in code review and in `git blame`, so the
# exemption is never silent. See docs/development/ci-gates.md for the current
# exempt scripts and why.
#
# Scope: only `scripts/*.sh`, `*.py`, and `*.mjs` files referenced by literal
# path in `.gitlab-ci.yml`. It does NOT reach into the ~19 inline `- |` shell
# blocks in the CI file, or into Django management commands (e.g.
# `check_migration_concurrency`) — those aren't files under `scripts/` this
# gate can point `--self-test` at. Extending coverage to those is future work
# (see docs/development/ci-gates.md), not silently assumed to be covered.
#
# Usage:
#   scripts/check-gate-selftest-parity.sh [--ci-file <path>] [--scripts-root <dir>]
#   scripts/check-gate-selftest-parity.sh --self-test
#
#   --ci-file <path>       CI file to scan (default: <repo>/.gitlab-ci.yml).
#   --scripts-root <dir>   Root that "scripts/x.sh" references resolve under
#                          (default: the repo root, one level up from this
#                          script). Both flags exist so --self-test can point
#                          the same detection logic at a synthetic fixture
#                          tree instead of the real repository.
#   --self-test            Build a synthetic CI file + script fixtures in a
#                          temp directory, prove the check fires on known-bad
#                          input and passes on known-good input, then exit.
#                          Touches nothing in this repository.
#
# Exit codes: 0 = every referenced gate script is exempt or self-test-clean,
#             1 = at least one violation (or a --self-test failure).
#
# Written in portable bash without associative arrays (macOS ships bash 3.2,
# which has none) and using only grep/sort primitives BusyBox provides
# (alpine:3.19 images in this CI have no GNU grep/sed) — see the `dep-scan-osv`
# and `migration-numbering-check` jobs this parity check itself audits.
#
# Deliberately `set -eu`, NOT `set -eu[o pipefail]`: with pipefail on, the
# `grep -q` at the end of the "is this script's --self-test actually invoked"
# check below exits as soon as it finds a match and closes its stdin, which
# sends SIGPIPE to the still-writing `grep` upstream of it — a normal,
# harmless short-circuit, but pipefail turns that SIGPIPE-driven exit into a
# pipeline failure and silently made this exact meta-gate report false
# positives (found while writing this, against the real .gitlab-ci.yml, on
# grep 3.11) — precisely the "the gate stops detecting anything and goes
# green forever" failure class #1093 exists to catch, just inverted into
# "reports violations that are not there." Left as `-eu` on purpose.

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_FILE="$REPO_ROOT/.gitlab-ci.yml"
SCRIPTS_ROOT="$REPO_ROOT"
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --ci-file)
      CI_FILE="$2"
      shift 2
      ;;
    --scripts-root)
      SCRIPTS_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Anchored to the start of a comment line (optional leading whitespace, a
# single '#', optional whitespace, then the literal marker) so that PROSE
# *describing* the marker — like this script's own header above, or this
# comment right here — is never mistaken for an actual exemption. A real
# exemption comment (see scripts/oidc_provision.py) reads exactly:
#   # gate-selftest-exempt: <reason>
EXEMPT_PATTERN='^[[:space:]]*#[[:space:]]*gate-selftest-exempt:'

# check_parity <ci-file> <scripts-root>
#
# Prints a report to stdout/stderr and returns 0 if every scripts/* gate
# referenced on a non-comment line of <ci-file> is either exempt or ships a
# --self-test mode that <ci-file> actually invokes; 1 if any violation is
# found. Known limitation: matching a script's invocation lines uses a plain
# substring grep on its path, so one script's path being a literal prefix of
# another's would over-match — not a concern for any script name in this repo
# today, but worth knowing if that ever changes.
check_parity() {
  local ci_file="$1" scripts_root="$2"

  if [ ! -f "$ci_file" ]; then
    echo "check-gate-selftest-parity: CI file not found: $ci_file" >&2
    return 1
  fi

  # Every literal scripts/<name>.<ext> reference on a non-comment line
  # (a line whose first non-blank character is '#' is a comment, matching
  # the .gitlab-ci.yml convention used throughout this file — e.g. the
  # "Also wired as a local pre-commit hook (scripts/gitleaks-precommit.sh...)"
  # comment near dep-scan-osv must not itself count as a gate reference).
  local refs
  refs=$(grep -vE '^[[:space:]]*#' "$ci_file" \
    | grep -oE 'scripts/[A-Za-z0-9_.-]+\.(sh|py|mjs)' \
    | sort -u || true)

  if [ -z "$refs" ]; then
    echo "check-gate-selftest-parity: no scripts/* gate scripts referenced in $ci_file."
    return 0
  fi

  local violations=0 checked=0 exempt=0 compliant=0
  local script_ref script_path

  while IFS= read -r script_ref; do
    [ -z "$script_ref" ] && continue
    script_path="$scripts_root/$script_ref"

    if [ ! -f "$script_path" ]; then
      # Referenced but missing on disk is a different failure mode (the job
      # itself will fail the first time it runs) — not this gate's concern.
      continue
    fi
    checked=$((checked + 1))

    if grep -qE "$EXEMPT_PATTERN" "$script_path"; then
      exempt=$((exempt + 1))
      echo "EXEMPT: $script_ref ($(grep -E "$EXEMPT_PATTERN" "$script_path" | head -1 | sed 's/^[[:space:]]*#[[:space:]]*//'))"
      continue
    fi

    if ! grep -q -- '--self-test' "$script_path"; then
      echo "VIOLATION: $script_ref — no --self-test mode found in the script." >&2
      violations=$((violations + 1))
      continue
    fi

    # The script supports --self-test — confirm some non-comment line in the
    # CI file actually invokes THIS script with that flag. A script that can
    # self-test but whose job never runs it is the migration-numbering-check
    # gap #1093 was filed over: capability without wiring is not compliance.
    if ! grep -vE '^[[:space:]]*#' "$ci_file" | grep -F "$script_ref" | grep -q -- '--self-test'; then
      echo "VIOLATION: $script_ref — supports --self-test but no job in $(basename "$ci_file") invokes it with that flag." >&2
      violations=$((violations + 1))
      continue
    fi

    compliant=$((compliant + 1))
  done <<< "$refs"

  echo ""
  echo "check-gate-selftest-parity: $checked gate script(s) referenced — $compliant compliant, $exempt exempt, $violations violation(s)."

  [ "$violations" -eq 0 ]
}

# self_test — builds a synthetic CI file + four fixture scripts in a temp
# directory (touches nothing in this repository, needs no network) covering
# the four classifications check_parity must tell apart:
#   good.sh              — has --self-test, CI invokes it with the flag: clean
#   bad.sh                — no --self-test at all: the known-bad case
#   wired_but_unused.sh   — has --self-test, but CI never passes the flag:
#                           the real migration-numbering-check gap, reproduced
#   exempt.sh             — no --self-test, but carries the escape hatch
self_test() {
  local tmp
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # intentional early expansion, path is fixed now
  trap "rm -rf '$tmp'" EXIT

  echo "=== check-gate-selftest-parity.sh --self-test ==="

  mkdir -p "$tmp/scripts"

  cat > "$tmp/scripts/good.sh" <<'EOS'
#!/usr/bin/env bash
case "${1:-}" in
  --self-test) echo "good.sh: self-test ok"; exit 0 ;;
esac
echo "good.sh: real run"
EOS

  cat > "$tmp/scripts/bad.sh" <<'EOS'
#!/usr/bin/env bash
echo "bad.sh: real run, no self-test capability"
EOS

  cat > "$tmp/scripts/wired_but_unused.sh" <<'EOS'
#!/usr/bin/env bash
case "${1:-}" in
  --self-test) echo "wired_but_unused.sh: self-test ok"; exit 0 ;;
esac
echo "wired_but_unused.sh: real run"
EOS

  # Built with a variable rather than a literal heredoc line: a literal
  # "# gate-selftest-exempt:" line here would make THIS script's own source
  # match $EXEMPT_PATTERN when check_parity scans itself later in this same
  # self-test run, self-reporting EXEMPT instead of compliant.
  exempt_tag="gate-selftest-exempt"
  {
    echo '#!/usr/bin/env bash'
    echo "# ${exempt_tag}: synthetic fixture only — no feasible self-test input."
    echo 'echo "exempt.sh: real run"'
  } > "$tmp/scripts/exempt.sh"

  cat > "$tmp/ci-bad.yml" <<'EOS'
bad-job:
  script:
    - bash scripts/bad.sh

wired-but-unused-job:
  script:
    - bash scripts/wired_but_unused.sh

exempt-job:
  script:
    - bash scripts/exempt.sh

good-job:
  script:
    - bash scripts/good.sh --self-test
    - bash scripts/good.sh
EOS

  local out rc

  rc=0
  out=$(check_parity "$tmp/ci-bad.yml" "$tmp" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SELF-TEST FAILED: expected violations on the known-bad CI file, got a clean pass." >&2
    echo "$out" >&2
    exit 1
  fi
  if ! echo "$out" | grep -q "VIOLATION: scripts/bad.sh"; then
    echo "SELF-TEST FAILED: bad.sh (no --self-test at all) was not flagged." >&2
    echo "$out" >&2
    exit 1
  fi
  if ! echo "$out" | grep -q "VIOLATION: scripts/wired_but_unused.sh"; then
    echo "SELF-TEST FAILED: wired_but_unused.sh (self-test present but not invoked) was not flagged." >&2
    echo "$out" >&2
    exit 1
  fi
  if echo "$out" | grep -q "VIOLATION: scripts/exempt.sh"; then
    echo "SELF-TEST FAILED: exempt.sh was flagged despite carrying the exemption marker." >&2
    echo "$out" >&2
    exit 1
  fi
  if echo "$out" | grep -q "VIOLATION: scripts/good.sh"; then
    echo "SELF-TEST FAILED: good.sh was flagged despite being fully compliant." >&2
    echo "$out" >&2
    exit 1
  fi
  echo "Case 1 OK: known-bad CI file flags bad.sh and wired_but_unused.sh; spares exempt.sh and good.sh."

  cat > "$tmp/ci-good.yml" <<'EOS'
exempt-job:
  script:
    - bash scripts/exempt.sh

good-job:
  script:
    - bash scripts/good.sh --self-test
    - bash scripts/good.sh
EOS

  rc=0
  out=$(check_parity "$tmp/ci-good.yml" "$tmp" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SELF-TEST FAILED: expected a clean pass on the known-good CI file." >&2
    echo "$out" >&2
    exit 1
  fi
  echo "Case 2 OK: known-good CI file (only compliant + exempt scripts) passes clean."

  echo "=== check-gate-selftest-parity.sh --self-test: PASSED ==="
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

check_parity "$CI_FILE" "$SCRIPTS_ROOT"
