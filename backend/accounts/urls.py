from django.urls import path
from .views import (
    AuthProvidersView, ChangePasswordView, ChooseUsernameView, CurrentUserView,
    PersonalAccessTokenDeleteView, PersonalAccessTokenListCreateView,
    SiteConfigView, UserSearchView, WSTicketView,
)
from .admin_views import (
    AdminActionLogView, AdminSettingsView, AdminUsersView, AdminUserDetailView,
    AdminEmailSettingsView, AdminEmailTestView,
    AdminInviteLinkListCreateView, AdminInviteLinkRevokeView,
    AdminUserDeactivateView,
)

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
    path("auth/site-config/", SiteConfigView.as_view()),
    path("auth/change-password/", ChangePasswordView.as_view()),
    path("auth/choose-username/", ChooseUsernameView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
    path("auth/tokens/", PersonalAccessTokenListCreateView.as_view()),
    path("auth/tokens/<int:pk>/", PersonalAccessTokenDeleteView.as_view()),
    path("auth/ws-ticket/", WSTicketView.as_view()),
    path("users/", UserSearchView.as_view()),
    # Admin API — all gated by IsSiteAdmin
    path("admin/settings/", AdminSettingsView.as_view()),
    path("admin/email-settings/", AdminEmailSettingsView.as_view()),
    path("admin/email-settings/test/", AdminEmailTestView.as_view()),
    path("admin/action-log/", AdminActionLogView.as_view()),
    path("admin/users/", AdminUsersView.as_view()),
    path("admin/users/<int:pk>/", AdminUserDetailView.as_view()),
    path("admin/users/<int:pk>/deactivate/", AdminUserDeactivateView.as_view()),
    path("admin/invite-links/", AdminInviteLinkListCreateView.as_view()),
    path("admin/invite-links/<int:pk>/", AdminInviteLinkRevokeView.as_view()),
]
