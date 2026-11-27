#!/usr/bin/env python3
"""Read the /wave implementer lifetime tool-call budget (macrodream/blueprint#352).

`.claude/hooks/pre-tool-agent-budget.sh` counts every tool call a `wave-worker` or
`wave-harness-worker` makes, keyed by its agent ID, in `wave-agent-budget/` under the git
common dir, and past the limit denies the call, stops the agent and writes
`<agent_id>.stopped`. The parent sees that stop as a normal `completed` finish with no NOTE, so
`/wave` runs this after every implementer result (Step 4, *Handoff at a stop*).

Usage:  python3 scripts/wave-agent-budget.py --stopped <agent_id> [--repo <dir>]
        python3 scripts/wave-agent-budget.py --count <agent_id> [--repo <dir>]
Exit:   --stopped: 0 stopped (prints the marker JSON) - 1 not stopped
        --count:   0 (prints the count so far, 0 when none)
        2 usage error, a malformed agent ID, or no git repository
"""
import json
import os
import re
import subprocess
import sys

ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")


def usage(msg):
    print("wave-agent-budget: " + msg, file=sys.stderr)
    print(__doc__.split("\n\n", 1)[1].strip(), file=sys.stderr)
    sys.exit(2)


def store_dir(repo):
    try:
        r = subprocess.run(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    p = r.stdout.strip()
    return os.path.join(p, "wave-agent-budget") if r.returncode == 0 and p.startswith("/") else None


def main(argv):
    mode, aid, repo = None, None, os.getcwd()
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--stopped", "--count") and i + 1 < len(argv) and mode is None:
            mode, aid = a, argv[i + 1]
            i += 2
        elif a == "--repo" and i + 1 < len(argv):
            repo = argv[i + 1]
            i += 2
        else:
            usage("unexpected argument %r" % a)
    if mode is None:
        usage("give --stopped <agent_id> or --count <agent_id>")
    if not ID_RE.fullmatch(aid):
        usage("malformed agent ID %r (expected [A-Za-z0-9_-]+)" % aid)
    store = store_dir(repo)
    if store is None:
        usage("%s is not inside a git repository" % repo)
    name = aid + (".count" if mode == "--count" else ".stopped")
    try:
        # O_NOFOLLOW: an agent can write the store, so a symlink planted there is not followed
        # into a file the orchestrator would then print into its own context.
        fd = os.open(os.path.join(store, name), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            text = f.read(4096)
    except FileNotFoundError:
        if mode == "--count":
            print("0")
            return 0
        return 1
    except OSError as exc:
        usage("cannot read %s (%s)" % (name, type(exc).__name__))
    if mode == "--count":
        if not re.fullmatch(r"[0-9]{1,9}", text.strip()):
            usage("the count file for %s is not a number" % aid)
        print(text.strip())
        return 0
    # Print the parsed fields only, never the raw file: it is agent-writable.
    try:
        d = json.loads(text)
    except ValueError:
        d = None
    if not isinstance(d, dict):
        print(json.dumps({"agent_id": aid, "malformed_marker": True}))
        return 0
    keep = {k: d.get(k) for k in ("agent_id", "agent_type", "count", "limit", "stopped_at")
            if isinstance(d.get(k), (str, int)) and not isinstance(d.get(k), bool)}
    print(json.dumps(keep))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
