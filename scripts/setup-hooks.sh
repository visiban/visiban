#!/usr/bin/env bash
# scripts/setup-hooks.sh — installs Visiban's git hooks (#1096).
#
# Usage:
#   scripts/setup-hooks.sh
#
# Installs a pre-push hook that runs scripts/check-issue-collision.sh before every
# push — see that script for what it checks and how to override it.
#
# Hooks live in the git COMMON dir (`git rev-parse --git-common-dir`), which every
# worktree of this repo shares — so this only needs to run once per clone, not once
# per `scripts/wt new` worktree. Idempotent: re-running reinstalls a hook this
# script manages (identified by its `managed-by` marker line) without prompting,
# and refuses to clobber a pre-existing pre-push hook it does not recognize.

set -euo pipefail

if [[ -t 1 ]]; then
  C_RED='\033[31m'; C_YELLOW='\033[33m'; C_GREEN='\033[32m'; C_OFF='\033[0m'
else
  C_RED=''; C_YELLOW=''; C_GREEN=''; C_OFF=''
fi

err()  { printf "${C_RED}setup-hooks: %s${C_OFF}\n" "$*" >&2; }
warn() { printf "${C_YELLOW}setup-hooks: %s${C_OFF}\n" "$*" >&2; }
ok()   { printf "${C_GREEN}setup-hooks: %s${C_OFF}\n" "$*"; }
die()  { err "$*"; exit 1; }

MARKER="# managed-by: visiban-setup-hooks"

GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)" || die "not in a git repo"
case "$GIT_COMMON_DIR" in
  /*) : ;;
  *)  GIT_COMMON_DIR="$(pwd)/$GIT_COMMON_DIR" ;;
esac
HOOKS_DIR="$GIT_COMMON_DIR/hooks"
HOOK_PATH="$HOOKS_DIR/pre-push"

install_hook() {
  mkdir -p "$HOOKS_DIR"
  cat > "$HOOK_PATH" <<HOOK
#!/usr/bin/env bash
$MARKER
# Installed by scripts/setup-hooks.sh. Runs scripts/check-issue-collision.sh (#1096)
# before every push. Safe to delete; re-run scripts/setup-hooks.sh to reinstall.
# Override a detected collision with: ALLOW_ISSUE_COLLISION=1 git push ...
set -euo pipefail

here="\$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "\$here" && -x "\$here/scripts/check-issue-collision.sh" ]]; then
  "\$here/scripts/check-issue-collision.sh" --hook "\$@"
else
  # This worktree's checked-out branch predates the check (or scripts/ isn't
  # executable here) — nothing to run, never block on that.
  exit 0
fi
HOOK
  chmod +x "$HOOK_PATH"
}

if [[ -e "$HOOK_PATH" ]]; then
  if [[ -f "$HOOK_PATH" ]] && grep -qF "$MARKER" "$HOOK_PATH" 2>/dev/null; then
    install_hook
    ok "pre-push hook reinstalled at $HOOK_PATH (already managed by this script)"
  else
    err "$HOOK_PATH already exists and is not managed by this script — leaving it alone."
    warn "back it up and re-run, or manually chain it: add this line to your existing hook:"
    warn "  \"\$(git rev-parse --show-toplevel)/scripts/check-issue-collision.sh\" --hook \"\$@\""
    exit 1
  fi
else
  install_hook
  ok "installed pre-push hook at $HOOK_PATH"
fi

ok "hooks apply to every worktree of this repo (hooks live in the shared git common dir)"
