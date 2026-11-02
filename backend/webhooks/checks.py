"""System checks for outbound webhooks (#863).

Both are errors, so a misconfiguration stops ``manage.py check`` (and the
container's startup) rather than surfacing at the first delivery.
"""

from django.conf import settings
from django.core import checks

from visiban.egress import AllowlistError, parse_allowlist


@checks.register(checks.Tags.security)
def check_webhooks_not_in_demo_mode(app_configs, **kwargs):
    """webhooks.E001: a public demo with a published login must not send webhooks.

    Anyone holding the demo credential could otherwise point a subscription at
    any address the demo's network can reach. The write fence already refuses
    the API, and the dispatcher exits in demo mode; this makes the combination
    a configuration error instead of a state that only looks safe.
    """
    if getattr(settings, "WEBHOOKS_ENABLED", False) and getattr(settings, "DEMO_MODE", False):
        return [
            checks.Error(
                "WEBHOOKS_ENABLED cannot be turned on while DEMO_MODE is on.",
                hint="Unset WEBHOOKS_ENABLED on the demo deployment.",
                id="webhooks.E001",
            )
        ]
    return []


@checks.register(checks.Tags.security)
def check_allowed_private_targets(app_configs, **kwargs):
    """webhooks.E002: every WEBHOOK_ALLOWED_PRIVATE_TARGETS entry must be usable.

    Checked whether or not webhooks are enabled, so a bad value is found when
    it is written rather than when the feature is switched on. The message
    names the entry but nothing else, and the entry is the operator's own value.
    """
    try:
        parse_allowlist(getattr(settings, "WEBHOOK_ALLOWED_PRIVATE_TARGETS", ""))
    except AllowlistError as exc:
        return [
            checks.Error(
                f"WEBHOOK_ALLOWED_PRIVATE_TARGETS has an unusable entry: {exc}",
                hint=(
                    "List exact hostnames, private IP addresses or private CIDRs. "
                    "A /0 or a public range is refused. See "
                    "docs/administration/configuration.md#webhooks."
                ),
                id="webhooks.E002",
            )
        ]
    return []
