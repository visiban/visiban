"""Column policy shape and validation (#1101).

A column policy is the board's written "entry criteria" and "definition of
done" for one column -- the Kanban practice of making policies explicit. It
is stored as one nullable, versioned JSON object on ``Column.policy``::

    {"v": 1, "entry": ["..."], "done": ["..."], "mode": "advisory" | "confirm"}

Why one versioned JSON field rather than columns per list: the architect
review on #1101 (2026-11-01) chose it so a later shape (``"v": 2``) can be
introduced without a schema migration, while ``v`` lets every reader tell
which shape it holds. Server-enforced, dimension-based entry gates (#1923) are
a separate column field and must never be added to this object.

Nothing here is enforced on a card move. ``mode: "confirm"`` asks the web
client to have the mover tick the entry criteria before the move is sent; it
is a client-side acknowledgment, and an API or MCP move never sees it.

One validator serves every write path -- the REST serializer, the JSON board
import, board templates and the Django admin (``Column.clean``) -- so the rules
cannot drift between them.
"""

import re

POLICY_VERSION = 1
POLICY_MODES = ("advisory", "confirm")
POLICY_MAX_CRITERIA = 8
POLICY_CRITERION_MAX_LENGTH = 200
POLICY_KEYS = frozenset({"v", "entry", "done", "mode"})
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class PolicyError(ValueError):
    """A policy value that does not match the v1 shape. ``str()`` is user-facing."""


def _criteria(value, key):
    if value is None:
        return []
    if not isinstance(value, list):
        raise PolicyError(f"'{key}' must be a list of strings.")
    if len(value) > POLICY_MAX_CRITERIA:
        raise PolicyError(f"'{key}' can hold at most {POLICY_MAX_CRITERIA} criteria.")
    cleaned = []
    for i, item in enumerate(value):
        if not isinstance(item, str):
            raise PolicyError(f"'{key}' item {i} must be a string.")
        # One-line criteria: no C0 control characters or DEL. NUL in
        # particular is refused by PostgreSQL jsonb ("unsupported Unicode
        # escape sequence"), which would surface as a 500 after validation
        # passed (same class as #1184).
        if _CONTROL_CHARS.search(item):
            raise PolicyError(f"'{key}' item {i} must not contain control characters.")
        text = item.strip()
        if not text:
            raise PolicyError(f"'{key}' item {i} must not be blank.")
        if len(text) > POLICY_CRITERION_MAX_LENGTH:
            raise PolicyError(
                f"'{key}' item {i} is longer than {POLICY_CRITERION_MAX_LENGTH} characters."
            )
        cleaned.append(text)
    return cleaned


def normalize_policy(value):
    """Validate *value* and return the stored form, or ``None`` for no policy.

    Raises :class:`PolicyError` on any shape problem. A policy whose two lists
    are both empty normalizes to ``None``: "no criteria" and "no policy" are
    the same thing to every reader, and one representation keeps the client's
    "does this column have a policy" check a single null test.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise PolicyError("Policy must be an object or null.")
    unknown = set(value) - POLICY_KEYS
    if unknown:
        # Sorted and bounded so the message is stable and cannot echo an
        # arbitrarily large payload back.
        names = ", ".join(sorted(repr(k)[:40] for k in unknown)[:5])
        raise PolicyError(f"Unknown policy key(s): {names}.")
    version = value.get("v")
    # bool is an int subclass; True must not pass for 1.
    if isinstance(version, bool) or version != POLICY_VERSION:
        raise PolicyError(f"'v' must be {POLICY_VERSION}.")
    mode = value.get("mode", "advisory")
    if mode not in POLICY_MODES:
        raise PolicyError(f"'mode' must be one of: {', '.join(POLICY_MODES)}.")
    entry = _criteria(value.get("entry"), "entry")
    done = _criteria(value.get("done"), "done")
    if not entry and not done:
        return None
    return {"v": POLICY_VERSION, "entry": entry, "done": done, "mode": mode}


def policy_or_none(value):
    """Like :func:`normalize_policy`, but an invalid value yields ``None``.

    For template data, which can come from a ``TEMPLATE_PROVIDERS`` row rather
    than trusted built-in data: a malformed policy must degrade to "no policy",
    never fail board creation (same stance as ``create_template_columns``).
    """
    try:
        return normalize_policy(value)
    except PolicyError:
        return None
