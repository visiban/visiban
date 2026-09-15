from urllib.parse import parse_qs, urlparse

from rest_framework.pagination import CursorPagination, LimitOffsetPagination
from rest_framework.response import Response


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

    def get_ordering(self, request, queryset, view):
        requested = request.query_params.get("ordering")
        if requested in self._ALLOWED_ORDERINGS:
            return self._ALLOWED_ORDERINGS[requested]
        return self.ordering

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
