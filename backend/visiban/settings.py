import sys
import environ
from django.core.exceptions import ImproperlyConfigured
from pathlib import Path

# Detect when running under `manage.py test` so we can substitute fast
# in-process backends for Redis-backed services. This avoids requiring a
# running Redis instance just to run the test suite locally.
_TESTING = len(sys.argv) > 1 and sys.argv[1] == "test"

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
_OIDC_SECRET = env("OIDC_SECRET", default="")
_OIDC_SERVER_URL = env("OIDC_SERVER_URL", default="")
# True when all three OIDC env vars are present. The provider app is only
# registered in INSTALLED_APPS and SOCIALACCOUNT_PROVIDERS when this is True
# so that allauth does not attempt discovery with an empty server_url.
_OIDC_ENABLED = bool(_OIDC_CLIENT_ID and _OIDC_SECRET and _OIDC_SERVER_URL)

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
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    # Restrict /admin/ to loopback (or DJANGO_ADMIN_ALLOWED_IPS) in production.
    # Placed early so the check runs before session/auth processing.
    "visiban.middleware.AdminIPRestrictionMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
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
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [env("REDIS_URL", default="redis://localhost:6379/0")],
            },
        },
    }
    # Cache — uses REDIS_CACHE_URL (db 1 by default) to keep it separate from
    # Channels (db 0). Set REDIS_CACHE_URL explicitly if your Redis host differs
    # from REDIS_URL or you want to use the same DB (which is fine for dev).
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": env("REDIS_CACHE_URL", default="redis://localhost:6379/1"),
        }
    }

DATABASES = {
    "default": env.db("DATABASE_URL"),
}

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
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

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SITE_ID = 1

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
    # Tell DRF to trust exactly one proxy (Nginx) when parsing X-Forwarded-For
    # for rate limiting and IP detection. Prevents IP spoofing via header injection.
    "NUM_PROXIES": 1,
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
        # Invite-link redemption: low ceiling prevents token brute-force scanning.
        "join_group": "9999/hour" if DEBUG else "10/hour",
        # Registration: prevents invite token brute-force and mass account creation.
        "register": "9999/hour" if DEBUG else "10/min",
        # Public board share-link reads: generous but bounded to limit scraping.
        "share_link": "120/hour",
        # Choose-username: prevents username enumeration via "already taken" probing.
        "choose_username": "9999/hour" if DEBUG else "10/min",
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Visiban API",
    "DESCRIPTION": "REST API for the Visiban Kanban board. Full OpenAPI 3.0 spec.",
    "VERSION": "1.0.0",
    "LICENSE": {"name": "Apache 2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0"},
    "CONTACT": {"name": "Visiban", "url": "https://visiban.com"},
    "SERVE_INCLUDE_SCHEMA": False,  # exclude the schema endpoints themselves from the schema
    "COMPONENT_SPLIT_REQUEST": True,  # separate request/response schemas for write endpoints
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
SECURE_CONTENT_TYPE_NOSNIFF = not DEBUG
X_FRAME_OPTIONS = "DENY"
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"

# django-allauth
ACCOUNT_ADAPTER = "accounts.adapter.RegistrationAdapter"
# Default to "none" so self-hosted installs work without a configured SMTP server.
# Set ACCOUNT_EMAIL_VERIFICATION=mandatory to require email confirmation before login,
# or "optional" to send a verification email but allow login without it.
ACCOUNT_EMAIL_VERIFICATION = env("ACCOUNT_EMAIL_VERIFICATION", default="none")
ACCOUNT_LOGIN_METHODS = {"username", "email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
LOGIN_REDIRECT_URL = env("FRONTEND_URL", default="http://localhost:5173")
ACCOUNT_LOGOUT_REDIRECT_URL = env("FRONTEND_URL", default="http://localhost:5173")
# Explicit login rate limits — locks in brute-force protection independent of
# allauth version defaults. 5 failed attempts per 5 minutes per IP.
ACCOUNT_RATE_LIMITS = {
    "login_failed": "5/300s",
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
                    "secret": _OIDC_SECRET,
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
    "USER_DETAILS_SERIALIZER": "accounts.serializers.UserSerializer",
    # allauth 65.x SIGNUP_FIELDS causes USERNAME_REQUIRED to return None, which DRF
    # normalises to required=True. Use a custom serializer that sets required=False
    # explicitly so email-only registration works without a username field.
    "REGISTER_SERIALIZER": "accounts.serializers.RegistrationSerializer",
}

APP_VERSION = env("APP_VERSION", default="dev")

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
