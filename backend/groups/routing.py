from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/groups/(?P<group_id>\d+)/$", consumers.GroupConsumer.as_asgi()),
]
