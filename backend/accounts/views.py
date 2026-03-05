from rest_framework.views import APIView
from rest_framework.response import Response
from .serializers import UserSerializer


class CurrentUserView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data)
