#!/bin/sh
# Regenerate backend/requirements.lock from backend/requirements.txt (#1378).
#
#   scripts/lock-backend-requirements.sh            # rewrite the lock in place
#   scripts/lock-backend-requirements.sh --check    # fail if the lock is stale
#   scripts/lock-backend-requirements.sh --self-test  # network-free gate self-test
#
# Locks: requirements.txt -> requirements.lock (runtime deps) and
# requirements-build.in -> requirements-build.lock (build backend for the one
# sdist-only dependency, dj-rest-auth).
#
# The lock is hash-pinned and universal (every platform marker, so the linux
# x86_64 and aarch64 wheels both get hashes) for the Python the images use
# (python:3.12-slim). Both Dockerfiles install it with
# `--only-binary :all: --require-hashes`. uv is pinned so the output is
# byte-stable between a maintainer's machine and the CI freshness job.
set -eu

UV_VERSION="0.12.22"
PY_VERSION="3.12"

# LOCK_BACKEND_DIR exists so --self-test can run against a synthetic tree.
BACKEND_DIR="${LOCK_BACKEND_DIR:-$(dirname "$0")/../backend}"
SELF="$0"

if [ "${1:-}" = "--self-test" ]; then
  # Network-free: a stub `uv` stands in for the resolver, so this proves the
  # script's own drift detection (write / --check / bad argument) still fires,
  # not uv's resolution. #1093 house rule: a gate must prove it can fail.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir "$tmp/backend" "$tmp/bin"
  cat > "$tmp/bin/uv" <<'STUB'
#!/bin/sh
if [ "$1" = "--version" ]; then echo "uv stub"; exit 0; fi
in="$3"; out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
{ echo "# locked"; cat "$in"; } > "$out"
STUB
  chmod +x "$tmp/bin/uv"
  echo "flask==1.0" > "$tmp/backend/requirements.txt"
  echo "setuptools" > "$tmp/backend/requirements-build.in"
  run() { LOCK_BACKEND_DIR="$tmp/backend" PATH="$tmp/bin:$PATH" sh "$SELF" "$@" >/dev/null 2>&1; }
  run || { echo "self-test FAIL: lock write failed" >&2; exit 1; }
  run --check || { echo "self-test FAIL: fresh lock reported stale" >&2; exit 1; }
  echo "flask==2.0" > "$tmp/backend/requirements.txt"
  if run --check; then echo "self-test FAIL: drifted lock not detected" >&2; exit 1; fi
  if run --bogus; then echo "self-test FAIL: bad argument accepted" >&2; exit 1; fi
  echo "self-test OK"
  exit 0
fi

MODE="write"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  *) echo "usage: $0 [--check|--self-test]" >&2; exit 2 ;;
esac

cd "$BACKEND_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required: pip install --require-hashes -r scripts/uv-requirements.txt" >&2
  exit 2
fi
case "$(uv --version)" in
  "uv ${UV_VERSION}"*|"uv stub"*) ;;
  *) echo "warning: expected uv ${UV_VERSION}, got $(uv --version); output may differ" >&2 ;;
esac

stale=0
for pair in requirements.txt:requirements.lock requirements-build.in:requirements-build.lock; do
  src="${pair%%:*}"; lock="${pair##*:}"
  out="$lock"
  if [ "$MODE" = "check" ]; then
    out="$(mktemp)"
    # uv keeps the pins already present in the output file unless the input
    # forces a change, so seeding the temp file with the committed lock makes
    # the check ignore new upstream releases of unconstrained transitive deps
    # and flag only genuine drift (an input edit that was not re-locked).
    cp "$lock" "$out"
  fi
  # UV_CUSTOM_COMPILE_COMMAND keeps the header (and so the diff) independent
  # of where the output file is written.
  UV_CUSTOM_COMPILE_COMMAND="scripts/lock-backend-requirements.sh" \
    uv pip compile "$src" \
      --universal --python-version "${PY_VERSION}" \
      --generate-hashes --quiet -o "$out"
  if [ "$MODE" = "check" ]; then
    if ! diff -u "$lock" "$out"; then
      echo "backend/$lock is stale: run scripts/lock-backend-requirements.sh and commit the result." >&2
      stale=1
    fi
    rm -f "$out"
  fi
done

if [ "$MODE" = "check" ]; then
  [ "$stale" -eq 0 ] || exit 1
  echo "backend lock files are up to date."
fi
