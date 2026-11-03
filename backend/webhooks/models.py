"""Outbound webhook subscriptions (#863).

A subscription is a cursor into one board's change feed plus a destination.
The dispatcher (``webhooks.dispatch``) reads feed rows after ``cursor`` through
the same redaction the REST feed applies, POSTs each one, and advances the
cursor on a 2xx. There is no queue table: the change feed *is* the queue, which
is why delivery is at-least-once with head-of-line blocking per subscription.

Every column is nullable or carries a ``db_default`` (zero-downtime rule), and
``default`` is set beside each ``db_default`` so an unsaved instance reads the
same value the database would write.

Secrets at rest
---------------
``url_encrypted`` and ``secret_encrypted`` are Fernet ciphertexts under their
own ``visiban.crypto`` info labels. The URL is encrypted too: a Slack or Zapier
incoming-webhook URL carries its credential in the path. ``url_host`` is the
only plaintext part of the URL, kept so the UI and the logs can name the
destination without decrypting anything.

Nothing here is registered in the Django admin, and the board export does not
include subscriptions: a copied board must not inherit a destination or a
signing secret.

Rotation overlap (#2054)
------------------------
``previous_secret_encrypted`` holds the secret a rotation replaced, moved
verbatim, so a receiver that has not updated yet keeps verifying until
``previous_secret_expires_at``. It is only ever an optional extra signature: the
current secret alone decides whether a delivery can be signed at all. The two
columns are written together, by ``rotate``, a URL change and the dispatcher's
sweep, and neither is ever returned by the API or written to a log.
"""

import logging
import secrets

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from boards.broadcast import BOARD_CHANNEL_EVENTS, EVT_BOARD_DELETED, EVT_PING
from boards.permissions import ADMIN_ONLY_EVENTS, PER_USER_EVENTS
from visiban import crypto

#: Event types a subscription may name in ``event_types``. Per-user and
#: admin-only rows never reach a webhook (the dispatcher reads as an anonymous
#: viewer), ``ping`` is a socket keepalive and never persisted, and
#: ``board.deleted`` is never delivered: the subscription is deleted with its
#: board (CASCADE). ``GET status/`` returns this list so the UI never keeps its
#: own copy.
SUBSCRIBABLE_EVENT_TYPES = tuple(
    sorted(BOARD_CHANNEL_EVENTS - PER_USER_EVENTS - ADMIN_ONLY_EVENTS - {EVT_PING, EVT_BOARD_DELETED})
)

SECRET_PREFIX = "whsec_"

#: Longest ``rotate`` overlap: seven days. A constant, deliberately not a setting:
#: this is how long a replaced signing secret may go on signing.
MAX_SECRET_OVERLAP_SECONDS = 604800

logger = logging.getLogger(__name__)


def generate_secret() -> str:
    """A new signing secret: ``whsec_`` + 32 random bytes, urlsafe base64."""
    return SECRET_PREFIX + secrets.token_urlsafe(32)


class WebhookSubscription(models.Model):
    class DisabledReason(models.TextChoices):
        NONE = "", "enabled"
        MANUAL = "manual", "disabled by an admin"
        FAILURES = "failures", "too many failed deliveries"
        CURSOR_EXPIRED = "cursor_expired", "fell behind event retention"
        CREATOR_LOST_ACCESS = "creator_lost_access", "owner no longer a board admin"
        SECRET_UNAVAILABLE = "secret_unavailable", "stored secret could not be decrypted"

    board = models.ForeignKey(
        "boards.Board", on_delete=models.CASCADE, related_name="webhook_subscriptions"
    )
    name = models.CharField(max_length=200, default="", db_default="", blank=True)
    url_encrypted = models.TextField(default="", db_default="")
    url_host = models.CharField(max_length=255, default="", db_default="")
    secret_encrypted = models.TextField(default="", db_default="")
    #: The replaced secret during a rotation overlap, same ciphertext and label.
    previous_secret_encrypted = models.TextField(default="", db_default="", blank=True)
    previous_secret_expires_at = models.DateTimeField(null=True, blank=True)
    #: Empty list = every type in SUBSCRIBABLE_EVENT_TYPES.
    event_types = models.JSONField(default=list, db_default=[])
    enabled = models.BooleanField(default=True, db_default=True)
    disabled_reason = models.CharField(
        max_length=32, choices=DisabledReason.choices, default="", db_default="", blank=True
    )
    disabled_at = models.DateTimeField(null=True, blank=True)

    #: Id of the last change-feed row delivered or skipped. Only ever moves
    #: forward, by compare-and-set under the lease (webhooks.dispatch).
    cursor = models.BigIntegerField(default=0, db_default=0)
    consecutive_failures = models.IntegerField(default=0, db_default=0)
    failing_since = models.DateTimeField(null=True, blank=True)
    #: Null means due now.
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    #: When the dispatcher last read this subscription's feed, delivered or not.
    #: Orders the run (least recently scanned first). Not used for cursor
    #: expiry, which reads the board's prune record (#2058, #2079).
    last_scanned_at = models.DateTimeField(null=True, blank=True)
    #: A fixed code from visiban.egress, never exception or response text.
    last_error_code = models.CharField(max_length=32, default="", db_default="", blank=True)
    last_status_code = models.SmallIntegerField(null=True, blank=True)

    lease_until = models.DateTimeField(null=True, blank=True)
    lease_token = models.UUIDField(null=True, blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    #: The standing principal (owner decision D4): the account whose board-admin
    #: standing keeps this subscription delivering. Re-stamped on create, URL
    #: change, secret rotation and re-enable; NULL (account deleted) fails closed.
    configured_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    configured_at = models.DateTimeField(null=True, blank=True)
    secret_rotated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "webhook_subscriptions"
        ordering = ["id"]
        indexes = [
            # The dispatcher's due-work scan: enabled rows by next_attempt_at.
            # Created with the table, so it needs no concurrent build.
            models.Index(fields=["enabled", "next_attempt_at"], name="webhook_due_idx"),
        ]

    def __str__(self):
        # Never the URL: it may be a credential.
        return f"WebhookSubscription #{self.pk} on board {self.board_id} ({self.url_host})"

    # ── secrets ──────────────────────────────────────────────────────────────

    def set_url(self, url: str, host: str):
        self.url_encrypted = crypto.encrypt_secret(url, info=crypto.WEBHOOK_URL_INFO)
        self.url_host = host[:255]

    def get_url(self) -> str:
        """Raises ``crypto.SecretDecryptionError``."""
        return crypto.decrypt_secret(self.url_encrypted, info=crypto.WEBHOOK_URL_INFO)

    def set_secret(self, secret: str):
        self.secret_encrypted = crypto.encrypt_secret(secret, info=crypto.WEBHOOK_SECRET_INFO)

    def get_secret(self) -> str:
        """Raises ``crypto.SecretDecryptionError``."""
        return crypto.decrypt_secret(self.secret_encrypted, info=crypto.WEBHOOK_SECRET_INFO)

    @property
    def previous_secret_active_until(self):
        """When the open overlap ends, or None when there is none.

        Reads the wall clock, so a window that has passed reads as closed even
        before the dispatcher's sweep clears the columns.
        """
        expires_at = self.previous_secret_expires_at
        if not self.previous_secret_encrypted or expires_at is None or expires_at <= timezone.now():
            return None
        return expires_at

    def get_previous_secret(self) -> str | None:
        """The previous secret while its overlap is open, else None. Never raises.

        An unreadable previous secret costs only the receiver's grace period,
        so unlike ``get_secret`` it does not stop delivery: the request is still
        signed with the current secret, and the failure is logged by id.
        """
        if self.previous_secret_active_until is None:
            return None
        try:
            return crypto.decrypt_secret(self.previous_secret_encrypted, info=crypto.WEBHOOK_SECRET_INFO) or None
        except crypto.SecretDecryptionError:
            logger.warning(
                "webhook previous secret unreadable: subscription_id=%s board_id=%s", self.pk, self.board_id
            )
            return None

    def clear_previous_secret(self):
        self.previous_secret_encrypted = ""
        self.previous_secret_expires_at = None

    def wants(self, event_type: str) -> bool:
        if event_type not in SUBSCRIBABLE_EVENT_TYPES:
            return False
        return not self.event_types or event_type in self.event_types


class WebhookDispatcherState(models.Model):
    """Singleton (pk=1) dispatcher heartbeat, read by ``GET status/``.

    Exists so a board admin can see that nothing is delivering because nothing
    is running, rather than an enabled subscription that silently never fires.
    """

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    last_run_started_at = models.DateTimeField(null=True, blank=True)
    last_run_finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "webhook_dispatcher_state"
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="webhook_dispatcher_state_singleton"),
        ]
