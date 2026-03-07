from rest_framework import serializers
from .models import User


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email", "first_name", "last_name", "avatar_url", "display_name", "is_site_admin", "must_change_password"]
        read_only_fields = ["id", "is_site_admin", "must_change_password"]
