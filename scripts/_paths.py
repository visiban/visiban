"""Shared path-containment helper for the CI gate scripts (#1377).

Why this exists: every gate script under ``scripts/`` opens files named on its
command line (``--input``, ``--schema``, ``--root`` ...). The callers are CI
and developers, not untrusted network input, but SonarCloud rates open
path-traversal findings (S8707) regardless, and a ``..`` or a symlink that
quietly points a reader/writer outside the tree is still a bug we want to fail
loudly. ``resolve_within`` canonicalizes first (``Path.resolve`` follows
symlinks and collapses ``..``) and only then checks containment, so a symlink
inside an allowed root that escapes it is rejected too.

Usage from a sibling script (``python scripts/x.py`` puts ``scripts/`` on
``sys.path``, so a plain import works)::

    from _paths import cli_roots, resolve_within
    text = resolve_within(cli_roots(), args.input).read_text()

Run ``python scripts/_paths.py --self-test`` for the unit checks (wired into the
``rbac-coverage`` CI job, which also satisfies the gate-selftest-parity rule).
"""

from __future__ import annotations

import os
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


class PathEscapeError(ValueError):
    """A user-supplied path resolved outside every allowed root."""


def cli_roots(*extra: str | os.PathLike) -> list[Path]:
    """Roots a CLI-supplied path may legitimately live under.

    The repo checkout (inputs and committed baselines), the current working
    directory (CI artifacts like ``nightly-load-test-results.json``), and the
    system temp dir plus ``/tmp`` (CI token files, test fixtures). Anything
    else - ``/etc``, ``~/.ssh``, a ``..`` climb out of these - is rejected.
    """
    # The temp dir and /tmp are trusted only on ephemeral, single-tenant runners
    # (CI containers, a developer's own machine). There is no ownership check, so
    # on a shared multi-user host another user could plant files there - a
    # documented limitation, not a guarantee.
    roots = [REPO_ROOT, Path(tempfile.gettempdir()), Path("/tmp"), *map(Path, extra)]
    cwd = Path.cwd().resolve()
    # A filesystem-root cwd (`/`, or a drive root) would make every path "inside".
    if len(cwd.parts) >= 2:
        roots.append(cwd)
    seen: list[Path] = []
    for r in roots:
        resolved = r.resolve()
        if resolved not in seen:
            seen.append(resolved)
    return seen


def resolve_within(roots: str | os.PathLike | Iterable[str | os.PathLike], user_path: str | os.PathLike) -> Path:
    """Return *user_path* canonicalized, or raise ``PathEscapeError``.

    *roots* is one root or an iterable of them. A relative *user_path* resolves
    against the current directory (normal CLI semantics); callers that hold a
    root-relative path should pass ``root / rel``. The path need not exist yet
    (output files), so ``resolve(strict=False)`` is used - symlinks in the
    existing prefix are still followed.
    """
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    resolved_roots = [Path(r).resolve() for r in roots]
    resolved = Path(user_path).resolve()
    if not any(resolved == r or resolved.is_relative_to(r) for r in resolved_roots):
        raise PathEscapeError(f"path escapes the allowed directories: {user_path}")
    return resolved


def self_test() -> int:
    failures: list[str] = []

    def check(name: str, ok: bool) -> None:
        if not ok:
            failures.append(name)

    def raises(roots, path) -> bool:
        try:
            resolve_within(roots, path)
        except PathEscapeError:
            return True
        return False

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp).resolve()
        root = base / "root"
        outside = base / "outside"
        root.mkdir()
        outside.mkdir()
        (root / "ok.txt").write_text("x")
        (outside / "secret.txt").write_text("y")

        check("file inside root is accepted", resolve_within(root, root / "ok.txt") == root / "ok.txt")
        check("not-yet-existing output inside root is accepted", resolve_within(root, root / "new.json") == root / "new.json")
        check("root itself is accepted", resolve_within(root, root) == root)
        check("dot-dot traversal is rejected", raises(root, root / ".." / "outside" / "secret.txt"))
        check("absolute path outside root is rejected", raises(root, outside / "secret.txt"))
        check("sibling with shared name prefix is rejected", raises(root, base / "root-evil" / "f"))

        (root / "link").symlink_to(outside, target_is_directory=True)
        check("symlink escaping the root is rejected", raises(root, root / "link" / "secret.txt"))
        (root / "filelink").symlink_to(outside / "secret.txt")
        check("file symlink escaping the root is rejected", raises(root, root / "filelink"))

        check("any-of-several roots is accepted", resolve_within([root, outside], outside / "secret.txt") == outside / "secret.txt")
        check("string root and path are accepted", resolve_within(str(root), str(root / "ok.txt")) == root / "ok.txt")
        check("cli_roots includes the repo root", REPO_ROOT.resolve() in cli_roots())
        check("cli_roots rejects /etc/passwd", raises(cli_roots(), "/etc/passwd"))
        prev = Path.cwd()
        try:
            os.chdir(Path(prev.anchor))
            check("filesystem-root cwd is not a root", raises(cli_roots(), "/etc/passwd"))
        finally:
            os.chdir(prev)

    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print("_paths self-test: ok")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    print("usage: python scripts/_paths.py --self-test", file=sys.stderr)
    sys.exit(2)
