from django.urls import path, include
from rest_framework.routers import SimpleRouter
from .views import GroupViewSet, JoinGroupView

router = SimpleRouter()
router.register(r"groups", GroupViewSet, basename="group")

urlpatterns = [
    path("", include(router.urls)),
    path("groups/join/<str:token>/", JoinGroupView.as_view(), name="group-join"),
]
