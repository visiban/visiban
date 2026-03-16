import environ
from django.core.exceptions import ImproperlyConfigured
from pathlib import Path

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

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.sites",
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
    "dj_rest_auth",
    "dj_rest_auth.registration",
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

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [env("REDIS_URL", default="redis://localhost:6379/0")],
        },
    },
}

DATABASES = {
    "default": env.db("DATABASE_URL"),
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
WHITENOISE_USE_FINDERS = True  # serve un-collected files in development

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Maximum upload size: 10 MB
MAX_UPLOAD_SIZE = 10 * 1024 * 1024

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SITE_ID = 1

# DRF
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.TokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
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
    },
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

# django-allauth
ACCOUNT_ADAPTER = "accounts.adapter.RegistrationAdapter"
ACCOUNT_EMAIL_VERIFICATION = "none"
ACCOUNT_LOGIN_METHODS = {"username", "email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
LOGIN_REDIRECT_URL = env("FRONTEND_URL", default="http://localhost:5173")
ACCOUNT_LOGOUT_REDIRECT_URL = env("FRONTEND_URL", default="http://localhost:5173")

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

# Suppress expected 401/403 WARNING noise from unauthenticated startup polls.
# django.request logs every 4xx response at WARNING level by default; 401 and
# 403 are normal for the initial session-check call made before login and
# should not clutter startup output.  Real server errors (5xx) still propagate.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "suppress_401_403": {
            "()": "django.utils.log.CallbackFilter",
            "callback": lambda record: getattr(record, "status_code", 0) not in (401, 403),
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "filters": ["suppress_401_403"],
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
