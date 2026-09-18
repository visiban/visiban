import hashlib
import json
import logging
import time

import requests
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from allauth.socialaccount.models import SocialToken
from boards.broadcast import record_board_event
from boards.models import BoardMembership
from boards.permissions import SITE_ADMIN
from boards.views import get_board_for_user
from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from . import providers
from .models import LensConnection
from .serializers import (
    _VALID_COLUMN_DIMS,
    _VALID_SWIMLANE_DIMS,
    LensConnectionSerializer,
)
from .types import LensConfig, LensFilters

logger = logging.getLogger(__name__)

# Defense-in-depth beyond the providers.py normalization boundary (#1085): a
# provider payload shape we didn't anticipate should degrade the board to the
# stale copy, same as a LensError/RequestException, rather than 500ing. Bounded
# by exception TYPE (not bare Exception) to the ones malformed provider data is
# known to raise (non-string subscripted/keyed/`.lower()`d) — not by cause, so
# an unrelated bug in provider_fn's call graph that happens to raise one of
# these four common types is also caught here rather than surfacing as a 500.
# We log with exc_info so that case is still triageable from the exception type
# and traceback (never payload contents — see the log call below).
_UNEXPECTED_PARSE_ERRORS = (TypeError, KeyError, AttributeError, ValueError)


# Filter-value bounds. The label cap is the fan-out control the #1067 security
# item asks for at the value level: every extra label multiplies the reachable
# cache-key space, and nobody legitimately AND-filters more than a handful.
MAX_LENS_LABELS = 5
MAX_FILTER_VALUE_LEN = 255


def _parse_filters(request) -> LensFilters:
    """Read server-side filter params from the query string and canonicalize them.

    **Fail-open is deliberate, not an oversight.** An unrecognized value is coerced
    to "no filter" rather than raising a 400 (mirroring the pivot-dim coercion just
    above ``LensBoardView.get``). Lens URLs are shareable snapshots that outlive the
    data they point at, so a link carrying a filter value that has since become
    meaningless must still render a board. Do not "fix" this into a serializer or a
    FilterSet — both fail closed, and that would turn every stale shared link into a
    hard error on already-shipped behavior.

    Canonicalization happens HERE and nowhere else, so that the cache key and the
    outbound provider request can never disagree about what was asked for.

    Text search is client-side and is deliberately never read here.
    """
    state = request.query_params.get("state")
    if state not in ("open", "closed"):
        state = None

    milestone = request.query_params.get("milestone") or None
    if milestone:
        # Bound the value (cache-key hygiene + defense); accept any non-empty title
        # so a shared link to an off-budget milestone still scopes the fetch.
        milestone = milestone.strip()[:MAX_FILTER_VALUE_LEN] or None

    # Labels: comma-separated AND set. Deduped BEFORE the cap (so "a,a,a,a,a,b" is
    # two labels, not six truncated to five) and sorted, because ?labels=b,a and
    # ?labels=a,b are the same question — an unsorted key would mint two cache
    # entries, and therefore two cold provider fetches, for one filter. Case is
    # preserved: GitLab label matching is case-sensitive and GitHub preserves case,
    # so lowercasing would either desynchronize the key from the value we send
    # upstream or silently return an empty board for any capitalized label.
    raw_labels = request.query_params.get("labels") or ""
    labels = tuple(
        sorted(
            {
                part
                for part in (
                    chunk.strip()[:MAX_FILTER_VALUE_LEN] for chunk in raw_labels.split(",")
                )
                if part
            }
        )[:MAX_LENS_LABELS]
    )

    # Single value by design — neither provider can express "assigned to any of N"
    # in one call (GitLab assignee_username, GitHub assignee).
    assignee = (
        request.query_params.get("assignee") or ""
    ).strip()[:MAX_FILTER_VALUE_LEN] or None

    return LensFilters(
        state=state, milestone=milestone, labels=labels, assignee=assignee
    )

# Per-repo lens-board cache. The board is shared, so the cache is keyed by
# (provider, repo, pivot) — NOT by user — so N members viewing one board collapse
# to a single upstream fetch per soft-TTL window. Stale-while-revalidate keeps the
# outbound provider-call rate bounded and predictable (the API-politeness contract).
LENS_CACHE_SOFT_TTL = 60     # serve cached data without revalidating for this long
LENS_CACHE_HARD_TTL = 600    # keep a stale-servable copy this long (SWR + error fallback)
# Filtered boards get a SHORTER hard TTL than the unfiltered one. The unfiltered
# board is the hot, genuinely shared entry (on GitLab one copy serves every viewer),
# so it keeps the full window. Filtered entries are the long tail: each distinct
# filter combination is its own key, they are far less likely to be re-read, and
# they are the entire resident footprint of the cache-key fan-out #1067 bounds.
# Cutting their lifetime cuts that footprint by ~3x for no loss on the path that
# matters — the fetch RATE is bounded separately by _claim_fetch_budget.
LENS_CACHE_FILTERED_HARD_TTL = 180
LENS_FETCH_LOCK_TTL = 90     # single-flight lock; must exceed worst-case fetch (see assertion)
LENS_FORCE_REFRESH_COOLDOWN = 30  # per (provider, repo, user) floor between ?refresh=1 re-fetches
LENS_FETCH_BUDGET = 12            # upstream fetches allowed per window, per (provider, repo, user)
LENS_FETCH_BUDGET_WINDOW = 300    # seconds
# A second, coarser ceiling per USER across every repo. The per-repo budget above
# is scoped on repo_slug, and repo_slug is user-mintable: any authenticated user
# can create a board, become its admin, and PUT a new repo_slug, minting a fresh
# per-repo budget each time (1 PUT + 12 GETs). Without this the only remaining
# bound is the global 5000/hour UserRateThrottle — ~400x looser than the per-repo
# budget implies. That matters most for GitLab, whose reads are ANONYMOUS and
# therefore charged to the instance's own IP: one account could saturate
# gitlab.com's unauthenticated per-IP limit and break the lens for everyone on the
# instance. Generous enough that viewing several lens boards in one sitting never
# reaches it (#1067 security-review).
LENS_USER_FETCH_BUDGET = LENS_FETCH_BUDGET * 4

# The lock must outlive the worst-case synchronous fetch, or it could expire
# mid-fetch and let a second fetcher dogpile the provider. Tie the constants
# together so a future bump to the provider page cap / timeout can't silently
# break the guarantee — fail loudly at import instead.
#
# The worst case is a GitHub PIPELINE fetch with a milestone filter:
#   * MAX_PAGES issue pages, plus
#   * two aux paginations (branches + open MRs, MAX_AUX_PAGES each) inside
#     _enrich_{github,gitlab}_pipeline, which runs whenever column_dim ==
#     "pipeline" (providers.py), plus
#   * ONE milestone-roster page (_github_milestone_map), needed since #1067 moved
#     GitHub milestone filtering server-side. It is capped at a single page
#     precisely so this formula stays a small, checkable constant.
# An earlier version of this formula counted only the issue pages, so the assertion
# passed (45 >= 30) while the guarantee this comment claims was false for every
# pipeline fetch. Keep every outbound leg represented here: the assert is the only
# thing standing between a page-cap bump and a lock that expires mid-fetch.
_WORST_CASE_FETCH_SECONDS = (
    providers.MAX_PAGES + 2 * providers.MAX_AUX_PAGES + 1
) * providers.REQUEST_TIMEOUT
assert LENS_FETCH_LOCK_TTL >= _WORST_CASE_FETCH_SECONDS, (
    "LENS_FETCH_LOCK_TTL must exceed the worst-case provider fetch duration "
    "((MAX_PAGES + 2 * MAX_AUX_PAGES + 1) * REQUEST_TIMEOUT)"
)

# Explicit permission chain, mirroring every other board-scoped view in the
# codebase so an accidental change to DEFAULT_PERMISSION_CLASSES cannot silently
# drop the auth gate from these endpoints without a visible diff here.
_BOARD_PERMISSIONS = [
    IsAuthenticated,
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
    TokenHasScope,
]


def _claim_force_refresh(conn, user) -> bool:
    """Consume this user's force-refresh slot for *conn*'s repo; False if spent.

    ``cache.add`` only succeeds when the key is absent, so the claim is atomic
    against concurrent clicks. Callers degrade to a normal soft-TTL read rather
    than erroring: a second click inside the cooldown still returns a board, and
    the provenance banner's "Synced X ago" keeps telling the truth about how
    fresh that copy actually is.

    Keyed on (provider, repo, user) rather than (board, user) because the thing
    being protected is the PROVIDER's rate limit, and that is shared by every
    board pointing at the same repo. A per-board key would let one user multiply
    their budget by simply being a member of several boards on one repo.
    """
    return cache.add(
        f"git_lens:force:{conn.provider}:{conn.repo_slug}:{user.id}",
        1,
        LENS_FORCE_REFRESH_COOLDOWN,
    )


def _claim_window_slot(key: str, limit: int) -> bool:
    """Consume one slot of a fixed-window counter at *key*; False once *limit* is hit.

    A fixed window rather than a sliding one: it keeps the claim to a single atomic
    cache op (``add`` is SETNX, ``incr`` is INCR and does not reset the TTL), and
    precision is not the point — these budgets exist to stop a scripted loop, not
    to ration normal use.
    """
    if cache.add(key, 1, LENS_FETCH_BUDGET_WINDOW):
        return True
    try:
        return cache.incr(key) <= limit
    except ValueError:
        # The window expired between add() and incr(); start a fresh one.
        return cache.add(key, 1, LENS_FETCH_BUDGET_WINDOW)


def _claim_fetch_budget(conn, user) -> bool:
    """Consume one upstream-fetch slot for this viewer; False if either budget is spent.

    Bounds how many provider fetches one viewer can cause regardless of WHICH path
    triggered them. ``?refresh=1`` has its own cooldown, but a cold cache key also
    fetches, and ``milestone``/``labels``/``assignee`` are all free text (see
    ``_parse_filters``) so the key space — and therefore the supply of cold keys —
    is unbounded. Without this, a viewer can loop novel filter values and drive a
    full upstream fetch on every request, bypassing both the soft-TTL and the
    refresh cooldown.

    This is also what bounds the cache-key FAN-OUT, which is why #1067 adds no
    dedicated fan-out limiter. Minting a distinct cache key *requires* a cold fetch,
    and ``_serve_board`` spends this budget BEFORE it touches the provider or takes
    the lock — so keys created can never exceed fetches allowed. The bound is
    dimension-agnostic by construction: it is keyed on the viewer and the repo, never
    on the filter value, so adding label and assignee filters enlarges the
    *reachable* key space combinatorially without changing the *rate* at which keys
    can be minted — and rate is the only term in the resident-footprint bound.
    ``test_novel_filter_values_cannot_loop_the_provider`` is the executable form of
    that claim; keep it passing for every filter dimension added here.

    TWO ceilings, both required:

    * per (provider, repo, user) — the provider rate limit is shared by every board
      pointing at the same repo, so a per-board key would let one user multiply
      their budget by joining several boards on one repo.
    * per user, across all repos — because the first key contains ``repo_slug``,
      and ``repo_slug`` is user-mintable. Any authenticated user can create a board
      and PUT a new slug, minting a fresh per-repo budget for the cost of one
      request. The per-repo ceiling alone therefore bounds a scope whose *count* the
      caller chooses, which is no bound at all; this one closes that (#1067
      security-review). Evaluated second and short-circuited, so a caller already
      over the per-repo limit is not also charged here.
    """
    return _claim_window_slot(
        f"git_lens:budget:{conn.provider}:{conn.repo_slug}:{user.id}",
        LENS_FETCH_BUDGET,
    ) and _claim_window_slot(
        f"git_lens:budget:user:{user.id}", LENS_USER_FETCH_BUDGET
    )


def _require_board_admin(role):
    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        raise PermissionDenied("Only board admins can configure the issue lens.")


def _user_provider_token(user, provider):
    """Return a non-expired OAuth token for *provider*, or None.

    Never log or serialize the returned value — it is sent only as an outbound
    Authorization header to the provider API.
    """
    tok = (
        SocialToken.objects.filter(account__user=user, account__provider=provider)
        .order_by("-expires_at")
        .first()
    )
    if not tok:
        return None
    if tok.expires_at and tok.expires_at < timezone.now():
        return None
    return tok.token


def _board_cache_key(provider, repo, column_dim, swimlane_dim, user_scope=None, filters=None):
    # GitLab public reads are anonymous → the rendered board is identical for every
    # viewer and safe to SHARE by repo (one fetch serves the whole board). GitHub
    # reads use the viewer's OWN token, which may see repos other members can't, so
    # those are scoped per user (``user_scope``) to preserve that boundary — the
    # "public repos only" contract is not enforced upstream, so we must not let one
    # member's token-authorized view leak to another through a shared cache.
    # Server-side filters change WHAT is fetched, so they MUST be in the key or a
    # filtered view would be served unfiltered (or vice versa). Text search is
    # client-side, so it is deliberately absent (it would explode the key space
    # without changing the fetched set).
    #
    # The preimage is JSON, not a delimiter-joined f-string (which is what this was
    # before #1067). Filter values are free text that legitimately contains the old
    # separators — a milestone titled "1.2|m=x", an assignee containing a comma — so
    # a hand-joined preimage lets two DIFFERENT filter sets collapse onto one digest,
    # and one user is then served a board answering somebody else's filter. JSON
    # quoting makes the preimage unambiguous for any value (quotes and backslashes
    # escaped, non-ASCII normalized by ensure_ascii, `null` distinct from any string,
    # the label slot type-tagged as an array), and documents the key grammar in one
    # place. ``labels`` arrives already sorted from _parse_filters, so ?labels=b,a
    # and ?labels=a,b share a key rather than doubling the fan-out.
    f = filters if filters is not None else LensFilters()
    preimage = json.dumps(
        [
            provider,
            repo,
            column_dim,
            swimlane_dim,
            f.state,
            f.milestone,
            list(f.labels),
            f.assignee,
        ],
        separators=(",", ":"),
    )
    # FULL digest, not truncated. For GitLab ``user_scope`` is None, so this key is
    # shared across every user on the instance — and a caller controls both sides of
    # the comparison (anyone can create a board, point it at any repo, and vary the
    # filter values freely). A truncated digest turns that into a multi-target second
    # preimage search whose cost falls off linearly with the number of victim keys
    # known; a poisoned entry would serve attacker-chosen issue titles and URLs into
    # another team's board. Key length is free here, so do not re-truncate this
    # (#1067 security-review).
    digest = hashlib.sha256(preimage.encode()).hexdigest()
    scope = f":u{user_scope}" if user_scope is not None else ""
    # v4: the preimage grammar changed (see above). Old v3 entries simply age out.
    return f"git_lens:board:v4{scope}:{digest}"


def _lock_key(cache_key: str) -> str:
    return f"{cache_key}:lock"


def _payload_etag(payload: dict) -> str:
    # Content hash for client-side conditional GETs. Excludes ``fetched_at`` so an
    # unchanged repo yields a stable ETag across revalidations and the browser gets
    # a 304. (The Visiban<->provider leg is bounded separately by the shared cache.)
    content = {k: v for k, v in payload.items() if k != "fetched_at"}
    raw = json.dumps(content, sort_keys=True, default=str).encode()
    return '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'


def _board_response(payload: dict, request) -> Response:
    etag = _payload_etag(payload)
    if request.headers.get("If-None-Match") == etag:
        resp = Response(status=304)
    else:
        resp = Response(payload)
    resp["ETag"] = etag
    return resp


def _provider_error_response(exc) -> Response:
    if isinstance(exc, providers.LensRateLimited):
        return Response(
            {
                "detail": "The provider is rate-limiting requests. Try again shortly.",
                "code": "rate_limited",
                "retry_after": exc.retry_after,
            },
            status=429,
        )
    if isinstance(exc, providers.LensNotFound):
        return Response(
            {"detail": str(exc) or "Repository not found.", "code": "repo_not_found"},
            status=404,
        )
    if isinstance(exc, providers.LensAuthError):
        return Response(
            {"detail": str(exc) or "Authentication required.", "code": "auth_required"},
            status=409,
        )
    # Network/timeout/unexpected upstream failure → clean 502, never 500.
    return Response(
        {"detail": "Could not fetch issues from the provider.", "code": "lens_error"},
        status=502,
    )


class LensConnectionView(APIView):
    """Read/configure/detach the lens connection for a board.

    Read: any board member. Write/delete: board admin, owner, or site admin.
    """

    permission_classes = _BOARD_PERMISSIONS

    def get(self, request, board_id):
        board, _role = get_board_for_user(board_id, request.user, slim=True)
        # select_related avoids a second query to render the nested created_by user.
        conn = (
            LensConnection.objects.select_related("created_by")
            .filter(board=board)
            .first()
        )
        if conn is None:
            return Response({"detail": "No lens configured for this board."}, status=404)
        return Response(LensConnectionSerializer(conn).data)

    def put(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user, slim=True)
        _require_board_admin(role)
        serializer = LensConnectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with transaction.atomic():
            conn, _created = LensConnection.objects.update_or_create(
                board=board,
                defaults={
                    "provider": data["provider"],
                    "repo_slug": data["repo_slug"],
                    "column_dim": data.get("column_dim", "pipeline"),
                    "swimlane_dim": data.get("swimlane_dim", "milestone"),
                    "created_by": request.user,
                },
            )
            # Re-fetch with the FK pre-loaded so serializing created_by is one query.
            conn = LensConnection.objects.select_related("created_by").get(pk=conn.pk)
            payload = LensConnectionSerializer(conn).data
            # Notify other connected board members so the Lens tab appears for them.
            board_id_int = board.id
            record_board_event(
                board_id_int, "lens_connection.configured", payload,
                actor_id=request.user.id,
            )
        return Response(payload)

    def delete(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user, slim=True)
        _require_board_admin(role)
        with transaction.atomic():
            LensConnection.objects.filter(board=board).delete()
            board_id_int = board.id
            record_board_event(
                board_id_int, "lens_connection.removed", {"board_id": board_id_int},
                actor_id=request.user.id,
            )
        return Response(status=204)


class LensBoardView(APIView):
    """Return the rendered, read-only lens board for a configured connection.

    Any board member may read it. The rendered board is cached and served
    stale-while-revalidate behind a single-flight lock so concurrent viewers never
    dogpile the provider API. GitLab (anonymous, public) is cached per
    (provider, repo, pivot) and shared across all members; GitHub (the viewer's own
    token) is additionally scoped per user so a token-authorized view never leaks
    to a member whose token lacks that access.

    ``?refresh=1`` forces a re-fetch past the soft-TTL. It is deliberately open to
    every board role including viewer — see the rationale at the ``force`` gate in
    ``get()`` — and is bounded instead by a per-(board, user) cooldown, so the
    privilege split here is read=any-member, force-refresh=any-member-but-rate-capped,
    configure=admin. Do not convert the cooldown into a role gate without revisiting
    the viewer persona in #1062.
    """

    permission_classes = _BOARD_PERMISSIONS

    def get(self, request, board_id):
        board, _role = get_board_for_user(board_id, request.user, slim=True)
        conn = LensConnection.objects.filter(board=board).first()
        if conn is None:
            return Response({"detail": "No lens configured for this board."}, status=404)

        # Optional per-request pivot overrides (ad-hoc re-pivot without saving).
        # Coerce unknown values back to the saved dim — this both validates the
        # query params and bounds the shared cache key space (no pollution).
        column_dim = request.query_params.get("column_dim") or conn.column_dim
        swimlane_dim = request.query_params.get("swimlane_dim") or conn.swimlane_dim
        if column_dim not in _VALID_COLUMN_DIMS:
            column_dim = conn.column_dim
        if swimlane_dim not in _VALID_SWIMLANE_DIMS:
            swimlane_dim = conn.swimlane_dim
        config = LensConfig(column_dim=column_dim, swimlane_dim=swimlane_dim)
        filters = _parse_filters(request)

        provider_fn = providers.get_provider(conn.provider)
        if provider_fn is None:
            return Response(
                {"detail": "Unknown provider.", "code": "unknown_provider"}, status=400
            )

        # GitHub needs the viewer's OWN OAuth token; GitLab public reads go
        # anonymous. This gate stays BEFORE the cache so a viewer without a GitHub
        # token cannot free-ride on a copy another member's token populated.
        token = None
        if conn.provider == "github":
            token = _user_provider_token(request.user, "github")
            if not token:
                return Response(
                    {
                        "detail": "Connect your GitHub account to use this lens.",
                        "code": "auth_required",
                    },
                    status=409,
                )

        # ?refresh=1 (the Refresh button) forces a re-fetch past the soft-TTL so the
        # user gets the latest upstream issues + an updated "synced" time, instead
        # of being served the still-fresh cached copy.
        #
        # Forcing stays open to EVERY board role, viewer included: the lens is a
        # read-only surface whose primary audience is viewers (#1062), so a Refresh
        # button that 403s for them would break the persona the feature exists for.
        # What has to be bounded is the outbound provider-call RATE, not who may
        # click — the soft-TTL is the API-politeness contract and ?refresh=1 is a
        # deliberate hole in it. The single-flight lock below only collapses
        # CONCURRENT fetches, so without a cooldown one member can drive continuous
        # sequential re-fetches and burn the shared provider quota for every board
        # on that provider (#1073 rbac-check finding).
        force = request.query_params.get("refresh") in ("1", "true")
        if force and not _claim_force_refresh(conn, request.user):
            force = False

        return self._serve_board(
            request, conn, provider_fn, config, column_dim, swimlane_dim, token, filters, force
        )

    def _serve_board(self, request, conn, provider_fn, config, column_dim, swimlane_dim, token, filters, force=False):
        """Stale-while-revalidate read with a single-flight lock.

        At most one request revalidates a given (repo, pivot) at a time; every
        other concurrent viewer is served the last good copy immediately. On a
        provider error we degrade to the stale copy rather than failing the board,
        so a transient rate-limit or network blip is invisible to viewers and we
        never retry-storm the provider. ``force`` (the Refresh button) skips the
        fresh-cache return so a warm copy is revalidated instead of re-served.
        """
        # Scope the cache to the viewer only when we fetch with their credential
        # (GitHub). Anonymous (GitLab public) reads share one copy across the board.
        user_scope = request.user.id if token is not None else None
        key = _board_cache_key(
            conn.provider, conn.repo_slug, column_dim, swimlane_dim, user_scope, filters
        )
        entry = cache.get(key)
        if not force and entry is not None and time.time() < entry["soft_expires"]:
            return _board_response(entry["payload"], request)  # fresh

        # Past this point every path hits the provider, so spend the budget first —
        # before taking the lock, so an exhausted caller never holds it (#1071
        # security-review finding).
        if not _claim_fetch_budget(conn, request.user):
            if entry is not None:
                return _board_response(entry["payload"], request)  # stale beats 429
            return Response(
                {
                    "detail": "Too many lens refreshes for this repository. Try again shortly.",
                    "code": "fetch_budget_exhausted",
                },
                status=429,
            )

        # Stale or cold: try to become the sole fetcher for this (repo, pivot).
        holding_lock = cache.add(_lock_key(key), "1", LENS_FETCH_LOCK_TTL)
        if entry is not None and not holding_lock:
            # Another request is already revalidating — serve the stale copy now.
            return _board_response(entry["payload"], request)

        try:
            data = provider_fn(token, conn.repo_slug, config, filters)
        except (
            providers.LensError,
            requests.RequestException,
            *_UNEXPECTED_PARSE_ERRORS,
        ) as exc:
            if isinstance(exc, _UNEXPECTED_PARSE_ERRORS):
                # The provider sent us a shape normalization didn't expect (#1085).
                # Never log payload contents/PII/tokens — exception type and the
                # connection identity are enough to go find it.
                logger.warning(
                    "git_lens: unexpected error parsing provider response "
                    "(conn_id=%s, provider=%s, exc_type=%s)",
                    conn.pk, conn.provider, type(exc).__name__,
                    exc_info=True,
                )
            if entry is not None:
                # Degrade to the last good copy instead of failing the board.
                return _board_response(entry["payload"], request)
            return _provider_error_response(exc)
        finally:
            if holding_lock:
                cache.delete(_lock_key(key))

        payload = data.to_dict()
        cache.set(
            key,
            {"payload": payload, "soft_expires": time.time() + LENS_CACHE_SOFT_TTL},
            LENS_CACHE_FILTERED_HARD_TTL if filters.active else LENS_CACHE_HARD_TTL,
        )
        return _board_response(payload, request)
