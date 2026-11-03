"""Secret rotation with an overlap window (#2054): what gets signed, when it stops."""

import hashlib
import hmac
import logging
from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import PersonalAccessToken
from boards.models import BoardEvent
from webhooks import dispatch, signing
from webhooks.models import MAX_SECRET_OVERLAP_SECONDS, WebhookSubscription

from .base import ENABLED, _make_membership, _make_user, admin_and_board, make_subscription, resolving
from .test_dispatch import GOLDEN_BODY, GOLDEN_SECRET, GOLDEN_SIGNATURE, Recorder

DAY = 86400
UNDECRYPTABLE = "v1:00000000:x"


def _url(board_id, suffix=""):
    return f"/api/v1/boards/{board_id}/webhooks/{suffix}"


def _values(call):
    return call["headers"]["X-Visiban-Signature"].split(",")


def _expected(secret, call):
    """Recompute a signature the way a receiver does, from what was on the wire."""
    message = call["headers"]["X-Visiban-Timestamp"].encode() + b"." + call["body"]
    return "v1=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


class SignatureHeaderTests(TestCase):
    def test_no_previous_is_byte_identical_to_sign(self):
        self.assertEqual(signing.signature_header(GOLDEN_SECRET, None, 1700000000, GOLDEN_BODY), GOLDEN_SIGNATURE)
        self.assertEqual(signing.signature_header(GOLDEN_SECRET, "", 1700000000, GOLDEN_BODY), GOLDEN_SIGNATURE)

    def test_previous_is_listed_after_the_current_with_no_spaces(self):
        header = signing.signature_header("whsec_new", GOLDEN_SECRET, 1700000000, GOLDEN_BODY)
        self.assertEqual(header, f"{signing.sign('whsec_new', 1700000000, GOLDEN_BODY)},{GOLDEN_SIGNATURE}")

    def test_verify_accepts_any_listed_value_and_only_those(self):
        header = signing.signature_header("whsec_new", GOLDEN_SECRET, 1700000000, GOLDEN_BODY)
        self.assertTrue(signing.verify("whsec_new", 1700000000, GOLDEN_BODY, header))
        self.assertTrue(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, header))
        self.assertFalse(signing.verify("whsec_third", 1700000000, GOLDEN_BODY, header))
        # A value appended by anyone else still has to match the HMAC.
        self.assertFalse(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, "v1=forged,v2=nope"))

    def test_verify_trims_folded_values_and_ignores_unknown_schemes(self):
        self.assertTrue(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, f"v2=x , {GOLDEN_SIGNATURE}"))

    def test_verify_refuses_more_values_than_the_cap(self):
        filler = ["v1=0"] * (signing.MAX_SIGNATURE_VALUES - 1)
        self.assertTrue(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, ",".join([*filler, GOLDEN_SIGNATURE])))
        self.assertFalse(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, ",".join([*filler, "v1=0", GOLDEN_SIGNATURE])))


class OverlapBase(TestCase):
    def setUp(self):
        cache.clear()
        self.admin, self.board = admin_and_board()
        self.sub = make_subscription(self.board, self.admin, secret="whsec_old")
        self.client = APIClient()
        self.client.force_login(self.admin)

    def rotate(self, sub=None, **body):
        sub = sub or self.sub
        return self.client.post(_url(self.board.pk, f"{sub.pk}/rotate/"), body, format="json")

    def event(self):
        return BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={"id": 1})

    def deliver(self, *outcomes):
        rec = Recorder(*outcomes)
        with patch("visiban.egress.guarded_post", rec):
            result = dispatch.run_once()
        self.sub.refresh_from_db()
        return rec, result

    def expire_window(self):
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            previous_secret_expires_at=timezone.now() - timedelta(seconds=1)
        )


@ENABLED
class SigningDuringAnOverlapTests(OverlapBase):
    def test_a_bare_rotate_sends_one_value_and_opens_no_window(self):
        r = self.client.post(_url(self.board.pk, f"{self.sub.pk}/rotate/"))
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.data["previous_secret_expires_at"])
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(_values(rec.calls[0]), [_expected(r.data["secret"], rec.calls[0])])
        self.assertEqual(self.sub.previous_secret_encrypted, "")

    def test_overlap_zero_sends_one_value(self):
        r = self.rotate(overlap_seconds=0)
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(_values(rec.calls[0]), [_expected(r.data["secret"], rec.calls[0])])

    def test_overlap_sends_new_then_old(self):
        before = timezone.now()
        r = self.rotate(overlap_seconds=DAY)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Cache-Control"], "no-store")
        self.sub.refresh_from_db()
        self.assertGreaterEqual(self.sub.previous_secret_expires_at, before + timedelta(seconds=DAY))
        self.assertLessEqual(self.sub.previous_secret_expires_at, timezone.now() + timedelta(seconds=DAY))
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(
            _values(rec.calls[0]),
            [_expected(r.data["secret"], rec.calls[0]), _expected("whsec_old", rec.calls[0])],
        )

    def test_rotate_moves_the_ciphertext_verbatim(self):
        stored = WebhookSubscription.objects.get(pk=self.sub.pk).secret_encrypted
        self.rotate(overlap_seconds=DAY)
        self.sub.refresh_from_db()
        self.assertEqual(self.sub.previous_secret_encrypted, stored)
        self.assertEqual(self.sub.get_previous_secret(), "whsec_old")

    def test_test_event_is_signed_like_a_real_delivery(self):
        r = self.rotate(overlap_seconds=DAY)
        rec = Recorder()
        with patch("visiban.egress.guarded_post", rec):
            t = self.client.post(_url(self.board.pk, f"{self.sub.pk}/test/"))
        self.assertTrue(t.data["ok"])
        self.assertEqual(
            _values(rec.calls[0]),
            [_expected(r.data["secret"], rec.calls[0]), _expected("whsec_old", rec.calls[0])],
        )

    def test_expired_test_event_sends_one_value(self):
        self.rotate(overlap_seconds=DAY)
        self.expire_window()
        rec = Recorder()
        with patch("visiban.egress.guarded_post", rec):
            self.client.post(_url(self.board.pk, f"{self.sub.pk}/test/"))
        self.assertEqual(len(_values(rec.calls[0])), 1)

    def test_a_second_rotation_keeps_one_previous_and_drops_the_older(self):
        first = self.rotate(overlap_seconds=DAY)
        second = self.rotate(overlap_seconds=DAY)
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(
            _values(rec.calls[0]),
            [_expected(second.data["secret"], rec.calls[0]), _expected(first.data["secret"], rec.calls[0])],
        )
        self.assertNotIn(_expected("whsec_old", rec.calls[0]), _values(rec.calls[0]))

    def test_overlap_zero_during_a_window_clears_it(self):
        self.rotate(overlap_seconds=DAY)
        r = self.rotate(overlap_seconds=0)
        self.assertIsNone(r.data["previous_secret_expires_at"])
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), ("", None))
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(_values(rec.calls[0]), [_expected(r.data["secret"], rec.calls[0])])

    def test_overlap_zero_stops_a_run_already_in_progress(self):
        self.rotate(overlap_seconds=DAY)
        self.event()
        self.event()
        calls = []

        def post(url, body, headers, **kwargs):
            calls.append(headers["X-Visiban-Signature"])
            self.assertEqual(self.rotate(overlap_seconds=0).status_code, 200)
            return 200

        with patch("visiban.egress.guarded_post", post):
            result = dispatch.run_once()
        # The first row was already on its way; the second never goes out with
        # the old secret: the rotation stops the run, and the next one re-reads.
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.lost_lease, 1)
        rec, _ = self.deliver()
        self.assertEqual(len(_values(rec.calls[0])), 1)

    def test_outside_a_window_the_header_is_a_single_value(self):
        self.event()
        rec, _ = self.deliver()
        self.assertEqual(rec.calls[0]["headers"]["X-Visiban-Signature"], _expected("whsec_old", rec.calls[0]))


@ENABLED
class ExpiryTests(OverlapBase):
    def test_expired_is_never_signed_even_before_a_sweep(self):
        r = self.rotate(overlap_seconds=DAY)
        self.expire_window()
        self.event()
        rec = Recorder()
        with patch("visiban.egress.guarded_post", rec), patch("webhooks.dispatch.sweep_expired_previous_secrets"):
            dispatch.run_once()
        self.assertEqual(_values(rec.calls[0]), [_expected(r.data["secret"], rec.calls[0])])
        # Unswept, and still not exposed as open.
        self.assertNotEqual(WebhookSubscription.objects.get(pk=self.sub.pk).previous_secret_encrypted, "")
        got = self.client.get(_url(self.board.pk, f"{self.sub.pk}/"))
        self.assertIsNone(got.data["previous_secret_expires_at"])

    def test_expiry_at_this_exact_moment_is_closed(self):
        self.rotate(overlap_seconds=DAY)
        self.sub.refresh_from_db()
        moment = self.sub.previous_secret_expires_at
        with patch("django.utils.timezone.now", return_value=moment):
            self.assertIsNone(self.sub.previous_secret_active_until)
            self.assertIsNone(self.sub.get_previous_secret())
        self.assertEqual(dispatch.sweep_expired_previous_secrets(now=moment), 1)

    def test_expiry_mid_run_drops_the_old_value_without_losing_the_lease(self):
        r = self.rotate(overlap_seconds=DAY)
        self.event()
        self.event()
        real_now = timezone.now
        shift = [timedelta(0)]
        rec = Recorder()

        def post(url, body, headers, **kwargs):
            status = rec(url, body, headers, **kwargs)
            shift[0] = timedelta(seconds=DAY + 60)  # the window ends after this delivery
            return status

        with (
            patch("visiban.egress.guarded_post", post),
            patch("django.utils.timezone.now", lambda: real_now() + shift[0]),
        ):
            result = dispatch.run_once()
        self.assertEqual(result.delivered, 2)
        self.assertEqual(result.lost_lease, 0)
        self.assertEqual(len(_values(rec.calls[0])), 2)
        self.assertEqual(_values(rec.calls[1]), [_expected(r.data["secret"], rec.calls[1])])

    def test_another_runs_sweep_mid_run_does_not_abort_it(self):
        self.rotate(overlap_seconds=DAY)
        self.event()
        self.event()
        rec = Recorder()

        def post(url, body, headers, **kwargs):
            status = rec(url, body, headers, **kwargs)
            self.expire_window()
            dispatch.sweep_expired_previous_secrets()
            return status

        with patch("visiban.egress.guarded_post", post):
            result = dispatch.run_once()
        self.assertEqual((result.delivered, result.lost_lease), (2, 0))


class SweepTests(OverlapBase):
    def _in_window(self, **fields):
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            previous_secret_encrypted="ciphertext",
            previous_secret_expires_at=timezone.now() - timedelta(seconds=1),
            **fields,
        )

    def _assert_cleared(self):
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), ("", None))

    @ENABLED
    def test_clears_a_disabled_row(self):
        self._in_window(enabled=False, disabled_reason="manual")
        dispatch.run_once()
        self._assert_cleared()

    @override_settings(WEBHOOKS_ENABLED=False, DEMO_MODE=False)
    def test_runs_with_the_feature_off(self):
        self._in_window()
        self.assertTrue(dispatch.run_once().skipped)
        self._assert_cleared()

    @override_settings(WEBHOOKS_ENABLED=True, DEMO_MODE=True)
    def test_runs_in_demo_mode(self):
        self._in_window()
        self.assertTrue(dispatch.run_once().skipped)
        self._assert_cleared()

    @ENABLED
    def test_leaves_an_open_window_and_the_configuration_stamps_alone(self):
        rotated_at = timezone.now() - timedelta(days=2)
        configured_at = timezone.now() - timedelta(days=3)
        future = timezone.now() + timedelta(hours=1)
        open_sub = make_subscription(self.board, self.admin, previous_secret_encrypted="keep", previous_secret_expires_at=future)
        self._in_window(secret_rotated_at=rotated_at, configured_at=configured_at)
        self.assertEqual(dispatch.sweep_expired_previous_secrets(), 1)
        self._assert_cleared()
        self.assertEqual((self.sub.secret_rotated_at, self.sub.configured_at), (rotated_at, configured_at))
        open_sub.refresh_from_db()
        self.assertEqual((open_sub.previous_secret_encrypted, open_sub.previous_secret_expires_at), ("keep", future))

    @ENABLED
    def test_a_sweep_with_nothing_to_do_logs_nothing(self):
        with self.assertNoLogs("webhooks.dispatch", level=logging.INFO):
            self.assertEqual(dispatch.sweep_expired_previous_secrets(), 0)


@ENABLED
class UnreadableSecretTests(OverlapBase):
    def test_undecryptable_previous_is_omitted_logged_by_id_and_does_not_disable(self):
        r = self.rotate(overlap_seconds=DAY)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(previous_secret_encrypted=UNDECRYPTABLE)
        self.event()
        with self.assertLogs("webhooks.models", level=logging.WARNING) as logs:
            rec, result = self.deliver()
        self.assertEqual(_values(rec.calls[0]), [_expected(r.data["secret"], rec.calls[0])])
        self.assertEqual((result.delivered, result.disabled), (1, 0))
        self.assertTrue(self.sub.enabled)
        text = "\n".join(logs.output)
        self.assertIn(f"subscription_id={self.sub.pk}", text)
        self.assertNotIn(UNDECRYPTABLE, text)

    def test_undecryptable_previous_logs_once_per_run_not_once_per_row(self):
        self.rotate(overlap_seconds=DAY)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(previous_secret_encrypted=UNDECRYPTABLE)
        self.event()
        self.event()
        self.event()
        with self.assertLogs("webhooks.models", level=logging.WARNING) as logs:
            rec, _ = self.deliver()
        self.assertEqual(len(rec.calls), 3)
        self.assertEqual(len(logs.output), 1)

    def test_undecryptable_previous_on_a_test_event_still_sends(self):
        self.rotate(overlap_seconds=DAY)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(previous_secret_encrypted=UNDECRYPTABLE)
        rec = Recorder()
        with patch("visiban.egress.guarded_post", rec):
            t = self.client.post(_url(self.board.pk, f"{self.sub.pk}/test/"))
        self.assertTrue(t.data["ok"])
        self.assertEqual(len(_values(rec.calls[0])), 1)

    def test_undecryptable_current_still_rotates_and_stores_no_previous(self):
        for broken in (UNDECRYPTABLE, ""):
            with self.subTest(stored=broken):
                WebhookSubscription.objects.filter(pk=self.sub.pk).update(secret_encrypted=broken)
                r = self.rotate(overlap_seconds=DAY)
                self.assertEqual(r.status_code, 200)
                self.assertIsNone(r.data["previous_secret_expires_at"])
                self.sub.refresh_from_db()
                self.assertEqual(self.sub.previous_secret_encrypted, "")
                self.assertEqual(self.sub.get_secret(), r.data["secret"])

    def test_undecryptable_current_during_a_window_clears_the_window(self):
        self.rotate(overlap_seconds=DAY)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(secret_encrypted=UNDECRYPTABLE)
        r = self.rotate(overlap_seconds=DAY)
        self.assertIsNone(r.data["previous_secret_expires_at"])
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), ("", None))


@ENABLED
class RotateApiTests(OverlapBase):
    def test_exposes_the_expiry_and_never_the_ciphertext(self):
        r = self.rotate(overlap_seconds=DAY)
        self.sub.refresh_from_db()
        self.assertIsNotNone(r.data["previous_secret_expires_at"])
        got = self.client.get(_url(self.board.pk, f"{self.sub.pk}/"))
        listed = self.client.get(_url(self.board.pk))
        for body in (r.content, got.content, listed.content):
            self.assertNotIn(b"previous_secret_encrypted", body)
            self.assertNotIn(self.sub.previous_secret_encrypted.encode(), body)
        self.assertIsNotNone(got.data["previous_secret_expires_at"])

    def test_bad_overlap_values_are_field_errors_and_rotate_nothing(self):
        stored = WebhookSubscription.objects.get(pk=self.sub.pk).secret_encrypted
        for value in (-1, MAX_SECRET_OVERLAP_SECONDS + 1, "soon", None, 1.5, [DAY], {"s": 1}, True):
            with self.subTest(value=value):
                r = self.rotate(overlap_seconds=value)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("overlap_seconds", r.data)
        self.assertEqual(WebhookSubscription.objects.get(pk=self.sub.pk).secret_encrypted, stored)

    def test_the_ceiling_itself_is_allowed(self):
        r = self.rotate(overlap_seconds=MAX_SECRET_OVERLAP_SECONDS)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(r.data["previous_secret_expires_at"])

    def test_a_non_object_body_is_refused(self):
        for body in ([1], 86400, "x"):
            with self.subTest(body=body):
                r = self.client.post(_url(self.board.pk, f"{self.sub.pk}/rotate/"), body, format="json")
                self.assertEqual(r.status_code, 400)

    def test_a_token_is_refused(self):
        _, raw = PersonalAccessToken.generate(self.admin, "t-2054")
        pat = APIClient()
        pat.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        r = pat.post(_url(self.board.pk, f"{self.sub.pk}/rotate/"), {"overlap_seconds": DAY}, format="json")
        self.assertEqual((r.status_code, r.data["code"]), (403, "session_required"))
        self.sub.refresh_from_db()
        self.assertEqual(self.sub.previous_secret_encrypted, "")

    def test_a_bad_body_never_outranks_the_access_gates(self):
        """Validation runs last, so a 400 can't confirm a board or webhook exists."""
        outsider, member = _make_user(), _make_user()
        _make_membership(self.board, member, "member")
        other_admin, other_board = admin_and_board("Other board")
        foreign = make_subscription(other_board, other_admin)
        _, raw = PersonalAccessToken.generate(self.admin, "t-2054-gates")
        pat = APIClient()
        pat.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        as_outsider, as_member = APIClient(), APIClient()
        as_outsider.force_login(outsider)
        as_member.force_login(member)
        own = self.sub.pk
        for body in ({"overlap_seconds": -1}, [1]):
            cases = [
                ("non-member", as_outsider, own, 404, None),
                ("below admin", as_member, own, 403, None),
                ("token", pat, own, 403, "session_required"),
                ("another board's webhook", self.client, foreign.pk, 404, None),
            ]
            for label, client, sub_id, status, code in cases:
                with self.subTest(who=label, body=body):
                    r = client.post(_url(self.board.pk, f"{sub_id}/rotate/"), body, format="json")
                    self.assertEqual(r.status_code, status, r.content)
                    if code:
                        self.assertEqual(r.data["code"], code)
            with self.subTest(who="feature off", body=body), override_settings(WEBHOOKS_ENABLED=False):
                r = self.client.post(_url(self.board.pk, f"{own}/rotate/"), body, format="json")
                self.assertEqual((r.status_code, r.data["code"]), (403, "webhooks_disabled"))
            with self.subTest(who="admin session", body=body):
                r = self.client.post(_url(self.board.pk, f"{own}/rotate/"), body, format="json")
                self.assertEqual(r.status_code, 400, r.content)

    def test_a_token_rename_keeps_the_window(self):
        self.rotate(overlap_seconds=DAY)
        self.sub.refresh_from_db()
        stored = (self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at)
        _, raw = PersonalAccessToken.generate(self.admin, "t-2054-rename")
        pat = APIClient()
        pat.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        r = pat.patch(_url(self.board.pk, f"{self.sub.pk}/"), {"name": "renamed"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(r.data["previous_secret_expires_at"])
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), stored)

    def test_url_change_clears_both_columns(self):
        self.rotate(overlap_seconds=DAY)
        with resolving():
            r = self.client.patch(_url(self.board.pk, f"{self.sub.pk}/"), {"url": "https://new.example.com/h"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.data["previous_secret_expires_at"])
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), ("", None))

    def test_a_name_only_patch_keeps_the_window(self):
        self.rotate(overlap_seconds=DAY)
        self.sub.refresh_from_db()
        stored = (self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at)
        r = self.client.patch(_url(self.board.pk, f"{self.sub.pk}/"), {"name": "renamed"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.data["previous_secret_expires_at"])
        self.sub.refresh_from_db()
        self.assertEqual((self.sub.previous_secret_encrypted, self.sub.previous_secret_expires_at), stored)

    def test_rotate_logs_the_effective_overlap_and_no_secret_material(self):
        with self.assertLogs("webhooks.dispatch", level=logging.INFO) as logs:
            self.rotate(overlap_seconds=DAY)
            self.rotate()
        text = "\n".join(logs.output)
        self.assertIn(f"reason=overlap={DAY}", text)
        self.assertIn("reason=overlap=0", text)
        self.sub.refresh_from_db()
        self.assertNotIn("whsec_", text)
        self.assertNotIn(self.sub.secret_encrypted, text)

    def test_a_webhook_deleted_during_rotate_is_a_404(self):
        stale = WebhookSubscription.objects.select_related("created_by", "configured_by").get(pk=self.sub.pk)
        WebhookSubscription.objects.filter(pk=self.sub.pk).delete()
        with patch("webhooks.views.WebhookSubscriptionViewSet._subscription", return_value=stale):
            r = self.rotate()
        self.assertEqual(r.status_code, 404)
