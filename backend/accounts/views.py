from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny
from rest_framework import status
from .serializers import UserSerializer


class AuthProvidersView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        providers = settings.SOCIALACCOUNT_PROVIDERS
        return Response({
            "google": bool(providers.get("google", {}).get("APP", {}).get("client_id")),
            "github": bool(providers.get("github", {}).get("APP", {}).get("client_id")),
            "gitlab": bool(providers.get("gitlab", {}).get("APP", {}).get("client_id")),
        })


class CurrentUserView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = UserSerializer(request.user, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class ChangePasswordView(APIView):
    def post(self, request):
        current_password = request.data.get("current_password", "")
        new_password = request.data.get("new_password", "")

        if not new_password or len(new_password) < 12:
            return Response(
                {"detail": "New password must be at least 12 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not request.user.check_password(current_password):
            return Response(
                {"detail": "Current password is incorrect."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        request.user.set_password(new_password)
        request.user.must_change_password = False
        request.user.save(update_fields=["password", "must_change_password"])
        return Response({"detail": "Password changed successfully."})
