from django.urls import path, include
from rest_framework_nested import routers
from rest_framework.routers import SimpleRouter
from .views import (
    BoardViewSet, BoardTemplateListView,
    ColumnViewSet, SwimlaneViewSet, LabelViewSet, CardViewSet,
    CardQueryViewSet, CustomFieldDefinitionViewSet,
    SwimlaneCustomFieldDefinitionViewSet,
    NotificationListView, NotificationMarkReadView, NotificationUnreadCountView,
    VersionView,
)

# Use SimpleRouter (not DefaultRouter) for the parent router to avoid a
# ValueError on startup. DefaultRouter calls format_suffix_patterns() when its
# .urls property is accessed, and NestedDefaultRouter does too — registering
# the same drf_format_suffix converter twice raises ValueError on any
# manage.py invocation.
router = SimpleRouter()
router.register(r"boards", BoardViewSet, basename="board")
# Top-level, cross-board card query endpoint (#1112) — list only, registered
# alongside `boards` rather than nested under it since it spans boards. Distinct
# from `boards_router`'s `boards/<board_pk>/cards/` (CardViewSet, basename
# "board-card") below.
router.register(r"cards", CardQueryViewSet, basename="card")

boards_router = routers.NestedDefaultRouter(router, r"boards", lookup="board")
boards_router.register(r"columns", ColumnViewSet, basename="board-column")
boards_router.register(r"swimlanes", SwimlaneViewSet, basename="board-swimlane")
boards_router.register(r"labels", LabelViewSet, basename="board-label")
boards_router.register(r"cards", CardViewSet, basename="board-card")
boards_router.register(
    r"custom-fields", CustomFieldDefinitionViewSet, basename="board-custom-field"
)
boards_router.register(
    r"swimlane-custom-fields",
    SwimlaneCustomFieldDefinitionViewSet,
    basename="board-swimlane-custom-field",
)

urlpatterns = [
    # The templates endpoint must come before include(router.urls) so Django
    # matches it before the router's boards/<pk>/ pattern can claim "templates"
    # as a board PK.
    path("boards/templates/", BoardTemplateListView.as_view()),
    path("", include(router.urls)),
    path("", include(boards_router.urls)),
    path("notifications/", NotificationListView.as_view()),
    path("notifications/mark-read/", NotificationMarkReadView.as_view()),
    path("notifications/unread-count/", NotificationUnreadCountView.as_view()),
    path("version/", VersionView.as_view()),
]
