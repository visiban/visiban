#!/usr/bin/env bash
# scripts/gitleaks-precommit.sh — block hardcoded secrets in staged changes.
#
# gitleaks is "optional but recommended" locally. If it is not installed we
# warn and pass, because the merge-blocking gitleaks-scan CI job is the hard
# gate. When gitleaks IS installed we enforce it here so leaks are caught at
# the earliest possible point — before they enter a commit.
#
# Config is auto-discovered from .gitleaks.toml at the repo root.
set -euo pipefail

if ! command -v gitleaks &>/dev/null; then
  echo "gitleaks not installed — skipping local secret scan (CI still enforces it)."
  echo "  Install: brew install gitleaks  (or https://github.com/gitleaks/gitleaks/releases)"
  exit 0
fi

exec gitleaks git --staged --redact --no-banner
