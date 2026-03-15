"""Tests for #173: site-wide registration toggle (require_invite_for_registration)."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User


class SiteConfigViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_registration_open_by_default(self):
        r = self.client.get("/api/auth/site-config/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["registration_open"])

    def test_registration_closed_when_toggle_on(self):
        s = SiteSetting.get()
        s.require_invite_for_registration = True
        s.save()
        r = self.client.get("/api/auth/site-config/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["registration_open"])

    def test_unauthenticated_can_reach_site_config(self):
        """Endpoint must be reachable before login so the frontend can check it."""
        r = self.client.get("/api/auth/site-config/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class RegistrationAdapterTests(TestCase):
    """
    Unit tests for RegistrationAdapter.is_open_for_signup() — the hook that
    controls password and OAuth signups via allauth's headless and social flows.
    """

    def setUp(self):
        from django.test import RequestFactory
        from accounts.adapter import RegistrationAdapter
        self.adapter = RegistrationAdapter()
        self.request = RequestFactory().get("/")

    def test_open_by_default(self):
        self.assertTrue(self.adapter.is_open_for_signup(self.request))

    def test_closed_when_toggle_on(self):
        s = SiteSetting.get()
        s.require_invite_for_registration = True
        s.save()
        self.assertFalse(self.adapter.is_open_for_signup(self.request))

    def test_reopened_after_toggle_off(self):
        s = SiteSetting.get()
        s.require_invite_for_registration = True
        s.save()
        self.assertFalse(self.adapter.is_open_for_signup(self.request))
        s.require_invite_for_registration = False
        s.save()
        self.assertTrue(self.adapter.is_open_for_signup(self.request))


class RegistrationEndpointToggleTests(TestCase):
    """
    Integration tests for the dj-rest-auth registration endpoint.
    When invite-only mode is on, the endpoint must return 403 before creating
    any user. When off, a valid payload must create the user.
    """

    def setUp(self):
        self.client = APIClient()

    def test_registration_blocked_when_closed(self):
        s = SiteSetting.get()
        s.require_invite_for_registration = True
        s.save()

        r = self.client.post("/api/auth/registration/", {
            "email": "blocked@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "Sup3rS3cr3t!xyz",
        })
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(User.objects.filter(email="blocked@example.com").exists())

    def test_registration_allowed_when_open(self):
        r = self.client.post("/api/auth/registration/", {
            "email": "newuser@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "Sup3rS3cr3t!xyz",
        })
        # 201 Created or 204 No Content depending on allauth email verification config
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertTrue(User.objects.filter(email="newuser@example.com").exists())


class SiteSettingSingletonTests(TestCase):
    def test_get_creates_singleton(self):
        self.assertEqual(SiteSetting.objects.count(), 0)
        s = SiteSetting.get()
        self.assertEqual(SiteSetting.objects.count(), 1)
        self.assertFalse(s.require_invite_for_registration)

    def test_get_returns_same_object(self):
        s1 = SiteSetting.get()
        s2 = SiteSetting.get()
        self.assertEqual(s1.pk, s2.pk)
        self.assertEqual(SiteSetting.objects.count(), 1)

    def test_save_enforces_singleton(self):
        SiteSetting.get()
        duplicate = SiteSetting(require_invite_for_registration=True)
        duplicate.save()
        self.assertEqual(SiteSetting.objects.count(), 1)
        self.assertTrue(SiteSetting.objects.get(pk=1).require_invite_for_registration)
