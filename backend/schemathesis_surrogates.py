"""Lone-surrogate injection for the `backend-schema-fuzz` jobs (#2121).

Imported by `schemathesis_hooks.py` (which `st run` loads via SCHEMATHESIS_HOOKS) and
kept in its own module with no Django import, so the negative control in
`boards/tests/test_schemathesis_surrogates.py` can load it against a stub server.

## Why a hook and not `--generation-codec`

schemathesis 4.27.1 defaults to `codec="utf-8"`, so no generated string ever holds a lone
surrogate (U+D800..U+DFFF), and that is how the 500 fixed in #2085 went unseen. Clearing the
codec does not help: it falls through to hypothesis's `characters()`, which excludes the
surrogate category by default. Only a post-generation mutation can put one on the wire.

## Behavior

`map_body` runs on every generated body. For about one body in `_ONE_IN` that carries at
least one string and is declared JSON-only, it replaces the last character of one string
value with a lone surrogate. Replacing (not appending) keeps the string length, so a
`maxLength`-valid body stays length-valid. The choice is a pure function of the body, so
Hypothesis shrinking and `--seed` replay stay deterministic, and no extra requests are
sent: the added cost is the mutation itself, a few microseconds per case.

`requests` serializes the body with `json.dumps` (ensure_ascii), so the wire carries the
ASCII escape `\\ud800`, which Python's `json.loads` decodes back to a lone `str` surrogate.
A handler that later encodes that string as UTF-8 (a DB write, a log line, a filename)
raises `UnicodeEncodeError`, which is the 500 class this exists to catch. The job's
`status_code_conformance` check already fails on an undocumented 500 and
`backend/schemathesis-baseline.json` holds no 500 entries, so no new check is needed.
"""

import zlib

import schemathesis

# Inject into roughly 1 body in N. High enough that a 10-example MR run reaches it on
# most string-bearing operations over a whole pass, low enough that the other ~90% of
# bodies keep exercising their normal validation paths.
_ONE_IN = 10

# One high and one low surrogate, plus the range ends; picked deterministically per body.
_SURROGATES = ("\ud800", "\udbff", "\udc00", "\udfff")


def _is_json_only(operation):
    """True when every request media type the operation declares is JSON.

    `map_body` does not say which media type a body will be serialized as. A lone
    surrogate in a form-urlencoded or multipart body fails in the client's own encoder
    (`UnicodeEncodeError`), which would be a harness crash and not a server finding.
    """
    media_types = [getattr(body, "media_type", "") for body in getattr(operation, "body", None) or []]
    return bool(media_types) and all(
        mt.split(";")[0].strip().lower() == "application/json" or mt.split(";")[0].strip().lower().endswith("+json")
        for mt in media_types
    )


def _string_paths(value, path=()):
    """Yield the path (a tuple of dict keys / list indexes) to every string value."""
    if isinstance(value, str):
        yield path
    elif isinstance(value, dict):
        for key in value:
            yield from _string_paths(value[key], path + (key,))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _string_paths(item, path + (index,))


def _replace_at(value, path, surrogate):
    """Return a copy of `value` with the string at `path` ending in `surrogate`."""
    if not path:
        return surrogate if not value else value[:-1] + surrogate
    head, rest = path[0], path[1:]
    if isinstance(value, dict):
        return {k: (_replace_at(v, rest, surrogate) if k == head else v) for k, v in value.items()}
    return [_replace_at(v, rest, surrogate) if i == head else v for i, v in enumerate(value)]


def inject_lone_surrogate(body):
    """Deterministically swap one string's last character for a lone surrogate, or return `body`."""
    if not isinstance(body, (dict, list, str)):
        return body
    digest = zlib.crc32(repr(body).encode("utf-8", "surrogatepass"))
    if digest % _ONE_IN != 0:
        return body
    paths = list(_string_paths(body))
    if not paths:
        return body
    # Independent bits of the same digest: which string, and which surrogate.
    path = paths[(digest // _ONE_IN) % len(paths)]
    surrogate = _SURROGATES[(digest // (_ONE_IN * 7)) % len(_SURROGATES)]
    return _replace_at(body, path, surrogate)


@schemathesis.hook
def map_body(context, body):
    """Put a lone surrogate into some JSON string bodies (#2121)."""
    if context.operation is None or not _is_json_only(context.operation):
        return body
    return inject_lone_surrogate(body)
