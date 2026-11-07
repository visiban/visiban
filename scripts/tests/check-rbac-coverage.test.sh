#!/usr/bin/env bash
# scripts/tests/check-rbac-coverage.test.sh
#
# Unit test for scripts/check-rbac-coverage.py — the gate that asserts every
# board/group-scoped endpoint carries its authentication gate, its membership
# check and its minimum-role check (#1143).
#
# The script's own --self-test already proves each *detector* fires against
# known-bad fixtures, and CI runs it immediately before the real invocation.
# This file covers the layer --self-test cannot: the command-line surface and
# the four exit codes CI branches on. Those four are the whole contract, and
# three of them are easy to conflate:
#
#   0  clean
#   1  findings — the gate failed on real code
#   2  could not run — fails closed; must never read as 0
#   3  unhandled pattern, defer to the rbac-check agent — must never read as 0
#      either, which is the distinction this file exists to pin down
#
# Run: bash scripts/tests/check-rbac-coverage.test.sh
# CI runs this in the rbac-coverage job (#2069), so a red case fails the pipeline.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-rbac-coverage.py"

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "SKIP: no python interpreter on PATH"; exit 0; }
[ -f "$GATE" ] || { echo "FAIL: $GATE not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

run_gate() {
  set +e
  OUT="$("$PY" "$GATE" "$@" 2>&1)"
  RC=$?
  set -e
}

# copy_tree <dest> — the minimum subtree the gate reads.
copy_tree() {
  mkdir -p "$1"
  ( cd "$REPO_ROOT" && tar cf - \
      backend/boards/views backend/boards/models.py \
      backend/groups/views.py backend/git_lens/views.py backend/webhooks/views.py \
  ) | ( cd "$1" && tar xf - )
}

# --- --self-test passes on its own fixtures -------------------------------
# If this goes red the detectors have stopped detecting, and every green tick
# the real invocation produced since is meaningless.
run_gate --self-test
check "--self-test exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "--self-test reports every case passing" \
  "$(echo "$OUT" | grep -q "all .* cases passed" && echo 0 || echo 1)"

# --- the real repository is clean ------------------------------------------
run_gate --root "$REPO_ROOT"
# Name the handler when run by hand. Every later case copies this tree, so a real
# gap also fails those cases, and their count alone says nothing about where it is.
[ "$RC" -eq 0 ] || echo "$OUT"
check "this checkout carries its RBAC gates (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "clean run says so" \
  "$(echo "$OUT" | grep -q "carry their RBAC gates" && echo 0 || echo 1)"
check "clean run prints a tally" \
  "$(echo "$OUT" | grep -q "view class(es)" && echo 0 || echo 1)"

# --- fail closed: --root pointing at a tree with no backend ---------------
# Exit 2, NOT 0. "I could not look" must never read as "I looked and it was
# fine" — that is exactly how a gate rots into decoration.
mkdir -p "$TMP/empty"
run_gate --root "$TMP/empty"
check "missing backend tree fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"
check "missing backend tree says why" \
  "$(echo "$OUT" | grep -q "cannot run" && echo 0 || echo 1)"

# --- fail closed: a source file that does not parse -----------------------
copy_tree "$TMP/broken"
printf 'class Oops(:\n' >> "$TMP/broken/backend/boards/views/labels.py"
run_gate --root "$TMP/broken"
check "unparseable source fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- findings exit 1 ------------------------------------------------------
# Strip the admin role gate out of LabelViewSet.perform_destroy. The membership
# resolution stays, so this isolates the minimum-role detector.
copy_tree "$TMP/drift"
"$PY" - "$TMP/drift/backend/boards/views/labels.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().splitlines(keepends=True)
gate = "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
deny = "            raise PermissionDenied\n"
# The last of the three identical gates in this file belongs to
# perform_destroy; drop only that one so the other two actions stay clean and
# the finding is unambiguous.
idx = max(i for i, l in enumerate(lines) if l == gate)
assert lines[idx + 1] == deny, "fixture drift: labels.py gate shape changed"
del lines[idx:idx + 2]
p.write_text("".join(lines))
PY
run_gate --root "$TMP/drift"
check "a write action with no role gate is a finding (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "the finding names the handler" \
  "$(echo "$OUT" | grep -q "LabelViewSet::destroy" && echo 0 || echo 1)"
check "the finding names the missing check" \
  "$(echo "$OUT" | grep -q "no minimum-role check" && echo 0 || echo 1)"

# --- a non-role require_* helper is not a gate (#2069) ---------------------
# Strip the role gate from ColumnViewSet.reorder and leave its body parse alone.
# require_json_object is not authorization, but the old `require_` name match
# counted it as a role gate, so this write passed with exit 0.
copy_tree "$TMP/nonrole"
"$PY" - "$TMP/nonrole/backend/boards/views/columns.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
gate = "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n            raise PermissionDenied\n"
parse = '        order = require_json_object(request).get("order", [])'
at = text.find(parse)
assert at != -1, "fixture drift: ColumnViewSet.reorder no longer parses with require_json_object"
start = text.rfind(gate, 0, at)
assert start != -1, "fixture drift: columns.py reorder gate shape changed"
p.write_text(text[:start] + text[start + len(gate):])
PY
run_gate --root "$TMP/nonrole"
check "a write whose only require_* call is a body parse is a finding (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "that finding names the handler" \
  "$(echo "$OUT" | grep -q "ColumnViewSet::@action reorder" && echo 0 || echo 1)"
check "that finding names the missing check" \
  "$(echo "$OUT" | grep -q "no minimum-role check" && echo 0 || echo 1)"

# --- gates the old checker read past on real handlers (#2069) -------------
# strip_gate <file> <anchor> <line>: drop the first copy of <line> after <anchor>.
strip_gate() {
  "$PY" - "$@" <<'PY'
import pathlib, sys
path, anchor, line = sys.argv[1:4]
p = pathlib.Path(path)
text = p.read_text()
line += "\n"
assert anchor in text, f"fixture drift: {anchor} is gone"
at = text.find(line, text.index(anchor))
assert at != -1, f"fixture drift: no gate after {anchor}"
p.write_text(text[:at] + text[at + len(line):])
PY
}
ADMIN_GATE="        _require_group_admin(request.user, group)"

# The _require_group_member check earlier in this handler proves membership only.
# Exit 3, not 1: the handler's GET branch also calls board_access_q, which this
# checker cannot read. Either way it must not read as a pass.
copy_tree "$TMP/member"
strip_gate "$TMP/member/backend/groups/views.py" "    def boards(self, request" "$ADMIN_GATE"
# The in-transaction re-check (#2115) re-runs the same admin gate, so a fixture
# that kept it would still hold the role check; membership alone drops both.
strip_gate "$TMP/member/backend/groups/views.py" "    def boards(self, request" \
  "            require_group_admin_reread(request.user, group)"
run_gate --root "$TMP/member"
check "group membership alone does not satisfy the role check (exit 3)" \
  "$([ "$RC" -eq 3 ] && echo 0 || echo 1)"
check "that defer names the handler" \
  "$(echo "$OUT" | grep -q "GroupViewSet::@action boards \[post\]: no role gate found" && echo 0 || echo 1)"

# group_labels has no such call, so the same strip is a plain finding.
copy_tree "$TMP/labels"
strip_gate "$TMP/labels/backend/groups/views.py" "    def group_labels(self, request" "$ADMIN_GATE"
run_gate --root "$TMP/labels"
check "group membership alone fails group_labels too (not exit 0)" \
  "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "that result names the handler" \
  "$(echo "$OUT" | grep -q "GroupViewSet::@action group_labels" && echo 0 || echo 1)"

# GroupInviteLink.generate(role=...) stores the link's role; it checks nobody.
copy_tree "$TMP/mint"
strip_gate "$TMP/mint/backend/groups/views.py" "    def invite_links(self, request" "$ADMIN_GATE"
run_gate --root "$TMP/mint"
check "role= on an invite-link mint is not a hand-off (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "that finding names the handler" \
  "$(echo "$OUT" | grep -q "GroupViewSet::@action invite_links \[post\]: no minimum-role check" && echo 0 || echo 1)"

# An emptied helper is judged on its body, and BoardInviteLinksMixin is scanned.
copy_tree "$TMP/mixin"
strip_gate "$TMP/mixin/backend/boards/views/invites.py" "def _require_board_admin(pk, user):" \
  "    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):"
strip_gate "$TMP/mixin/backend/boards/views/invites.py" "def _require_board_admin(pk, user):" \
  '        raise PermissionDenied("You must be a board admin to manage invites.")'
run_gate --root "$TMP/mixin"
check "an emptied role helper fails a mixin's write (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "that finding names the mixin" \
  "$(echo "$OUT" | grep -q "BoardInviteLinksMixin::@action invite_links" && echo 0 || echo 1)"

# --- defers exit 3, distinct from both 0 and 1 ---------------------------
# A permission_classes value the checker cannot read must hand the view to the
# rbac-check agent, not wave it through.
copy_tree "$TMP/defer"
"$PY" - "$TMP/defer/backend/git_lens/views.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
# Anchored to the class, not to the first occurrence: two views in this file
# carry the identical permission_classes line, and a bare replace(…, 1) would
# silently start exercising the other one if their order ever changed.
anchor = "class LensConnectionView(APIView):"
needle = "    permission_classes = _BOARD_PERMISSIONS"
assert anchor in text, "fixture drift: LensConnectionView is gone"
at = text.index(needle, text.index(anchor))
p.write_text(
    text[:at] + "    permission_classes = build_permissions()" + text[at + len(needle):]
)
PY
run_gate --root "$TMP/defer"
check "an unclassifiable view defers (exit 3), not passes" \
  "$([ "$RC" -eq 3 ] && echo 0 || echo 1)"
check "the defer names the agent to run" \
  "$(echo "$OUT" | grep -q "rbac-check" && echo 0 || echo 1)"
check "the defer says it is not a pass" \
  "$(echo "$OUT" | grep -q "not a pass" && echo 0 || echo 1)"

# --- unknown flag is a usage error, not a pass ----------------------------
run_gate --no-such-flag
check "unknown flag does not exit 0" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"

echo ""
if [ "$fail" -eq 0 ]; then
  echo "check-rbac-coverage.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-rbac-coverage.test.sh: $fail failed, $pass passed"
  exit 1
fi
