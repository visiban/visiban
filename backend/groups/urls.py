from django.urls import path, include
from rest_framework.routers import SimpleRouter
from .views import GroupViewSet, JoinGroupView

router = SimpleRouter()
router.register(r"groups", GroupViewSet, basename="group")

# The join route must precede the router: the router's detail-action patterns
# (`groups/<pk>/star/`, `groups/<pk>/labels/`, ...) otherwise match
# `groups/join/<token>/` with pk="join" whenever the token equals an action
# name, answering 405/404 from GroupViewSet instead of JoinGroupView. This
# ordering is now belt-and-braces: GroupViewSet.lookup_value_regex (#1202)
# constrains the router's own pk segment to digits, so "join" can no longer
# match a detail route as a pk even if this ordering is ever changed back.
urlpatterns = [
    path("groups/join/<str:token>/", JoinGroupView.as_view(), name="group-join"),
    path("", include(router.urls)),
]
