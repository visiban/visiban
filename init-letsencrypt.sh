#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DEPRECATED — use init-prod.sh instead.
#
# This script is a compatibility shim that calls init-prod.sh with
# TLS_MODE=letsencrypt. It will be removed in a future release.
# ---------------------------------------------------------------------------
set -euo pipefail

echo ""
echo "  ============================================================"
echo "  WARNING: init-letsencrypt.sh is deprecated."
echo "  Use init-prod.sh instead — it supports all TLS modes."
echo "  See docs/getting-started/installation.md for details."
echo "  ============================================================"
echo ""

# Default to letsencrypt if TLS_MODE is not already set
export TLS_MODE="${TLS_MODE:-letsencrypt}"
exec "$(dirname "$0")/init-prod.sh"
