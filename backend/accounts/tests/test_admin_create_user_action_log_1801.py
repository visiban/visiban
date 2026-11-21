"""POST /api/v1/admin/users/ records the password set in the action log (#1801)."""

from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import AdminActionLog, User

SET = AdminActionLog.Action.USER_PASSWORD_SET
PW = "a-Strong-new-pass-1801"


class AdminCreateUserLogTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="adm1801", password="adminpass123!")
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.payload = {"username": "new1801", "email": "new1801@example.com", "password": PW}

    def test_creation_is_recorded_with_acting_admin(self):
        r = self.client.post("/api/v1/admin/users/", self.payload, format="json")
        self.assertEqual(r.status_code, 201)
        user = User.objects.get(username="new1801")
        entry = AdminActionLog.objects.get(action=SET)
        self.assertEqual(entry.source, AdminActionLog.Source.ADMIN_API)
        self.assertEqual(entry.actor_id, self.admin.pk)
        self.assertEqual(entry.metadata, {"target_id": user.pk, "target_username": "new1801"})
        self.assertNotIn(PW, repr(entry.metadata))
        user.refresh_from_db()
        self.assertNotIn(user.password, repr(entry.metadata))
        self.assertNotRegex(repr(entry.metadata), r"(md5|pbkdf2_sha256|argon2|bcrypt)\$")

    def test_invalid_payload_records_nothing(self):
        self.payload["password"] = "x"
        r = self.client.post("/api/v1/admin/users/", self.payload, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(AdminActionLog.objects.filter(action=SET).exists())

    def test_log_failure_creates_no_account(self):
        client = APIClient(raise_request_exception=False)
        client.force_authenticate(self.admin)
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            r = client.post("/api/v1/admin/users/", self.payload, format="json")
        self.assertEqual(r.status_code, 500)
        self.assertFalse(User.objects.filter(username="new1801").exists())
