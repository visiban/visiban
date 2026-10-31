from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from django.utils.dateparse import parse_datetime

from rest_framework.exceptions import NotFound
from rest_framework.pagination import CursorPagination, LimitOffsetPagination
from rest_framework.response import Response

from visiban.exceptions import INVALID_QUERY_PARAM, CodedValidationError

# Postgres stores a UTC offset only below 16 hours (same bound as
# boards.views._helpers.BoundedDateTimeFilter, #1120).
_PG_MAX_UTC_OFFSET = timedelta(hours=16)


def _invalid_cursor():
    return CodedValidationError(INVALID_QUERY_PARAM, "cursor is not a valid page cursor.")


class OffsetCountPagination(LimitOffsetPagination):
    """Standard paginated response shape for all list endpoints: {count, offset, page_size, results}.

    Standardized at 1.0 to unify the DRF PageNumberPagination shape ({count, next, previous,
    results}) used by board/group list endpoints with the hand-rolled offset shape used by
    movements and archived-cards endpoints. All paginated endpoints now emit the same contract.

    Query params:
      offset  — zero-based row offset (default 0)
      page_size — rows per page (default 50, max 200)
    """

    default_limit = 50
    max_limit = 200
    limit_query_param = "page_size"
    offset_query_param = "offset"

    def get_paginated_response(self, data):
        return Response({
            "count": self.count,
            "offset": self.offset,
            "page_size": self.limit,
            "results": data,
        })

    def get_paginated_response_schema(self, schema):
        return {
            "type": "object",
            "required": ["count", "offset", "page_size", "results"],
            "properties": {
                "count": {"type": "integer", "example": 123},
                "offset": {"type": "integer", "example": 0},
                "page_size": {"type": "integer", "example": 50},
                "results": schema,
            },
        }


class CardQueryCursorPagination(CursorPagination):
    """Cursor-paginated response shape for the cross-board card query endpoint
    (#1112): {results, next_cursor} — deliberately NOT the {count, offset,
    page_size, results} envelope of OffsetCountPagination used everywhere else.

    Offset pagination requires a stable COUNT(*) and a stable row order under
    concurrent writes; neither holds for a cross-board card feed used for
    incremental sync (new/updated cards keep landing while a client pages
    through). Cursor pagination has no COUNT(*) and its cursor encodes a
    position on (ordering field, id) rather than an offset, so rows inserted
    or updated during a page walk cannot shift already-issued cursors out from
    under the client the way an offset would.

    Ordering is intentionally NOT auto-detected from a `filter_backends`
    OrderingFilter (DRF's default CursorPagination.get_ordering() would do
    this if the view had one registered) — that path lets a client request any
    single serializer field with no forced tiebreaker, and ties on that field
    would make the cursor skip or repeat rows. get_ordering() below instead
    validates ?ordering= against a fixed allowlist and always appends a
    matching-direction `id` tiebreaker. Only non-nullable fields are allowed
    orderings: `due_date` is deliberately excluded even though CardFilter
    exposes it as a filter — it is nullable, and DRF's cursor cutoff comparison
    does not define an ordering position for NULL, so paging by a nullable
    field can silently skip or duplicate rows across the boundary.
    """

    ordering = ("-updated_at", "-id")
    page_size = 50
    max_page_size = 200
    page_size_query_param = "page_size"
    cursor_query_param = "cursor"

    # Client-facing ?ordering= value -> validated (ordering_field, tiebreaker)
    # tuple, tiebreaker direction always matching the primary field's direction
    # so cursor position comparisons stay consistent.
    _ALLOWED_ORDERINGS = {
        "updated_at": ("updated_at", "id"),
        "-updated_at": ("-updated_at", "-id"),
        "created_at": ("created_at", "id"),
        "-created_at": ("-created_at", "-id"),
    }

    def decode_cursor(self, request):
        """DRF's decode, with a malformed cursor as the bad-query-param 400 (#1832).

        DRF answers an undecodable ``?cursor=`` with ``404 {"detail": "Invalid
        cursor"}``. A garbled query parameter is a client error, not a missing
        resource, and the refused query parameters listed in docs/api/index.md
        ("Bad query parameters") answer ``400`` with
        ``code: "invalid_query_param"``. ``GET /cards/`` is new in 1.2, so the
        404 never shipped in a GA. ``decode_cursor`` raises ``NotFound`` only
        for an undecodable cursor, so catching it here changes nothing else.

        A cursor that decodes but carries a position that is not a datetime
        (hand-built, e.g. ``p=notadate``) used to reach the ORM filter and 500.
        Every allowed ordering is a datetime column (``_ALLOWED_ORDERINGS``),
        so the position is checked here: it must parse as a datetime, with a
        UTC offset Postgres can store (the cursors this class issues are
        always ``+00:00``; see ``BoundedDateTimeFilter`` for the 16-hour bound).
        """
        try:
            cursor = super().decode_cursor(request)
        except NotFound:
            raise _invalid_cursor() from None
        if cursor is not None and cursor.position is not None:
            try:
                position = parse_datetime(cursor.position)
            except ValueError:
                position = None
            offset = position.utcoffset() if position is not None else None
            if position is None or (offset is not None and abs(offset) >= _PG_MAX_UTC_OFFSET):
                raise _invalid_cursor()
        return cursor

    def get_ordering(self, request, queryset, view):
        requested = request.query_params.get("ordering")
        if requested in self._ALLOWED_ORDERINGS:
            return self._ALLOWED_ORDERINGS[requested]
        return self.ordering

    def get_schema_operation_parameters(self, view):
        """DRF's ``cursor``/``page_size``, plus the ``ordering`` this class parses (#1887).

        ``ordering`` is read here, not by an ``OrderingFilter`` (see the class
        docstring), so no filter backend publishes it; the enum is the
        allowlist above.
        """
        params = super().get_schema_operation_parameters(view)
        for param in params:
            if param["name"] == self.page_size_query_param:
                param["description"] = (
                    f"Rows per page (default {self.page_size}, max {self.max_page_size})."
                )
        params.append({
            "name": "ordering",
            "required": False,
            "in": "query",
            "description": (
                "Sort order, with an `id` tiebreaker in the same direction. Default "
                "`-updated_at` (most recently updated first). An unrecognized value "
                "falls back to the default rather than erroring."
            ),
            "schema": {"type": "string", "enum": list(self._ALLOWED_ORDERINGS)},
        })
        return params

    def get_paginated_response(self, data):
        next_cursor = None
        next_link = self.get_next_link()
        if next_link:
            next_cursor = parse_qs(urlparse(next_link).query).get(self.cursor_query_param, [None])[0]
        return Response({"results": data, "next_cursor": next_cursor})

    def get_paginated_response_schema(self, schema):
        return {
            "type": "object",
            "required": ["results", "next_cursor"],
            "properties": {
                "results": schema,
                "next_cursor": {
                    "type": "string",
                    "nullable": True,
                    "description": "Opaque cursor for the next page, or null when this is the last page.",
                },
            },
        }
