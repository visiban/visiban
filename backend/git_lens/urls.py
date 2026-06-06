from django.urls import path

from .views import LensBoardView, LensConnectionView

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
]
