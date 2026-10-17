"""Test helper for minting board and group invites (#1678).

``generate()`` refuses an emailed invite without a recipient address, since
every emailed invite is bound to one. Most invite tests exercise rules that
do not depend on that binding (caps, sender standing, consume-once, the
access ladder), and they redeem with whichever account the test needs. For
those, ``generate_invite`` mints an emailed invite with a placeholder address
and then clears the binding: the same shape as a row minted before
``recipient_hash`` existed, which redeems for any account. Tests of the binding
itself live in ``test_invite_recipient_binding.py`` and call ``generate()``
with a real address.
"""

_PLACEHOLDER = "unbound-fixture@example.invalid"


def generate_invite(model, *args, **kwargs):
    """``model.generate(*args, **kwargs)``; an emailed invite comes back unbound."""
    emailed = kwargs.get("delivery") == model.Delivery.EMAIL and not kwargs.get("recipient_email")
    if not emailed:
        return model.generate(*args, **kwargs)
    kwargs["recipient_email"] = _PLACEHOLDER
    link, raw = model.generate(*args, **kwargs)
    model.objects.filter(pk=link.pk).update(recipient_hash=None)
    link.recipient_hash = None
    return link, raw
