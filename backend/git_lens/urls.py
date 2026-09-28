from django.urls import path

from .views import LensBoardView, LensConnectionView, LensUsageAdminView

urlpatterns = [
    path(
        "git-lens/connections/<int:board_id>/",
        LensConnectionView.as_view(),
        name="lens-connection",
    ),
    path(
        "git-lens/board/<int:board_id>/",
        LensBoardView.as_view(),
        name="lens-board",
    ),
    # Site-admin usage telemetry (#1061). Under /api/v1/admin/ so the PAT admin-
    # scope prefix check, the maintenance-mode exemption and the demo fence all
    # treat it like every other admin route.
    path(
        "admin/git-lens/usage/",
        LensUsageAdminView.as_view(),
        name="lens-admin-usage",
    ),
]
