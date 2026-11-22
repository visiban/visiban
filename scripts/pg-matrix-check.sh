#!/usr/bin/env bash
# scripts/pg-matrix-check.sh — backend checks against one PostgreSQL major (#2463).
#
# Run once per supported major by the `backend-test-pg-matrix` CI job
# (parallel: matrix: PG_MAJOR). backend-test and migration-check cover the
# default major (17); this covers the rest of the supported range documented in
# docs/administration/upgrade.md § Supported PostgreSQL versions.
#
#   1. Asserts the database it reached IS major $PG_MAJOR (server_version_num).
#      A matrix job silently testing the default image proves nothing.
#   2. Applies every migration from zero on that major, then
#      `makemigrations --check`.
#   3. Runs one pytest-split group (of PG_TEST_SPLITS, default 8). The group is
#      $PG_TEST_GROUP if set, else (CI_PIPELINE_IID mod splits) + 1, so
#      successive pipelines rotate through the whole suite on every major
#      without paying for the full ~110-minute suite three times per pipeline.
#      The log names the group; re-run it with PG_TEST_GROUP=<n>.
#
# Usage: (from the repo root, DATABASE_URL etc. set as for backend-test)
#   PG_MAJOR=16 bash scripts/pg-matrix-check.sh
#   bash scripts/pg-matrix-check.sh --self-test

set -euo pipefail

# 150004 -> 15, 180001 -> 18, 90624 -> 9 (pre-10 numbering).
major_from_version_num() {
  local n="$1"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  echo $(( n / 10000 ))
}

# pick_group <override> <pipeline_iid> <splits>
pick_group() {
  local override="$1" iid="$2" splits="$3"
  if [ -n "$override" ]; then
    case "$override" in *[!0-9]*|0) return 1 ;; esac
    [ "$override" -le "$splits" ] || return 1
    echo "$override"
    return
  fi
  case "$iid" in ''|*[!0-9]*) iid=0 ;; esac
  echo $(( iid % splits + 1 ))
}

self_test() {
  local fails=0
  check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: want '$2', got '$3'" >&2; fails=$((fails + 1)); fi; }
  echo "pg-matrix-check.sh --self-test"
  check "15.4 -> 15" 15 "$(major_from_version_num 150004)"
  check "18.1 -> 18" 18 "$(major_from_version_num 180001)"
  check "9.6 -> 9"   9  "$(major_from_version_num 90624)"
  check "garbage rejected" "" "$(major_from_version_num 'PostgreSQL 17' || true)"
  check "rotation iid 0"   1 "$(pick_group '' 0 8)"
  check "rotation iid 15"  8 "$(pick_group '' 15 8)"
  check "rotation iid 16"  1 "$(pick_group '' 16 8)"
  check "override wins"    3 "$(pick_group 3 15 8)"
  check "override > splits rejected" "" "$(pick_group 9 1 8 || true)"
  check "override 0 rejected" "" "$(pick_group 0 1 8 || true)"
  check "missing iid -> group 1" 1 "$(pick_group '' '' 8)"
  if [ "$fails" -ne 0 ]; then echo "pg-matrix-check.sh --self-test: $fails failure(s)" >&2; return 1; fi
  echo "pg-matrix-check.sh --self-test: all passed"
}

main() {
  if [ "${1:-}" = "--self-test" ]; then self_test; return; fi
  : "${PG_MAJOR:?PG_MAJOR must be set (the matrix variable)}"
  local splits="${PG_TEST_SPLITS:-8}" group num got
  group="$(pick_group "${PG_TEST_GROUP:-}" "${CI_PIPELINE_IID:-0}" "$splits")" \
    || { echo "PG_TEST_GROUP must be 1..${splits}" >&2; return 2; }

  cd backend
  num="$(python manage.py shell -c 'from django.db import connection
with connection.cursor() as c:
    c.execute("SHOW server_version_num")
    print("PGVER", c.fetchone()[0])' | awk '$1=="PGVER"{print $2}')"
  got="$(major_from_version_num "$num")" || { echo "could not read server_version_num (got '$num')" >&2; return 1; }
  if [ "$got" != "$PG_MAJOR" ]; then
    echo "FAIL: expected PostgreSQL ${PG_MAJOR}, the service is ${got} (${num}) — the matrix service image is wrong" >&2
    return 1
  fi
  echo "==> PostgreSQL ${got} (server_version_num ${num})"

  echo "==> migrate from zero on PostgreSQL ${got}"
  python manage.py migrate --noinput
  python manage.py makemigrations --check --dry-run --verbosity=1

  echo "==> pytest-split group ${group}/${splits} on PostgreSQL ${got} (re-run with PG_TEST_GROUP=${group})"
  python -m pytest \
    --splitting-algorithm least_duration \
    --durations-path .test_durations \
    --splits "$splits" --group "$group" \
    --junitxml="test-results/junit-pg${got}.xml" \
    -o faulthandler_timeout=300 \
    -v
}

main "$@"
