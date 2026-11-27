"""The User signal receivers are held by strong reference (#2145).

``accounts.signals._connect_user_signals`` defines its receivers as local
functions. Django connects a receiver weakly unless told otherwise, and
nothing else references a local function, so a garbage-collection pass
disconnected them mid-run: a superuser then kept ``can_access_all_content``
False and lost every board (``test_superuser_status_removed_clears`` failed
in one CI shard, in order-dependent fashion).
"""

import gc
import weakref

from django.db.models.signals import post_save, pre_delete, pre_save
from django.test import SimpleTestCase

from accounts.models import User

EXPECTED = {
    pre_delete: {"accounts.revoke_deleted_creator_site_invites"},
    pre_save: {"accounts.capture_prior_superuser_state", "accounts.capture_prior_email"},
    post_save: {"accounts.ensure_superuser_is_site_admin", "accounts.notify_previous_email"},
}


class UserSignalReceiverTests(SimpleTestCase):
    def test_every_user_receiver_is_connected_strongly(self):
        for signal, uids in EXPECTED.items():
            held = {
                key[0]: receiver
                for key, receiver, *_ in signal.receivers
                if key[0] in uids
            }
            self.assertEqual(set(held), uids)
            for uid, receiver in held.items():
                self.assertNotIsInstance(receiver, weakref.ReferenceType, uid)

    def test_receivers_survive_a_collection_pass(self):
        gc.collect()
        for signal, uids in EXPECTED.items():
            live = signal._live_receivers(User)
            live = live[0] if isinstance(live, tuple) else live
            self.assertGreaterEqual(len(live), len(uids), signal)
