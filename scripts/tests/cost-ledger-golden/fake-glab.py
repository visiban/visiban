#!/usr/bin/env python3
"""A fake `glab api` for the cost-ledger golden fixture: no network, state in $FAKE_GLAB_STATE.

State: {"mrs": {"<iid>": {...MR JSON...}}, "notes": {"<iid>": [note, ...]}, "next_id": N}.
Every call is appended to $FAKE_GLAB_STATE.log. A project path must be spelled out and equal
$FAKE_GLAB_PROJECT (URL-encoded): `:id` or another project exits 1, so a call that resolves its
project from the working directory fails the fixture. Handles exactly what the cost scripts call: GET user, GET an MR, GET an MR's notes, POST a note
(JSON body on stdin) and PUT a note. Anything else exits 1, like a failed request."""
import json
import os
import re
import sys

path = os.environ["FAKE_GLAB_STATE"]
with open(path, encoding="utf-8") as f:
    st = json.load(f)
argv = sys.argv[1:]
if argv[:1] != ["api"]:
    sys.exit(1)
argv = argv[1:]
method, target, has_input = "GET", None, False
i = 0
while i < len(argv):
    a = argv[i]
    if a == "-X":
        method = argv[i + 1]
        i += 2
    elif a in ("-H", "--input"):
        has_input = has_input or a == "--input"
        i += 2
    else:
        target = a
        i += 1
body = json.load(sys.stdin) if has_input else None
with open(path + ".log", "a", encoding="utf-8") as log:
    log.write("%s %s\n" % (method, target))
if target == "user":
    print(json.dumps({"id": 7, "username": "fixture-bot"}))
    sys.exit(0)
m = re.match(r"^projects/([^/]+)/merge_requests/(\d+)(?:/notes(?:/(\d+))?)?(?:\?.*)?$", target or "")
if not m or m.group(1) != os.environ.get("FAKE_GLAB_PROJECT"):
    sys.exit(1)
iid, note_id = m.group(2), m.group(3)
is_notes = "/notes" in target
if not is_notes:
    if iid not in st["mrs"]:
        sys.exit(1)
    print(json.dumps(st["mrs"][iid]))
    sys.exit(0)
notes = st["notes"].setdefault(iid, [])
if method == "GET":
    page = re.search(r"[?&]page=(\d+)", target)
    p = int(page.group(1)) if page else 1
    print(json.dumps(notes[(p - 1) * 100:p * 100]))
elif method == "POST":
    note = {"id": st["next_id"], "body": body["body"], "system": False, "author": {"id": 7, "username": "fixture-bot"}}
    st["next_id"] += 1
    notes.append(note)
    print(json.dumps(note))
elif method == "PUT" and note_id:
    hit = [n for n in notes if n["id"] == int(note_id)]
    if not hit:
        sys.exit(1)
    hit[0]["body"] = body["body"]
    print(json.dumps(hit[0]))
else:
    sys.exit(1)
with open(path, "w", encoding="utf-8") as f:
    json.dump(st, f)
