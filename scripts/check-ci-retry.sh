#!/usr/bin/env bash
# scripts/check-ci-retry.sh — fail when any `retry:` in .gitlab-ci.yml can retry
# a script failure (#2462). Red tests here have repeatedly been real bugs, so
# only infrastructure failure classes may retry (see `default:` and
# docs/maintainers/known-ci-failures.md).
#
# GitLab retries EVERY failure class, script_failure included, when a retry has
# no `when:`. So the file is parsed as YAML (anchors and `<<:` merges resolved)
# and this fails on:
#   * `retry: N` with N > 0 (no `when:` possible), or any non-integer scalar;
#   * a retry mapping with no `when:` (unless `max: 0`), or an empty one;
#   * a `when:` naming script_failure, unknown_failure or always;
#   * a retry value this check cannot resolve (`!reference`), so write it out;
#   * a `default:` without a retry mapping that has a `when:` list.
# `retry: 0` (the non-idempotent opt-out) passes.
#
# Needs a Python with PyYAML: $PYTHON, else python3, else backend/.venv/bin/python
# (CI: `py3-yaml` in script-tests). Exits 3, never 0, when none has it.
#
# Usage: scripts/check-ci-retry.sh [--ci-file F] | --self-test
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC2016  # Python source, not shell
CHECK_PY='
import sys
import yaml

FORBIDDEN = {"script_failure", "unknown_failure", "always"}


class Tagged:
    def __init__(self, tag, value):
        self.tag, self.value = tag, value


class Loader(yaml.SafeLoader):
    pass


def _tagged(loader, suffix, node):
    if isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    elif isinstance(node, yaml.MappingNode):
        value = loader.construct_mapping(node, deep=True)
    else:
        value = loader.construct_scalar(node)
    return Tagged("!" + suffix, value)


Loader.add_multi_constructor("!", _tagged)  # GitLab tags such as !reference


def problem(where, r):
    if isinstance(r, Tagged):
        return f"{where}: retry is a {r.tag} value this check cannot resolve; write the mapping out"
    if isinstance(r, bool) or not isinstance(r, (int, dict)):
        return f"{where}: retry: {r!r} is not an integer or a mapping"
    if isinstance(r, int):
        if r == 0:
            return None
        return (f"{where}: retry: {r} has no when:, so GitLab retries every failure class "
                "(script_failure included); use a mapping with an infrastructure-only when: list, or retry: 0")
    if "when" not in r:
        if r.get("max") == 0:
            return None
        return (f"{where}: retry mapping has no when:, so GitLab retries every failure class "
                "(script_failure included); add an infrastructure-only when: list")
    when = r["when"]
    whens = [when] if isinstance(when, str) else when
    if not isinstance(whens, list) or not whens or not all(isinstance(w, str) for w in whens):
        return f"{where}: retry when: {when!r} is not a non-empty list of failure classes"
    bad = sorted(set(whens) & FORBIDDEN)
    if bad:
        names = ", ".join(bad)  # outside the f-string: Python 3.11 (alpine 3.19) forbids reused quotes
        return f"{where}: retry when: includes a script-failure class: {names}"
    return None


try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = yaml.load(fh, Loader=Loader)  # noqa: S506 - SafeLoader subclass
except (OSError, yaml.YAMLError) as exc:
    print(f"ERROR: cannot parse {sys.argv[1]}: {exc}", file=sys.stderr)
    sys.exit(3)
if not isinstance(data, dict):
    print("FAIL: CI file is not a mapping", file=sys.stderr)
    sys.exit(1)
fails = []
default = data.get("default")
dretry = default.get("retry") if isinstance(default, dict) else None
if not isinstance(dretry, dict) or "when" not in dretry:
    fails.append("default: needs a retry mapping with an infrastructure-only when: list "
                 "(without one, a job that sets no retry: inherits none, or GitLab retries everything)")
for name, job in data.items():
    if isinstance(job, dict) and "retry" in job:
        p = problem(str(name), job["retry"])
        if p:
            fails.append(p)
for f in fails:
    print(f"FAIL: {f}", file=sys.stderr)
sys.exit(1 if fails else 0)
'

find_python() {
  local py
  for py in "${PYTHON:-}" python3 "$ROOT/backend/.venv/bin/python"; do
    [ -n "$py" ] && command -v "$py" >/dev/null 2>&1 && "$py" -c 'import yaml' 2>/dev/null && { echo "$py"; return 0; }
  done
  echo "ERROR: check-ci-retry.sh needs a Python with PyYAML (set PYTHON, or apk add py3-yaml)" >&2
  return 3
}

check() {
  local py
  [ -f "$1" ] || { echo "ERROR: CI file not found: $1" >&2; return 3; }
  py="$(find_python)" || return 3
  "$py" -c "$CHECK_PY" "$1" || return $?
  echo "OK: no retry: in $(basename "$1") can retry a script failure."
}

self_test() {
  local tmp rc=0 d f n=0
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  d='default:\n  retry:\n    max: 2\n    when:\n      - runner_system_failure\n      - api_failure\n'
  # expect <ok|fail> <description> <printf-format fixture>
  expect() {
    n=$((n + 1)); f="$tmp/f$n.yml"
    # shellcheck disable=SC2059  # the fixture is the format
    printf "$3" >"$f"
    check "$f" >/dev/null 2>&1; local got=$?
    if [ "$1" = ok ] && [ $got -ne 0 ]; then echo "self-test FAILED: $2 rejected (rc=$got)" >&2; rc=1; fi
    if [ "$1" = fail ] && [ $got -ne 1 ]; then echo "self-test FAILED: $2 not caught (rc=$got)" >&2; rc=1; fi
  }
  expect ok   "safe default + retry: 0"               "${d}j:\n  retry: 0\n  script: [true]\n"
  expect ok   "unrelated script_failure mention"      "${d}j:\n  script:\n    - echo script_failure always\n"
  expect ok   "alias to an infra-only mapping"        "${d}.r: &r\n  max: 2\n  when: [api_failure]\nj:\n  retry: *r\n"
  expect ok   "!reference outside retry"              "${d}j:\n  script: !reference [.x, script]\n"
  expect ok   "retry: {max: 0}"                       "${d}j:\n  retry: {max: 0}\n"
  expect fail "block when: script_failure in default" 'default:\n  retry:\n    max: 2\n    when:\n      - script_failure\n'
  expect fail "inline unknown_failure"                "${d}j:\n  retry: { max: 2, when: [unknown_failure] }\n"
  expect fail "when: always"                          "${d}j:\n  retry:\n    max: 1\n    when: always\n"
  expect fail "retry: 2 (no when:)"                   "${d}j:\n  retry: 2\n"
  expect fail "inline retry: {max: 2} (no when:)"     "${d}j:\n  retry: {max: 2}\n"
  expect fail "block retry with only max:"            "${d}j:\n  retry:\n    max: 2\n"
  expect fail "retry: *alias to script_failure"       "${d}.r: &r\n  max: 2\n  when: [script_failure]\nj:\n  retry: *r\n"
  expect fail "retry via <<: merge of a bad template" "${d}.t: &t\n  retry: 1\nj:\n  <<: *t\n  script: [true]\n"
  expect fail "retry: !reference (unresolvable)"      "${d}j:\n  retry: !reference [.x, retry]\n"
  expect fail "empty when: list"                      "${d}j:\n  retry:\n    max: 1\n    when: []\n"
  expect fail "default with retry but no when:"       'default:\n  retry:\n    max: 2\nj:\n  retry: 0\n'
  expect fail "default with retry: 2"                 'default:\n  retry: 2\n'
  expect fail "no default retry at all"               'j:\n  script: [true]\n'
  check "$ROOT/.gitlab-ci.yml" >/dev/null 2>&1 || { echo "self-test FAILED: the real .gitlab-ci.yml is rejected" >&2; rc=1; }
  [ $rc -eq 0 ] && echo "self-test OK"
  return $rc
}

CI_FILE="$ROOT/.gitlab-ci.yml"
case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --ci-file) CI_FILE="${2:?}" ;;
  "") ;;
  *) echo "usage: $0 [--ci-file F] | --self-test" >&2; exit 3 ;;
esac
check "$CI_FILE"
