"""Custom ORM lookups for boards.

``CardTextContains`` exists so card search can use the ``pg_trgm`` GIN indexes
from migration ``0030_card_trigram_search_indexes`` (#1809).
"""

from django.db.models import CharField, TextField
from django.db.models.lookups import IContains


class CardTextContains(IContains):
    """Case-insensitive substring match that PostgreSQL can serve from a trigram index.

    Why: Django renders ``icontains`` on PostgreSQL as ``UPPER(col::text) LIKE
    UPPER(%s)``. The trigram indexes are on the bare columns, so the planner
    cannot use them for that expression and falls back to a sequential scan.
    ``col ILIKE %s`` matches the index and returns the same rows.

    Everything else is inherited from ``IContains``: the right-hand side is a
    bound parameter, and ``%``, ``_`` and ``\\`` in the user's term are escaped by
    ``connection.ops.prep_for_like_query`` exactly as for ``icontains``. On other
    backends (SQLite in local dev) this renders as plain ``icontains`` SQL.
    """

    lookup_name = "ci_contains"

    def process_rhs(self, compiler, connection):
        # PatternLookup wraps expression right-hand sides (F(), Concat) with
        # connection.pattern_ops; our get_rhs_op bypasses that, so an expression
        # would render with no % wrapping or escaping. Card search only ever
        # passes a literal term, so refuse rather than silently mis-match.
        if not self.rhs_is_direct_value():
            raise NotImplementedError(
                "ci_contains supports only literal right-hand values."
            )
        return super().process_rhs(compiler, connection)

    def as_postgresql(self, compiler, connection):
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        return f"{lhs} ILIKE {rhs}", (*lhs_params, *rhs_params)

    def get_rhs_op(self, connection, rhs):
        # Non-PostgreSQL backends: same operator as ``icontains``. Django keys
        # ``connection.operators`` by lookup name, so ours would KeyError.
        return connection.operators["icontains"] % rhs


CharField.register_lookup(CardTextContains)
TextField.register_lookup(CardTextContains)
