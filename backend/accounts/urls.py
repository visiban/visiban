from django.urls import path, re_path
from .views import (
    AuthProvidersView, ChangePasswordView, ChooseUsernameView,
    ConnectedAccountDetailView, ConnectedAccountsView, CurrentUserView,
    PendingConnectView, PendingEmailResendView, PendingEmailView,
    PersonalAccessTokenDeleteView, PersonalAccessTokenListCreateView,
    SiteConfigView, UserSearchView, WSTicketView,
)
from .admin_views import (
    AdminActionLogView, AdminSettingsView, AdminUsersView, AdminUserDetailView,
    AdminEmailSettingsView, AdminEmailTestView,
    AdminInviteLinkListCreateView,
    AdminInviteLinkSendView,
    AdminInviteLinkRevokeView,
    AdminBoardInviteLinkListView,
    AdminBoardInviteLinkRevokeView,
    AdminUserClearLockoutView, AdminUserDeactivateView,
)

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
    path("auth/site-config/", SiteConfigView.as_view()),
    path("auth/change-password/", ChangePasswordView.as_view()),
    path("auth/choose-username/", ChooseUsernameView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
    # #1293: withdraw / resend a pending email change (EMAIL_VERIFICATION=mandatory).
    path("auth/me/pending-email/", PendingEmailView.as_view()),
    path("auth/me/pending-email/resend/", PendingEmailResendView.as_view()),
    # #1314: connected sign-in providers, and the post-login connect prompt.
    path("auth/me/pending-connect/", PendingConnectView.as_view()),
    path("auth/me/connected-accounts/", ConnectedAccountsView.as_view()),
    re_path(
        r"^auth/me/connected-accounts/(?P<provider>[a-z0-9_-]{1,64})/$",
        ConnectedAccountDetailView.as_view(),
    ),
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
    path("admin/users/<int:pk>/clear-lockout/", AdminUserClearLockoutView.as_view()),
    path("admin/invite-links/", AdminInviteLinkListCreateView.as_view()),
    path("admin/invite-links/send/", AdminInviteLinkSendView.as_view()),
    path("admin/invite-links/<int:pk>/", AdminInviteLinkRevokeView.as_view()),
    # Board invites across every board (#439).
    path("admin/board-invite-links/", AdminBoardInviteLinkListView.as_view()),
    path("admin/board-invite-links/<int:pk>/", AdminBoardInviteLinkRevokeView.as_view()),
]
