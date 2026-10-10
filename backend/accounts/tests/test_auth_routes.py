"""Every route under ``api/v1/auth/`` resolves to the project's view (#1540).

dj-rest-auth registers its routes as ``re_path(r"<name>/?$")``, matching both
slash forms. ``visiban/urls.py`` therefore does not include its urlconfs and
registers each auth route itself, anchored and matching both forms, so the
project's throttles, scope gate, and password-change side effects apply to
whichever form a client sends. These tests pin that:

- no dj-rest-auth urlconf is included anywhere in the root resolver;
- every route under ``api/v1/auth/`` is anchored and serves a project view,
  or one of the stock views listed in ``APPROVED_STOCK_VIEWS``;
- both slash forms of each auth endpoint resolve to the expected view;
- the project behavior is observable on the no-slash form too.
"""

from django.test import SimpleTestCase
from django.urls import URLPattern, URLResolver, get_resolver, resolve
from django.urls.resolvers import RegexPattern
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts import views as account_views
from accounts.models import SCOPE_WRITE, PersonalAccessToken, User

#: Stock dj-rest-auth views that may serve an ``api/v1/auth/`` route, with why.
APPROVED_STOCK_VIEWS = {
    "dj_rest_auth.views.LogoutView": "AllowAny by design; ends only the caller's own session or token.",
    "dj_rest_auth.registration.views.ResendEmailVerificationView": "Public resend; no project subclass exists.",
}

#: Path (without leading slash, with trailing slash) -> the view class it must
#: resolve to. Each is checked with and without the trailing slash.
EXPECTED = {
    "api/v1/auth/login/": account_views.ThrottledLoginView,
    "api/v1/auth/password/reset/": account_views.ThrottledPasswordResetView,
    "api/v1/auth/password/reset/confirm/": account_views.ThrottledPasswordResetConfirmView,
    "api/v1/auth/user/": account_views.UserDetailsView,
    "api/v1/auth/password/change/": account_views.TokenRevokingPasswordChangeView,
    "api/v1/auth/registration/verify-email/": account_views.VerifyEmailView,
}


def _walk(patterns, prefix=""):
    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            yield from _walk(pattern.url_patterns, prefix + str(pattern.pattern))
        elif isinstance(pattern, URLPattern):
            yield prefix + str(pattern.pattern), pattern


def _view_class(callback):
    return getattr(callback, "cls", None) or getattr(callback, "view_class", None)


def _dotted(cls):
    return f"{cls.__module__}.{cls.__qualname__}"


def _resolved_class(path):
    return _view_class(resolve(path).func)


class AuthRouteResolutionTests(SimpleTestCase):
    def test_no_dj_rest_auth_urlconf_is_included(self):
        def resolvers(patterns):
            for pattern in patterns:
                if isinstance(pattern, URLResolver):
                    yield pattern
                    yield from resolvers(pattern.url_patterns)

        included = [
            getattr(r.urlconf_module, "__name__", str(r.urlconf_name))
            for r in resolvers(get_resolver().url_patterns)
        ]
        self.assertFalse(
            [name for name in included if name.startswith("dj_rest_auth")],
            "Register auth routes explicitly in visiban/urls.py instead of including dj-rest-auth's urlconfs.",
        )

    def test_every_auth_route_is_anchored_and_serves_an_approved_view(self):
        auth_routes = [(r, p) for r, p in _walk(get_resolver().url_patterns) if "api/v1/auth/" in r]
        self.assertTrue(auth_routes)
        problems = []
        for route, pattern in auth_routes:
            if isinstance(pattern.pattern, RegexPattern) and not route.startswith("^"):
                problems.append(f"{route}: regex route is not anchored")
            cls = _view_class(pattern.callback)
            if cls is None:
                continue  # function views: covered by test_auth_entry_points' NON_DRF_ALLOWLIST
            key = _dotted(cls)
            if key.startswith("dj_rest_auth.") and key not in APPROVED_STOCK_VIEWS:
                problems.append(f"{route}: serves stock view {key}")
        self.assertEqual(problems, [])

    def test_both_slash_forms_resolve_to_the_project_view(self):
        for path, cls in EXPECTED.items():
            for form in (f"/{path}", f"/{path.rstrip('/')}"):
                with self.subTest(form=form):
                    self.assertIs(_resolved_class(form), cls)

    def test_approved_stock_routes_resolve_in_both_forms(self):
        for path, key in (
            ("api/v1/auth/logout/", "dj_rest_auth.views.LogoutView"),
            ("api/v1/auth/registration/resend-email/", "dj_rest_auth.registration.views.ResendEmailVerificationView"),
        ):
            for form in (f"/{path}", f"/{path.rstrip('/')}"):
                with self.subTest(form=form):
                    self.assertEqual(_dotted(_resolved_class(form)), key)

    def test_registration_resolves_to_invite_register_view(self):
        self.assertIs(_resolved_class("/api/v1/auth/registration/"), account_views.InviteRegisterView)

    def test_route_names_still_reverse(self):
        from django.urls import reverse

        self.assertEqual(reverse("rest_logout"), "/api/v1/auth/logout")
        self.assertEqual(reverse("rest_resend_email"), "/api/v1/auth/registration/resend-email")
        self.assertEqual(
            reverse("account_confirm_email", args=["abc:def"]),
            "/api/v1/auth/registration/account-confirm-email/abc:def/",
        )
        self.assertEqual(
            reverse("account_email_verification_sent"),
            "/api/v1/auth/registration/account-email-verification-sent",
        )


class NoSlashFormAppliesProjectBehaviorTests(APITestCase):
    """The project's side effects and gates hold on the no-slash form."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="noslash", password="NoSlashPass123!")

    def test_password_change_without_slash_revokes_tokens_and_clears_the_flag(self):
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        PersonalAccessToken.generate(self.user, "a")
        self.client.force_authenticate(self.user)
        r = self.client.post(
            "/api/v1/auth/password/change",
            {
                "old_password": "NoSlashPass123!",
                "new_password1": "BrandNewPass456!",
                "new_password2": "BrandNewPass456!",
            },
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_user_details_without_slash_applies_the_token_scope_gate(self):
        _, raw = PersonalAccessToken.generate(self.user, "w", scopes=[SCOPE_WRITE])
        r = self.client.get("/api/v1/auth/user", HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
