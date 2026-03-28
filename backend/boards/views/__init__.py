"""boards.views — re-exports all public names for backward compatibility.

This package was extracted from a single views.py file. All public names are
re-exported here so that existing imports (urls.py, tests, etc.) continue to
work without modification.
"""

# ViewSets
from .boards import BoardViewSet  # noqa: F401
from .columns import ColumnViewSet  # noqa: F401
from .swimlanes import SwimlaneViewSet  # noqa: F401
from .labels import LabelViewSet  # noqa: F401
from .cards import CardViewSet, CardFilter  # noqa: F401

# Standalone API views
from .notifications import (  # noqa: F401
    NotificationListView,
    NotificationMarkReadView,
    NotificationUnreadCountView,
)
from .templates import BoardTemplateListView  # noqa: F401
from .share import ShareBoardView, ShareLinkThrottle  # noqa: F401
from .media import ServeMediaView  # noqa: F401
from .health import LivenessView, ReadinessView, VersionView  # noqa: F401

# Helper functions and constants used by tests and other modules
from ._helpers import (  # noqa: F401
    get_board_for_user,
    _can_modify_others_content,
    _refetched_card_data,
)
from .cards import (  # noqa: F401
    _validate_upload_mime,
    _MAGIC_SIGNATURES,
    _ALLOWED_MIME_TYPES,
)
from .import_export import _sanitize_csv_field  # noqa: F401

# Re-export broadcast_board_event so that mock.patch("boards.views.broadcast_board_event")
# still works in tests. Submodules access it through the broadcast module object
# (from .. import broadcast as _broadcast) so the mock propagates correctly.
from ..broadcast import broadcast_board_event  # noqa: F401
