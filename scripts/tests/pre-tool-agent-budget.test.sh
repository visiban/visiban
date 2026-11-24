#!/usr/bin/env bash
# scripts/tests/pre-tool-agent-budget.test.sh — the /wave implementer's lifetime tool-call total
# (macrodream/blueprint#352): .claude/hooks/pre-tool-agent-budget.sh and its reader,
# scripts/wave-agent-budget.py.
#
# The hook is called directly with a synthetic event, as Claude Code would call it. This does
# not run Claude Code: what the harness does with the hook's output (the call blocked, the
# subagent alone stopped, agent_id stable across a resume) rests on the 2026-11-04 probe in
# docs/development/wave-budget-stop.md § A total across runs. The settings.json registration is
# held by the wiring check at the end (this repo has no load-bearing.declarations).
# Ported from macrodream/blueprint#352 (#2564). Run: bash scripts/tests/pre-tool-agent-budget.test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/.claude/hooks/pre-tool-agent-budget.sh"
READER="$ROOT/scripts/wave-agent-budget.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
check() { # <label> <0 = pass>
  if [[ "$2" -eq 0 ]]; then echo "OK: $1"
  else echo "FAILED: $1" >&2; fail=1; fi
}
ok() { if "$@"; then echo 0; else echo 1; fi; }

REPO="$TMP/repo"
git init -q "$REPO"
STORE="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/wave-agent-budget"
export CLAUDE_PROJECT_DIR="$REPO"
unset WAVE_AGENT_TOOL_CAP

# event <agent_type> <agent_id> — a PreToolUse event for a Bash call from that agent.
event() {
  printf '{"session_id":"s","hook_event_name":"PreToolUse","cwd":"%s","tool_name":"Bash","tool_input":{"command":"echo hi"},"agent_type":"%s","agent_id":"%s"}' \
    "$REPO" "$1" "$2"
}
run() { printf '%s' "$1" | bash "$HOOK"; }
# Both are called through ok(), which shellcheck cannot follow.
# shellcheck disable=SC2329
denied() { grep -q '"permissionDecision": "deny"' <<<"$1"; }
# shellcheck disable=SC2329
stops() { grep -q '"continue": false' <<<"$1"; }
count_of() { cat "$STORE/$1.count" 2>/dev/null || echo none; }

# 1. Main thread: no agent_id, no agent_type, even with a worker name in the tool input.
out="$(run '{"hook_event_name":"PreToolUse","cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"grep wave-worker x"}}')"; rc=$?
check "main thread: exit 0, no output" "$(ok test "$rc" -eq 0 -a -z "$out")"
check "main thread: no store written" "$(ok test ! -e "$STORE")"

# 2. Another agent type is untouched, however many calls it makes.
for _ in 1 2 3; do out="$(run "$(event completeness-check a1)")"; done
check "completeness-check: untouched" "$(ok test -z "$out" -a ! -e "$STORE/a1.count")"
out="$(run "$(event Explore wave-worker)")"
check "an agent_id that merely reads like a worker type: untouched" "$(ok test -z "$out")"

# 3. The count increments and persists across invocations: a resume is the same agent_id.
for _ in 1 2 3; do out="$(run "$(event wave-worker w1)")"; done
check "wave-worker: three calls allowed with no output" "$(ok test -z "$out")"
check "wave-worker: count persists to 3" "$(ok test "$(count_of w1)" = 3)"
out="$(run "$(event wave-harness-worker h1)")"
check "wave-harness-worker: counted too" "$(ok test "$(count_of h1)" = 1)"

# 4. The crossing call is denied and stops the agent; the marker is written once.
export WAVE_AGENT_TOOL_CAP=4
out="$(run "$(event wave-worker w1)")"
check "call 4 of 4: allowed" "$(ok test -z "$out")"
check "reader: not stopped yet exits 1" "$( python3 "$READER" --repo "$REPO" --stopped w1 >/dev/null; [[ $? -eq 1 ]] && echo 0 || echo 1 )"
out="$(run "$(event wave-worker w1)")"
check "call 5 of 4: denied" "$(ok denied "$out")"
check "call 5 of 4: continue false (the agent stops)" "$(ok stops "$out")"
check "the output is valid JSON with a stopReason" \
  "$(ok python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["stopReason"] and d["hookSpecificOutput"]["hookEventName"]=="PreToolUse"' "$out")"
check "marker written" "$(ok test -f "$STORE/w1.stopped")"
first="$(cat "$STORE/w1.stopped")"
check "marker fields" "$(ok python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert (d["agent_id"],d["agent_type"],d["count"],d["limit"])==("w1","wave-worker",5,4) and d["stopped_at"].endswith("Z")' "$first")"
out="$(run "$(event wave-worker w1)")"
check "a resume past the limit: stopped again at its first call" "$(ok stops "$out")"
check "marker written once (not rewritten)" "$(ok test "$(cat "$STORE/w1.stopped")" = "$first")"
check "reader: stopped exits 0 and prints the marker's fields" \
  "$(ok python3 -c 'import json,sys; assert json.loads(sys.argv[1])==json.loads(sys.argv[2])' "$(python3 "$READER" --repo "$REPO" --stopped w1)" "$first")"
check "reader: --count" "$(ok test "$(python3 "$READER" --repo "$REPO" --count w1)" = 6)"
check "reader: --count for an unknown agent is 0" "$(ok test "$(python3 "$READER" --repo "$REPO" --count nobody)" = 0)"

# 5. The env override applies; a bad override falls back to 120.
for bad in 0 -3 abc "" 1.5 "10 " 99999999999; do
  rm -rf "$STORE"
  mkdir -p "$STORE"; printf '119\n' > "$STORE/b1.count"
  export WAVE_AGENT_TOOL_CAP="$bad"
  o120="$(run "$(event wave-worker b1)")"
  o121="$(run "$(event wave-worker b1)")"
  check "override '$bad': falls back to 120 (call 120 allowed, 121 denied)" \
    "$(ok test -z "$o120" -a -n "$o121")"
done
export WAVE_AGENT_TOOL_CAP=2
rm -rf "$STORE"
run "$(event wave-worker o1)" >/dev/null; run "$(event wave-worker o1)" >/dev/null
out="$(run "$(event wave-worker o1)")"
check "override 2: call 3 denied" "$(ok denied "$out")"
unset WAVE_AGENT_TOOL_CAP

# 6. A malformed agent_id in the worker tier is refused, and nothing is written for it.
for bad in '../x' 'a/b' '' 'a b' '.hidden'; do
  out="$(run "$(event wave-worker "$bad")")"
  check "agent_id '$bad': denied" "$(ok denied "$out")"
done
out="$(run '{"tool_name":"Bash","agent_type":"wave-worker","agent_id":7}')"
check "a non-string agent_id: denied" "$(ok denied "$out")"
out="$(run '{"tool_name":"Bash","agent_type":"wave-worker"}')"
check "a worker event with no agent_id: denied" "$(ok denied "$out")"
check "nothing written outside the store" "$(ok test ! -e "$(dirname "$STORE")/x.count")"

# 7. Unreadable events: fail closed in the worker tier, open outside it.
out="$(run '{"agent_type":"wave-worker", broken')"
check "unreadable worker event: denied" "$(ok denied "$out")"
out="$(run '{"agent_type":"wave-harness-worker", broken')"
check "unreadable harness-worker event: denied" "$(ok denied "$out")"
out="$(run 'not json at all')"; rc=$?
check "unreadable non-worker event: exit 0, no output" "$(ok test "$rc" -eq 0 -a -z "$out")"
out="$(run '{"agent_type":"\u0077ave-worker","agent_id":"u1","tool_name":"Bash"}')"
check "a \\u-escaped worker type still reaches the real check" "$(ok test "$(count_of u1)" = 1)"
printf 'junk\n' > "$STORE/j1.count"
out="$(run "$(event wave-worker j1)")"
check "a corrupt count file: denied" "$(ok denied "$out")"
NOREPO="$TMP/norepo"; mkdir -p "$NOREPO"
out="$(CLAUDE_PROJECT_DIR="$NOREPO" bash "$HOOK" <<<'{"cwd":"'"$NOREPO"'","agent_type":"wave-worker","agent_id":"n1"}')"
check "no git repository to count in: denied" "$(ok denied "$out")"
out="$(CLAUDE_PROJECT_DIR="$NOREPO" bash "$HOOK" <<<'{"cwd":"'"$REPO"'","agent_type":"wave-worker","agent_id":"c1"}')"
check "CLAUDE_PROJECT_DIR not a repo: falls back to the event cwd" "$(ok test "$(count_of c1)" = 1)"
OTHER="$TMP/other"; git init -q "$OTHER"
run '{"cwd":"'"$OTHER"'","agent_type":"wave-worker","agent_id":"m1"}' >/dev/null
check "a cwd in another repository does not move the count" "$(ok test "$(count_of m1)" = 1 -a ! -e "$OTHER/.git/wave-agent-budget")"

# 8. A symlinked count file is not followed.
ln -s "$TMP/target" "$STORE/s1.count"
out="$(run "$(event wave-worker s1)")"
check "a symlinked count file: denied, target not written" "$(ok test -n "$out" -a ! -e "$TMP/target")"

# 8b. A lock held by someone else fails closed in seconds, inside the 10 s hook timeout.
python3 -c 'import fcntl,os,sys,time; fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT); fcntl.flock(fd,fcntl.LOCK_EX); open(sys.argv[2],"w").close(); time.sleep(8)' "$STORE/.lock" "$TMP/locked" &
HOLDER=$!
for _ in $(seq 1 100); do [[ -e "$TMP/locked" ]] && break; python3 -c 'import time; time.sleep(0.05)'; done
t0=$(date +%s)
out="$(run "$(event wave-worker l1)")"
t1=$(date +%s)
kill "$HOLDER" 2>/dev/null || true; wait "$HOLDER" 2>/dev/null || true
check "a held lock: denied" "$(ok denied "$out")"
check "a held lock: answered within 8 s ($((t1 - t0)) s)" "$(ok test $((t1 - t0)) -lt 8)"

# 8c. The reader prints parsed fields only, and follows no symlink.
printf 'secret\n' > "$TMP/secret"
ln -s "$TMP/secret" "$STORE/r1.stopped"
o="$(python3 "$READER" --repo "$REPO" --stopped r1 2>&1)" && rc=0 || rc=$?
check "reader: a symlinked marker is not followed (exit 2, nothing printed from it)" \
  "$(ok test "$rc" -eq 2 -a -n "${o##*secret*}")"
printf 'not json' > "$STORE/r2.stopped"
o="$(python3 "$READER" --repo "$REPO" --stopped r2)"
check "reader: a malformed marker still reads as stopped, without its text" \
  "$(ok test "$o" = '{"agent_id": "r2", "malformed_marker": true}')"

# 9. Concurrent invocations lose no count: 20 parallel calls, limit 15.
rm -rf "$STORE"
export WAVE_AGENT_TOOL_CAP=15
for i in $(seq 1 20); do run "$(event wave-harness-worker p1)" > "$TMP/par.$i" & done
wait
unset WAVE_AGENT_TOOL_CAP
check "20 parallel calls: count is 20" "$(ok test "$(count_of p1)" = 20)"
nden="$(cat "$TMP"/par.* | grep -c '"permissionDecision": "deny"' || true)"
check "20 parallel calls, limit 15: exactly 5 denied (got $nden)" "$(ok test "$nden" = 5)"
check "marker written once under concurrency" "$(ok python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["count"]==16' "$STORE/p1.stopped")"

# 10. Entries older than 30 days are removed on a write; fresh ones are kept.
printf '3\n' > "$STORE/old.count"; printf '{}\n' > "$STORE/old.stopped"; printf '3\n' > "$STORE/young.count"
touch -t 202001010000 "$STORE/old.count" "$STORE/old.stopped"
run "$(event wave-worker p2)" >/dev/null
check "a 30-day-old count and marker are removed" "$(ok test ! -e "$STORE/old.count" -a ! -e "$STORE/old.stopped")"
check "a fresh count is kept" "$(ok test -e "$STORE/young.count")"

# 11. The reader's usage errors exit 2.
for args in "" "--stopped" "--stopped ../x" "--bogus a" "--stopped a --stopped b"; do
  # shellcheck disable=SC2086
  python3 "$READER" --repo "$REPO" $args >/dev/null 2>&1 && rc=0 || rc=$?
  check "reader '$args': exit 2" "$(ok test "$rc" -eq 2)"
done
python3 "$READER" --repo "$NOREPO" --stopped a >/dev/null 2>&1 && rc=0 || rc=$?
check "reader outside a repository: exit 2" "$(ok test "$rc" -eq 2)"

# 12. The wiring: registered for every tool, and named by the skill's handoff.
check "settings.json registers the hook on PreToolUse matcher *" "$(ok python3 -c '
import json,sys
s=json.load(open(sys.argv[1]))
hits=[h for e in s["hooks"]["PreToolUse"] if e.get("matcher")=="*" for h in e["hooks"] if "pre-tool-agent-budget.sh" in h["command"]]
assert len(hits)==1' "$ROOT/.claude/settings.json")"
check "/wave reads the marker after every implementer result" \
  "$(ok grep -q 'wave-agent-budget.py --stopped' "$ROOT/.claude/skills/wave/SKILL.md")"

exit "$fail"
