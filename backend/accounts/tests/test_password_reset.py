"""Tests for the password-reset flow: URL generation, OAuth-only user handling,
throttled endpoint, and confirm with valid/expired tokens."""
from unittest.mock import MagicMock, patch

from allauth.account.forms import default_token_generator
from allauth.account.utils import user_pk_to_url_str
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from dj_rest_auth.forms import AllAuthPasswordResetForm

from accounts.forms import VisibanPasswordResetForm, _frontend_url_generator
from accounts.models import User


class FrontendUrlGeneratorTests(TestCase):
    """_frontend_url_generator builds the correct SPA URL."""

    def _make_user(self):
        return User.objects.create_user(username="urltest", email="url@example.com", password="pass1")

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_url_uses_frontend_url(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "abc123-def456")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/abc123-def456")

    @override_settings(FRONTEND_URL="https://app.example.com/")
    def test_url_strips_trailing_slash(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "xyz-token")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/xyz-token")

    @override_settings(FRONTEND_URL="http://localhost:5173")
    def test_url_dev_default(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "tok-en")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"http://localhost:5173/reset-password/{uid}/tok-en")

    def test_url_reads_the_real_setting_without_an_override(self):
        """Regression: settings.FRONTEND_URL must actually exist (#356).

        ``_frontend_url_generator`` has always resolved it with
        ``getattr(settings, "FRONTEND_URL", "http://localhost:5173")``, but until
        #356 no setting was defined under that name — the env var was only ever
        read into LOGIN_REDIRECT_URL. So the getattr always took the localhost
        fallback and every production reset link pointed at a developer's laptop.
        Every test above masks that by injecting the setting with
        ``@override_settings``; this one deliberately does not, so the bug cannot
        come back unnoticed.
        """
        from django.conf import settings

        self.assertTrue(hasattr(settings, "FRONTEND_URL"))
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "real-token")
        self.assertTrue(url.startswith(settings.FRONTEND_URL.rstrip("/")))
        self.assertEqual(settings.FRONTEND_URL, settings.LOGIN_REDIRECT_URL)


class OAuthOnlyPasswordResetTests(TestCase):
    """VisibanPasswordResetForm.save() for accounts with no usable password.

    #1314 deliberately reversed part of this: a password-less account whose
    address is VERIFIED now gets the real set-password link (the "genuinely
    stuck" recovery path — lost access to the provider it signed up with).
    Only an UNVERIFIED password-less account still gets the alternate "sign in
    with your provider" email, because mail reaching an unverified address
    proves nothing about who owns the account.
    """

    def _oauth_only_user(self, *, verified):
        from allauth.account.models import EmailAddress
        from allauth.socialaccount.models import SocialAccount

        user = User.objects.create_user(username="oauthuser", email="oauth@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="google-123", extra_data={})
        EmailAddress.objects.create(user=user, email="oauth@example.com", verified=verified, primary=True)
        return user

    def _save(self, user, email="oauth@example.com"):
        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": email}
        form.users = [user]
        mock_adapter = MagicMock()
        seen_users = []

        def fake_super_save(this, request, **kwargs):
            seen_users.extend(this.users)

        with patch("accounts.forms.get_adapter", return_value=mock_adapter), patch.object(
            AllAuthPasswordResetForm, "save", autospec=True, side_effect=fake_super_save
        ):
            form.save(MagicMock())
        return mock_adapter, seen_users

    def test_unverified_oauth_only_user_gets_alternate_email(self):
        user = self._oauth_only_user(verified=False)

        mock_adapter, seen_users = self._save(user)

        # send_mail must be called with the no-password template.
        # All three args are positional: (template_prefix, email, context_dict).
        mock_adapter.send_mail.assert_called_once()
        args, _ = mock_adapter.send_mail.call_args
        self.assertEqual(args[0], "account/email/password_reset_no_password")
        self.assertEqual(args[2]["provider"], "Google")
        self.assertEqual(seen_users, [])  # no reset link generated

    def test_oauth_only_user_without_email_row_gets_alternate_email(self):
        """An admin-created password-less account (no EmailAddress row at all)
        has never proven the inbox either."""
        user = User.objects.create_user(username="adminmade", email="made@example.com")
        user.set_unusable_password()
        user.save()

        mock_adapter, seen_users = self._save(user, email="made@example.com")

        mock_adapter.send_mail.assert_called_once()
        self.assertEqual(seen_users, [])

    def test_verified_oauth_only_user_gets_real_reset_link(self):
        """#1314: reversed behavior — the recovery path must reach this user."""
        user = self._oauth_only_user(verified=True)

        mock_adapter, seen_users = self._save(user)

        mock_adapter.send_mail.assert_not_called()
        self.assertEqual(seen_users, [user])

    def test_verified_match_is_case_insensitive(self):
        user = self._oauth_only_user(verified=True)

        mock_adapter, seen_users = self._save(user, email="OAuth@Example.com")

        self.assertEqual(seen_users, [user])

    def test_regular_user_goes_through_standard_flow(self):
        user = User.objects.create_user(
            username="regular", email="regular@example.com", password="strongpass1"
        )

        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": "regular@example.com"}
        form.users = [user]

        request = MagicMock()
        # super().save() is the actual AllAuthPasswordResetForm.save() — mock it
        with patch.object(
            AllAuthPasswordResetForm, "save", return_value=None
        ) as mock_super_save:
            form.save(request)
            mock_super_save.assert_called_once()


def _redeem_via_allauth_html_page(uid, token, password="NewPassword9876"):
    """Redeem a uid/token pair on allauth's own HTML page.

    GET stashes a valid key in the session and redirects to the set-password
    URL, which the POST then submits. A token the page refuses renders the
    "bad token" page (200, ``token_fail``) without redirecting; that response
    is returned as-is.
    """
    client = Client()
    r = client.get(f"/accounts/password/reset/key/{uid}-{token}/")
    if r.status_code != 302:
        return r
    return client.post(r["Location"], {"password1": password, "password2": password})


class PasswordlessRecoveryEndToEndTests(TestCase):
    """#1314 "genuinely stuck" path end to end: a verified, password-less
    account requests a reset, gets a working link, and sets a password."""

    def setUp(self):
        cache.clear()

    def test_reset_link_reaches_passwordless_account_and_sets_password(self):
        from allauth.account.models import EmailAddress
        from django.core import mail

        user = User.objects.create_user(username="stuck", email="stuck@example.com")
        user.set_unusable_password()
        user.save()
        EmailAddress.objects.create(user=user, email="stuck@example.com", verified=True, primary=True)

        client = APIClient()
        r = client.post("/api/v1/auth/password/reset/", {"email": "stuck@example.com"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("/reset-password/", mail.outbox[0].body)

        uid = user_pk_to_url_str(user)
        token = default_token_generator.make_token(user)
        r = client.post("/api/v1/auth/password/reset/confirm/", {
            "uid": uid, "token": token,
            "new_password1": "NewPassword9876", "new_password2": "NewPassword9876",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    def test_link_refused_if_address_is_no_longer_verified_when_used(self):
        """#1314: verification is re-checked when the link is used, not only
        when it was sent — a link mailed while verified must not set a
        password after the account stops vouching for that address."""
        from allauth.account.models import EmailAddress
        from django.core import mail

        user = User.objects.create_user(username="stale", email="stale@example.com")
        user.set_unusable_password()
        user.save()
        address = EmailAddress.objects.create(user=user, email="stale@example.com", verified=True, primary=True)

        client = APIClient()
        client.post("/api/v1/auth/password/reset/", {"email": "stale@example.com"})
        self.assertEqual(len(mail.outbox), 1)
        uid = user_pk_to_url_str(user)
        token = default_token_generator.make_token(user)

        address.verified = False
        address.save()

        r = client.post("/api/v1/auth/password/reset/confirm/", {
            "uid": uid, "token": token,
            "new_password1": "NewPassword9876", "new_password2": "NewPassword9876",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("token", r.json())
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def _stale_link_user(self):
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="stalehtml", email="stalehtml@example.com")
        user.set_unusable_password()
        user.save()
        address = EmailAddress.objects.create(user=user, email="stalehtml@example.com", verified=True, primary=True)
        token = default_token_generator.make_token(user)
        return user, address, user_pk_to_url_str(user), token

    def _post_allauth_html_reset(self, uid, token):
        """allauth's own HTML page redeems the same uid/token pair: GET stashes
        the key in the session and redirects to its set-password URL. A token
        the page refuses outright renders its "bad token" page (200) instead
        of redirecting; that response is returned as-is."""
        return _redeem_via_allauth_html_page(uid, token)

    def test_allauth_html_reset_page_refuses_link_once_no_address_is_verified(self):
        """#1314: the alternate redemption URL must not accept the link either.

        Since #1337 the token itself is refused here (``token_fail``), before
        the form's ``password_reset_still_allowed`` re-check is reached; that
        re-check is pinned directly by ``PasswordResetStillAllowedTests``.
        """
        user, address, uid, token = self._stale_link_user()
        address.verified = False
        address.save()

        r = self._post_allauth_html_reset(uid, token)

        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.context.get("token_fail"))
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_allauth_html_reset_page_still_works_while_verified(self):
        """Control: the same request succeeds when the address is still verified,
        so the test above depends on the re-check, not a broken request."""
        user, _address, uid, token = self._stale_link_user()

        r = self._post_allauth_html_reset(uid, token)

        self.assertEqual(r.status_code, 302)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    def _passwordless_with_two_addresses(self):
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="twoaddr", email="owner@example.com")
        user.set_unusable_password()
        user.save()
        EmailAddress.objects.create(user=user, email="owner@example.com", verified=True, primary=True)
        EmailAddress.objects.create(user=user, email="second@example.com", verified=False, primary=False)
        return user

    def test_reset_request_page_requires_verified_address(self):
        """#1314: allauth's HTML reset-request page applies the same rule as the
        REST endpoint — a password-less account gets a link only for an address
        that is verified on it."""
        from django.core import mail

        self._passwordless_with_two_addresses()

        r = Client().post("/accounts/password/reset/", {"email": "second@example.com"})

        self.assertEqual(r.status_code, 302)
        self.assertEqual(len(mail.outbox), 1)
        self.assertNotIn("/password/reset/key/", mail.outbox[0].body)
        self.assertNotIn("/reset-password/", mail.outbox[0].body)
        self.assertIn("doesn't have a", mail.outbox[0].body)

    def test_reset_request_page_sends_link_for_verified_address(self):
        """Control for the test above: the verified address does get a link."""
        from django.core import mail

        self._passwordless_with_two_addresses()

        Client().post("/accounts/password/reset/", {"email": "owner@example.com"})

        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("/password/reset/key/", mail.outbox[0].body)

    def test_rest_reset_requires_verified_address_too(self):
        from django.core import mail

        self._passwordless_with_two_addresses()

        APIClient().post("/api/v1/auth/password/reset/", {"email": "second@example.com"})

        self.assertEqual(len(mail.outbox), 1)
        self.assertNotIn("/reset-password/", mail.outbox[0].body)

    def test_password_account_reset_unaffected_by_unverified_address(self):
        """Accounts that already have a password keep the ordinary reset."""
        user = User.objects.create_user(username="haspw", email="haspw@example.com", password="oldpassword12")
        client = APIClient()
        r = client.post("/api/v1/auth/password/reset/confirm/", {
            "uid": user_pk_to_url_str(user), "token": default_token_generator.make_token(user),
            "new_password1": "NewPassword9876", "new_password2": "NewPassword9876",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class ResetLinkBoundToAddressTests(TestCase):
    """#1337: a password-less account's reset link is valid only while *the
    address it was sent to* is still verified on the account — another
    verified address on the same account does not keep it alive. Both
    redemption entry points check the same token generator."""

    REST_CONFIRM = "/api/v1/auth/password/reset/confirm/"

    def setUp(self):
        cache.clear()

    def _passwordless_two_verified(self):
        """Password-less account with two verified addresses, A (primary) and B."""
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="bound", email="a@example.com")
        user.set_unusable_password()
        user.save()
        a = EmailAddress.objects.create(user=user, email="a@example.com", verified=True, primary=True)
        b = EmailAddress.objects.create(user=user, email="b@example.com", verified=True, primary=False)
        return user, a, b

    def _request_link_for(self, email):
        """Request a link through the REST endpoint; return the token it mailed."""
        from django.core import mail

        r = APIClient().post("/api/v1/auth/password/reset/", {"email": email})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)
        # Mailed URL: {FRONTEND_URL}/reset-password/{uid}/{token}
        body = mail.outbox[0].body
        path = body[body.index("/reset-password/"):].split()[0]
        _, _, uid, token = path.rstrip("/").split("/")[:4]
        mail.outbox.clear()
        return uid, token

    def _confirm_rest(self, uid, token):
        return APIClient().post(self.REST_CONFIRM, {
            "uid": uid, "token": token,
            "new_password1": "NewPassword9876", "new_password2": "NewPassword9876",
        })

    # --- the address the link was sent to stops being verified ---------------

    def test_rest_refuses_link_after_its_address_is_unverified(self):
        user, a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        a.verified = False
        a.save()

        r = self._confirm_rest(uid, token)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("token", r.json())
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_rest_refuses_link_after_its_address_is_removed(self):
        """Control, not coverage of the #1337 code: allauth's stock hash already
        covers every address on the account, so removing one voids the link
        with or without the verified-set binding. Kept so a future generator
        change cannot lose it."""
        user, a, b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        # As allauth's email page does it: make B primary, then remove A.
        a.primary = False
        a.save()
        b.primary = True
        b.save()
        user.email = "b@example.com"
        user.save()
        a.delete()

        r = self._confirm_rest(uid, token)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_html_page_refuses_link_after_its_address_is_unverified(self):
        user, a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        a.verified = False
        a.save()

        r = _redeem_via_allauth_html_page(uid, token)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.context["token_fail"])
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_html_page_refuses_when_address_is_unverified_between_open_and_submit(self):
        """The set-password POST re-checks the token, so unverifying the address
        after the page was opened still refuses the submit."""
        user, a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        client = Client()
        r = client.get(f"/accounts/password/reset/key/{uid}-{token}/")
        self.assertEqual(r.status_code, 302)
        a.verified = False
        a.save()
        r = client.post(r["Location"], {"password1": "NewPassword9876", "password2": "NewPassword9876"})

        self.assertEqual(r.status_code, 200)
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    # --- controls: the link works while its address is verified --------------

    def test_rest_accepts_link_while_its_address_is_verified(self):
        user, _a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        r = self._confirm_rest(uid, token)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    def test_html_page_accepts_link_while_its_address_is_verified(self):
        user, _a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")

        r = _redeem_via_allauth_html_page(uid, token)
        self.assertEqual(r.status_code, 302)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    def test_fresh_link_after_the_change_works(self):
        """The refusal is per-link: a link requested after the change, to an
        address still verified, works normally."""
        user, a, _b = self._passwordless_two_verified()
        stale_uid, stale_token = self._request_link_for("a@example.com")
        a.verified = False
        a.save()
        self.assertEqual(self._confirm_rest(stale_uid, stale_token).status_code, 400)

        uid, token = self._request_link_for("b@example.com")
        r = self._confirm_rest(uid, token)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    # --- tampering ------------------------------------------------------------

    def test_token_not_bound_to_verified_addresses_is_refused(self):
        """A token minted without the verified-address binding — allauth's stock
        generator, i.e. the pre-#1337 format — is refused for a password-less
        account at both entry points, so the binding cannot be skipped."""
        from allauth.account.forms import EmailAwarePasswordResetTokenGenerator

        user, _a, _b = self._passwordless_two_verified()
        uid = user_pk_to_url_str(user)
        unbound = EmailAwarePasswordResetTokenGenerator().make_token(user)

        self.assertEqual(self._confirm_rest(uid, unbound).status_code, 400)
        r = _redeem_via_allauth_html_page(uid, unbound)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.context["token_fail"])
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_tampered_token_is_refused(self):
        user, _a, _b = self._passwordless_two_verified()
        uid, token = self._request_link_for("a@example.com")
        ts, digest = token.split("-")
        tampered = f"{ts}-{digest[:-1]}{'0' if digest[-1] != '0' else '1'}"

        self.assertEqual(self._confirm_rest(uid, tampered).status_code, 400)
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    # --- accounts with a usable password are unaffected ----------------------

    def test_usable_password_token_is_identical_to_allauths(self):
        """Links already in inboxes for accounts with a password were minted by
        allauth's stock generator; they must still validate, so the hash for
        these accounts has to be byte-identical."""
        from allauth.account.forms import EmailAwarePasswordResetTokenGenerator
        from allauth.account.models import EmailAddress

        from accounts.tokens import VisibanPasswordResetTokenGenerator

        user = User.objects.create_user(username="haspw2", email="haspw2@example.com", password="oldpassword12")
        EmailAddress.objects.create(user=user, email="haspw2@example.com", verified=True, primary=True)
        stock = EmailAwarePasswordResetTokenGenerator()
        ours = VisibanPasswordResetTokenGenerator()

        self.assertEqual(ours._make_hash_value(user, 12345), stock._make_hash_value(user, 12345))
        self.assertTrue(ours.check_token(user, stock.make_token(user)))

    def test_usable_password_pre_existing_link_still_works_at_both_entry_points(self):
        from allauth.account.forms import EmailAwarePasswordResetTokenGenerator
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="haspw3", email="haspw3@example.com", password="oldpassword12")
        EmailAddress.objects.create(user=user, email="haspw3@example.com", verified=True, primary=True)
        uid = user_pk_to_url_str(user)
        legacy = EmailAwarePasswordResetTokenGenerator().make_token(user)

        r = _redeem_via_allauth_html_page(uid, legacy, password="HtmlPassword9876")
        self.assertEqual(r.status_code, 302)
        user.refresh_from_db()
        self.assertTrue(user.check_password("HtmlPassword9876"))

        legacy = EmailAwarePasswordResetTokenGenerator().make_token(user)
        r = self._confirm_rest(uid, legacy)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPassword9876"))

    def test_usable_password_link_survives_unverifying_an_address(self):
        """Verified-address changes move no trust boundary for an account that
        already has a password, so they do not void its link."""
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="haspw4", email="haspw4@example.com", password="oldpassword12")
        address = EmailAddress.objects.create(user=user, email="haspw4@example.com", verified=True, primary=True)
        uid, token = self._request_link_for("haspw4@example.com")

        address.verified = False
        address.save()

        r = self._confirm_rest(uid, token)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    # --- wiring ---------------------------------------------------------------

    def test_every_entry_point_uses_the_binding_generator(self):
        """Both request forms and both redemption paths read allauth's
        default_token_generator (dj-rest-auth imports it at call time), and
        allauth's HTML key page reads UserTokenForm.token_generator."""
        from allauth.account import forms as allauth_forms

        from accounts.tokens import VisibanPasswordResetTokenGenerator

        self.assertIsInstance(allauth_forms.default_token_generator, VisibanPasswordResetTokenGenerator)
        self.assertIsInstance(allauth_forms.UserTokenForm.token_generator, VisibanPasswordResetTokenGenerator)


class ResetLinkMintingRaceTests(TestCase):
    """#1337: the request gate and token minting are separate queries. An
    address unverified between them must not yield a working link — the
    minting generator re-checks the address against the set it hashes."""

    def setUp(self):
        cache.clear()

    def _user_with_a_unverified_b_verified(self):
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="race", email="a@example.com")
        user.set_unusable_password()
        user.save()
        EmailAddress.objects.create(user=user, email="a@example.com", verified=False, primary=True)
        EmailAddress.objects.create(user=user, email="b@example.com", verified=True, primary=False)
        return user

    def test_rest_request_link_is_dead_if_address_unverified_after_gate(self):
        from django.core import mail

        user = self._user_with_a_unverified_b_verified()
        # The gate saw A verified; by minting time it no longer is.
        with patch("accounts.forms._has_verified_email", return_value=True):
            APIClient().post("/api/v1/auth/password/reset/", {"email": "a@example.com"})
        self.assertEqual(len(mail.outbox), 1)
        body = mail.outbox[0].body
        path = body[body.index("/reset-password/"):].split()[0]
        _, _, uid, token = path.rstrip("/").split("/")[:4]

        r = APIClient().post("/api/v1/auth/password/reset/confirm/", {
            "uid": uid, "token": token,
            "new_password1": "NewPassword9876", "new_password2": "NewPassword9876",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_html_request_link_is_dead_if_address_unverified_after_gate(self):
        import re

        from django.core import mail

        user = self._user_with_a_unverified_b_verified()
        with patch("accounts.forms._has_verified_email", return_value=True):
            Client().post("/accounts/password/reset/", {"email": "a@example.com"})
        self.assertEqual(len(mail.outbox), 1)
        m = re.search(r"/accounts/password/reset/key/([0-9A-Za-z]+)-(\S+?)/", mail.outbox[0].body)
        self.assertIsNotNone(m)

        r = _redeem_via_allauth_html_page(m.group(1), m.group(2))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.context["token_fail"])
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())

    def test_minting_generator_matches_redemption_when_address_is_verified(self):
        from accounts.tokens import AddressBoundTokenGenerator, VisibanPasswordResetTokenGenerator

        user = self._user_with_a_unverified_b_verified()
        token = AddressBoundTokenGenerator("B@example.com").make_token(user)
        self.assertTrue(VisibanPasswordResetTokenGenerator().check_token(user, token))
        dead = AddressBoundTokenGenerator("a@example.com").make_token(user)
        self.assertFalse(VisibanPasswordResetTokenGenerator().check_token(user, dead))


class VerifiedSuffixEncodingTests(TestCase):
    """#1337: the verified-address set is encoded unambiguously, so two
    different sets can never hash the same."""

    def test_pipe_in_address_does_not_collide_with_two_addresses(self):
        from accounts.tokens import verified_suffix

        self.assertNotEqual(
            verified_suffix(['"a|b"@example.com']),
            verified_suffix(['"a@example.com', 'b"@example.com']),
        )
        self.assertNotEqual(
            verified_suffix(["a@example.com|b@example.com"]),
            verified_suffix(["a@example.com", "b@example.com"]),
        )

    def test_suffix_is_order_independent(self):
        from accounts.tokens import verified_suffix

        self.assertEqual(verified_suffix(["b@x.com", "a@x.com"]), verified_suffix(["a@x.com", "b@x.com"]))


class PasswordResetStillAllowedTests(TestCase):
    """#1314 defense-in-depth re-check, pinned directly: since #1337 the token
    is normally refused first, so end-to-end tests no longer reach it."""

    def _passwordless(self, verified):
        from allauth.account.models import EmailAddress

        user = User.objects.create_user(username="psa", email="psa@example.com")
        user.set_unusable_password()
        user.save()
        EmailAddress.objects.create(user=user, email="psa@example.com", verified=verified, primary=True)
        return user

    def test_passwordless_without_verified_address_is_refused(self):
        from accounts.forms import password_reset_still_allowed

        self.assertFalse(password_reset_still_allowed(self._passwordless(verified=False)))

    def test_passwordless_with_verified_address_is_allowed(self):
        from accounts.forms import password_reset_still_allowed

        self.assertTrue(password_reset_still_allowed(self._passwordless(verified=True)))

    def test_usable_password_is_allowed(self):
        from accounts.forms import password_reset_still_allowed

        user = User.objects.create_user(username="psa2", email="psa2@example.com", password="oldpassword12")
        self.assertTrue(password_reset_still_allowed(user))
        self.assertTrue(password_reset_still_allowed(None))

    def test_html_key_form_clean_applies_the_recheck(self):
        """``VisibanResetPasswordKeyForm`` is only built after allauth validated
        the token, so the form is exercised directly with a user in hand."""
        from accounts.forms import VisibanResetPasswordKeyForm

        data = {"password1": "NewPassword9876", "password2": "NewPassword9876"}
        refused = VisibanResetPasswordKeyForm(data=data, user=self._passwordless(verified=False), temp_key="k")
        self.assertFalse(refused.is_valid())
        self.assertIn("no longer valid", str(refused.errors))

    def test_html_key_form_clean_passes_while_verified(self):
        from accounts.forms import VisibanResetPasswordKeyForm

        data = {"password1": "NewPassword9876", "password2": "NewPassword9876"}
        self.assertTrue(
            VisibanResetPasswordKeyForm(data=data, user=self._passwordless(verified=True), temp_key="k").is_valid()
        )


class PasswordResetTokenGeneratorCheckTests(TestCase):
    """#1337: a system check catches a settings override that drops the binding."""

    def test_check_passes_with_the_configured_generator(self):
        from accounts.checks import check_password_reset_token_generator

        self.assertEqual(check_password_reset_token_generator(None), [])

    def test_check_fails_when_the_generator_is_replaced(self):
        from allauth.account.forms import EmailAwarePasswordResetTokenGenerator

        from accounts.checks import check_password_reset_token_generator

        with patch("allauth.account.forms.default_token_generator", EmailAwarePasswordResetTokenGenerator()):
            errors = check_password_reset_token_generator(None)
        self.assertEqual([e.id for e in errors], ["accounts.E001"])
        self.assertIn("ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR", errors[0].hint)

    def test_check_is_registered(self):
        from django.core import checks

        from accounts.checks import check_password_reset_token_generator

        self.assertIn(check_password_reset_token_generator, checks.registry.registry.get_checks())


class PasswordResetEndpointTests(TestCase):
    """POST /api/v1/auth/password/reset/ — enumeration safety."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="alice", email="alice@example.com", password="strongpass1"
        )

    def _post_reset(self, email):
        # Patch VisibanPasswordResetForm.save to avoid sending real emails.
        with patch.object(VisibanPasswordResetForm, "save", return_value=None):
            return self.client.post(
                "/api/v1/auth/password/reset/", {"email": email}
            )

    def test_reset_request_returns_200_for_registered_email(self):
        r = self._post_reset("alice@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_reset_request_returns_200_for_unknown_email(self):
        """Endpoint must not reveal whether an email is registered."""
        r = self._post_reset("nobody@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class PasswordResetConfirmTests(TestCase):
    """POST /api/v1/auth/password/reset/confirm/ — valid token, invalid token."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="bob", email="bob@example.com", password="oldpassword1"
        )

    def _make_confirm_payload(self, user=None):
        u = user or self.user
        # dj-rest-auth uses allauth's url_str_to_user_pk (base36) when allauth
        # is installed — must match or uid decoding returns 400.
        uid = user_pk_to_url_str(u)
        token = default_token_generator.make_token(u)
        return {
            "uid": uid,
            "token": token,
            "new_password1": "NewPassword9876",
            "new_password2": "NewPassword9876",
        }

    def test_confirm_with_valid_token_resets_password(self):
        payload = self._make_confirm_payload()
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("NewPassword9876"))

    def test_confirm_with_invalid_token_returns_400(self):
        payload = self._make_confirm_payload()
        payload["token"] = "invalid-token-xyz"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_with_mismatched_passwords_returns_400(self):
        payload = self._make_confirm_payload()
        payload["new_password2"] = "DifferentPassword9876"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_rejects_password_below_twelve_characters(self):
        """#1258: the reset path enforces the same 12-char minimum as every other set path."""
        payload = self._make_confirm_payload()
        payload["new_password1"] = payload["new_password2"] = "Kx7#mQ2vLp9"  # 11 chars
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("oldpassword1"))

    def test_confirm_token_can_only_be_used_once(self):
        payload = self._make_confirm_payload()
        r1 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        # Second use of the same token must fail.
        r2 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r2.status_code, status.HTTP_400_BAD_REQUEST)


class PasswordResetThrottleStructureTests(TestCase):
    """Verify throttle classes are wired correctly and use IP-based (not anon-only) keys."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="throttle_user", email="throttle@example.com", password="strongpass1"
        )

    def test_password_reset_throttle_is_simple_rate_throttle(self):
        from rest_framework.throttling import SimpleRateThrottle, AnonRateThrottle
        from accounts.views import PasswordResetThrottle
        self.assertTrue(issubclass(PasswordResetThrottle, SimpleRateThrottle))
        self.assertFalse(issubclass(PasswordResetThrottle, AnonRateThrottle))

    def test_password_reset_throttle_key_is_not_none_for_authenticated_user(self):
        from accounts.views import PasswordResetThrottle
        throttle = PasswordResetThrottle()
        throttle.scope = "password_reset"
        request = MagicMock()
        request.user = self.user
        request.META = {"REMOTE_ADDR": "192.0.2.1"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("192.0.2.1", key)

    def test_password_reset_confirm_view_uses_confirm_throttle(self):
        from accounts.views import ThrottledPasswordResetConfirmView, PasswordResetConfirmThrottle
        throttle_classes = ThrottledPasswordResetConfirmView.throttle_classes
        self.assertIn(PasswordResetConfirmThrottle, throttle_classes)

    def test_password_reset_confirm_throttle_key_is_ip_based(self):
        from accounts.views import PasswordResetConfirmThrottle
        throttle = PasswordResetConfirmThrottle()
        throttle.scope = "password_reset_confirm"
        request = MagicMock()
        request.META = {"REMOTE_ADDR": "203.0.113.5"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("203.0.113.5", key)


class LoginThrottleStructureTests(TestCase):
    """#924 — verify the login throttle subclass and URL precedence so a
    future urls.py edit cannot silently drop the rate limit."""

    def test_login_throttle_is_simple_rate_throttle(self):
        from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle
        from accounts.views import LoginRateThrottle
        # SimpleRateThrottle (keyed on IP unconditionally) — not AnonRateThrottle
        # which skips authenticated requests and would let an attacker bypass
        # the limit by toggling auth state mid-attack.
        self.assertTrue(issubclass(LoginRateThrottle, SimpleRateThrottle))
        self.assertFalse(issubclass(LoginRateThrottle, AnonRateThrottle))

    def test_login_throttle_key_is_ip_based(self):
        from accounts.views import LoginRateThrottle
        throttle = LoginRateThrottle()
        request = MagicMock()
        request.META = {"REMOTE_ADDR": "198.51.100.7"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("198.51.100.7", key)

    def test_login_view_subclass_carries_throttle_class(self):
        from accounts.views import LoginRateThrottle, ThrottledLoginView
        self.assertIn(LoginRateThrottle, ThrottledLoginView.throttle_classes)

    def test_login_url_resolves_to_throttled_view(self):
        """``/api/v1/auth/login/`` must resolve to ThrottledLoginView, not the
        default dj-rest-auth LoginView.  A future urls.py reordering that
        broke the precedence would silently re-introduce the missing-scope
        gap reported in #924."""
        from django.urls import resolve
        from accounts.views import ThrottledLoginView
        match = resolve("/api/v1/auth/login/")
        view_cls = getattr(match.func, "view_class", None) or getattr(match.func, "cls", None)
        self.assertIs(view_cls, ThrottledLoginView)


class LoginPerAccountLockoutTests(TestCase):
    """#1199 — the allauth per-account ``login_failed`` lockout must actually
    engage on ``POST /api/v1/auth/login/``.

    Before #1199, dj-rest-auth's ``LoginSerializer.authenticate()`` called
    ``django.contrib.auth.authenticate()`` directly, which never reached
    allauth's ``pre_authenticate()`` / ``ratelimit.consume(action="login_failed")``
    hook. These tests exercise the real endpoint end-to-end and vary the source
    IP per attempt specifically to prove the lockout is keyed on the account,
    not the caller's IP (NUM_PROXIES=1, so the IP DRF/allauth resolve is the
    last hop of X-Forwarded-For) — a distributed attacker is exactly the gap
    #1199 closes.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        self.client = APIClient()
        self.victim = User.objects.create_user(
            username="lockout_victim", email="victim@example.com", password=self.PASSWORD
        )
        self.other = User.objects.create_user(
            username="lockout_other", email="other@example.com", password=self.PASSWORD
        )
        # allauth's ratelimit.consume() reads/writes Django's default cache
        # directly (not DRF's throttle cache) — clear it so no prior test's
        # login_failed usage bleeds into these, and clear again after so this
        # test's lockout state doesn't bleed into whatever runs next.
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_login(self, username, password, ip):
        return self.client.post(
            "/api/v1/auth/login/",
            {"username": username, "password": password},
            format="json",
            HTTP_X_FORWARDED_FOR=ip,
            REMOTE_ADDR=ip,
        )

    def test_successful_login_still_works(self):
        r = self._post_login(self.other.username, self.PASSWORD, "203.0.113.1")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())

    def test_failed_attempts_from_many_ips_lock_the_account(self):
        # ACCOUNT_RATE_LIMITS["login_failed"] = "5/300s/key" — 5 failed attempts
        # exhausts the bucket. Each attempt comes from a distinct IP.
        for i in range(5):
            r = self._post_login(self.victim.username, "wrong-password", f"198.51.100.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        # A 6th attempt, from yet another new IP, with the CORRECT password —
        # must still be refused because the account (not the IP) is locked.
        r = self._post_login(self.victim.username, self.PASSWORD, "198.51.100.99")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        detail = str(r.json())
        self.assertIn("Too many", detail)
        # No user-enumeration signal: the lockout message must not name the
        # account or otherwise differ from what an unknown username would get.
        self.assertNotIn(self.victim.username, detail)
        self.assertNotIn(self.victim.email, detail)

    def test_many_accounts_from_one_ip_trip_the_per_ip_limit(self):
        """Completeness-check re-check finding: allauth's per-IP rate
        ("10/m/ip") applies here too, not just on the HTML login view — the
        SPA endpoint now goes through the same rate-limited adapter (#1199).
        10 failed attempts across 10 *different* accounts, all from one IP,
        trip the per-IP bucket; an 11th attempt from that IP — even with a
        correct password, for an account that never itself failed — is also
        refused. This is a deliberate tradeoff to close single-IP,
        many-account credential stuffing against the SPA; it can briefly
        (up to the ~1-minute window) refuse a correct login sharing that IP
        (see docs/architecture/deployment.md's shared-NAT note)."""
        for i in range(10):
            User.objects.create_user(username=f"perip_spauser{i}", password=self.PASSWORD)
            r = self._post_login(f"perip_spauser{i}", "wrong-password", "10.10.10.10")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        untouched = User.objects.create_user(username="perip_spauser_untouched", password=self.PASSWORD)
        r = self._post_login(untouched.username, self.PASSWORD, "10.10.10.10")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_demo_mode_published_account_is_exempt_from_lockout(self):
        """#1199 gate finding: the demo account's password is published to every
        visitor, so a per-account lockout on it protects nothing and is instead a
        repeatable DoS lever — 5 wrong passwords from anyone locks out every other
        visitor for 5 minutes. With DEMO_MODE on, the published account must keep
        working even after many failed attempts."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME="demovisitor"):
            User.objects.create_user(username="demovisitor", password=self.PASSWORD)
            for i in range(6):
                r = self._post_login("demovisitor", "wrong-password", f"192.0.2.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login("demovisitor", self.PASSWORD, "192.0.2.200")
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_demo_mode_does_not_exempt_other_accounts(self):
        """The carve-out is scoped to DEMO_LOGIN_USERNAME only — every other
        account on a demo instance, including a real user's, keeps the full
        per-account lockout."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME="demovisitor"):
            for i in range(5):
                r = self._post_login(self.victim.username, "wrong-password", f"203.0.113.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login(self.victim.username, self.PASSWORD, "203.0.113.200")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_demo_username_locks_normally_when_demo_mode_is_off(self):
        """The carve-out only applies while DEMO_MODE is actually on — an
        install that merely reuses "visitor" as a real username, with demo mode
        off, gets the ordinary per-account lockout."""
        with override_settings(DEMO_MODE=False, DEMO_LOGIN_USERNAME="demovisitor"):
            User.objects.create_user(username="demovisitor", password=self.PASSWORD)
            for i in range(5):
                r = self._post_login("demovisitor", "wrong-password", f"198.18.0.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login("demovisitor", self.PASSWORD, "198.18.0.200")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_demo_carve_out_normalizes_case_and_whitespace(self):
        """#1199 completeness-check gap: the carve-out must match
        DEMO_LOGIN_USERNAME the same way allauth normalizes its own lockout
        key (lowercased), plus a strip — not an exact string match.

        The account itself is always logged into with its real, exact-case
        username ("demovisitor") — Django's username lookup is case-sensitive,
        so varying the *submitted* login's case would confound this with an
        unrelated "wrong username" failure. What actually needs to tolerate
        case/whitespace is DEMO_LOGIN_USERNAME itself (an operator-supplied
        env var), so that's what's varied here: removing either normalization
        step in ``_is_demo_account`` would make one of these configured values
        fail to recognize the real demo account and start failing this test.
        """
        User.objects.create_user(username="demovisitor", password=self.PASSWORD)
        for configured in ("DEMOVISITOR", " demovisitor ", "DemoVisitor"):
            with self.subTest(configured=configured):
                with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME=configured):
                    cache.clear()
                    for i in range(6):
                        r = self._post_login("demovisitor", "wrong-password", f"192.0.2.{i + 1}")
                        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                    r = self._post_login("demovisitor", self.PASSWORD, "192.0.2.200")
                    self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_empty_demo_login_username_exempts_nobody(self):
        """A misconfigured (empty/unset) DEMO_LOGIN_USERNAME must not
        accidentally exempt every account by comparing two empty strings —
        it should just never match, so the ordinary lockout still applies."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME=""):
            for i in range(5):
                r = self._post_login(self.victim.username, "wrong-password", f"203.0.113.{i + 10}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login(self.victim.username, self.PASSWORD, "203.0.113.201")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_other_account_is_unaffected_by_a_locked_account(self):
        for i in range(5):
            self._post_login(self.victim.username, "wrong-password", f"192.0.2.{i + 1}")
        # Confirm the victim account is indeed locked before checking isolation.
        locked = self._post_login(self.victim.username, self.PASSWORD, "192.0.2.99")
        self.assertEqual(locked.status_code, status.HTTP_400_BAD_REQUEST, locked.content)

        r = self._post_login(self.other.username, self.PASSWORD, "192.0.2.100")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())


class LoginLockoutEarlyRecoveryTests(TestCase):
    """#1203 — a successful password reset clears the per-account
    ``login_failed`` lockout early, instead of forcing a locked-out user to
    wait out the full 5-minute window even with their brand-new, correct
    password.

    Covers both identifier keys allauth's lockout can be keyed on
    (``ACCOUNT_LOGIN_METHODS = {"username", "email"}``) — see
    ``accounts.adapter.clear_login_lockout`` for why both must be cleared
    unconditionally.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential
    NEW_PASSWORD = "NewPassword9876"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="lockout_reset_user", email="lockoutreset@example.com", password=self.PASSWORD
        )
        # Same reasoning as LoginPerAccountLockoutTests.setUp: allauth's
        # ratelimit.consume()/clear() read and write Django's default cache
        # directly, so it must be isolated per test.
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_login(self, field, value, password, ip):
        return self.client.post(
            "/api/v1/auth/login/",
            {field: value, "password": password},
            format="json",
            HTTP_X_FORWARDED_FOR=ip,
            REMOTE_ADDR=ip,
        )

    def _lock_out_via(self, field, value, ip_prefix):
        for i in range(5):
            r = self._post_login(field, value, "wrong-password", f"{ip_prefix}.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        # Confirm the account is actually locked (even the correct password is
        # refused) before testing recovery from it.
        locked = self._post_login(field, value, self.PASSWORD, f"{ip_prefix}.99")
        self.assertEqual(locked.status_code, status.HTTP_400_BAD_REQUEST, locked.content)

    def _reset_confirm_payload(self):
        uid = user_pk_to_url_str(self.user)
        token = default_token_generator.make_token(self.user)
        return {
            "uid": uid,
            "token": token,
            "new_password1": self.NEW_PASSWORD,
            "new_password2": self.NEW_PASSWORD,
        }

    def test_reset_clears_lockout_keyed_on_username(self):
        self._lock_out_via("username", self.user.username, "192.0.2")

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        r = self._post_login("username", self.user.username, self.NEW_PASSWORD, "192.0.2.200")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_reset_clears_lockout_keyed_on_email(self):
        self._lock_out_via("email", self.user.email, "198.51.100")

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        # Since #1206 email login works (accounts.backends.EmailBackend), so
        # the reset must leave the user able to log in by email outright — not
        # merely "no longer rate-limited" as this test asserted before.
        r = self._post_login("email", self.user.email, self.NEW_PASSWORD, "198.51.100.200")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_reset_does_not_clear_a_different_accounts_lockout(self):
        """The clear must be scoped to the resetting user — a locked-out
        bystander's lockout must survive an unrelated account's reset."""
        bystander = User.objects.create_user(
            username="lockout_bystander", email="bystander@example.com", password=self.PASSWORD
        )
        for i in range(5):
            r = self._post_login("username", bystander.username, "wrong-password", f"203.0.113.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        r = self._post_login("username", bystander.username, self.PASSWORD, "203.0.113.200")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_reset_does_not_clear_the_per_ip_rate_limit(self):
        """The per-IP ``login_failed`` rate (10 failed attempts/minute, across
        ANY accounts — #1199) must survive a password reset completed from
        that same IP. allauth's own public ``ratelimit.clear()`` would clear
        BOTH configured rates for the action in one call, including the
        per-IP one computed from the reset request's own client IP — that
        would silently reopen the single-IP credential-stuffing gap #1199
        closed, every time anyone completes a reset. See
        ``accounts.adapter.clear_login_lockout``'s docstring for why this is
        scoped to the per-account (``/key``) rate only.
        """
        ip = "192.0.2.50"
        # Trip the per-IP bucket: 10 failed attempts across 10 different
        # accounts, all from the same IP the reset below is submitted from.
        for i in range(10):
            User.objects.create_user(username=f"perip_reset_user{i}", password=self.PASSWORD)
            r = self._post_login("username", f"perip_reset_user{i}", "wrong-password", ip)
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        r = self.client.post(
            "/api/v1/auth/password/reset/confirm/",
            self._reset_confirm_payload(),
            REMOTE_ADDR=ip,
            HTTP_X_FORWARDED_FOR=ip,
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        # The per-IP bucket must still be tripped: an 11th account that never
        # itself failed, logging in with its correct password from that same
        # IP, is still refused.
        untouched = User.objects.create_user(username="perip_reset_untouched", password=self.PASSWORD)
        r = self._post_login("username", untouched.username, self.PASSWORD, ip)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_failed_reset_attempt_does_not_clear_the_lockout(self):
        """security-review finding on #1203: an invalid/expired token must
        never reach ``VisibanPasswordResetConfirmSerializer.save()`` at all
        (dj-rest-auth's ``validate()`` raises before ``save()`` runs), so a
        rejected reset attempt must leave an existing lockout untouched —
        it must not become a way to clear a lockout without proving email
        access via a valid token."""
        self._lock_out_via("username", self.user.username, "198.18.0")

        payload = self._reset_confirm_payload()
        payload["token"] = "invalid-token-xyz"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        # Still locked out — including with the (unchanged) correct password.
        r = self._post_login("username", self.user.username, self.PASSWORD, "198.18.0.200")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))


class AllauthHtmlLoginPerIpThrottleTests(TestCase):
    """#1199 completeness-check BLOCKER: allauth's own HTML login view,
    ``/accounts/login/`` (registered live via ``path("accounts/",
    include("allauth.urls"))``), is not behind ``ThrottledLoginView`` /
    ``LoginRateThrottle`` — that DRF throttle only wraps the SPA's
    ``/api/v1/auth/login/``. Before #1199, ``ACCOUNT_RATE_LIMITS["login_failed"]``
    was a bare ``"5/300s"``, which allauth happens to parse as a per-IP rate
    (no "/key" suffix), so this route was accidentally protected. Changing it
    to ``"5/300s/key"`` for the per-account fix removed that per-IP layer
    entirely, leaving this view an unlimited cross-account credential-stuffing
    oracle from a single IP (wrong password -> 200 re-render, right -> 302).
    ``ACCOUNT_RATE_LIMITS["login_failed"]`` is now ``"10/m/ip,5/300s/key"`` —
    both rates must allow a request through.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        # enforce_csrf_checks=False: this view renders and posts a real CSRF
        # token in normal use, but the throttle behavior under test doesn't
        # depend on CSRF at all, and disabling it keeps the test focused on
        # the rate limit rather than token plumbing.
        self.client = Client(enforce_csrf_checks=False)
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_html_login(self, login, password, ip):
        return self.client.post(
            "/accounts/login/",
            {"login": login, "password": password},
            REMOTE_ADDR=ip,
        )

    def test_normal_login_still_works(self):
        User.objects.create_user(username="htmlloginuser", password=self.PASSWORD)
        r = self._post_html_login("htmlloginuser", self.PASSWORD, "203.0.113.50")
        self.assertEqual(r.status_code, 302, r.content)

    def test_many_accounts_from_one_ip_are_throttled(self):
        """The reviewer's probe: 12 failed attempts across 12 different
        accounts, all from one IP, then a real password for a 13th account
        from that same IP — must be refused. Before the fix this succeeded
        (302): unlimited cross-account credential stuffing from a single IP."""
        for i in range(12):
            User.objects.create_user(username=f"stuffuser{i}", password=self.PASSWORD)
            r = self._post_html_login(f"stuffuser{i}", "wrong-password", "198.51.100.200")
            self.assertEqual(r.status_code, 200, r.content)

        target = User.objects.create_user(username="stuffuser_target", password=self.PASSWORD)
        r = self._post_html_login(target.username, self.PASSWORD, "198.51.100.200")
        # Refused by the per-IP rate, not a login failure or a lockout on
        # `target` specifically — it never had a failed attempt of its own.
        self.assertNotEqual(r.status_code, 302, r.content)

    def test_five_failures_from_five_ips_still_locks_the_html_login_account(self):
        """The per-IP "10/m/ip" rate added alongside the per-account "/key"
        rate must not interfere with the #1199 per-account scenario: 5 failed
        attempts from 5 *different* IPs (well under the per-IP ceiling each)
        must still lock the account via the per-account rate, same as
        LoginPerAccountLockoutTests exercises against the SPA endpoint."""
        User.objects.create_user(username="fiveipsuser", password=self.PASSWORD)
        for i in range(5):
            r = self._post_html_login("fiveipsuser", "wrong-password", f"192.0.2.{i + 1}")
            self.assertEqual(r.status_code, 200, r.content)
        r = self._post_html_login("fiveipsuser", self.PASSWORD, "192.0.2.99")
        self.assertEqual(r.status_code, 200, r.content)
