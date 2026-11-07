"""Webhook delivery over the board change feed (#863).

``manage.py dispatch_webhooks`` calls :func:`run_once` (or loops on it). There
is no queue: each subscription is a cursor into its board's change feed, and a
run reads the rows after the cursor, POSTs them in ``event_id`` order, and
moves the cursor forward on each 2xx.

Guarantees, and how each one is kept
------------------------------------
* **Same redaction as the feed.** Rows are read with
  ``boards.services.feed.feed_queryset`` and rendered with
  ``serialize_feed_rows`` as a ``viewer`` with no reader id, the lowest role
  and an identity that owns nothing. Never the subscription owner's role: the
  receiver is outside the board, and an admin's role would hand it admin-only
  rows and fields (security-invariants Rules 8 and 10).
* **One dispatcher per subscription at a time.** A run takes a lease with a
  conditional UPDATE (row count 1 = held), which works on SQLite as well as
  PostgreSQL, and every later write is a compare-and-set on the lease token.
  Two overlapping runs (a slow loop and a host cron, two Helm replicas) never
  deliver the same row from both: the loser of the lease does nothing.
* **At-least-once.** The cursor moves only after a 2xx, so a crash between the
  POST and the cursor write re-sends that row next run. ``X-Visiban-Event-Id``
  is the receiver's idempotency key.
* **Head-of-line blocking per subscription.** A failure stops that
  subscription for this run and backs it off; the next run retries the same
  row. Later rows are not delivered past a failed one, so order holds.
* **Standing re-derived every run (owner decision D4).** ``configured_by``
  must still be an active account with an admin or site-admin role on the
  board. A NULL (deleted) account fails closed.
* **Never unsigned.** A URL or secret that no longer decrypts disables the
  subscription; nothing is sent.
* **Never skipped silently (D5).** Retention pruning can remove events a
  webhook has not sent yet. ``prune_board_events`` records, per board and
  event type, the highest id it removed (#2058, #2079), and a webhook whose
  cursor is below the mark of a type it would have been sent is turned off as
  ``cursor_expired`` instead of delivering past the gap. The marks are read
  after the page of rows, so a prune that lands mid-run is either seen or
  removed nothing that run read.
* **Commit-order settle window.** Only rows older than
  ``WEBHOOK_SETTLE_SECONDS`` are read, and a run stops before the oldest
  unsettled row, so a transaction that committed late is still picked up.
  Best-effort until #2053 gives the feed a commit-ordered cursor.
* **A replaced secret signs only inside its overlap (#2054).** Each delivery
  re-reads the wall clock, so a window that ends mid-run drops the old value at
  the next row. :func:`run_once` also clears expired columns before its gate,
  because ``_due_ids`` skips disabled rows and a server with the feature off
  would otherwise keep the ciphertext forever.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import F, Max, Q
from django.utils import timezone

from boards.models import Board, BoardEvent, BoardMembership
from boards.permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_role
from boards.services.feed import feed_queryset, newest_event_id, prune_marks, resume_cursor, serialize_feed_rows
from visiban import crypto, egress
from visiban.authorization import authorize_account

from . import notices, signing
from .models import SUBSCRIBABLE_EVENT_TYPES, WebhookDispatcherState, WebhookSubscription

logger = logging.getLogger(__name__)

#: The role a webhook reads the feed as. Fixed: never the owner's role.
WEBHOOK_READER_ROLE = BoardMembership.Role.VIEWER
#: Roles that keep a subscription's configurer in standing (D4).
STANDING_ROLES = frozenset({BoardMembership.Role.ADMIN, SITE_ADMIN})

TEST_EVENT = "webhook.test"

Reason = WebhookSubscription.DisabledReason


def _setting(name, default):
    return getattr(settings, name, default)


def webhooks_enabled() -> bool:
    """The runtime gate: ``WEBHOOKS_ENABLED`` and never in demo mode."""
    return bool(_setting("WEBHOOKS_ENABLED", False)) and not _setting("DEMO_MODE", False)


def user_agent() -> str:
    return f"Visiban-Webhooks/{_setting('APP_VERSION', '') or 'dev'}"


# ─── Request building ────────────────────────────────────────────────────────


def build_request(
    subscription_id: int, board_id: int, row: dict, secret: str, *, previous_secret=None, now=None
):
    """Return ``(body, headers)`` for one delivery of the feed *row*.

    *row* is one serialized feed row ``{id, event, data, actor_id, actor, redacted_at,
    created_at}``. The body is exactly that row as JSON; the signature covers
    ``f"{timestamp}.{body}"``. With *previous_secret* (an open rotation overlap)
    the header lists the current secret's signature, then the previous one's.
    """
    timestamp = int((now or timezone.now()).timestamp())
    body = json.dumps(row, cls=DjangoJSONEncoder, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
    headers = {
        "Content-Type": "application/json",
        "User-Agent": user_agent(),
        "X-Visiban-Event": str(row.get("event", "")),
        "X-Visiban-Event-Id": str(row.get("id", "")),
        "X-Visiban-Board-Id": str(board_id),
        "X-Visiban-Subscription-Id": str(subscription_id),
        "X-Visiban-Timestamp": str(timestamp),
        "X-Visiban-Signature": signing.signature_header(secret, previous_secret, timestamp, body),
    }
    return body, headers


def post(url: str, body: bytes, headers: dict):
    """One guarded POST. Returns ``(status_code_or_None, error_code_or_None)``.

    A 2xx is ``(status, None)``; any other status is ``(status, "http_error")``,
    3xx included (redirects are never followed).
    """
    try:
        status = egress.guarded_post(
            url,
            body,
            headers,
            allowlist=egress.parse_allowlist(_setting("WEBHOOK_ALLOWED_PRIVATE_TARGETS", "")),
            connect_timeout=float(_setting("WEBHOOK_CONNECT_TIMEOUT_SECONDS", 3.0)),
            total_timeout=float(_setting("WEBHOOK_TIMEOUT_SECONDS", 10.0)),
        )
    except egress.EgressError as exc:
        return None, exc.code
    if 200 <= status < 300:
        return status, None
    return status, egress.HTTP_ERROR


def send_test(subscription: WebhookSubscription):
    """Send a ``webhook.test`` event now. Returns ``(ok, code, status_code, latency_ms)``.

    ``latency_ms`` is the time from send to the receiver's status line, or
    ``None`` when nothing was sent or nothing answered.

    The test row has ``id`` 0, so a receiver deduplicating on event id never
    confuses it with a real row. It does not touch the cursor or the failure
    counters.
    """
    try:
        url = subscription.get_url()
        secret = subscription.get_secret()
    except crypto.SecretDecryptionError:
        return False, Reason.SECRET_UNAVAILABLE.value, None, None
    now = timezone.now()
    row = {
        "id": 0,
        "event": TEST_EVENT,
        "data": {"subscription_id": subscription.pk, "board_id": subscription.board_id},
        "actor_id": None,
        "actor": None,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "redacted_at": None,
    }
    body, headers = build_request(
        subscription.pk,
        subscription.board_id,
        row,
        secret,
        previous_secret=subscription.get_previous_secret(),
        now=now,
    )
    started = time.monotonic()
    status, code = post(url, body, headers)
    latency_ms = int((time.monotonic() - started) * 1000) if status is not None else None
    return code is None, code, status, latency_ms


# ─── Cursor helpers (shared with the API) ────────────────────────────────────


def latest_event_id(board_id: int) -> int:
    """Where a webhook starts: the board's newest event id or its prune mark, whichever is greater.

    Used for a new webhook's cursor (D5: nothing earlier is sent) and for
    ``reenable`` with ``resume_from: latest``. The prune mark matters when
    every event after the old cursor was pruned and nothing newer exists: the
    newest surviving id is then below the mark, and a cursor there would be
    expired again at once (#2058). Board-wide, unlike the feed's ``410``
    ``next_cursor``, which is computed from the rows and marks its reader may
    see (``reader_resume_cursor``, #2126).
    """
    return resume_cursor(board_id)


def cursor_expired(subscription: WebhookSubscription) -> bool:
    """True when a pruned event this webhook would have been sent is after the cursor (#2058, #2079).

    Exact, not an estimate: ``prune_board_events`` records the highest id it
    removed per board and event type, in the same transaction as the delete,
    and never lowers it. A cursor below the mark of a type the webhook takes
    skipped at least one event it would have sent; a cursor at or above all of
    them skipped none, whatever its own row's fate and however long since the
    last scan. So:

    * a webhook whose missed events were all pruned, with nothing newer on
      the board, is expired (there is no newer row to notice the gap by);
    * a webhook whose failing event was then pruned is expired, although the
      failed attempt counted as a scan;
    * a webhook idle past retention, or with cursor 0 on a board that had no
      events, is not expired when nothing after it was pruned;
    * a webhook is not expired by a pruned row the dispatcher would have skipped
      anyway: per-user and admin-only rows (it reads as ``WEBHOOK_READER_ROLE``
      with no reader id, as the page below does), and types ``wants()`` refuses.

    The types are the subscription's *current* ones, as for delivery. A webhook
    widened to a type whose pruned events are past its cursor is expired; one
    narrowed away from a type no longer answers for it.

    ``BoardEventPruneMark.max_pruned_id`` counts whatever the types: a mark with
    no type detail does not know them.

    No mark means nothing has been pruned from the board since the mark table
    existed. Unlike the feed, which keeps an older inference for boards
    pruned before the record, and counts a floor for what such a pruner may have
    removed, a webhook needs neither: webhooks ship in the same release as the
    record, so every event after any webhook's cursor was written after it, and
    was pruned (if at all) by a pruner that records. Counting that floor would
    expire a webhook at cursor 0 for events it could never have received. A
    pre-#2058 pruner still scheduled on 1.3 breaks that premise, which is why
    the docs tell operators to keep it on the backend's version. A webhook's
    cursor is set by the server, so it is never another board's id.
    """
    wanted = [t for t in (subscription.event_types or SUBSCRIBABLE_EVENT_TYPES) if subscription.wants(t)]
    visible = prune_marks(
        subscription.board_id,
        role=WEBHOOK_READER_ROLE,
        reader_id=None,
        events=wanted,
        count_unrecorded_floor=False,
    ).visible
    return visible is not None and visible > subscription.cursor


def configurer_has_standing(user, board) -> bool:
    """D4: the configurer passes the account-state gates and administers *board*.

    The account gates are the ones every non-REST transport applies
    (security-invariants Rule 1): inactive, or a forced password or username
    change pending, and the webhook stops. A NULL configurer (account
    deleted) fails closed.
    """
    if user is None or not user.is_active or not authorize_account(user):
        return False
    return get_board_role(user, board) in STANDING_ROLES


def backoff_seconds(failures: int) -> float:
    """``min(base * 2**(failures-1), max)`` plus up to 10% jitter."""
    base = int(_setting("WEBHOOK_BACKOFF_BASE_SECONDS", 30))
    cap = int(_setting("WEBHOOK_BACKOFF_MAX_SECONDS", 3600))
    delay = min(base * (2 ** max(failures - 1, 0)), cap)
    jitter = secrets.SystemRandom().uniform(0, delay * 0.1)
    return delay + jitter


def disable(subscription_id: int, reason: str, *, lease_token=None, notify=True, actor_id=None) -> bool:
    """Disable a subscription and, for an automatic reason, notify its board's admins.

    With *lease_token*, only while that lease is still held (dispatcher use).
    Returns True if this call disabled it. The notice carries the board name,
    the subscription id and the reason code: never the URL or any response.
    """
    now = timezone.now()
    with transaction.atomic():
        qs = WebhookSubscription.objects.filter(pk=subscription_id, enabled=True)
        if lease_token is not None:
            qs = qs.filter(lease_token=lease_token)
        changed = qs.update(
            enabled=False,
            disabled_reason=reason,
            disabled_at=now,
            next_attempt_at=None,
            lease_until=None,
            lease_token=None,
            updated_at=now,
        )
        if not changed:
            return False
        sub = WebhookSubscription.objects.select_related("board", "configured_by").get(pk=subscription_id)
        if notify:
            notices.notify_disabled(sub, reason)
    log_config_event("disable", sub, actor_id=actor_id, reason=reason)
    return True


def log_config_event(action: str, sub: WebhookSubscription, *, actor_id=None, reason=None):
    """One structured line per configuration change (D11). Ids only, never the URL."""
    logger.info(
        "webhook %s: subscription_id=%s board_id=%s actor_id=%s reason=%s",
        action,
        sub.pk,
        sub.board_id,
        actor_id,
        reason or "",
    )


# ─── The run ─────────────────────────────────────────────────────────────────


@dataclass
class RunResult:
    skipped: bool = False
    subscriptions: int = 0
    delivered: int = 0
    failed: int = 0
    disabled: int = 0
    errored: int = 0
    lost_lease: int = 0
    notes: list = field(default_factory=list)


def _heartbeat(**fields):
    WebhookDispatcherState.objects.update_or_create(pk=1, defaults=fields)


def _due_ids(now):
    """Every due subscription, least recently scanned first.

    Round-robin by ``last_scanned_at`` (never-scanned first), not by id: a
    healthy subscription is due on every run (``next_attempt_at`` stays null),
    so ordering by id would let the run budget be spent on the same low ids
    every time and starve the rest. No row cap: the list is bounded by
    ``WEBHOOK_MAX_TOTAL``, and the run stops at its budget.
    """
    return list(
        WebhookSubscription.objects.filter(enabled=True)
        .filter(Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now))
        .filter(Q(lease_until__isnull=True) | Q(lease_until__lt=now))
        .order_by(F("last_scanned_at").asc(nulls_first=True), "id")
        .values_list("id", flat=True)
    )


def sweep_expired_previous_secrets(*, now=None) -> int:
    """Clear previous secrets whose overlap has passed. Returns how many.

    Every row, disabled ones included: ``_due_ids`` never sees those, and the
    ciphertext should not outlive its window. Leaves ``configured_at`` and
    ``secret_rotated_at`` alone, so a run in progress never reads an expiry as a
    reconfiguration (``_still_configured_as_read``). A rotation committing at the
    same moment is safe: the row is re-checked against this filter after its
    lock, and a fresh window no longer matches.
    """
    now = now or timezone.now()
    cleared = WebhookSubscription.objects.filter(previous_secret_expires_at__lte=now).update(
        previous_secret_encrypted="", previous_secret_expires_at=None, updated_at=now
    )
    if cleared:
        logger.info("webhook previous secrets expired: count=%s", cleared)
    return cleared


def run_once(*, budget_seconds=None, clock=time.monotonic) -> RunResult:
    """Process due subscriptions until done or the run budget is spent."""
    result = RunResult()
    # Before the gate: turning the feature off must not strand a replaced secret.
    sweep_expired_previous_secrets()
    if not webhooks_enabled():
        result.skipped = True
        return result
    budget = float(budget_seconds if budget_seconds is not None else _setting("WEBHOOK_RUN_BUDGET_SECONDS", 50))
    deadline = clock() + budget
    _heartbeat(last_run_started_at=timezone.now())
    for sub_id in _due_ids(timezone.now()):
        if clock() >= deadline:
            break
        result.subscriptions += 1
        # One webhook's bug must not cost the others their turn. The exception
        # class only: its text could carry an address.
        try:
            _process(sub_id, deadline, clock, result)
        except Exception as exc:  # noqa: BLE001
            result.errored += 1
            logger.error("webhook run error: subscription_id=%s error=%s", sub_id, type(exc).__name__)
    _heartbeat(last_run_finished_at=timezone.now())
    return result


def _lease_seconds(budget_remaining: float) -> float:
    per_request = float(_setting("WEBHOOK_CONNECT_TIMEOUT_SECONDS", 3.0)) + float(
        _setting("WEBHOOK_TIMEOUT_SECONDS", 10.0)
    )
    return max(budget_remaining, 0) + 2 * per_request + 30


def _process(sub_id: int, deadline: float, clock, result: RunResult):
    now = timezone.now()
    token = uuid.uuid4()
    lease_until = now + timedelta(seconds=_lease_seconds(deadline - clock()))
    # Conditional UPDATE: row count 1 means this run holds the lease. Works on
    # every backend, unlike select_for_update(skip_locked=True).
    got = (
        WebhookSubscription.objects.filter(pk=sub_id, enabled=True)
        .filter(Q(lease_until__isnull=True) | Q(lease_until__lt=now))
        .filter(Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now))
        .update(lease_until=lease_until, lease_token=token)
    )
    if got != 1:
        result.lost_lease += 1
        return
    try:
        _deliver(sub_id, token, deadline, clock, result)
    finally:
        WebhookSubscription.objects.filter(pk=sub_id, lease_token=token).update(
            lease_until=None, lease_token=None
        )


def _deliver(sub_id: int, token, deadline: float, clock, result: RunResult):
    sub = WebhookSubscription.objects.select_related("configured_by").get(pk=sub_id)
    board = Board.objects.select_related("owner", GROUP_ANCESTOR_SELECT_RELATED).get(pk=sub.board_id)

    if not configurer_has_standing(sub.configured_by, board):
        if disable(sub_id, Reason.CREATOR_LOST_ACCESS, lease_token=token):
            result.disabled += 1
        return
    try:
        url = sub.get_url()
        secret = sub.get_secret()
    except crypto.SecretDecryptionError:
        if disable(sub_id, Reason.SECRET_UNAVAILABLE, lease_token=token):
            result.disabled += 1
        return
    if not url or not secret:
        if disable(sub_id, Reason.SECRET_UNAVAILABLE, lease_token=token):
            result.disabled += 1
        return

    now = timezone.now()
    # Idle fast path: nothing after the cursor on the board, and nothing it
    # would have been sent pruned after it either (#2058, #2079). An indexed MAX
    # and the marks instead of the feed, settle and tail queries. Standing and
    # the secrets were still checked above, every run (D4). A cursor whose
    # missed events were all pruned, with nothing newer, falls through to the
    # expiry check below. The board-wide resume point would not do here: a
    # cursor below a mark of a type it does not take would never be idle.
    if newest_event_id(board.pk) <= sub.cursor and not cursor_expired(sub):
        WebhookSubscription.objects.filter(pk=sub_id, lease_token=token).update(last_scanned_at=now)
        return

    settle_cutoff = now - timedelta(seconds=int(_setting("WEBHOOK_SETTLE_SECONDS", 10)))
    max_events = int(_setting("WEBHOOK_MAX_EVENTS_PER_RUN", 100))
    rows = list(
        feed_queryset(board.pk, role=WEBHOOK_READER_ROLE, reader_id=None)
        .filter(pk__gt=sub.cursor, created_at__lte=settle_cutoff)
        .order_by("id")[:max_events]
    )
    # Checked after the page is read, never before (D5). A prune deletes rows
    # and raises the mark in one transaction: one that committed before the
    # page query is in the mark read now, and one that commits after it
    # removed nothing from this page. Read first, a prune landing in between
    # would leave the page starting past a gap the check never saw.
    if cursor_expired(sub):
        if disable(sub_id, Reason.CURSOR_EXPIRED, lease_token=token):
            result.disabled += 1
        return
    # Stop before the oldest row that has not settled yet: a lower id that
    # committed late must not be skipped by delivering a higher one first.
    # Bounded by the page when it is full, so a subscription far behind does
    # not scan its whole backlog on every run; first() walks the (board_id, id)
    # index forward and stops at the first match.
    unsettled = BoardEvent.objects.filter(
        board_id=board.pk, pk__gt=sub.cursor, created_at__gt=settle_cutoff
    )
    if len(rows) == max_events:
        unsettled = unsettled.filter(pk__lte=rows[-1].pk)
    first_unsettled = unsettled.order_by("id").values_list("id", flat=True).first()
    if first_unsettled is not None:
        rows = [r for r in rows if r.pk < first_unsettled]
    window = Q(pk__gt=sub.cursor, created_at__lte=settle_cutoff)
    if first_unsettled is not None:
        window &= Q(pk__lt=first_unsettled)
    WebhookSubscription.objects.filter(pk=sub_id, lease_token=token).update(last_scanned_at=now)
    payloads = serialize_feed_rows(board.pk, rows, role=WEBHOOK_READER_ROLE, reader_id=None)
    # Read once, so an unreadable one logs once per run, not once per row.
    previous_secret = sub.get_previous_secret()

    cursor = sub.cursor
    pending = cursor  # cursor value not yet written (skipped rows)
    for payload in payloads:
        event_id = int(payload["id"])
        if not sub.wants(payload["event"]):
            pending = event_id
            continue
        if clock() >= deadline:
            break
        if not _still_configured_as_read(sub, token):
            # Disabled, re-pointed, rotated or taken over since this run read
            # the row: stop, so no further row goes out with the old URL or
            # secret. The next run starts from the new state.
            result.lost_lease += 1
            break
        # The wall clock per row: the overlap can end during a run, and that is
        # not a reconfiguration, so the run carries on with the current secret.
        body, headers = build_request(
            sub.pk,
            board.pk,
            payload,
            secret,
            previous_secret=previous_secret if sub.previous_secret_active_until else None,
        )
        attempt_at = timezone.now()
        status, code = post(url, body, headers)
        if code is None:
            if not _advance(sub_id, token, cursor, event_id, success_at=attempt_at, status=status):
                result.lost_lease += 1
                return
            cursor = pending = event_id
            result.delivered += 1
            continue
        result.failed += 1
        if pending != cursor and _advance(sub_id, token, cursor, pending):
            cursor = pending
        _record_failure(sub_id, token, code, status, attempt_at, result)
        return
    else:
        # Every fetched row handled. If the page was short, the subscription is
        # caught up: move the cursor past rows this reader never sees (per-user
        # and admin-only rows) up to the newest settled id, so the next run and
        # the cursor-expiry rule start from a row that exists.
        # A page cut short by an unsettled row is also short: the window
        # already stops before that row, so the tail stays below it.
        if len(rows) < max_events:
            tail = BoardEvent.objects.filter(board_id=board.pk).filter(window).aggregate(m=Max("id"))["m"]
            if tail and tail > pending:
                pending = tail
    if pending != cursor and not _advance(sub_id, token, cursor, pending):
        result.lost_lease += 1


def _still_configured_as_read(sub, token) -> bool:
    """True while the row still has the lease and the configuration this run read."""
    return WebhookSubscription.objects.filter(
        pk=sub.pk,
        lease_token=token,
        enabled=True,
        configured_at=sub.configured_at,
        secret_rotated_at=sub.secret_rotated_at,
    ).exists()


def _advance(sub_id, token, old_cursor, new_cursor, *, success_at=None, status=None) -> bool:
    """Compare-and-set the cursor under the lease. False if the lease was lost.

    Also requires ``enabled=True``: an admin who disables the subscription
    mid-run stops it at the next row.
    """
    updates = {"cursor": new_cursor}
    if success_at is not None:
        updates.update(
            consecutive_failures=0,
            failing_since=None,
            last_error_code="",
            last_status_code=status,
            last_attempt_at=success_at,
            last_success_at=success_at,
        )
    return (
        WebhookSubscription.objects.filter(
            pk=sub_id, cursor=old_cursor, lease_token=token, enabled=True
        ).update(**updates)
        == 1
    )


def _record_failure(sub_id, token, code, status, attempt_at, result: RunResult):
    sub = WebhookSubscription.objects.filter(pk=sub_id).first()
    if sub is None:
        return  # Deleted while the POST was in flight: nothing left to record.
    failures = sub.consecutive_failures + 1
    failing_since = sub.failing_since or attempt_at
    limit = int(_setting("WEBHOOK_DISABLE_AFTER_FAILURES", 20))
    hours = float(_setting("WEBHOOK_DISABLE_AFTER_HOURS", 24))
    WebhookSubscription.objects.filter(pk=sub_id, lease_token=token).update(
        consecutive_failures=failures,
        failing_since=failing_since,
        last_attempt_at=attempt_at,
        last_error_code=code,
        last_status_code=status,
        next_attempt_at=attempt_at + timedelta(seconds=backoff_seconds(failures)),
    )
    logger.info(
        "webhook delivery failed: subscription_id=%s board_id=%s code=%s status=%s failures=%s",
        sub_id,
        sub.board_id,
        code,
        status,
        failures,
    )
    if failures >= limit or attempt_at - failing_since >= timedelta(hours=hours):
        if disable(sub_id, Reason.FAILURES, lease_token=token):
            result.disabled += 1


def dispatcher_status(*, now=None):
    """``(last_run_at, stale)`` for ``GET status/``."""
    now = now or timezone.now()
    state = WebhookDispatcherState.objects.filter(pk=1).first()
    last = None
    if state is not None:
        last = state.last_run_finished_at or state.last_run_started_at
    stale_after = timedelta(seconds=int(_setting("WEBHOOK_DISPATCHER_STALE_SECONDS", 300)))
    return last, last is None or last < now - stale_after
