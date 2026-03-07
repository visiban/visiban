from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/boards/(?P<board_id>\d+)/$", consumers.BoardConsumer.as_asgi()),
]
