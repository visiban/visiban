from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import GroupViewSet, JoinGroupView

router = DefaultRouter()
router.register(r"groups", GroupViewSet, basename="group")

urlpatterns = [
    path("", include(router.urls)),
    path("groups/join/<uuid:token>/", JoinGroupView.as_view(), name="group-join"),
]
