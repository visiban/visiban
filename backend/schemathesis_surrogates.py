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

The requests transport's JSON serializer is wrapped (`_install_json_serializer`), so the
mutation happens as the request body is built, only for cases whose media type is JSON.
It cannot be a `map_body` hook (not told the media type; drf-spectacular declares JSON, form
and multipart on nearly every serializer-bodied operation, only 2 of 80 are JSON-only) and it
must not set `case.body`: the CLI re-validates the recorded case after the scenario and the
validator UTF-8-encodes strings, so a surrogate stored on the case crashes `st run` with
`UnicodeEncodeError` (seen in CI on the first attempt). Serialization-time injection leaves
the case pristine. A lone surrogate in a form or multipart body would crash the client's own
encoder, which is why those serializers are left alone.

For about one JSON case in `_ONE_IN` whose body carries a string, the last character of
one string value is replaced with a lone surrogate. Replacing (not appending) keeps the
string length. The choice is a pure function of the body, so `--seed` replay stays
deterministic, the input body is copied and not mutated, and no extra requests are sent.

Reach, measured on `manage.py spectacular` output: 198 operations, 80 with a request body,
77 of those declare JSON, and 62 of those have a string in the JSON body schema. Per
case that is about 1 in 10 of the JSON-selected cases (about 3% of cases if schemathesis
picks uniformly among three declared media types, which was not measured), so roughly
20 injections in a 10-example MR run and roughly 10x that in the deep nightly.

`requests` serializes the body with `json.dumps` (ensure_ascii), so the wire carries the
ASCII escape `\\ud800`, which Python's `json.loads` decodes back to a lone `str` surrogate.
A handler that later encodes that string as UTF-8 (a DB write, a log line, a filename)
raises `UnicodeEncodeError`, which is the 500 class this exists to catch. The job's
`status_code_conformance` check already fails on an undocumented 500 and
`backend/schemathesis-baseline.json` holds no 500 entries, so no new check is needed. A
surrogate that is rejected with a documented 400 is fine; only a 5xx (or other undocumented
status) turns the job red.
"""

import zlib

# Inject into roughly 1 JSON case in N: often enough to land a few dozen times per MR run
# across the string-bearing operations, rare enough that the other ~90% of bodies keep
# exercising their normal validation paths.
_ONE_IN = 10

# One high and one low surrogate, plus the range ends; picked deterministically per body.
_SURROGATES = ("\ud800", "\udbff", "\udc00", "\udfff")


def _is_json(media_type):
    """True for `application/json` and `+json` types, ignoring parameters."""
    main = (media_type or "").split(";")[0].strip().lower()
    return main == "application/json" or main.endswith("+json")


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


def _install_json_serializer():
    """Wrap the requests transport's JSON serializer so the wire body carries the surrogate.

    The mutation happens at serialization time, on the way out, so the `Case` keeps its
    pristine generated body. That matters: schemathesis re-validates a recorded case's body
    against the schema after the scenario (`cli/commands/run/warnings.py` ->
    `Case._revalidate_metadata`), and that validator UTF-8-encodes every string, which raises
    `UnicodeEncodeError` on a lone surrogate and crashes `st run`. A first attempt that set
    `case.body` in `before_call` hit exactly that in CI (and restoring it in `after_call`
    is not reliable: it is skipped when the call raises without a request attached).

    The serializer is chosen from `case.media_type`, so form and multipart cases never reach
    it, which is the JSON-only guard.
    """
    from schemathesis.transport.requests import REQUESTS_TRANSPORT

    original = REQUESTS_TRANSPORT._serializers["application/json"]

    def json_serializer_with_surrogates(ctx, value):
        return original(ctx, inject_lone_surrogate(value))

    # Idempotent if this module is loaded twice (tests import it by name and by path).
    if getattr(original, "_injects_surrogates", False):
        return
    json_serializer_with_surrogates._injects_surrogates = True
    REQUESTS_TRANSPORT.serializer("application/json", "text/json")(json_serializer_with_surrogates)


_install_json_serializer()
