#!/bin/bash
# PostToolUse(Bash): after `glab mr create`, post the "## Cost of this MR" comment (record 1) unless
# the cost-ledger setting is off. All logic is in scripts/post-mr-cost.py (stdin passes straight
# through; do not wrap it in a heredoc, which would swallow the hook payload).
exec python3 "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/scripts/post-mr-cost.py"
