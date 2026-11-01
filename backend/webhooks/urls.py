from rest_framework.routers import SimpleRouter

from .views import WebhookSubscriptionViewSet

# Board-scoped, but registered from this app so the boards app stays unaware of
# webhooks. The board id segment matches the digits-only rule BoardViewSet uses.
router = SimpleRouter()
router.register(
    r"boards/(?P<board_pk>\d+)/webhooks",
    WebhookSubscriptionViewSet,
    basename="board-webhook",
)

urlpatterns = router.urls
