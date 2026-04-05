from rest_framework.pagination import LimitOffsetPagination
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
