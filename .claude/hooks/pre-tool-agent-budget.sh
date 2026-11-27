#!/usr/bin/env bash
# PreToolUse hook (matcher: "*") — a lifetime tool-call total per /wave implementer
# (macrodream/blueprint#352; docs/development/wave-budget-stop.md § A total across runs).
#
# `maxTurns` bounds each implementer RUN in turns, and a resume restarts it. This hook bounds
# the implementer's whole life in the budget's own unit, tool calls: it counts every tool call
# an agent of type `wave-worker` or `wave-harness-worker` makes, keyed by `agent_id` (stable
# across a resume), and past the limit it denies that call AND stops the agent
# (`continue: false` plus `permissionDecision: "deny"`; the 2026-11-04 probe showed the first
# alone lets the crossing call run). It writes `<agent_id>.stopped` once, because the parent
# sees a hook stop as a normal finish with no NOTE: `scripts/wave-agent-budget.py --stopped`
# is how the orchestrator reads it.
#
# Limit: 120 (the implementer's 80-call budget expanded by half), or WAVE_AGENT_TOOL_CAP when
# that is a positive integer; anything else falls back to 120. Store: `wave-agent-budget/` in
# the git common dir, shared by every worktree, resolved from CLAUDE_PROJECT_DIR, so an agent
# cannot move its count by moving its cwd. The event's cwd is a fallback only for a hook run with
# CLAUDE_PROJECT_DIR unset or not a repository, and is the weaker guarantee: there, an agent that
# moves into another repository gets a fresh count. Count and marker files older than 30 days are
# removed on each write.
#
# Accepted risk: an implementer with Bash can write the common dir, so it can delete its own count
# (or the lock) on purpose. The hook still runs before every call, so that is deliberate sabotage,
# not a way past the hook; a stopped agent's marker stays for the orchestrator. A lock held past
# LOCK_WAIT seconds fails closed rather than running into the hook timeout (which would let the
# call through).
#
# Off for the main thread (no agent_id) and every other agent type: exit 0 at once. Fails
# CLOSED (a deny with the reason) for a worker-tier event it cannot read, key or count.
# Only main-thread and other-agent events skip python: the case below is a cheap pre-filter,
# and python makes the real decision for anything that might be a worker event.
set -uo pipefail
raw="$(cat)"
case "$raw" in
  *wave-worker*|*wave-harness-worker*|*'\u'*) ;;
  *) exit 0 ;;
esac
if ! command -v python3 >/dev/null 2>&1; then
  echo "pre-tool-agent-budget: python3 is required to count a /wave implementer's tool calls (fail closed)." >&2
  exit 2
fi
exec python3 -I -c '
import datetime, fcntl, json, os, re, subprocess, sys, time

WORKERS = ("wave-worker", "wave-harness-worker")
DEFAULT_CAP = 120
MAX_AGE = 30 * 86400
LOCK_WAIT = 4  # seconds; under the 10 s hook timeout in settings.json, with the 3 s git call
raw = sys.stdin.read()


def emit(reason, stop=False):
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                  "permissionDecision": "deny",
                                  "permissionDecisionReason": reason}}
    if stop:
        out = dict({"continue": False, "stopReason": reason}, **out)
    print(json.dumps(out))
    sys.exit(0)


def fail_closed(why):
    emit("pre-tool-agent-budget: " + why + " (fail closed). Commit what passes and stop; "
         "the orchestrator hands off to a fresh agent.")


try:
    e = json.loads(raw)
except Exception:
    e = None
if not isinstance(e, dict):
    # Unreadable. The pre-filter let it through because it may be a worker event.
    if any(w in raw for w in WORKERS):
        fail_closed("could not read the hook event")
    sys.exit(0)
atype = e.get("agent_type")
if not isinstance(atype, str) or atype not in WORKERS:
    sys.exit(0)

aid = e.get("agent_id")
if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", aid):
    fail_closed("this " + atype + " event has no usable agent_id")

cap = DEFAULT_CAP
env_cap = os.environ.get("WAVE_AGENT_TOOL_CAP", "")
if re.fullmatch(r"[0-9]{1,9}", env_cap) and int(env_cap) > 0:
    cap = int(env_cap)


def common_dir(where):
    if not isinstance(where, str) or not where.startswith("/") or not os.path.isdir(where):
        return None
    try:
        r = subprocess.run(["git", "-C", where, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=3)
    except Exception:
        return None
    p = r.stdout.strip()
    return p if r.returncode == 0 and p.startswith("/") and os.path.isdir(p) else None


common = common_dir(os.environ.get("CLAUDE_PROJECT_DIR", "")) or common_dir(e.get("cwd"))
if not common:
    fail_closed("no git common dir to keep the tool-call count in")

store = os.path.join(common, "wave-agent-budget")
NOFOLLOW = os.O_NOFOLLOW


def write_new(path, text, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | NOFOLLOW | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


try:
    os.makedirs(store, mode=0o700, exist_ok=True)
    if os.path.islink(store) or not os.path.isdir(store):
        fail_closed("the count store is not a plain directory")
    lock = os.open(os.path.join(store, ".lock"), os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    # Parallel tool calls in one turn fire this hook concurrently: read-increment-write under a lock.
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline:
                fail_closed("the count lock stayed busy for %d seconds" % LOCK_WAIT)
            time.sleep(0.02)
    cpath = os.path.join(store, aid + ".count")
    try:
        fd = os.open(cpath, os.O_RDONLY | NOFOLLOW)
        with os.fdopen(fd) as f:
            text = f.read().strip()
        if not re.fullmatch(r"[0-9]{1,9}", text):
            fail_closed("the count file for agent " + aid + " is not a number")
        n = int(text)
    except FileNotFoundError:
        n = 0
    n += 1
    write_new(cpath, "%d\n" % n)
    now = time.time()
    for ent in os.scandir(store):
        if ent.name.endswith((".count", ".stopped")) and ent.is_file(follow_symlinks=False):
            try:
                if now - ent.stat(follow_symlinks=False).st_mtime > MAX_AGE:
                    os.unlink(ent.path)
            except OSError:
                pass
    if n <= cap:
        sys.exit(0)
    marker = os.path.join(store, aid + ".stopped")
    if not os.path.lexists(marker):
        write_new(marker, json.dumps({
            "agent_id": aid, "agent_type": atype, "count": n, "limit": cap,
            "stopped_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }) + "\n", exclusive=True)
except SystemExit:
    raise
except Exception as exc:
    fail_closed("could not update the tool-call count (" + type(exc).__name__ + ")")

emit("pre-tool-agent-budget: agent " + aid + " (" + atype + ") passed its lifetime budget of "
     + str(cap) + " tool calls, across every run and resume (macrodream/blueprint#352). "
     "This call was blocked and the agent stops here; the orchestrator hands off to a fresh agent.",
     stop=True)
' <<<"$raw"
