"""Root pytest configuration for the backend suite (#2488, #2490).

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

#2490 adds the ``migrations`` marker guard and the pg_trgm pre_migrate receiver
below the hasher hook.
"""

import pytest

# Test-only hasher: never reachable from a production settings module.
# PBKDF2 stays second so a fixture carrying a real production hash still verifies
# (Django checks a stored hash with whichever listed hasher matches its prefix);
# new hashes are always MD5, the first entry.
FAST_TEST_PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
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

def migrations_guard_error(items, nomigrations):
    """Return an error message when a `migrations` test would run without migrations.

    Why fail instead of skip: under --nomigrations the test DB is built straight
    from the models, so a test that drives the real migration graph (or reads
    rows a data migration seeds) would pass or fail for the wrong reason. A skip
    would hide that the full-apply coverage never ran, so this errors loudly.
    CI shards avoid it by also passing `-m "not migrations"`, which deselects
    these tests before this hook sees them.
    """
    if not nomigrations:
        return None
    marked = [i.nodeid for i in items if i.get_closest_marker("migrations")]
    if not marked:
        return None
    shown = ", ".join(marked[:3]) + (" ..." if len(marked) > 3 else "")
    return (
        f"{len(marked)} test(s) marked @pytest.mark.migrations would run with "
        f"--nomigrations ({shown}). Add -m 'not migrations' or drop --nomigrations."
    )


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    # trylast: must run after the -m deselection in _pytest.mark, so `items` is
    # exactly what will execute.
    message = migrations_guard_error(items, config.getoption("nomigrations", default=False))
    if message:
        raise pytest.UsageError(message)


def _create_pg_extensions(sender, using="default", **kwargs):
    """Create the Postgres extensions the models' indexes need, before tables.

    Why: migration boards.0030 runs CREATE EXTENSION pg_trgm, and Card declares
    GIN indexes on gin_trgm_ops. Under --nomigrations the schema is built straight
    from the models and 0030 never runs, so without this the Card table fails to
    create on Postgres. The full-migration job still proves 0030 itself.
    """
    from django.db import connections

    connection = connections[using]
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")


def pytest_sessionstart(session):
    # A separate hook from the hasher's pytest_configure above (one name per
    # module); runs before any fixture builds the test DB.
    if session.config.getoption("nomigrations", default=False):
        from django.db.models.signals import pre_migrate

        pre_migrate.connect(_create_pg_extensions, dispatch_uid="visiban_2490_pg_extensions")
