import os
import sys
import warnings
from urllib.parse import urlparse
import environ
from django.core.exceptions import ImproperlyConfigured
from pathlib import Path

from visiban.utils import normalize_app_version


def _warn_deprecated_env_alias(old_name: str, new_name: str) -> None:
    """Emit a one-shot DeprecationWarning when a legacy env var is set.

    Only fires when the operator has actually set the old name in the
    environment — checking ``env()`` with defaults would warn on every
    worker start regardless of whether the alias is in use (#819).
    """
    if os.environ.get(old_name):
        warnings.warn(
            f"{old_name} is deprecated; rename it to {new_name}. "
            f"The {old_name} alias will be removed in a future release.",
            DeprecationWarning,
            stacklevel=2,
        )


def _validate_redis_url(name: str, url: str) -> None:
    """Raise if `url` can't be parsed into a host, without echoing it (it carries the password).

    A password containing "/", "?", "#" or "[" / "]" spliced raw into the URL
    (docker-compose.prod.yml builds these from REDIS_PASSWORD) moves the host
    into the path. Nothing fails without this check — the backend just boots
    pointing at no host and every WebSocket and cache call fails later, far
    from the cause. Extracted from the settings body so it can be unit-tested
    directly instead of only via a subprocess settings reload (#987).
    """
    try:
        # urlparse itself raises on "[" / "]" in the netloc (it validates
        # them as an IPv6 literal) and its message quotes the bracketed
        # text — part of the password — so it must sit inside the try too.
        parsed = urlparse(url)
        parsed.port  # noqa: B018 — raises ValueError on a malformed port
        # An empty netloc (redis:///0) is a valid "default host" URL; a
        # netloc that yields no hostname is the broken-password case.
        bad = (
            parsed.scheme in ("redis", "rediss")
            and bool(parsed.netloc)
            and not parsed.hostname
        )
    except ValueError:
        bad = True
    if bad:
        raise ImproperlyConfigured(
            f"{name} could not be parsed into a host. If its password contains "
            "any of / ? # % [ ] or a space, percent-encode them, or generate the "
            "password with `openssl rand -hex 32`."
        )


_DB_URL_ERROR = (
    "DATABASE_URL could not be parsed. If its password contains any of "
    "/ ? # % [ ] or a space, percent-encode them, or generate the password "
    "with `openssl rand -hex 32`."
)


def _load_database_url(url: str) -> dict:
    """Parse DATABASE_URL, raising ImproperlyConfigured rather than echoing a bad password.

    Same failure class as the Redis URLs above, but louder: a "/" in the
    password (docker-compose.prod.yml splices DB_PASSWORD in raw) makes the
    parser read the text before it as the port, and its ValueError quotes
    that text — a fragment of the database password, printed to the
    container log. Re-raised without the original message (`from None` also
    drops the chained traceback).

    The warnings are captured and never re-emitted: for a URL with no usable
    scheme, django-environ does not raise but warns "Engine not recognized
    from url: {config}" — the parsed dict, PASSWORD included — and returns
    {}. Extracted from the settings body so it can be unit-tested directly
    instead of only via a subprocess settings reload (#987).
    """
    try:
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            db_config = environ.Env.db_url_config(url)
    except ValueError:
        raise ImproperlyConfigured(_DB_URL_ERROR) from None
    if not db_config.get("ENGINE"):
        raise ImproperlyConfigured(_DB_URL_ERROR)
    return db_config


# Detect when running under `manage.py test` or pytest so we can substitute
# fast in-process backends for Redis-backed services. This avoids requiring a
# running Redis instance just to run the test suite locally.
_TESTING = (
    (len(sys.argv) > 1 and sys.argv[1] == "test")
    or "pytest" in sys.modules
)

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, False),
)
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    environ.Env.read_env(_env_file)

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env("DEBUG")

# Reject placeholder secret keys in production. This guard fires at startup so a
# misconfigured deploy fails immediately rather than running silently with a known
# weak key that could allow session forgery or cookie tampering.
_INSECURE_SECRET_KEYS = {"change-me-in-production", ""}
if not DEBUG and SECRET_KEY in _INSECURE_SECRET_KEYS:
    raise ImproperlyConfigured(
        "DJANGO_SECRET_KEY must be set to a secure random value. "
        'Generate one with: python -c "import secrets; print(secrets.token_hex(50))"'
    )
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

# Resolve OIDC env vars early so INSTALLED_APPS and SOCIALACCOUNT_PROVIDERS
# both reference the same computed flag instead of calling env() twice.
_OIDC_CLIENT_ID = env("OIDC_CLIENT_ID", default="")
# OIDC_CLIENT_SECRET is the canonical name (consistent with GOOGLE_CLIENT_SECRET,
# GITHUB_CLIENT_SECRET, etc.).
_OIDC_CLIENT_SECRET = env("OIDC_CLIENT_SECRET", default="")
# Warn operators still setting the pre-1.1 alias: the old name is no longer
# read, so an unrenamed OIDC_SECRET silently deactivates SSO (#894, #1047).
_warn_deprecated_env_alias("OIDC_SECRET", "OIDC_CLIENT_SECRET")
_OIDC_SERVER_URL = env("OIDC_SERVER_URL", default="")
# True when all three OIDC env vars are present. The provider app is only
# registered in INSTALLED_APPS and SOCIALACCOUNT_PROVIDERS when this is True
# so that allauth does not attempt discovery with an empty server_url.
_OIDC_ENABLED = bool(_OIDC_CLIENT_ID and _OIDC_CLIENT_SECRET and _OIDC_SERVER_URL)

# Issue Board Lens (experiment) — render a public GitHub/GitLab repo's issues as
# a read-only Visiban board. Off by default so operators who don't use it never
# expose the surface area; the app and its routes stay dormant when False.
GIT_LENS_ENABLED = env.bool("GIT_LENS_ENABLED", default=False)

# MCP (Model Context Protocol) server — exposes Visiban boards to AI agents
# over the Streamable HTTP transport at /mcp (#511). Off by default: it is a
# new network-reachable transport, and an install that upgrades should not
# acquire that surface without opting in. When False the ASGI mount is skipped
# entirely, so /mcp does not exist and the MCP SDK is never imported.
MCP_SERVER_ENABLED = env.bool("MCP_SERVER_ENABLED", default=False)

# Host allowlist for the MCP transport's DNS-rebinding protection. Defaults to
# ALLOWED_HOSTS; set this explicitly when ALLOWED_HOSTS is "*", which cannot
# serve as a rebinding allowlist (see mcp_server/server.py).
MCP_ALLOWED_HOSTS = env.list("MCP_ALLOWED_HOSTS", default=[])

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.sites",
    "django.contrib.postgres",
    # Third-party
    "channels",
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",
    "django_filters",
    "allauth",
    "allauth.account",
    "allauth.socialaccount",
    "allauth.socialaccount.providers.google",
    "allauth.socialaccount.providers.github",
    "allauth.socialaccount.providers.gitlab",
    # openid_connect is only registered when all three OIDC env vars are set
    # (_OIDC_ENABLED, computed above). Registering the app without a valid
    # configuration causes allauth startup errors on discovery, so the guard
    # here keeps INSTALLED_APPS in sync with SOCIALACCOUNT_PROVIDERS below.
    *([
        "allauth.socialaccount.providers.openid_connect",
    ] if _OIDC_ENABLED else []),
    "dj_rest_auth",
    "dj_rest_auth.registration",
    "drf_spectacular",
    # Local
    "accounts",
    "boards",
    "groups",
    # Issue Board Lens — only registered when the experiment flag is on, mirroring
    # the OIDC conditional-app pattern above so dormant code loads no tables/routes.
    *(["git_lens"] if GIT_LENS_ENABLED else []),
    # MCP server — registered only when the flag is on, mirroring the
    # conditional-app pattern above. The app holds no models (MCP callers
    # authenticate with accounts.PersonalAccessToken), so it adds no tables.
    *(["mcp_server"] if MCP_SERVER_ENABLED else []),
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    # Restrict /admin/ to loopback (or DJANGO_ADMIN_ALLOWED_IPS) in production.
    # Placed early so the check runs before session/auth processing.
    "visiban.middleware.AdminIPRestrictionMiddleware",
    # Hosted-demo write fence (#1179). Deliberately EARLIER than
    # MaintenanceModeMiddleware and ahead of session/auth/CSRF: it refuses
    # everyone (a site admin included), so it needs no request.user, and its
    # process_view hook — where the allowlist decision is made, because it
    # needs the resolved view_name — then runs before CsrfViewMiddleware's, so
    # a refused request does no session, CSRF or database work. A no-op unless
    # DEMO_MODE is on. See visiban/demo.py.
    "visiban.middleware.DemoModeMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    # Instance-wide read-only mode (#783). Must come AFTER
    # AuthenticationMiddleware, because the site-admin exemption reads
    # request.user, and is placed ahead of the allauth/session bookkeeping
    # below so a request that is about to be rejected does not first do that
    # work.
    #
    # Note that during maintenance a write that would also have failed CSRF
    # gets 503 rather than 403: CSRF is enforced in CsrfViewMiddleware's
    # process_view hook, which runs after every middleware's pre-view phase,
    # and this middleware short-circuits before that. Harmless — both are
    # refusals — but do not "fix" the ordering on the assumption that moving
    # this earlier or later changes it. It does not.
    "visiban.middleware.MaintenanceModeMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    # Stash invite tokens in the Django session before OAuth redirects so that
    # the SocialRegistrationAdapter can validate them on the callback.
    "accounts.middleware.OAuthInviteTokenMiddleware",
]

ROOT_URLCONF = "visiban.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "visiban.wsgi.application"
ASGI_APPLICATION = "visiban.asgi.application"

if _TESTING:
    # Use in-process backends when running the test suite so that a local Redis
    # instance is not required. Tests that specifically need to verify broadcast
    # or cache behaviour still work correctly because InMemoryChannelLayer and
    # LocMemCache implement the same interfaces as the Redis-backed versions.
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        },
    }
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }
else:
    _REDIS_URL = env("REDIS_URL", default="redis://localhost:6379/0")
    _REDIS_CACHE_URL = env("REDIS_CACHE_URL", default="redis://localhost:6379/1")
    # Fail at startup on an unparseable host, and never echo the URL: it
    # carries the password. See _validate_redis_url's docstring above.
    for _name, _url in (("REDIS_URL", _REDIS_URL), ("REDIS_CACHE_URL", _REDIS_CACHE_URL)):
        _validate_redis_url(_name, _url)
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [_REDIS_URL],
            },
        },
    }
    # Cache — uses REDIS_CACHE_URL (db 1 by default) to keep it separate from
    # Channels (db 0). Set REDIS_CACHE_URL explicitly if your Redis host differs
    # from REDIS_URL or you want to use the same DB (which is fine for dev).
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": _REDIS_CACHE_URL,
        }
    }

# Same failure class as the Redis URLs above, but louder — see
# _load_database_url's docstring above.
_DEFAULT_DB = _load_database_url(env("DATABASE_URL"))

DATABASES = {
    "default": _DEFAULT_DB,
}

AUTH_USER_MODEL = "accounts.User"

# The single source of truth for Visiban's password-length policy (#1258).
# Enforced through MinimumLengthValidator below, so it applies to EVERY path
# that runs AUTH_PASSWORD_VALIDATORS: registration and invite-accept (allauth's
# clean_password), password-reset confirm and dj-rest-auth's password/change/
# (Django's SetPasswordForm), /auth/change-password/, admin-created accounts,
# the Django admin's set-password form and createsuperuser. Before #1258 the
# validator ran with Django's default of 8, so only the endpoints that also
# hard-coded 12 enforced the documented policy. Validators run only when a
# password is *set* — existing accounts with a shorter password still log in
# and are asked for 12+ characters only the next time they change it.
PASSWORD_MIN_LENGTH = 12

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": PASSWORD_MIN_LENGTH},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}
WHITENOISE_USE_FINDERS = DEBUG  # serve un-collected files in development only

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Maximum upload size. Operators can override via MAX_UPLOAD_SIZE_BYTES env var.
MAX_UPLOAD_SIZE = env.int("MAX_UPLOAD_SIZE_BYTES", default=10 * 1024 * 1024)

# Maximum Trello JSON export accepted by POST /api/boards/import/trello/ (#456),
# in bytes. Separate from MAX_UPLOAD_SIZE because Trello exports of large boards
# routinely exceed the 10 MB attachment cap. The import runs synchronously, so
# per-import count caps in boards/services/trello_import.py bound the work, not
# this value alone. Reverse proxies must allow bodies at least this large.
VISIBAN_IMPORT_MAX_SIZE = env.int("VISIBAN_IMPORT_MAX_SIZE", default=25 * 1024 * 1024)

# X-Accel-Redirect (Nginx sendfile) for media downloads. Default: enabled in
# production, disabled in development. Operators on platforms that don't mount
# the media volume on Nginx (e.g. the Helm chart, where only the backend mounts
# the media PVC so RWO storage classes work in HA) can disable it explicitly to
# have Django stream the file body via FileResponse.
USE_X_ACCEL_REDIRECT = env.bool("USE_X_ACCEL_REDIRECT", default=not DEBUG)

# Board change feed (#1114) — how long an event stays readable by
# GET /api/v1/boards/<id>/events/. Enforced by `manage.py prune_board_events`,
# which an operator schedules; nothing expires on its own, so raising this only
# takes effect for events the pruner has not already removed. A consumer whose
# cursor falls outside the window gets 410 and re-syncs via /full/.
BOARD_EVENT_RETENTION_DAYS = env.int("BOARD_EVENT_RETENTION_DAYS", default=30)

# In-app notifications (#1158) — how long a row in `notifications` is kept,
# read or unread. Enforced by `manage.py prune_notifications`, which only runs
# when an operator schedules it (host cron, the Compose `scheduler` profile, or
# the Helm `scheduledJobs.pruneNotifications` CronJob) — an install that never
# schedules it keeps every notification, exactly as before 1.2. The command
# refuses windows under 14 days: notification rows double as the "already sent"
# record for notify_due_soon / notify_stale_cards, so a too-short window would
# make those commands re-notify (and re-email) the same card.
NOTIFICATION_RETENTION_DAYS = env.int("NOTIFICATION_RETENTION_DAYS", default=90)

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SITE_ID = 1

# Trusted reverse-proxy depth (#1180). Strictly parsed: a typo refuses to boot
# rather than silently collapsing every visitor into one throttle bucket (or
# letting clients choose their own). Unset keeps the pre-#1180 value of 1.
from visiban.utils import parse_num_proxies as _parse_num_proxies  # noqa: E402

_NUM_PROXIES = _parse_num_proxies(os.environ.get("NUM_PROXIES"))

# DRF
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        # PAT must be first so authenticate_header() returns "Token", which causes
        # DRF to emit 401 (not 403) for authentication failures on all views.
        "accounts.authentication.PATAuthentication",
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.TokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
        # Block all API access for accounts with a forced password-change pending.
        # Views that must remain accessible (ChangePasswordView) opt out by declaring
        # their own explicit permission_classes without this class. All other views
        # must NOT override permission_classes with [IsAuthenticated] alone.
        "visiban.permissions.MustNotHavePendingPasswordChange",
        "visiban.permissions.MustNotHavePendingUsernameChange",
        # Per-view scope requirements for personal access tokens (#1110). The
        # read/write/admin baseline is NOT here — it runs in PATAuthentication,
        # because the views below almost all override permission_classes and a
        # baseline declared here would be evaluated on nearly no endpoint.
        "accounts.permissions.TokenHasScope",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "visiban.pagination.OffsetCountPagination",
    "PAGE_SIZE": 50,
    # Versioning — all API endpoints are served under /api/v1/.
    # Adding the infrastructure at 1.0 gives clients an upgrade path for v2
    # without requiring a flag day or a second URL structure.
    "DEFAULT_VERSIONING_CLASS": "rest_framework.versioning.URLPathVersioning",
    "DEFAULT_VERSION": "v1",
    "ALLOWED_VERSIONS": ["v1"],
    # How many reverse proxies in front of Django append to X-Forwarded-For.
    # DRF keys every per-IP throttle on the entry this many hops from the right,
    # and visiban.utils.get_client_ip (admin allowlist, allauth rate limits)
    # reads the same value. Default 1 = the bundled nginx alone. A deployment
    # behind another proxy layer (the public demo's Cloudflare Tunnel, #1180)
    # must raise it, or every visitor shares the tunnel's address and one
    # client exhausts the login/anon throttles for everyone. Raising it past
    # the real chain lets a client pick its own bucket via a spoofed header.
    "NUM_PROXIES": _NUM_PROXIES,
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        # In development throttling is disabled (effectively unlimited).
        # In production use sane but generous limits; polling endpoints
        # (notifications, version) fire every 15–30 s so a single active
        # user easily makes 500+ authenticated requests per hour.
        "anon": "9999/hour" if DEBUG else "300/hour",
        "user": "9999/hour" if DEBUG else "5000/hour",
        # Tighter limit for user-search: protects against enumeration attacks
        # while still comfortably supporting interactive autocomplete use.
        "user_search": "9999/hour" if DEBUG else "30/min",
        # Cross-board card query (#1112): the first bulk-read endpoint that can
        # return a member's entire accessible-card corpus (across every board
        # they belong to) in a handful of ?search=/paged requests, unlike every
        # other card read which is scoped to one board. Generous enough for a
        # UI polling for incremental sync, tight enough to bound scraping.
        "card_query": "9999/hour" if DEBUG else "120/min",
        # Invite-link redemption: low ceiling prevents token brute-force scanning.
        "join_group": "9999/hour" if DEBUG else "10/hour",
        # Registration: prevents invite token brute-force and mass account creation.
        "register": "9999/hour" if DEBUG else "10/min",
        # Password reset: prevents the reset flow from being used for bulk email sends.
        "password_reset": "9999/hour" if DEBUG else "5/hour",
        # Password reset confirm: prevents automated token-stuffing against the confirm endpoint.
        "password_reset_confirm": "9999/hour" if DEBUG else "10/hour",
        # WebSocket ticket issuance (#1109): one ticket is spent per connection
        # attempt, so a client reconnecting after a network blip legitimately
        # bursts here. Generous enough to absorb a reconnect storm, low enough
        # to bound a script farming tickets.
        "ws_ticket": "9999/hour" if DEBUG else "60/min",
        # Public board share-link reads: generous per-IP cap to limit scraping.
        "share_link": "120/hour",
        # Per-token cap (#988): bounds brute-force enumeration of share tokens
        # regardless of source IP (CGNAT, residential proxy pool).  UUID
        # entropy already makes brute force impractical; this is defense in
        # depth to bound abusive traffic against a single discovered token.
        "share_link_token": "240/hour",
        # Choose-username: prevents username enumeration via "already taken" probing.
        "choose_username": "9999/hour" if DEBUG else "10/min",
        # Board import: each import can create up to 500 cards; cap prevents DB flooding.
        "board_import": "9999/hour" if DEBUG else "10/hour",
        # Trello import previews (#456): the wizard re-previews on every mapping
        # change, so previews get their own looser budget; confirmed Trello
        # imports share "board_import" above.
        "board_import_preview": "9999/hour" if DEBUG else "60/hour",
        # Board export: responses can be tens of MB; cap prevents programmatic hammering.
        "board_export": "9999/hour" if DEBUG else "20/hour",
        # Email verification: HMAC keys are not brute-forceable; scope exists for
        # operator-level observability and consistency with the rest of the auth surface.
        "verify_email": "9999/hour" if DEBUG else "20/hour",
        # Login: defense-in-depth ceiling applied alongside the allauth
        # ACCOUNT_RATE_LIMITS gate below — itself two rates: 10 failed
        # attempts/min per IP, and 5 failed attempts/5 min per account (#1199).
        # This throttle is a separate, SPA/API-only per-IP layer, not "on top
        # of" a single per-IP allauth gate as previously described here — see
        # ACCOUNT_RATE_LIMITS's own comment for why allauth's per-IP rate is
        # still needed independently (it is what protects allauth's own HTML
        # login view, which this throttle does not wrap at all).
        # 20/hour matches the verify_email pattern and prevents an attacker from
        # rotating across many usernames within the global anon throttle (#924).
        "login": "9999/hour" if DEBUG else "20/hour",
        # Email-confirm SPA redirect: no token validation happens at this endpoint,
        # so the ceiling is generous — the limit exists to prevent log flooding and
        # cache-layer exhaustion, not token enumeration (#754).
        "email_confirm_redirect": "9999/hour" if DEBUG else "60/hour",
        # Socialaccount-signup SPA redirect (#1321): same rationale as
        # email_confirm_redirect above — no DB access happens here, so the
        # ceiling bounds log/cache noise, not token enumeration.
        "socialaccount_signup_redirect": "9999/hour" if DEBUG else "60/hour",
        # Admin SMTP test send (#306): each call opens an outbound SMTP
        # connection to an operator-supplied host, so the ceiling bounds both
        # mail-relay abuse and use of the endpoint as a network probe. Keyed on
        # the user, and the endpoint is site-admin-only on top of this.
        "email_test": "9999/hour" if DEBUG else "5/hour",
    },
}

# MCP per-token rate limits (#1177). DRF's DEFAULT_THROTTLE_RATES above never
# apply to /mcp: the MCP server is mounted in-process at the ASGI level and
# calls tool functions directly, not through a DRF view (see
# mcp_server/asgi_mount.py's module docstring). These are consumed by
# mcp_server.throttling.McpTokenBucket, keyed on the presented personal access
# token's own primary key (never IP, never the raw token value) and reusing
# this same cache backend so limits hold across daphne workers. Two stacked
# buckets:
#   - MCP_THROTTLE_READ_RATE: the baseline applied to EVERY tool/resource call.
#   - MCP_THROTTLE_COMPUTE_RATE: an ADDITIONAL, tighter cap opted into per-tool
#     for expensive reads (list_cards, board_snapshot) — a call to one of
#     those spends a unit from both buckets, not one or the other.
# Deliberately no DEBUG-time bypass (unlike DEFAULT_THROTTLE_RATES above): a
# runaway loop in an agent under local development is exactly the case the
# compute bucket exists to catch, and MCP has no interactive-user polling
# pattern to accommodate the way the REST "user" scope does.
MCP_THROTTLE_READ_RATE = env("MCP_THROTTLE_READ_RATE", default="300/min")
MCP_THROTTLE_COMPUTE_RATE = env("MCP_THROTTLE_COMPUTE_RATE", default="30/min")

SPECTACULAR_SETTINGS = {
    "TITLE": "Visiban API",
    "DESCRIPTION": "REST API for the Visiban Kanban board. Full OpenAPI 3.0 spec.",
    "VERSION": "1.1.0",
    "LICENSE": {"name": "Apache 2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0"},
    "CONTACT": {"name": "Visiban", "url": "https://visiban.com"},
    "SERVE_INCLUDE_SCHEMA": False,  # exclude the schema endpoints themselves from the schema
    "COMPONENT_SPLIT_REQUEST": True,  # separate request/response schemas for write endpoints
    # Documents the 401/403/404/429 error envelope on every operation that
    # doesn't already declare one, so backend-schema-fuzz's
    # response_schema_conformance check has something to validate against
    # instead of silently skipping undocumented error responses (#1080).
    "POSTPROCESSING_HOOKS": [
        # Must run before postprocess_schema_enums — see the hook's docstring (#1137).
        "visiban.schema_hooks.pin_named_enums",
        "drf_spectacular.hooks.postprocess_schema_enums",
        "visiban.schema_hooks.add_standard_error_responses",
    ],
}

# CORS
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=["http://localhost:5173"])
CORS_ALLOW_CREDENTIALS = True

# Guard: refuse to start in production if CORS_ALLOWED_ORIGINS contains a
# localhost or loopback origin. Developers sometimes leave the default env value
# in place when deploying; this raises loud-and-early rather than silently
# shipping a misconfiguration that allows cross-origin requests from any local
# browser tab.
if not DEBUG:
    for _origin in CORS_ALLOWED_ORIGINS:
        if "localhost" in _origin or "127.0.0.1" in _origin:
            raise ImproperlyConfigured(
                f"CORS_ALLOWED_ORIGINS contains a localhost origin ({_origin}) in production "
                "(DEBUG=False). Set CORS_ALLOWED_ORIGINS to your public domain(s) before starting."
            )
else:
    # In development, log the active CORS origins at startup so they are visible
    # in `docker compose logs backend`. New users accessing from a LAN IP or
    # hostname often miss that CORS_ALLOWED_ORIGINS must match the exact origin
    # the browser uses; this makes the current value easy to spot and fix.
    import logging as _logging

    _logging.getLogger("django.security").warning(
        "CORS allowed origins (dev): %s  —  "
        "If API calls fail from a different address, update CORS_ALLOWED_ORIGINS in .env",
        ", ".join(CORS_ALLOWED_ORIGINS),
    )

# CSRF — defaults to CORS_ALLOWED_ORIGINS so that a single env var covers both.
# Override with CSRF_TRUSTED_ORIGINS if the two sets of origins must differ.
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=CORS_ALLOWED_ORIGINS)
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_HTTPONLY = False  # Must be False so JS can read it
SESSION_COOKIE_SAMESITE = "Lax"
# Allow operators running behind their own TLS terminator (or on an air-gapped
# network) to disable secure cookie flags so plain-HTTP deployments work.
# Default: secure in production (not DEBUG), insecure only when explicitly opted out.
_FORCE_INSECURE_COOKIES = env.bool("FORCE_INSECURE_COOKIES", default=False)
SESSION_COOKIE_SECURE = not DEBUG and not _FORCE_INSECURE_COOKIES
CSRF_COOKIE_SECURE = not DEBUG and not _FORCE_INSECURE_COOKIES

if _FORCE_INSECURE_COOKIES and not DEBUG:
    import logging as _logging

    # Block the contradictory case: insecure cookies + HTTPS origins.
    # This catches the scenario where an operator tested with TLS_MODE=none,
    # then switched to letsencrypt but forgot to remove FORCE_INSECURE_COOKIES.
    _https_origins = [o for o in CORS_ALLOWED_ORIGINS if o.startswith("https://")]
    if _https_origins:
        raise ImproperlyConfigured(
            "FORCE_INSECURE_COOKIES=true but CORS_ALLOWED_ORIGINS contains HTTPS "
            f"origins ({', '.join(_https_origins)}). This combination weakens "
            "security — cookies would be sent without the Secure flag despite TLS "
            "being available. Either remove FORCE_INSECURE_COOKIES or change "
            "CORS_ALLOWED_ORIGINS to http:// origins."
        )

    _logging.getLogger("django.security").warning(
        "\u26a0\ufe0f  FORCE_INSECURE_COOKIES is enabled in production. "
        "Session and CSRF cookies will be sent over plain HTTP. "
        "Do NOT use this setting when the application is reachable from the public internet."
    )

# Tell Django that the X-Forwarded-Proto header (set by Nginx) is the
# authoritative indicator of HTTPS. Required for request.is_secure() to
# return True behind the Nginx reverse proxy.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# HTTP security headers — opt-in Django SecurityMiddleware settings.
# HSTS tells browsers to always use HTTPS; env override allows operators to
# set 0 during initial deployment before they have verified HTTPS is stable.
# When FORCE_INSECURE_COOKIES is set, default HSTS to 0 to avoid locking
# browsers into HTTPS for a deployment that may not have TLS at all.
_HSTS_DEFAULT = 0 if (DEBUG or _FORCE_INSECURE_COOKIES) else 31536000
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=_HSTS_DEFAULT)
# includeSubDomains prevents protocol-downgrade cookie theft on subdomains.
# PRELOAD is intentionally left off — operators must opt in by submitting their
# domain to the browser preload list; enabling it server-side alone has no effect
# but can surprise operators who later want to remove the domain from HSTS.
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG and not _FORCE_INSECURE_COOKIES
SECURE_CONTENT_TYPE_NOSNIFF = not DEBUG
X_FRAME_OPTIONS = "DENY"
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"

# django-allauth
ACCOUNT_ADAPTER = "accounts.adapter.RegistrationAdapter"
SOCIALACCOUNT_ADAPTER = "accounts.adapter.SocialRegistrationAdapter"
# HTML signup form (/accounts/signup/) with the #1221/#1312 email collision
# check — see accounts.forms.VisibanSignupForm for why this lives on the
# form, not on RegistrationAdapter.clean_email.
#
# reset_password_from_key: allauth's own HTML reset page
# (/accounts/password/reset/key/<uid>-<key>/) redeems the very same uid/token
# pair the SPA's reset email carries, so it must apply the same use-time
# re-check as the REST confirm endpoint (#1314) — see
# accounts.forms.password_reset_still_allowed.
ACCOUNT_FORMS = {
    "signup": "accounts.forms.VisibanSignupForm",
    "reset_password_from_key": "accounts.forms.VisibanResetPasswordKeyForm",
}
# EMAIL_VERIFICATION is the canonical env var name (added in 1.0).
# Warn operators still setting the pre-1.1 ACCOUNT_EMAIL_VERIFICATION alias —
# it is no longer read, so it silently has no effect (#894, #1047).
_warn_deprecated_env_alias("ACCOUNT_EMAIL_VERIFICATION", "EMAIL_VERIFICATION")
ACCOUNT_EMAIL_VERIFICATION = env("EMAIL_VERIFICATION", default="optional")
ACCOUNT_LOGIN_METHODS = {"username", "email"}
# Password login accepts a username or an email address (#1206) — the SPA form
# has always said "Username or email". ModelBackend stays first and stays listed:
# existing sessions record it as their backend, so dropping it would log every
# user out on upgrade. EmailBackend only handles identifiers that are not a
# username and fails closed on an email shared by several accounts — see
# accounts/backends.py. An enterprise settings include that replaces this list
# must keep both entries to keep email login working. The setting is process-
# global, so Django admin's /admin/login/ also accepts an email — intended, and no
# permission change: the password is still required and both backends share
# ModelBackend's permission logic.
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "accounts.backends.EmailBackend",
]
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
# The public origin of the SPA. Read into a setting of its own (#356) as well as
# the two allauth redirect settings below, because outbound mail needs to build
# absolute links and a Django setting is the only thing a mail helper can read.
#
# This is a fix, not just an addition: ``accounts/forms.py`` has always done
# ``getattr(settings, "FRONTEND_URL", "http://localhost:5173")`` to build
# password-reset links, and until now no setting existed under that name — so the
# getattr *always* took the fallback and every production reset link pointed at
# localhost:5173. Its own test suite masked that by injecting the setting with
# ``@override_settings``. The env var is unchanged, so no install has to
# reconfigure anything.
FRONTEND_URL = env("FRONTEND_URL", default="http://localhost:5173")
LOGIN_REDIRECT_URL = FRONTEND_URL
ACCOUNT_LOGOUT_REDIRECT_URL = FRONTEND_URL
# Guard against operator misconfiguration: a value like "//evil.com" would produce
# a protocol-relative open redirect in confirmation emails. Fail fast at startup
# rather than silently sending broken or exploitable links to users.
if not DEBUG and not (
    LOGIN_REDIRECT_URL.startswith("http://") or LOGIN_REDIRECT_URL.startswith("https://")
):
    raise ImproperlyConfigured(
        f"FRONTEND_URL must start with http:// or https://. Got: {LOGIN_REDIRECT_URL!r}. "
        "Set FRONTEND_URL to your public frontend origin before starting."
    )
# Explicit login rate limits — locks in brute-force protection independent of
# allauth version defaults. Two comma-separated rates (allauth's own
# multi-rate syntax, confirmed against allauth.core.internal.ratelimit
# .parse_rates in 65.14.3 — ALL listed rates must allow a request through, so
# this is "AND", not "first match wins"):
#   - "10/m/ip"     — per-IP: 10 failed logins/minute from any one IP, across
#                     ANY number of accounts. This is the ONLY rate limit on
#                     allauth's own HTML login view (/accounts/login/, live —
#                     it is not behind ThrottledLoginView/LoginRateThrottle,
#                     which only wraps the SPA's /api/v1/auth/login/), so
#                     without it an attacker gets unlimited cross-account
#                     credential stuffing from a single IP there (a right/wrong
#                     password oracle: wrong -> 200 re-render, right -> 302).
#                     A prior version of this setting was a single "5/300s"
#                     rate, which allauth parses as per-IP by default (no "/key"
#                     suffix) — so it accidentally provided this same per-IP
#                     protection under a different number, until #1199 changed
#                     it to "5/300s/key" and silently dropped the per-IP layer.
#                     This is allauth's own upstream default value for this rate
#                     (see allauth.account.app_settings.RATE_LIMITS).
#   - "5/300s/key"  — per-account: 5 failed attempts / 5 minutes, keyed on the
#                     submitted email/username (the "/key" suffix — omitting it
#                     defaults to "/ip", which is NOT a per-account limit despite
#                     what an earlier version of this comment claimed). This is
#                     the only defense against a distributed attacker spreading
#                     failed attempts across many source IPs at one account —
#                     see accounts.serializers.LoginSerializer for why it never
#                     engaged at all on the SPA login endpoint before #1199.
# See accounts/views.py's LoginRateThrottle for the separate, SPA-only per-IP
# throttle that sits alongside (not instead of) the per-IP rate here.
ACCOUNT_RATE_LIMITS = {
    "login_failed": "10/m/ip,5/300s/key",
}

SOCIALACCOUNT_PROVIDERS = {
    "google": {
        "SCOPE": ["profile", "email"],
        "AUTH_PARAMS": {"access_type": "online"},
        "APP": {
            "client_id": env("GOOGLE_CLIENT_ID", default=""),
            "secret": env("GOOGLE_CLIENT_SECRET", default=""),
        },
    },
    "github": {
        "SCOPE": ["read:user", "user:email"],
        "APP": {
            "client_id": env("GITHUB_CLIENT_ID", default=""),
            "secret": env("GITHUB_CLIENT_SECRET", default=""),
        },
    },
    "gitlab": {
        "SCOPE": ["read_user", "openid", "email"],
        "APP": {
            "client_id": env("GITLAB_CLIENT_ID", default=""),
            "secret": env("GITLAB_CLIENT_SECRET", default=""),
        },
    },
    # Generic OIDC — only populated when all three env vars are set so that
    # allauth does not attempt to discover endpoints with an empty server_url.
    # OIDC_SERVER_URL must be the issuer URL (e.g. https://idp.example.com/realms/my-realm).
    # allauth appends /.well-known/openid-configuration automatically.
    **({
        "openid_connect": {
            "APPS": [
                {
                    "provider_id": "oidc",
                    "name": env("OIDC_PROVIDER_NAME", default="SSO"),
                    "client_id": _OIDC_CLIENT_ID,
                    "secret": _OIDC_CLIENT_SECRET,
                    "settings": {
                        "server_url": _OIDC_SERVER_URL,
                    },
                }
            ],
        },
    } if _OIDC_ENABLED else {}),
}

# dj-rest-auth
REST_AUTH = {
    "USE_JWT": False,
    "SESSION_LOGIN": True,
    # CurrentUserSerializer is a strict superset of UserSerializer (adds the
    # read-only uploads_enabled / git_lens_enabled instance-flag fields). The SPA
    # bootstraps its current-user object from this endpoint (GET /auth/user/) and
    # writes profile edits back through it (PATCH), so the flags must live here or
    # they never reach — and get clobbered out of — the in-memory user. The flags
    # stay off the *embedded* UserSerializer used for assignees/authors/members in
    # board and card payloads, so this adds no per-row cost to those responses.
    "USER_DETAILS_SERIALIZER": "accounts.serializers.CurrentUserSerializer",
    # allauth 65.x SIGNUP_FIELDS causes USERNAME_REQUIRED to return None, which DRF
    # normalises to required=True. Use a custom serializer that sets required=False
    # explicitly so email-only registration works without a username field.
    "REGISTER_SERIALIZER": "accounts.serializers.RegistrationSerializer",
    # Use our custom serializer so the reset email link points at the frontend
    # SPA rather than reversing 'password_reset_confirm' (a Django built-in URL
    # name that Visiban does not register).
    "PASSWORD_RESET_SERIALIZER": "accounts.serializers.VisibanPasswordResetSerializer",
    # dj-rest-auth's default PasswordResetConfirmSerializer.save() never clears
    # allauth's login_failed lockout bucket — only allauth's own reset flow
    # does that, and this endpoint doesn't go through it. Our subclass clears
    # the lockout (both the username and email keys) after a successful reset
    # so a locked-out user can log back in immediately instead of waiting out
    # the window (#1203).
    "PASSWORD_RESET_CONFIRM_SERIALIZER": "accounts.serializers.VisibanPasswordResetConfirmSerializer",
    # dj-rest-auth's default LoginSerializer.authenticate() calls Django's bare
    # authenticate(), bypassing allauth's ratelimit-consuming adapter entirely —
    # the per-account login_failed lockout below never fired on this endpoint
    # (#1199). Our subclass routes through get_adapter().authenticate() instead.
    "LOGIN_SERIALIZER": "accounts.serializers.LoginSerializer",
    # dj-rest-auth defaults this to False, which pops old_password from the
    # password-change serializer entirely: POST /api/v1/auth/password/change/
    # changed the password for any authenticated caller — session or PAT —
    # without proving knowledge of the current one (#1257). Our serializer below
    # enforces the check regardless of this flag; setting it too keeps any other
    # consumer of dj-rest-auth's settings consistent with that.
    "OLD_PASSWORD_FIELD_ENABLED": True,
    "PASSWORD_CHANGE_SERIALIZER": "accounts.serializers.VisibanPasswordChangeSerializer",
}

# APP_VERSION is set as the v-prefixed image tag operators pin in .env
# (e.g. "v1.1.0", matching the tags CI publishes to GHCR -- #1174), but
# GET /api/v1/version/ promises callers bare semver (docs/api/version.md).
# Normalize here so the API contract holds regardless of which form is set.
APP_VERSION = normalize_app_version(env("APP_VERSION", default="dev"))

# ── Hosted demo mode (#1034) ─────────────────────────────────────────────────
# Opt-in: DEMO_MODE defaults to False so existing installs are unchanged. When
# on, the public /api/v1/auth/site-config/ endpoint publishes the demo login
# credentials so the login page can show them — that publication is the whole
# point of a public demo, so ONLY ever enable this on a throwaway instance with
# its own database (see docs/administration/demo-data.md; the supported deploy
# is the Helm chart's `demo:` mode, #1180). The credentials come from env,
# never from source; the seeder (`seed_demo_data --demo-site`) reads the same
# variables so what is published always matches what was seeded.
#
# #1179: DEMO_MODE also arms visiban.middleware.DemoModeMiddleware, the
# deny-by-default write fence, so it is parsed strictly — `DEMO_MODE=ture`
# refuses to boot instead of silently disabling the fence (env.bool would read
# it as False) while the login page still publishes a credential.
from visiban.demo import parse_demo_mode as _parse_demo_mode  # noqa: E402
from visiban.demo import parse_demo_reset_schedule as _parse_demo_reset_schedule  # noqa: E402
from visiban.demo import DEFAULT_DEMO_RESET_SCHEDULE  # noqa: E402

DEMO_MODE = _parse_demo_mode(os.environ.get("DEMO_MODE"))
# The PUBLISHED account (#1179): a non-admin "visitor", MEMBER on every seeded
# board. Before #1179 this was the site admin; these variables are unreleased
# (post-v1.1.0), so changing their meaning breaks no install.
DEMO_LOGIN_USERNAME = env("DEMO_LOGIN_USERNAME", default="visitor")
DEMO_LOGIN_PASSWORD = env("DEMO_LOGIN_PASSWORD", default="")
# The demo site admin's own password. Never published — the fence refuses
# every admin write anyway, but the credential that is printed on the login
# page must not be one that holds site-wide authority.
DEMO_ADMIN_PASSWORD = env("DEMO_ADMIN_PASSWORD", default="")
# Password for the two seeded member accounts. Not published anywhere.
DEMO_MEMBER_PASSWORD = env("DEMO_MEMBER_PASSWORD", default="")
# Cron expression of the demo reset (#1180 renders the CronJob and this value
# from one Helm value). Drives `demo_next_reset_at`, the countdown the login
# page and the in-app demo bar show. Validated at boot only while DEMO_MODE is
# on: a schedule the backend cannot evaluate would publish a wrong countdown.
#
# UNSET and SET-BUT-EMPTY mean different things, deliberately (#1180). Unset
# keeps the hourly default, so a demo run outside the chart behaves as it did
# in #1179. Empty means "no reset is scheduled": the Helm chart renders it
# empty when `demo.reset.enabled` is false, and the login page and demo bar
# must then promise no reset at all rather than an hourly one that never runs
# (TruePPM ADR-1197 D9). `os.environ.get`, not `env()`, because the default
# must apply only when the variable is absent.
_raw_demo_reset_schedule = os.environ.get("DEMO_RESET_SCHEDULE")
DEMO_RESET_SCHEDULE = (
    DEFAULT_DEMO_RESET_SCHEDULE if _raw_demo_reset_schedule is None else _raw_demo_reset_schedule.strip()
)
if DEMO_MODE:
    if DEMO_RESET_SCHEDULE:
        _parse_demo_reset_schedule(DEMO_RESET_SCHEDULE)
elif os.environ.get("DEMO_LOGIN_USERNAME") or os.environ.get("DEMO_LOGIN_PASSWORD"):
    # A warning, not a crash: a leftover variable on a real install publishes
    # nothing (SiteConfigView gates on DEMO_MODE), but it usually means the
    # operator believes the fence is armed when it is not.
    import logging as _logging  # noqa: E402

    _logging.getLogger("visiban.demo").warning(
        "DEMO_LOGIN_USERNAME/DEMO_LOGIN_PASSWORD is set but DEMO_MODE is off: "
        "the demo write fence is NOT armed and no credential is published."
    )

# #1180: the `user` throttle re-aimed for the demo's one shared account (see
# visiban.demo.parse_demo_user_throttle_rate for why). Applied only while
# DEMO_MODE is on, so a leftover variable cannot loosen a real install's limits.
from visiban.demo import parse_demo_user_throttle_rate as _parse_demo_user_throttle_rate  # noqa: E402

_DEMO_USER_THROTTLE_RATE = _parse_demo_user_throttle_rate(os.environ.get("DEMO_USER_THROTTLE_RATE"))
if DEMO_MODE and _DEMO_USER_THROTTLE_RATE:
    REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["user"] = _DEMO_USER_THROTTLE_RATE

# Email backend — console in development (prints to stdout), SMTP in production.
# Set EMAIL_BACKEND explicitly to override (e.g. for testing or third-party relay).
# Whether the operator pinned EMAIL_BACKEND explicitly. Load-bearing for #306:
# an explicit value is honored verbatim and suppresses DB-backed configuration
# entirely, so an install pointing at a third-party relay keeps that relay and
# a development install keeps the console backend. Only when the variable is
# unset does the DB-aware backend take over.
EMAIL_BACKEND_EXPLICIT = env("EMAIL_BACKEND", default="") != ""
EMAIL_BACKEND = env("EMAIL_BACKEND", default="visiban.mail.DatabaseAwareEmailBackend")
EMAIL_HOST = env("EMAIL_HOST", default="localhost")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
# Added in 1.2 alongside #306 so the environment and the database express the
# same set of settings. Purely additive, and both defaults reproduce exactly what
# these knobs implicitly did before they existed.
EMAIL_USE_SSL = env.bool("EMAIL_USE_SSL", default=False)
# default=None, NOT 10: EMAIL_TIMEOUT is a pre-existing Django setting whose
# global default is None (no explicit socket timeout). This file simply never
# set it before, so every env-configured install ran without one. Defaulting to
# 10 here would impose a hard timeout they never had and break greylisting
# relays and slow Exchange front-ends — a behavior change for existing installs,
# which CLAUDE.md forbids. The DB-backed path has its own default of 10, which
# is new configuration and therefore free to choose.
EMAIL_TIMEOUT = env.int("EMAIL_TIMEOUT", default=None)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="noreply@example.com")

# --- Notification email (#356) -------------------------------------------------
# Global off switch for outbound *notification* email. Transactional account mail
# (password reset, email confirmation) is deliberately NOT covered: an operator
# who silences notifications must not also lock users out of account recovery.
# Default True so configuring SMTP is the only step needed to turn the feature
# on; per-user preferences default to off, so a fresh upgrade still sends nothing
# until somebody opts in.
NOTIFICATION_EMAIL_ENABLED = env.bool("NOTIFICATION_EMAIL_ENABLED", default=True)

# Socket timeout floor, in seconds, for notification email only.
#
# Why this exists rather than changing EMAIL_TIMEOUT: notification mail is sent
# from the request path (via transaction.on_commit, which runs inline when no
# atomic block is open), so a blackholed SMTP port would otherwise hang a worker
# on every card assignment or move for as long as the OS default takes. But
# EMAIL_TIMEOUT defaults to None on purpose — see the note above — and raising
# that default would change behavior for existing installs' account mail, which
# CLAUDE.md forbids. So the floor is scoped to this one sender: it applies only
# when the resolved configuration expresses no timeout of its own, and an
# operator who did set EMAIL_TIMEOUT (or the admin-UI timeout) keeps their value.
NOTIFICATION_EMAIL_TIMEOUT = env.int("NOTIFICATION_EMAIL_TIMEOUT", default=10)

# Send notification mail from a short-lived daemon thread rather than inline.
#
# Default True because the alternative puts an SMTP session on the request path:
# notification mail is dispatched from transaction.on_commit, which runs inline
# once the atomic block exits, so a card assignment or move would block on it.
# NOTIFICATION_EMAIL_TIMEOUT does not bound that — smtplib applies a timeout per
# socket operation, so a tarpitting relay can spend it again at connect, EHLO,
# STARTTLS, AUTH and every message's DATA.
#
# The trade is that delivery becomes explicitly best-effort: a worker recycling
# mid-send drops that batch. That is the same bargain the rest of this feature
# makes — a notification email is only useful promptly, and the OSS core does not
# take a dependency on a task queue to get one out.
#
# Set False to send inline: management commands, where blocking is harmless, and
# tests that assert on mail.outbox deterministically.
NOTIFICATION_EMAIL_ASYNC = env.bool("NOTIFICATION_EMAIL_ASYNC", default=True)

# Optional dedicated key for secrets encrypted at rest (#306). When unset, the
# key is derived from SECRET_KEY — see visiban/crypto.py for why that is the
# default rather than a mandatory variable. Validated eagerly so a malformed
# value fails at boot rather than at the first password save.
SECRET_ENCRYPTION_KEY = env("VISIBAN_SECRET_ENCRYPTION_KEY", default="")
if SECRET_ENCRYPTION_KEY:
    import base64 as _b64

    try:
        if len(_b64.urlsafe_b64decode(SECRET_ENCRYPTION_KEY.encode())) != 32:
            raise ValueError
    except Exception:
        raise ImproperlyConfigured(
            "VISIBAN_SECRET_ENCRYPTION_KEY must be 32 bytes of urlsafe base64. "
            'Generate one with: python -c "import base64,os; '
            'print(base64.urlsafe_b64encode(os.urandom(32)).decode())"'
        )

# Sender-address placeholder check.
#
# This was an import-time `raise ImproperlyConfigured` until #306. It had to be
# demoted, because it made the feature it now guards unreachable: on a fresh
# production install (DEBUG=False → SMTP backend, DEFAULT_FROM_EMAIL unset →
# the example.com default) Django refused to start, so an operator intending to
# configure SMTP entirely from the admin UI could never reach that UI. Verified
# empirically against this tree before changing it.
#
# No protection is lost. "Never send from a placeholder address" is enforced
# where a send actually happens: visiban.mail._checked() wraps EVERY return path
# out of resolve_email_config() — the env ones included — and the admin
# serializer's validate() rejects it on save as well. That also covers the
# database-configured sender the import-time check could not see.
#
# The env path is the one that matters, and it is easy to get wrong: an operator
# who configures a real relay via EMAIL_HOST/EMAIL_HOST_USER but forgets
# DEFAULT_FROM_EMAIL would otherwise send live password-reset mail from a domain
# they do not control, fail SPF/DMARC, and lose account recovery silently. If
# you ever add a new return path to the resolver, wrap it in _checked().
#
# This is a relaxation at boot, so no install that boots today stops booting.
if not DEBUG and "example.com" in DEFAULT_FROM_EMAIL:
    import logging as _logging

    _logging.getLogger(__name__).warning(
        "DEFAULT_FROM_EMAIL is still set to the example.com placeholder. "
        "Outbound mail will be refused until you set DEFAULT_FROM_EMAIL, or "
        "configure a sender address in Admin → Settings → Email."
    )

# Log auth failures (401/403) at WARNING so operators can detect brute-force
# attempts and misconfigured clients. Previously these were suppressed, hiding
# legitimate security signals alongside the benign initial session check.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
        },
    },
    "loggers": {
        "django.request": {
            "handlers": ["console"],
            "level": "WARNING",
            "propagate": False,
        },
        # Issue Board Lens outbound-call log (#1061): one INFO line per GitHub/
        # GitLab HTTP request, so admins can see the feature's upstream traffic.
        # Configured explicitly because the root logger is unconfigured here and
        # would otherwise drop INFO. Silent in practice unless GIT_LENS_ENABLED is
        # on (nothing emits to it otherwise). Set GIT_LENS_OUTBOUND_LOG_LEVEL=WARNING
        # to quiet it; the admin usage counters are unaffected.
        "git_lens.outbound": {
            "handlers": ["console"],
            "level": env("GIT_LENS_OUTBOUND_LOG_LEVEL", default="INFO"),
            "propagate": False,
        },
    },
}

# Enterprise settings include — the enterprise package may override or extend
# any setting defined above (e.g. INSTALLED_APPS, MIDDLEWARE, REST_FRAMEWORK,
# AUTHENTICATION_BACKENDS). If the enterprise package is not installed, this
# block is silently skipped and the OSS defaults are used as-is.
try:
    from enterprise.settings import *  # type: ignore[import]  # noqa: F401,F403
except ImportError:
    pass
