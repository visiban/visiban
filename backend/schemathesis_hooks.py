"""schemathesis path-parameter seeding for the `backend-schema-fuzz` CI job (#1120).

Loaded automatically by `st run` via the `SCHEMATHESIS_HOOKS=schemathesis_hooks`
environment variable set on the job (see `.gitlab-ci.yml`).

## Why this exists

`seed_demo_data` gives the fuzz job a populated, deterministic "Visiban Demo Board" so
it isn't fuzzing against an empty database — but schemathesis still generates each
operation's path parameters (``board_pk``, ``id``, ``item_pk``, ...) independently at
random. For a board-scoped nested route the corresponding Django URL segment is an
untyped string (see `boards/urls.py`'s `NestedDefaultRouter` — no `<int:...>` converter,
so drf-spectacular documents it as `type: string`), so a random value essentially never
matches a real row. The baseline run found ~72 operations reachable only via a 404 —
schemathesis never got to exercise the real 200-path logic for a detail/write endpoint,
only its "no such object" branch.

This module maps a fixed set of *known* path parameter names, keyed by the exact
OpenAPI path template, to real ids pulled from the seeded demo board at hook-load
time (once, not per-request — `st run` loads this module a single time per process).
Hypothesis still owns the *values that aren't overridden here* (query params, request
bodies, and any path parameter this module has no mapping for), so this only narrows
reachability for the specific board-scoped resource family the baseline flagged —
it does not turn off negative testing generally.

## What this deliberately does NOT seed

Several resource families have no corresponding row in `seed_demo_data` at all — there
is no seeded Group, CustomFieldDefinition, SavedFilter, CardAttachment, or group
invite-link/label, so there is nothing to seed an id *from*. Those operations still
404 under fuzzing; per #1120 triage this is accepted for now (extending
`seed_demo_data` with those entity types touches its committed
`sample-boards/demo_board.json`/`.csv` export and is tracked separately — see #1125).
Admin-only endpoints (`/api/v1/admin/...`) are excluded on purpose too: #1080 requires
`provision_fuzz_token` to refuse an admin/superuser account, so this job's token can
never reach them regardless of path-parameter seeding (#1120 accepted this as
documented residual scope rather than adding a second admin-scoped pass — see the
`backend-schema-fuzz` job comment in `.gitlab-ci.yml`).

## Why a hook instead of `--generation-database` or `--phases stateful`

`--generation-database` is hypothesis's own example-replay cache (speeds up repeat
runs against the *same* schema+seed by reusing previously-discovered inputs) — it has
no notion of "real" ids and cannot be pointed at application data. `--phases stateful`
chains operations using OpenAPI `links`; this schema declares none, and schemathesis
4.27's automatic link inference (`schemathesis/specs/openapi/stateful/inference.py`)
only works from a `Location` response header, which no Visiban view sets on create.
Both were considered and ruled out during #1120's investigation — a `map_path_parameters`
hook against real seeded rows is the mechanism this schemathesis version actually
supports for this problem.
"""

import os
import sys

import django

# Make the Django project importable regardless of the CLI's cwd when it loads
# this file — `st run`'s `script:` step in .gitlab-ci.yml runs from the repo
# root (SCHEMATHESIS_HOOKS points at `backend/schemathesis_hooks.py`), not
# from `backend/`, unlike `manage.py`'s commands earlier in the same job.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
django.setup()

import schemathesis  # noqa: E402


def _load_real_ids():
    """Pull real ids from the seeded demo board, once, at hook-load time.

    Any piece that is missing (e.g. no card has a checklist item in some future
    reseed) degrades gracefully to `None`, which `map_path_parameters` below
    treats as "leave whatever schemathesis generated" rather than crashing the
    whole fuzz run over one missing fixture.

    `_query_real_ids()` is only ever called from here, in whichever thread `st run`
    happens to import this module in. `--workers` runs the fuzzing phase itself
    on a `WorkerPool` of threads (see `schemathesis/engine/run/unit/_pool.py`), so
    the connection this query opens would otherwise sit open, thread-pinned per
    Django's per-thread connection handling, for the run's full `--max-time` —
    same hazard as an ORM call from a spawned thread in a test (see this repo's
    backend-test-conventions doc), just with a `st run` process instead of pytest.
    """
    from django.db import connections

    try:
        return _query_real_ids()
    finally:
        connections.close_all()


def _query_real_ids():
    from boards.models import Board, BoardMembership, Card

    ids = {
        "board_pk": None,
        "column_id": None,
        "swimlane_id": None,
        "label_id": None,
        "card_id": None,
        "checklist_item_id": None,
        "comment_id": None,
        "member_user_id": None,
        "pat_id": None,
    }

    board = Board.objects.filter(name="Visiban Demo Board").first()
    if board is None:
        return ids
    ids["board_pk"] = board.id

    column = board.columns.order_by("position").first()
    if column is not None:
        ids["column_id"] = column.id

    swimlane = board.swimlanes.order_by("position").first()
    if swimlane is not None:
        ids["swimlane_id"] = swimlane.id

    label = board.labels.order_by("id").first()
    if label is not None:
        ids["label_id"] = label.id

    # Prefer a card that has both a checklist item and a comment so the
    # checklist/comment detail routes have something real to fetch too.
    card = (
        Card.objects.filter(board=board, checklist_items__isnull=False, comments__isnull=False)
        .distinct()
        .first()
        or Card.objects.filter(board=board).order_by("id").first()
    )
    if card is not None:
        ids["card_id"] = card.id
        item = card.checklist_items.order_by("id").first()
        if item is not None:
            ids["checklist_item_id"] = item.id
        comment = card.comments.order_by("id").first()
        if comment is not None:
            ids["comment_id"] = comment.id

    member = (
        BoardMembership.objects.filter(board=board)
        .exclude(user_id=board.owner_id)
        .order_by("id")
        .first()
    )
    if member is not None:
        ids["member_user_id"] = member.user_id

    # The fuzz job's own PAT (provisioned by provision_fuzz_token for the same
    # user this run authenticates as) — gives GET/DELETE
    # /api/v1/auth/tokens/{id}/ a real row to resolve instead of always 404ing.
    from accounts.models import PersonalAccessToken

    pat = (
        PersonalAccessToken.objects.filter(user_id=board.owner_id).order_by("id").first()
        if member is None
        else PersonalAccessToken.objects.filter(user_id=member.user_id).order_by("id").first()
    )
    if pat is not None:
        ids["pat_id"] = pat.id

    return ids


_IDS = _load_real_ids()

# Exact OpenAPI path template -> {path parameter name: key into _IDS}.
# Keyed by the literal template (not a regex) so a new operation added to the
# schema simply isn't seeded until someone opts it in here — no risk of an
# overly broad pattern silently overriding a parameter it was never meant to.
_PATH_PARAM_OVERRIDES = {
    "/api/v1/boards/{board_pk}/cards/archived/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/cards/{id}/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/activities/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/archive/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/unarchive/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/attachments/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/": {
        "board_pk": "board_pk", "id": "card_id",
    },
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/{item_pk}/": {
        "board_pk": "board_pk", "id": "card_id", "item_pk": "checklist_item_id",
    },
    "/api/v1/boards/{board_pk}/cards/{id}/comments/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/comments/{comment_pk}/": {
        "board_pk": "board_pk", "id": "card_id", "comment_pk": "comment_id",
    },
    "/api/v1/boards/{board_pk}/cards/{id}/move/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/movements/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/status/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/timeline/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/columns/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/columns/reorder/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/columns/{id}/": {"board_pk": "board_pk", "id": "column_id"},
    "/api/v1/boards/{board_pk}/labels/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/labels/{id}/": {"board_pk": "board_pk", "id": "label_id"},
    "/api/v1/boards/{board_pk}/swimlanes/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/swimlanes/reorder/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/swimlanes/{id}/": {"board_pk": "board_pk", "id": "swimlane_id"},
    "/api/v1/boards/{board_pk}/swimlanes/{id}/set-collapsed/": {
        "board_pk": "board_pk", "id": "swimlane_id",
    },
    "/api/v1/boards/{board_pk}/swimlanes/{id}/set_collapsed/": {
        "board_pk": "board_pk", "id": "swimlane_id",
    },
    "/api/v1/boards/{board_pk}/custom-fields/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/custom-fields/reorder/": {"board_pk": "board_pk"},
    # No CustomFieldDefinition is seeded, so `id` here is left to schemathesis —
    # board_pk alone still turns the 404 from "no such board" into "no such field".
    "/api/v1/boards/{board_pk}/custom-fields/{id}/": {"board_pk": "board_pk"},
    "/api/v1/boards/{id}/": {"id": "board_pk"},
    "/api/v1/boards/{id}/analytics/": {"id": "board_pk"},
    "/api/v1/boards/{id}/events/": {"id": "board_pk"},
    "/api/v1/boards/{id}/export/": {"id": "board_pk"},
    "/api/v1/boards/{id}/export-history/": {"id": "board_pk"},
    "/api/v1/boards/{id}/full/": {"id": "board_pk"},
    "/api/v1/boards/{id}/members/": {"id": "board_pk"},
    "/api/v1/boards/{id}/members/{user_id}/": {"id": "board_pk", "user_id": "member_user_id"},
    "/api/v1/boards/{id}/move-group/": {"id": "board_pk"},
    "/api/v1/boards/{id}/movements/": {"id": "board_pk"},
    "/api/v1/boards/{id}/saved-filters/": {"id": "board_pk"},
    # No SavedFilter is seeded; filter_pk is left to schemathesis.
    "/api/v1/boards/{id}/saved-filters/{filter_pk}/": {"id": "board_pk"},
    "/api/v1/boards/{id}/share/": {"id": "board_pk"},
    "/api/v1/boards/{id}/star/": {"id": "board_pk"},
    "/api/v1/boards/{id}/summary/": {"id": "board_pk"},
    "/api/v1/auth/tokens/{id}/": {"id": "pat_id"},
}


@schemathesis.hook
def map_path_parameters(context, path_parameters):
    """Replace known path parameters with real seeded ids (#1120).

    Only touches parameters this module has both a mapping for *and* a
    non-None real value for — anything else (including every path this
    module has no entry for at all) passes through untouched, so ordinary
    fuzzing/negative testing of path parameters this module doesn't know
    about is unaffected.
    """
    if context.operation is None or not path_parameters:
        return path_parameters

    overrides = _PATH_PARAM_OVERRIDES.get(context.operation.path)
    if not overrides:
        return path_parameters

    result = dict(path_parameters)
    for param_name, ids_key in overrides.items():
        real_value = _IDS.get(ids_key)
        if param_name in result and real_value is not None:
            result[param_name] = real_value
    return result
