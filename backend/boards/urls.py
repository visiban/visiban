from django.urls import path, include
from rest_framework_nested import routers
from rest_framework.routers import DefaultRouter
from .views import BoardViewSet, ColumnViewSet, CustomerViewSet, LabelViewSet, CardViewSet

router = DefaultRouter()
router.register(r"boards", BoardViewSet, basename="board")

boards_router = routers.NestedDefaultRouter(router, r"boards", lookup="board")
boards_router.register(r"columns", ColumnViewSet, basename="board-column")
boards_router.register(r"customers", CustomerViewSet, basename="board-customer")
boards_router.register(r"labels", LabelViewSet, basename="board-label")
boards_router.register(r"cards", CardViewSet, basename="board-card")

urlpatterns = [
    path("", include(router.urls)),
    path("", include(boards_router.urls)),
]
