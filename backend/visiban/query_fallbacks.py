"""Make serializer live-query fallbacks visible outside production (#1731).

Several serializer method fields read an annotation or a prefetched attribute
that the endpoint's queryset supplies (``_member_count``, ``_is_starred``, a
``select_related`` chain, an injected map) and fall back to a live query when it
is missing. The fallback keeps a bare instance correct, but on a list it costs
one query per row, and nothing told a new caller it had skipped the annotated
queryset: the response was right, only slower (#799, #993).

``note_fallback`` is called just before such a fallback query runs. What it
does depends on ``settings.SERIALIZER_FALLBACK_GUARD``:

* ``"off"`` (production): nothing. Behavior and query counts are unchanged.
* ``"warn"`` (``DEBUG``): logs a warning naming the serializer field.
* ``"raise"`` (the test suite): raises ``UnannotatedFallback``, so a test that
  drives a new unannotated caller fails and names the field.

``per_row=True`` (the default) reports only when the serializer is rendering a
list (its parent is a ``ListSerializer``), which is where the fallback is an
N+1. A single-object response that falls back pays one query, which is the
documented purpose of the fallback, so it is not reported. ``per_row=False`` is
for fields whose only callers are expected to supply the data even for one
object.
"""

import logging

from django.conf import settings
from rest_framework.serializers import ListSerializer

logger = logging.getLogger(__name__)

GUARD_OFF = "off"
GUARD_WARN = "warn"
GUARD_RAISE = "raise"


class UnannotatedFallback(AssertionError):
    """A serializer fell back to a live query the caller should have avoided.

    An ``AssertionError`` so it reads as a test failure. Only raised under
    ``SERIALIZER_FALLBACK_GUARD = "raise"``, which only the test suite sets.
    """


def _renders_a_list(serializer) -> bool:
    return isinstance(getattr(serializer, "parent", None), ListSerializer)


def note_fallback(serializer, field: str, *, per_row: bool = True) -> None:
    """Report that ``serializer``'s ``field`` is about to run its fallback query."""
    mode = getattr(settings, "SERIALIZER_FALLBACK_GUARD", GUARD_OFF)
    if mode == GUARD_OFF:
        return
    if per_row and not _renders_a_list(serializer):
        return
    where = f"{type(serializer).__name__}.{field}"
    message = (
        f"{where} fell back to a live query: the queryset that fed this serializer "
        "is missing the annotation or prefetch the field reads. Fetch through the "
        "endpoint's annotated queryset (see the field's comment). See #1731."
    )
    if mode == GUARD_RAISE:
        raise UnannotatedFallback(message)
    logger.warning(message)


def fk_chain_loaded(instance, field_name: str, max_depth: int) -> bool:
    """True when following ``field_name`` from ``instance`` needs no query.

    Walks the self-referential foreign key (``Group.parent``) up to
    ``max_depth`` levels, checking each hop is already in Django's field cache
    (``select_related`` or an earlier access put it there).
    """
    field = type(instance)._meta.get_field(field_name)
    node = instance
    for _ in range(max_depth):
        if getattr(node, field.attname) is None:
            return True
        if not field.is_cached(node):
            return False
        node = getattr(node, field_name)
    return True
