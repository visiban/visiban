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

`seed_demo_data` now also seeds a demo Group (owning the demo board),
CustomFieldDefinition (+ value), SavedFilter, CardAttachment, GroupInviteLink, and
GroupLabel (#1125), so the corresponding path parameters below are mapped the same
way as every other board-scoped resource.

#1570 targeted the "repeatedly returned 404" warning (43 operations) and measured 43 -> 6
locally (seed 1, SQLite; the Postgres count must be confirmed from the CI log). Root cause
of the group routes: the fuzz user is a plain board member but was not a *group* member,
and `GroupViewSet.get_queryset()` only admits groups the caller owns or belongs to, so
every `/groups/{id}/...` call 404ed whatever id was supplied. `seed_demo_data` now adds the
board's members to the demo group (as MEMBER). The join/share/media routes had no mapping
at all: invite tokens are stored hashed, so this module mints fresh links itself
(`_mint_public_tokens`) and maps the board share token and the seeded attachment's file
path. Card/relation/checklist-reorder routes were missing from the table below. DELETE
operations get a disposable row minted per call (`_mint_disposable`) so they cannot
destroy the shared fixture other operations rely on.

Still 404 on purpose (no seedable id, or the id is in the request body):
`/auth/me/connected-accounts/{provider}/` (needs a linked social account),
`/boards/{id}/invite-links/{link_id}/` (unseeded id, and a member fails the admin check
first), `/auth/me/pending-email/resend/` (needs a pending email change),
`/auth/registration/verify-email/` (needs a signup key), `/boards/import/trello/` (no
Trello export), `/cards/{id}/move/` (target ids live in the body). The confirm-email routes
are excluded in the job (#1321).

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

import itertools
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

    Guarded by `connection.in_atomic_block`: `boards/tests/test_schemathesis_hooks.py`
    calls this function directly from inside a `TestCase`, which wraps the test body
    in an atomic block sharing the *same* connection this function would otherwise
    close — an unconditional `close_all()` here previously broke every subsequent
    query in those tests with `InterfaceError: connection already closed`. `st run`
    never runs inside an atomic block, so the close still happens for the real case
    this exists to protect.
    """
    from django.db import connection, connections

    try:
        return _query_real_ids()
    finally:
        if not connection.in_atomic_block:
            connections.close_all()


def _query_real_ids():
    from boards.models import Board, BoardMembership, CardAttachment, CardRelation

    from django.db.models import Q

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
        # #1125 — group/custom-field/saved-filter/attachment/invite-link/
        # group-label ids, now that seed_demo_data creates one of each.
        "group_pk": None,
        "custom_field_id": None,
        # #1391 — swimlane (row) field definitions are seeded by
        # seed_demo_data too; without a real board_pk their writes 404 in the
        # viewset before any definition validation runs under fuzz.
        "swimlane_custom_field_id": None,
        "saved_filter_id": None,
        "attachment_id": None,
        "group_invite_link_id": None,
        "group_label_id": None,
        # #1570 — card relation, and the three public-credential routes
        # (board/group join token, board share token) plus a media path.
        "relation_id": None,
        "board_join_token": None,
        "group_join_token": None,
        "share_token": None,
        "media_path": None,
    }

    board = Board.objects.filter(name="Visiban Demo Board").first()
    if board is None:
        return ids
    ids["board_pk"] = board.id

    if board.group_id is not None:
        ids["group_pk"] = board.group_id
        invite_link = board.group.invite_links.order_by("id").first()
        if invite_link is not None:
            ids["group_invite_link_id"] = invite_link.id
        group_label = board.group.labels.order_by("id").first()
        if group_label is not None:
            ids["group_label_id"] = group_label.id

    custom_field = board.custom_field_definitions.order_by("id").first()
    if custom_field is not None:
        ids["custom_field_id"] = custom_field.id

    swimlane_field = board.swimlane_custom_field_definitions.order_by("id").first()
    if swimlane_field is not None:
        ids["swimlane_custom_field_id"] = swimlane_field.id

    saved_filter = board.saved_filters.order_by("id").first()
    if saved_filter is not None:
        ids["saved_filter_id"] = saved_filter.id

    column = board.columns.order_by("position").first()
    if column is not None:
        ids["column_id"] = column.id

    swimlane = board.swimlanes.order_by("position").first()
    if swimlane is not None:
        ids["swimlane_id"] = swimlane.id

    label = board.labels.order_by("id").first()
    if label is not None:
        ids["label_id"] = label.id

    member = (
        BoardMembership.objects.filter(board=board)
        .exclude(user_id=board.owner_id)
        .order_by("id")
        .first()
    )
    if member is not None:
        ids["member_user_id"] = member.user_id

    # The user the fuzz job authenticates as (provision_fuzz_token --username
    # demo2) is the first non-owner member. Card, comment and attachment deletes
    # are authorship-gated for a plain member, so the card id is chosen to be
    # one whose sub-resources that user owns (#1570); an arbitrary card made
    # those operations 403 for a fixture reason rather than a role rule.
    card = _pick_card(board, member.user_id if member is not None else None)
    if card is not None:
        ids["card_id"] = card.id
        item = card.checklist_items.order_by("id").first()
        if item is not None:
            ids["checklist_item_id"] = item.id
        comments = card.comments.order_by("id")
        comment = (
            (comments.filter(author_id=member.user_id).first() if member is not None else None)
            or comments.first()
        )
        if comment is not None:
            ids["comment_id"] = comment.id
        relation = (
            CardRelation.objects.filter(Q(from_card=card) | Q(to_card=card)).order_by("id").first()
        )
        if relation is not None:
            ids["relation_id"] = relation.id

        # Attachment ids must belong to the SAME card as card_id: the view looks
        # the attachment up with card=card, so an attachment on another card 404s.
        attachments = CardAttachment.objects.filter(card=card).order_by("id")
        attachment = (
            (attachments.filter(uploaded_by_id=member.user_id).first() if member is not None else None)
            or attachments.first()
        )
        if attachment is not None:
            ids["attachment_id"] = attachment.id
            ids["media_path"] = attachment.file.name or None

    _mint_public_tokens(board, ids)

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


def _pick_card(board, member_user_id):
    """Choose the one card id every ``{id}``-on-a-card path will use (#1570).

    Ranked so that the fuzz user (``member_user_id``) can reach success paths:
    created by that user (card DELETE is authorship-gated), then richest in
    sub-resources it owns (attachment, comment) and in checklist/relation rows.
    Archived cards are skipped, as the card endpoints exclude them. Falls back
    to any card on the board so a board without a member still gets an id.
    """
    from boards.models import Card

    cards = (
        Card.objects.filter(board=board, archived_at__isnull=True)
        .exclude(title=_DISPOSABLE_TITLE)
        .prefetch_related("checklist_items", "comments", "attachments")
        .order_by("id")
    )
    best, best_score = None, -1
    for card in cards:
        score = 0
        if member_user_id is not None:
            score += 8 * (card.created_by_id == member_user_id)
            score += 4 * any(a.uploaded_by_id == member_user_id for a in card.attachments.all())
            score += 2 * any(c.author_id == member_user_id for c in card.comments.all())
        score += 1 * bool(card.checklist_items.all())
        if score > best_score:
            best, best_score = card, score
    return best


def _mint_public_tokens(board, ids):
    """Mint the credentials the public join/share routes need (#1570).

    Invite tokens are stored only as hashes, so no seeded row can tell this hook
    the raw value the URL needs; the only way to hold one is to create the link
    here and keep the raw string in memory. That is also why it cannot live in
    ``seed_demo_data``. Everything is generated with ``secrets`` inside the
    models; nothing is logged or written to disk. This runs once per ``st run``
    process and WRITES to whatever database the hook is loaded against: it is
    meant for the throwaway CI fuzz database. Loading it against a database you
    care about (a local replay against ``seed_demo_data``) leaves non-expiring,
    multi-use MEMBER join links and sets a public ``share_token`` on the demo
    board. The links are named "schemathesis fuzz fixture" so they are easy to
    revoke afterwards.

    Prior fixture links are deleted first so repeated loads do not accumulate
    rows. A pre-existing board share token is reused, never rotated.
    """
    import uuid

    from boards.models import Board, BoardInviteLink
    from groups.models import GroupInviteLink

    name = "schemathesis fuzz fixture"
    owner = board.owner

    BoardInviteLink.objects.filter(board=board, name=name).delete()
    _, ids["board_join_token"] = BoardInviteLink.generate(
        board=board, created_by=owner, name=name, role=BoardInviteLink.Role.MEMBER,
    )

    if board.group_id is not None:
        group = board.group
        GroupInviteLink.objects.filter(group=group, name=name).delete()
        # The join preview 404s a link whose creator no longer administers the
        # group (#1510), so mint it as the group owner.
        _, ids["group_join_token"] = GroupInviteLink.generate(
            group=group, created_by=group.owner, name=name, role=GroupInviteLink.Role.MEMBER,
        )

    if board.share_token is None:
        Board.objects.filter(pk=board.pk, share_token__isnull=True).update(share_token=uuid.uuid4())
        board.refresh_from_db(fields=["share_token"])
    ids["share_token"] = str(board.share_token) if board.share_token else None


_DISPOSABLE_TITLE = "schemathesis fuzz disposable"


def _load_disposable_context(ids):
    """Objects needed to mint disposable rows, or None without a member fixture.

    Also clears rows a previous load of this hook left behind, so a reload
    against the same database does not accumulate them.
    """
    from django.db import connection, connections

    from accounts.models import User
    from boards.models import Card, Column, SavedFilter, Swimlane

    needed = ("board_pk", "card_id", "member_user_id", "column_id", "swimlane_id")
    if any(ids.get(key) is None for key in needed):
        return None
    try:
        member = User.objects.get(pk=ids["member_user_id"])
        shared = Card.objects.get(pk=ids["card_id"])
        Card.objects.filter(board_id=ids["board_pk"], title=_DISPOSABLE_TITLE).delete()
        shared.attachments.filter(filename__startswith="fuzz-disposable-").delete()
        shared.comments.filter(body=_DISPOSABLE_TITLE).delete()
        shared.checklist_items.filter(text=_DISPOSABLE_TITLE).delete()
        SavedFilter.objects.filter(
            board_id=ids["board_pk"], user=member, name__startswith="fuzz-disposable-"
        ).delete()
        return {
            "member": member,
            "shared": shared,
            "board_id": ids["board_pk"],
            "column": Column.objects.get(pk=ids["column_id"]),
            "swimlane": Swimlane.objects.get(pk=ids["swimlane_id"]),
        }
    finally:
        if not connection.in_atomic_block:
            connections.close_all()


def _mint_disposable(kind):
    """Create one row that only a DELETE operation will touch; return its id.

    Authorship-gated deletes (card, comment, attachment, checklist item,
    relation, saved filter) really succeed for the fuzz user, and a hard card
    delete cascades and removes the attachment file. If DELETE shared the one
    fixture row with every other operation it would destroy it early in the run
    and every later call on it would 404 (#1570). So each DELETE call gets a
    freshly minted row instead, owned by the fuzz user and, for sub-resources,
    attached to the shared card (which therefore stays alive). A prebuilt pool
    ran dry after ~60 calls per operation (a run makes ~270), so the row is
    minted on demand. Any failure returns None and the generated id stays: a
    404, never the shared row and never a crashed run.
    """
    from django.core.files.base import ContentFile

    from boards.models import (
        Card, CardAttachment, CardChecklist, CardComment, CardRelation, SavedFilter,
    )

    fixture = _DISPOSABLE
    if fixture is None:
        return None
    member, shared = fixture["member"], fixture["shared"]
    n = next(_DISPOSABLE_COUNTER)

    def card():
        return Card.objects.create(
            board_id=fixture["board_id"], column=fixture["column"], swimlane=fixture["swimlane"],
            title=_DISPOSABLE_TITLE, position=9000 + n, created_by=member,
        )

    try:
        if kind == "card":
            return card().id
        if kind == "attachment":
            name = f"fuzz-disposable-{n}.txt"
            return CardAttachment.objects.create(
                card=shared, file=ContentFile(b"x", name=name), filename=name, size=1,
                uploaded_by=member,
            ).id
        if kind == "comment":
            return CardComment.objects.create(card=shared, author=member, body=_DISPOSABLE_TITLE).id
        if kind == "checklist_item":
            return CardChecklist.objects.create(
                card=shared, text=_DISPOSABLE_TITLE, position=900 + n).id
        if kind == "relation":
            low, high = sorted((shared, card()), key=lambda c: c.pk)
            return CardRelation.objects.create(
                from_card=low, to_card=high, relation_type=CardRelation.Type.RELATES_TO,
                created_by=member).id
        if kind == "saved_filter":
            return SavedFilter.objects.create(
                user=member, board_id=fixture["board_id"], name=f"fuzz-disposable-{n}",
                state_json={"search": "", "assigneeIds": [], "labelIds": [], "priorities": [], "dueDate": ""},
            ).id
    except Exception:  # noqa: BLE001 -- a fixture hiccup must not abort the fuzz run
        return None
    return None


def _first_sample_id():
    """A real sample-board slug for ``/boards/samples/{sample_id}/``."""
    from boards.services import sample_boards

    try:
        return sample_boards.list_samples()[0]["id"]
    except (IndexError, KeyError, TypeError):
        return None


_IDS = _load_real_ids()
_EXTRA_IDS = {"sample_id": _first_sample_id()}
_DISPOSABLE = _load_disposable_context(_IDS)
_DISPOSABLE_COUNTER = itertools.count(1)

# DELETE-only: path template -> {param: disposable kind}. See _mint_disposable.
_DELETE_POOL_OVERRIDES = {
    "/api/v1/boards/{board_pk}/cards/{id}/": {"id": "card"},
    "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/": {"attachment_pk": "attachment"},
    "/api/v1/boards/{board_pk}/cards/{id}/comments/{comment_pk}/": {"comment_pk": "comment"},
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/{item_pk}/": {"item_pk": "checklist_item"},
    "/api/v1/boards/{board_pk}/cards/{id}/relations/{relation_pk}/": {"relation_pk": "relation"},
    "/api/v1/boards/{id}/saved-filters/{filter_pk}/": {"filter_pk": "saved_filter"},
}

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
    # attachment_pk seeded since #1125 (was left to schemathesis before).
    "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/": {
        "board_pk": "board_pk", "id": "card_id", "attachment_pk": "attachment_id",
    },
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/{item_pk}/": {
        "board_pk": "board_pk", "id": "card_id", "item_pk": "checklist_item_id",
    },
    # #1570: the card collection route and the relation/reorder routes had no
    # entry at all, so every one fell through to random ids and 404ed.
    "/api/v1/boards/{board_pk}/cards/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/cards/{id}/checklist/reorder/": {
        "board_pk": "board_pk", "id": "card_id",
    },
    "/api/v1/boards/{board_pk}/cards/{id}/relations/": {"board_pk": "board_pk", "id": "card_id"},
    "/api/v1/boards/{board_pk}/cards/{id}/relations/{relation_pk}/": {
        "board_pk": "board_pk", "id": "card_id", "relation_pk": "relation_id",
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
    # id seeded since #1125 (was left to schemathesis before).
    "/api/v1/boards/{board_pk}/custom-fields/{id}/": {
        "board_pk": "board_pk", "id": "custom_field_id",
    },
    # #1391 — swimlane (row) field definitions, mapped like the card ones above.
    "/api/v1/boards/{board_pk}/swimlane-custom-fields/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/swimlane-custom-fields/reorder/": {"board_pk": "board_pk"},
    "/api/v1/boards/{board_pk}/swimlane-custom-fields/{id}/": {
        "board_pk": "board_pk", "id": "swimlane_custom_field_id",
    },
    "/api/v1/boards/{id}/": {"id": "board_pk"},
    "/api/v1/boards/{id}/analytics/": {"id": "board_pk"},
    "/api/v1/boards/{id}/events/": {"id": "board_pk"},
    "/api/v1/boards/{id}/export/": {"id": "board_pk"},
    "/api/v1/boards/{id}/export-history/": {"id": "board_pk"},
    "/api/v1/boards/{id}/full/": {"id": "board_pk"},
    # Board invites (#1444, #439): a real board_pk so these routes get past the
    # board lookup instead of 404ing on a fuzzed id. The fuzz account is a
    # plain board MEMBER, so list/create/send/revoke answer 403 at the
    # board-admin check — the fuzzer exercises the permission path and the
    # declared 403, not the create/send success paths (those bodies are pinned
    # by groups/tests/test_invite_email_schema_contract.py). link_id is not
    # seeded (no demo invite). The /api/v1/admin/ routes stay excluded (#1080).
    "/api/v1/boards/{id}/invite-links/": {"id": "board_pk"},
    "/api/v1/boards/{id}/invite-links/send/": {"id": "board_pk"},
    "/api/v1/boards/{id}/invite-links/{link_id}/": {"id": "board_pk"},
    "/api/v1/boards/{id}/members/": {"id": "board_pk"},
    "/api/v1/boards/{id}/members/{user_id}/": {"id": "board_pk", "user_id": "member_user_id"},
    "/api/v1/boards/{id}/move-group/": {"id": "board_pk"},
    "/api/v1/boards/{id}/movements/": {"id": "board_pk"},
    "/api/v1/boards/{id}/saved-filters/": {"id": "board_pk"},
    # filter_pk seeded since #1125 (was left to schemathesis before).
    "/api/v1/boards/{id}/saved-filters/{filter_pk}/": {
        "id": "board_pk", "filter_pk": "saved_filter_id",
    },
    "/api/v1/boards/{id}/share/": {"id": "board_pk"},
    "/api/v1/boards/{id}/star/": {"id": "board_pk"},
    "/api/v1/boards/{id}/summary/": {"id": "board_pk"},
    "/api/v1/auth/tokens/{id}/": {"id": "pat_id"},
    # ── Group routes (#1125) — group_pk seeded via board.group, now that
    # seed_demo_data attaches the demo board to a demo Group.
    "/api/v1/groups/{id}/": {"id": "group_pk"},
    "/api/v1/groups/{id}/board-defaults/": {"id": "group_pk"},
    "/api/v1/groups/{id}/boards/": {"id": "group_pk"},
    "/api/v1/groups/{id}/descendant-boards/": {"id": "group_pk"},
    "/api/v1/groups/{id}/invite-links/": {"id": "group_pk"},
    "/api/v1/groups/{id}/invite-links/{link_id}/": {
        "id": "group_pk", "link_id": "group_invite_link_id",
    },
    "/api/v1/groups/{id}/labels/": {"id": "group_pk"},
    "/api/v1/groups/{id}/labels/{label_id}/": {
        "id": "group_pk", "label_id": "group_label_id",
    },
    "/api/v1/groups/{id}/subgroups/": {"id": "group_pk"},
    "/api/v1/groups/{id}/star/": {"id": "group_pk"},
    # #1570 — the remaining group routes. The fuzz user is a plain group MEMBER
    # (seed_demo_data), so the admin-only ones (send, transfer-ownership, member
    # PATCH/DELETE) answer a declared 403 rather than mutating anything.
    "/api/v1/groups/{id}/invite-links/send/": {"id": "group_pk"},
    "/api/v1/groups/{id}/members/": {"id": "group_pk"},
    "/api/v1/groups/{id}/members/{user_id}/": {"id": "group_pk", "user_id": "member_user_id"},
    "/api/v1/groups/{id}/transfer-ownership/": {"id": "group_pk"},
    # #1570 — public credentials and media. Tokens are minted by
    # _mint_public_tokens(); the media path is the seeded attachment's file.
    "/api/v1/boards/join/{token}/": {"token": "board_join_token"},
    "/api/v1/groups/join/{token}/": {"token": "group_join_token"},
    "/api/share/{token}/": {"token": "share_token"},
    "/media/{path}": {"path": "media_path"},
    # A real slug from the sample-board manifest (#1570).
    "/api/v1/boards/samples/{sample_id}/": {"sample_id": "sample_id"},
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
        real_value = _IDS.get(ids_key, _EXTRA_IDS.get(ids_key))
        if param_name in result and real_value is not None:
            result[param_name] = real_value

    # DELETE gets a freshly minted disposable row instead of the shared one (#1570); if
    # minting fails the generated value stays, so the shared row is never deleted.
    if str(getattr(context.operation, "method", "")).upper() == "DELETE":
        for param_name, pool_name in _DELETE_POOL_OVERRIDES.get(context.operation.path, {}).items():
            if param_name not in result:
                continue
            minted = _mint_disposable(pool_name)
            result[param_name] = minted if minted is not None else path_parameters[param_name]
    return result


def _is_server_layer_multipart_rejection(case, response):
    """True for the bare, bodiless 400 the ASGI server gives a malformed multipart body.

    Twisted (under daphne) pre-parses ``multipart/form-data`` request bodies
    itself and, when it cannot, answers ``400`` with no body and no
    ``Content-Type`` and drops the connection — before Django or DRF is
    reached. The application never sees the request and cannot shape that
    response, so it is neither a defect nor something the OpenAPI document
    could describe. Fuzzing produces such bodies constantly (it is a
    negative-test of the request media type), so leaving them to the baseline
    made the job pass or fail depending on which operation the random seed
    happened to send one to — a flake by construction (#1165).
    """
    if response.status_code != 400 or response.content:
        return False
    if any(name.lower() == "content-type" for name in response.headers):
        return False
    request_type = ""
    for name, value in response.request.headers.items():
        if name.lower() == "content-type":
            request_type = value[0] if isinstance(value, (list, tuple)) else value
    return str(request_type).lower().startswith("multipart/form-data")


@schemathesis.hook
def filter_failure(context, failure, case, response):
    """Drop only the server-layer multipart rejection; keep every other failure.

    Deliberately narrow — status 400, empty body, no response Content-Type,
    *and* a multipart request — so an application 400/500 with a missing
    Content-Type, or a 400 to a non-multipart body, is still reported. Returning
    True means "keep this failure".
    """
    return not _is_server_layer_multipart_rejection(case, response)
