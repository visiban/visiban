#!/usr/bin/env python3
"""scripts/check-help-link-anchors.py: in-app help topic -> docs anchor gate (#2591).

The help registry (frontend/src/help/topics.ts, #2589) maps a topic key to a docs
`path` and an optional `anchor`. If a docs heading is renamed the anchor vanishes,
the app opens the right page at the top, and nobody notices. This gate fails when a
registered topic points at a page or anchor that does not exist in docs/.

Resolution is local and offline (no mkdocs build, no network): a page's anchors are
its heading slugs (python-markdown `toc` default slugify, the mkdocs default, with
the `_1`, `_2` suffix for repeated headings) plus explicit `<a id="...">` / `id="..."`
anchors. Explicit ids are the stable choice (see docs/features/concepts.md).

Reverse check (warning only, exit code unaffected): every `page.md#anchor` listed in
the Anchors table of docs/features/concepts.md must still exist.

Usage:
  scripts/check-help-link-anchors.py
  scripts/check-help-link-anchors.py --self-test

The repo root is derived from this script's location; there is no path flag.
Exit codes: 0 = clean, 1 = unresolved registry anchor (or self-test failure),
2 = bad usage.
"""
from __future__ import annotations

import contextlib
import io
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

REGISTRY = "frontend/src/help/topics.ts"
CONCEPTS = "docs/features/concepts.md"


def slugify(text: str) -> str:
    """python-markdown toc.slugify (the mkdocs default)."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[-\s]+", "-", text)


def page_anchors(md: str) -> set[str]:
    """Heading slugs and explicit ids of one markdown page (fenced code skipped)."""
    anchors: set[str] = set()
    seen: dict[str, int] = {}
    in_fence = False
    for line in md.splitlines():
        if re.match(r"^\s*(```|~~~)", line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            title = re.sub(r"<[^>]+>|`|\*|\[([^\]]*)\]\([^)]*\)", lambda x: x.group(1) or "", m.group(1))
            slug = slugify(title)
            n = seen.get(slug, 0)
            seen[slug] = n + 1
            anchors.add(slug if n == 0 else f"{slug}_{n}")
        for ident in re.findall(r"""\bid=["']([^"']+)["']""", line):
            anchors.add(ident)
    return anchors


def parse_registry(ts: str) -> dict[str, dict[str, str]]:
    """Read `key: { path: "...", anchor: "..." }` entries from HELP_TOPICS.

    Entries are split at each two-space-indented `key: {` (any quote style, inline or
    multi-line); an entry with no parseable `path` is kept with an empty path so the
    caller fails on it instead of silently skipping it.
    """
    start = ts.find("HELP_TOPICS")
    body = ts[start:] if start >= 0 else ts
    heads = list(re.finditer(r"""^ {2}(?:["'`]([\w.-]+)["'`]|([\w.-]+)):\s*\{""", body, re.M))
    topics: dict[str, dict[str, str]] = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(body)
        chunk = body[m.end():end]
        fields = dict(re.findall(r"""\b(path|anchor):\s*["'`]([^"'`]*)["'`]""", chunk))
        fields.setdefault("path", "\0unparsed")
        topics[m.group(1) or m.group(2)] = fields
    return topics


def load_page(root: Path, rel: str, cache: dict[str, set[str] | None]) -> set[str] | None:
    if rel not in cache:
        f = root / "docs" / rel
        cache[rel] = page_anchors(f.read_text(encoding="utf-8")) if f.is_file() else None
    return cache[rel]


def docs_file_for(path: str) -> str:
    """mkdocs directory URL `features/x/` -> `features/x.md` (index.md for the root)."""
    p = path.strip("/")
    return f"{p}.md" if p else "index.md"


def check(root: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    reg = root / REGISTRY
    if not reg.is_file():
        return [f"registry not found: {REGISTRY}"], []
    topics = parse_registry(reg.read_text(encoding="utf-8"))
    if not topics:
        return [f"no topics parsed from {REGISTRY} (registry format changed?)"], []
    cache: dict[str, set[str] | None] = {}
    for key, t in topics.items():
        if t["path"] == "\0unparsed":
            errors.append(f"help topic '{key}': no parseable path in {REGISTRY} (use a plain string literal)")
            continue
        rel = docs_file_for(t["path"])
        anchors = load_page(root, rel, cache)
        if anchors is None:
            alt = load_page(root, rel[:-3] + "/index.md", cache)
            if alt is not None:
                anchors, rel = alt, rel[:-3] + "/index.md"
        if anchors is None:
            errors.append(f"help topic '{key}': page docs/{rel} (path '{t['path']}') does not exist")
        elif t.get("anchor") and t["anchor"] not in anchors:
            errors.append(
                f"help topic '{key}': anchor '#{t['anchor']}' not found in docs/{rel} (path '{t['path']}')"
            )
    concepts = root / CONCEPTS
    if concepts.is_file():
        base = concepts.parent
        for page, anchor in sorted(set(re.findall(r"`([\w./-]+\.md)#([\w-]+)`", concepts.read_text(encoding="utf-8")))):
            f = base / page
            found = page_anchors(f.read_text(encoding="utf-8")) if f.is_file() else set()
            if anchor not in found:
                warnings.append(f"{CONCEPTS} lists '{page}#{anchor}' but it no longer exists")
    return errors, warnings


def print_warnings(warnings: list[str]) -> None:
    """Block of GitLab-friendly WARNING: lines at the very end of the log."""
    if not warnings:
        return
    print("")
    for w in warnings:
        print(f"WARNING: {w}")
    print(f"WARNING: {len(warnings)} stale Concepts anchor(s) (warning only, exit code unaffected).")


def main_check(root: Path) -> int:
    errors, warnings = check(root)
    for e in errors:
        print(f"FAIL: {e}", file=sys.stderr)
    if errors:
        print(f"{len(errors)} unresolved help link(s). Fix the docs anchor or the registry entry.", file=sys.stderr)
        print_warnings(warnings)
        return 1
    print("OK: every registered help topic resolves to a docs page and anchor.")
    print_warnings(warnings)
    return 0


def self_test() -> int:
    registry = (
        'export const HELP_TOPICS = {\n'
        '  home: {\n    path: "",\n    summary: "x",\n  },\n'
        '  "a.good": {\n    path: "features/a/",\n    anchor: "real-heading",\n  },\n'
        '  "a.explicit": {\n    path: "features/a/",\n    anchor: "my-id",\n  },\n'
        '  "a.dup": {\n    path: "features/a/",\n    anchor: "again_1",\n  },\n'
        '} as const;\n'
    )
    page = "# Title\n\n## Real heading\n\n<a id=\"my-id\"></a>\n\n## Again\n\n## Again\n\n```\n## not-a-heading\n```\n"
    fails = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "frontend/src/help").mkdir(parents=True)
        (root / "docs/features").mkdir(parents=True)
        (root / "docs/index.md").write_text("# Home\n")
        (root / "docs/features/a.md").write_text(page)
        (root / REGISTRY).write_text(registry)
        errs, _ = check(root)
        if errs:
            fails.append(f"clean fixture reported errors: {errs}")
        # Negative: missing anchor must name key, path and anchor.
        (root / REGISTRY).write_text(registry.replace("real-heading", "renamed-away"))
        errs, _ = check(root)
        text = "\n".join(errs)
        if not (errs and "a.good" in text and "features/a/" in text and "renamed-away" in text):
            fails.append(f"missing anchor not reported with key+path+anchor: {errs}")
        # Negative: missing page.
        (root / REGISTRY).write_text(registry.replace("features/a/", "features/gone/", 1))
        errs, _ = check(root)
        if not any("a.good" in e and "features/gone/" in e for e in errs):
            fails.append(f"missing page not reported: {errs}")
        # Inline entries and single quotes must parse; a path-less entry must fail.
        (root / REGISTRY).write_text(
            "export const HELP_TOPICS = {\n  a: { path: 'features/a/', anchor: 'nope' },\n"
            "  'b.c': {\n    path: \"features/a/\",\n  },\n  d: {\n    path: someVar,\n  },\n} as const;\n"
        )
        errs, _ = check(root)
        text = "\n".join(errs)
        if not ("'a'" in text and "'#nope'" in text.replace("#nope", "'#nope") and "'d'" in text and "'b.c'" not in text):
            fails.append(f"parser hardening cases wrong: {errs}")
        # Heading inside a code fence is not an anchor.
        if "not-a-heading" in page_anchors(page):
            fails.append("fenced heading counted as anchor")
        # Reverse check warns, never fails.
        (root / REGISTRY).write_text(registry)
        (root / CONCEPTS).write_text("| T | `a.md#gone-anchor` | none |\n")
        errs, warns = check(root)
        if errs or not any("gone-anchor" in w for w in warns):
            fails.append(f"reverse check wrong: errs={errs} warns={warns}")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            print_warnings(warns)
        out = buf.getvalue()
        if "WARNING: " not in out or "1 stale" not in out:
            fails.append(f"warning block wrong: {out!r}")
        # Registry that parses to nothing fails loudly.
        (root / REGISTRY).write_text("export const X = 1;\n")
        errs, _ = check(root)
        if not errs:
            fails.append("empty registry did not fail")
    # The real registry must parse to at least one topic with a non-empty path.
    real = parse_registry((Path(__file__).resolve().parent.parent / REGISTRY).read_text(encoding="utf-8"))
    if not real or any(t["path"] == "\0unparsed" for t in real.values()) or not any(t["path"] for t in real.values()):
        fails.append(f"real registry did not parse to topics with a path: {list(real)[:5]}")
    if slugify("Verifying signatures") != "verifying-signatures":
        fails.append("slugify wrong")
    for f in fails:
        print(f"SELF-TEST FAIL: {f}", file=sys.stderr)
    if not fails:
        print("self-test OK")
    return 1 if fails else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--self-test"]:
        sys.exit(self_test())
    root = Path(__file__).resolve().parent.parent
    if args:
        print(__doc__)
        sys.exit(2)
    sys.exit(main_check(root))
