"""Root pytest configuration for the backend suite (#2488).

Test-only fast password hasher. Production uses Django's default PBKDF2 at
~1M iterations, which made every ``create_user()`` / ``set_password()`` in the
suite cost ~100 ms and dominated CI shard time. Under pytest the preferred
hasher is swapped for MD5, which is fast and deterministic.

This lives here, not in ``visiban/settings.py``: the ``_TESTING`` flag there is
``"pytest" in sys.modules``, so a production process that merely imported
pytest would silently hash with MD5. A conftest only ever loads under pytest.

Tests that assert real hashing behavior (hash format, ``must_update`` upgrades)
opt back in with ``@override_settings(PASSWORD_HASHERS=[...])`` -- see
``docs/development/testing.md``.
"""

import pytest

# Test-only hasher: never reachable from a production settings module.
FAST_TEST_PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]


@pytest.hookimpl(trylast=True)
def pytest_configure(config):
    # trylast: pytest-django must have configured settings first.
    from django.conf import settings
    from django.contrib.auth import hashers
    from django.test.signals import setting_changed

    settings.PASSWORD_HASHERS = FAST_TEST_PASSWORD_HASHERS
    # Drop any hasher cache built before the swap.
    setting_changed.send(
        sender=settings._wrapped.__class__,
        setting="PASSWORD_HASHERS",
        value=FAST_TEST_PASSWORD_HASHERS,
        enter=True,
    )
    hashers.get_hashers.cache_clear()
    hashers.get_hashers_by_algorithm.cache_clear()
