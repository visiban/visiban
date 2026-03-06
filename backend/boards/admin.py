from django.contrib import admin
from .models import Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement, CardComment

admin.site.register(Board)
admin.site.register(BoardMembership)
admin.site.register(Column)
admin.site.register(Swimlane)
admin.site.register(Label)
admin.site.register(Card)
admin.site.register(CardMovement)
admin.site.register(CardComment)
