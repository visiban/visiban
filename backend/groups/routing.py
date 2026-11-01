from django.urls import re_path

from . import consumers

# Ids are BigAutoField (max 19 digits, 9223372036854775807); bound the match to
# 18 digits so an oversized id never reaches the DB lookup and overflows (#1945).
websocket_urlpatterns = [
    re_path(r"ws/groups/(?P<group_id>\d{1,18})/$", consumers.GroupConsumer.as_asgi()),
]
