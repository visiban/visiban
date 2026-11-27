#!/usr/bin/env python3
"""scripts/check-frontend-claude-md.py: size cap for the always-loaded frontend rules (#2681).

Claude Code loads `frontend/CLAUDE.md` into context on every frontend task. It had
grown to 723 KB (about 180k tokens) before #2681 split it into a short index plus
topic files under `frontend/ui-conventions/`, which are read on demand. This gate
keeps the index short and keeps every topic section reachable from it:

  1. `frontend/CLAUDE.md` is at most MAX_BYTES (64 KiB).
  2. An index line (`- **<title>** — <summary> → `frontend/ui-conventions/<file>.md``)
     is at most MAX_INDEX_LINE characters.
  3. Every index line points at an existing topic file that has a `## <title>` section.
  4. Every `## ` section of every topic file (searched recursively; only `.md` files are
     allowed under the directory) has an index line pointing at it.
  5. Section titles are unique across the index's kept sections and all topic files, so a
     `§ <title>` citation resolves through exactly one Topic-index line.

`--lossless <old-file>` is the proof for a move (the #2681 split, or any later move
between the index and a topic file): every non-blank line of <old-file>, headings
included, must still appear at least as many times in the index plus the topic
files. Topic files sit one directory deeper than the index, so a relative link
`](../../x)` in a topic file counts as the `](../x)` it was in the index.

Usage:
  scripts/check-frontend-claude-md.py [--root <dir>] [--index <file>]
  scripts/check-frontend-claude-md.py --lossless <old-file> [--root <dir>]
  scripts/check-frontend-claude-md.py --self-test

  --root <dir>     repo root (default: one level up from this script).
  --index <file>   check this file as the index instead of <root>/frontend/CLAUDE.md
                   (e.g. a pre-split copy, to show the gate is red on it).

Exit codes: 0 = clean, 1 = violation (or self-test failure), 2 = bad usage.
"""
from __future__ import annotations

import argparse
import collections
import re
import sys
import tempfile
from pathlib import Path

from _paths import PathEscapeError, cli_roots, resolve_within

MAX_BYTES = 64 * 1024
MAX_INDEX_LINE = 300
INDEX = "frontend/CLAUDE.md"
TOPIC_DIR = "frontend/ui-conventions"

POINTER = re.compile(r"^- \*\*(?P<title>.+?)\*\* — (?P<summary>.+) → `(?P<path>[^`]+)`$")


def _confine(path: Path) -> Path:
    """Canonicalize a CLI path and refuse one outside the repo, cwd and temp dir (#1377, Sonar S8707)."""
    return resolve_within(cli_roots(), path)


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def _sections(path: Path) -> list[str]:
    """`## ` headings outside fenced code blocks."""
    out, fenced = [], False
    for line in _lines(path):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif not fenced and line.startswith("## "):
            out.append(line[3:].strip())
    return out


def check(root: Path, index: Path | None = None) -> list[str]:
    index = index or root / INDEX
    errors: list[str] = []
    size = index.stat().st_size
    if size > MAX_BYTES:
        errors.append(
            f"{index}: {size} bytes, over the {MAX_BYTES}-byte cap. Move a section to a topic "
            f"file under {TOPIC_DIR}/ and leave one index line (see the file's 'How this file works')."
        )
    pointed: set[tuple[str, str]] = set()
    for n, line in enumerate(_lines(index), 1):
        m = POINTER.match(line)
        if not m:
            continue
        title, rel = m["title"], m["path"]
        if len(line) > MAX_INDEX_LINE:
            errors.append(f"{index}:{n}: index line is {len(line)} characters, over {MAX_INDEX_LINE}; shorten the summary.")
        if not rel.startswith(TOPIC_DIR + "/"):
            errors.append(f"{index}:{n}: index line points outside {TOPIC_DIR}/: {rel}")
            continue
        target = root / rel
        if not target.is_file():
            errors.append(f"{index}:{n}: index line points at a missing file: {rel}")
            continue
        if title not in _sections(target):
            errors.append(f"{index}:{n}: {rel} has no '## {title}' section.")
        pointed.add((title, rel))
    topic_dir = root / TOPIC_DIR
    # rglob, not glob: pointers into subdirectories are accepted above and CI watches `**/*`,
    # so a section in `ui-conventions/sub/x.md` must not escape the index-line check.
    files = sorted(p for p in topic_dir.rglob("*") if p.is_file()) if topic_dir.is_dir() else []
    owners: dict[str, list[str]] = collections.defaultdict(list)
    for title in _sections(index):
        owners[title].append(INDEX)
    for topic in files:
        rel = topic.relative_to(root).as_posix()
        if topic.suffix != ".md":
            errors.append(f"{rel}: not a .md file; only .md files are allowed under {TOPIC_DIR}/ (a section in it would escape the index check).")
            continue
        for title in _sections(topic):
            owners[title].append(rel)
            if (title, rel) not in pointed:
                errors.append(f"{rel}: section '## {title}' has no index line in {INDEX}.")
    # A "§ <title>" citation must resolve through exactly one Topic-index line.
    for title, where in owners.items():
        if len(where) > 1:
            errors.append(f"duplicate section title '## {title}' in {', '.join(where)}; section titles must be unique.")
    return errors


def lossless(root: Path, old: Path) -> tuple[int, list[str]]:
    have: collections.Counter[str] = collections.Counter(_lines(root / INDEX))
    topic_dir = root / TOPIC_DIR
    for topic in sorted(topic_dir.rglob("*.md")) if topic_dir.is_dir() else []:
        have.update(line.replace("](../../", "](../") for line in _lines(topic))
    want = collections.Counter(line for line in _lines(old) if line.strip())
    missing = [line for line, count in want.items() if have[line] < count]
    return sum(want.values()), missing


def self_test() -> int:
    failures: list[str] = []

    def build(base: Path, index: str, topics: dict[str, str]) -> Path:
        (base / TOPIC_DIR).mkdir(parents=True, exist_ok=True)
        (base / INDEX).write_text(index, encoding="utf-8")
        for name, body in topics.items():
            (base / TOPIC_DIR / name).parent.mkdir(parents=True, exist_ok=True)
            (base / TOPIC_DIR / name).write_text(body, encoding="utf-8")
        return base

    good_index = (
        "# Frontend UI Conventions\n\n## Color tokens\n\n- Always use slate.\n\n## Topic index\n\n"
        f"- **Cards** — Cards are calm. → `{TOPIC_DIR}/cards.md`\n"
    )
    good_topic = {"cards.md": "# Card face\n\n## Cards\n\n- A card is calm.\n- See [spec](../../docs/x.md).\n"}
    old = "# Frontend UI Conventions\n\n## Color tokens\n\n- Always use slate.\n\n## Cards\n\n- A card is calm.\n- See [spec](../docs/x.md).\n"

    ghost_section = good_index + f"- **Ghost** — Not a section. → `{TOPIC_DIR}/cards.md`\n"
    ghost_file = good_index + f"- **Cards** — Cards again. → `{TOPIC_DIR}/gone.md`\n"
    cases = [
        ("good tree passes", good_index, good_topic, None),
        ("oversized index fails", good_index + ("x" * 80 + "\n") * (MAX_BYTES // 80 + 1), good_topic, "-byte cap"),
        ("long index line fails", good_index.replace("Cards are calm.", "c" * MAX_INDEX_LINE), good_topic, "over 300"),
        ("pointer to a missing file fails", ghost_file, good_topic, "missing file"),
        ("pointer to a missing section fails", ghost_section, good_topic, "has no '## Ghost' section"),
        ("topic section without an index line fails", good_index,
         {"cards.md": good_topic["cards.md"] + "\n## Orphan\n\n- text\n"}, "section '## Orphan' has no index line"),
        ("a fenced '## ' line is not a section", good_index,
         {"cards.md": good_topic["cards.md"] + "\n```md\n## not a heading\n```\n"}, None),
        ("a section in a subdirectory without an index line fails", good_index,
         {"cards.md": good_topic["cards.md"], "sub/x.md": "## Hidden\n\n- text\n"}, "sub/x.md: section '## Hidden' has no index line"),
        ("a non-.md file under the topic dir fails", good_index,
         {"cards.md": good_topic["cards.md"], "extra.markdown": "## Sneaky\n\n- text\n"}, "extra.markdown: not a .md file"),
        ("the same section title in two topic files fails",
         good_index + f"- **Cards** — Dup. → `{TOPIC_DIR}/more.md`\n",
         {"cards.md": good_topic["cards.md"], "more.md": "## Cards\n\n- other\n"}, "duplicate section title '## Cards'"),
        ("a title duplicated between the index and a topic file fails",
         good_index + f"- **Color tokens** — Dup. → `{TOPIC_DIR}/cards.md`\n",
         {"cards.md": good_topic["cards.md"] + "\n## Color tokens\n\n- again\n"}, "duplicate section title '## Color tokens'"),
        ("a pointer escaping the conventions dir fails",
         good_index + f"- **Cards** — Escape. → `frontend/other/cards.md`\n", good_topic, "points outside"),
        ("a moved-from note in a topic file is not a section", good_index,
         {"cards.md": good_topic["cards.md"].replace("# Card face\n", "# Card face\n\nMoved verbatim; \"above\" means the old file.\n")}, None),
    ]
    for name, index, topics, expect in cases:
        with tempfile.TemporaryDirectory() as tmp:
            errors = check(build(Path(tmp), index, topics))
        if expect is None:
            ok = not errors
        else:
            # Assert on the message, not just a non-zero result: two checks can both fire on
            # one fixture, and a case that passes via the wrong check proves nothing.
            ok = len(errors) == 1 and expect in errors[0]
        if not ok:
            failures.append(f"{name}: expected {expect or 'clean'}, got {errors}")

    lossless_cases = [
        ("verbatim move is lossless (relative link rebased)", good_topic, False, old),
        ("dropped line is caught", {"cards.md": good_topic["cards.md"].replace("- A card is calm.\n", "")}, True, old),
        ("reworded line is caught", {"cards.md": good_topic["cards.md"].replace("calm", "quiet")}, True, old),
        ("dropped heading is caught", {"cards.md": good_topic["cards.md"].replace("## Cards\n", "")}, True, old),
        ("a line the old file had twice, kept once, is caught", good_topic, True, old + "- A card is calm.\n"),
    ]
    for name, topics, expect_fail, old_text in lossless_cases:
        with tempfile.TemporaryDirectory() as tmp:
            base = build(Path(tmp), good_index, topics)
            (base / "old.md").write_text(old_text, encoding="utf-8")
            _, missing = lossless(base, base / "old.md")
        if bool(missing) != expect_fail:
            failures.append(f"lossless {name}: expected {'missing lines' if expect_fail else 'none'}, got {missing}")

    confine_cases = 0
    with tempfile.NamedTemporaryFile(suffix=".md") as inside:
        confine_cases += 1
        try:
            _confine(Path(inside.name))
        except PathEscapeError:
            failures.append("confine: a file in the temp dir was refused")
    confine_cases += 1
    try:
        _confine(Path("/etc/hostname"))
        failures.append("confine: a path outside the allowed roots was accepted")
    except PathEscapeError:
        pass

    total = len(cases) + len(lossless_cases) + confine_cases
    if failures:
        for f in failures:
            print(f"SELF-TEST FAIL: {f}", file=sys.stderr)
        return 1
    print(f"self-test: {total}/{total} cases behaved as expected")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--lossless", type=Path, metavar="OLD_FILE")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    try:
        args.root = _confine(args.root)
        args.index = _confine(args.index) if args.index else None
        args.lossless = _confine(args.lossless) if args.lossless else None
    except PathEscapeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.lossless:
        total, missing = lossless(args.root, args.lossless)
        for line in missing[:20]:
            print(f"MISSING: {line[:160]}", file=sys.stderr)
        print(f"lossless: {total} non-blank lines of {args.lossless} checked, {len(missing)} distinct lines missing")
        return 1 if missing else 0
    errors = check(args.root, args.index)
    index = args.index or args.root / INDEX
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    print(f"{index}: {index.stat().st_size} bytes (cap {MAX_BYTES}); {len(errors)} violation(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
