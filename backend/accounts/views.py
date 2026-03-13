from django.conf import settings
from django.contrib.auth import get_user_model, update_session_auth_hash
from django.db.models import Q
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework import status
from .serializers import UserSerializer

User = get_user_model()


class UserSearchView(APIView):
    """Search users by display name, email, or username; requires at least 2 characters."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        query = request.query_params.get("search", "").strip()
        if len(query) < 2:
            return Response([])
        users = (
            User.objects.filter(
                Q(display_name__icontains=query)
                | Q(email__icontains=query)
                | Q(username__icontains=query)
                | Q(first_name__icontains=query)
            )
            .exclude(pk=request.user.pk)
            .order_by("display_name", "username")[:10]
        )
        return Response(UserSerializer(users, many=True).data)


class AuthProvidersView(APIView):
    """Return which OAuth providers (Google, GitHub, GitLab) are configured on this instance."""

    permission_classes = [AllowAny]

    def get(self, request):
        providers = settings.SOCIALACCOUNT_PROVIDERS
        return Response({
            "google": bool(providers.get("google", {}).get("APP", {}).get("client_id")),
            "github": bool(providers.get("github", {}).get("APP", {}).get("client_id")),
            "gitlab": bool(providers.get("gitlab", {}).get("APP", {}).get("client_id")),
        })


class CurrentUserView(APIView):
    """Retrieve or update the currently authenticated user's profile."""

    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = UserSerializer(request.user, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class ChangePasswordView(APIView):
    """Change the authenticated user's password, keeping the session alive afterwards."""

    def post(self, request):
        current_password = request.data.get("current_password", "")
        new_password = request.data.get("new_password", "")

        if not new_password or len(new_password) < 12:
            return Response(
                {"detail": "New password must be at least 12 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Social-only accounts have no usable password — skip the current
        # password check so they can set one for the first time.
        if request.user.has_usable_password():
            if not request.user.check_password(current_password):
                return Response(
                    {"detail": "Current password is incorrect."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        request.user.set_password(new_password)
        request.user.must_change_password = False
        request.user.save(update_fields=["password", "must_change_password"])
        # Keep the current session alive after the password rotation so the
        # user does not get logged out and left with a broken session state.
        update_session_auth_hash(request, request.user)
        return Response({"detail": "Password changed successfully."})
