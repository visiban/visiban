from urllib.parse import urlsplit

from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import LoginSerializer as DjRestAuthLoginSerializer
from dj_rest_auth.serializers import PasswordChangeSerializer as DjRestAuthPasswordChangeSerializer
from dj_rest_auth.serializers import PasswordResetConfirmSerializer as DjRestAuthPasswordResetConfirmSerializer
from dj_rest_auth.serializers import PasswordResetSerializer
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import EmailValidator
from django.db import transaction
from drf_spectacular.utils import extend_schema_field, extend_schema_serializer
from rest_framework import serializers

from .adapter import clear_login_lockout
from .credentials import finalize_password_reset
from .models import (
    PAT_SCOPES,
    PersonalAccessToken,
    User,
    get_uploads_enabled,
)
from . import instance_flags
from .forms import VisibanPasswordResetForm
from .validators import (
    EMAIL_TAKEN_MESSAGE,
    USERNAME_TAKEN_MESSAGE,
    UsernameFormatValidator,
    answers_in_use_address_as_new,
    email_collides_with_identifier,
    is_username_taken,
    normalize_username_field_validators,
    username_collides_with_email,
)


@extend_schema_field({
    "type": "string",
    "maxLength": 200,
})
class AvatarUrlField(serializers.CharField):
    """``avatar_url`` with the ``format: uri`` constraint dropped from its schema.

    ``User.avatar_url`` is ``models.URLField(blank=True)`` — an empty string is
    a valid "no avatar set" value, not just an absent one. A plain
    ``serializers.URLField`` mapping declares ``format: uri`` regardless of
    ``allow_blank`` (drf-spectacular derives it from the field's attached
    ``URLValidator``, independently of the ``@extend_schema_field`` override
    above — subclassing ``URLField`` and only overriding the *declared* schema
    still leaves the *validator* in place, which re-adds ``format`` from the
    other direction), which is a JSON Schema violation for `""` (schemathesis
    correctly flags it, #1120). Subclassing ``CharField`` instead avoids
    attaching that validator in the first place.

    The SPA renders the value as ``<img src>`` (#1679), so on write only a
    non-blank value must be an absolute ``http``/``https`` URL with a host and
    no userinfo. This blocks other schemes (``javascript:``, ``data:``,
    relative paths) and credential-bearing URLs; it does NOT stop a tracking
    pixel on an arbitrary https host, which remains mitigated only by the
    deployment's CSP ``img-src``. Reads are untouched, so rows stored before
    this check keep serializing.
    """

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if value:
            message = (
                "Enter an absolute http:// or https:// URL without "
                "embedded credentials."
            )
            # Whitespace/control characters are never legal in a URL and make
            # parsers disagree about the host.
            if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
                raise serializers.ValidationError(message)
            try:
                parsed = urlsplit(value)
                # ``.port`` raises ValueError for a non-numeric/out-of-range
                # port; urlsplit itself raises it for e.g. "http://[bad".
                parsed.port  # noqa: B018
            except ValueError:
                raise serializers.ValidationError(message) from None
            # ``hostname`` is None for "https:///x" and for scheme-less or
            # protocol-relative values; "@" in netloc means userinfo.
            if (
                parsed.scheme.lower() not in ("http", "https")
                or not parsed.hostname
                or "@" in parsed.netloc
            ):
                raise serializers.ValidationError(message)
        return value


@extend_schema_field({
    "type": "string",
    "maxLength": 254,
    "title": "Email address",
})
class EmailOrBlankField(serializers.CharField):
    """``email`` with the ``format: email`` constraint dropped from its schema.

    ``User.email`` is Django's default ``AbstractUser.email = EmailField(blank=True)``
    — an empty string is a valid "no email on file" value (e.g. an account
    provisioned via SSO without an email claim in the token), not just an absent
    one. A plain ``serializers.EmailField`` mapping declares ``format: email``
    unconditionally (drf-spectacular maps that format from the field class
    itself, same as ``AvatarUrlField`` above), which is a JSON Schema violation
    for `""`: a PATCH to `/api/v1/auth/user/` that wrote a blank email made
    every subsequent read of that user fail schema conformance
    (backend-schema-fuzz). Subclassing ``CharField`` avoids the class-based
    format mapping.

    Unlike ``AvatarUrlField``, format validation on write is *not* dropped —
    drf-spectacular's ``_insert_field_validators`` re-derives ``format: email``
    from any ``EmailValidator`` found in ``field.validators``, independently of
    this field's declared schema, so the validator can't simply be re-attached
    here. See ``UserSerializer.validate_email`` for where it actually lives.
    """


def validate_optional_email_format(value):
    """Run Django's ``EmailValidator`` unless ``value`` is blank.

    Reused as a serializer-level ``validate_<field>`` method rather than a
    ``Field`` validator so drf-spectacular's validator-derived schema (see
    ``EmailOrBlankField`` above) never sees it and re-adds ``format: email``.
    DRF's own ``Field.run_validators`` already skips attached validators for a
    blank value when ``allow_blank=True``; this replicates that behavior
    explicitly since it runs outside that mechanism.
    """
    if value:
        EmailValidator()(value)
    return value


class RegistrationSerializer(RegisterSerializer):
    # allauth 65.x SIGNUP_FIELDS causes allauth_account_settings.USERNAME_REQUIRED
    # to return None rather than False. DRF normalises required=None to required=True
    # (Field.__init__: if required is None: required = default is empty and not read_only),
    # making username mandatory even when it is not a signup field. Override with an
    # explicit required=False so users can register with only email + passwords.
    username = serializers.CharField(
        max_length=150,
        required=False,
        validators=[UsernameFormatValidator()],
    )

    # The inherited validate_username goes through
    # RegistrationAdapter.clean_username, which rejects a username equal to
    # another active account's email (#1221) — see accounts/adapter.py.

    #: Set by ``validate_email`` when the address is already in use and the
    #: registration is to be answered like a new one (see
    #: ``answers_in_use_address_as_new``). The view then calls
    #: ``decline_in_use_address`` instead of creating an account.
    address_in_use = False

    def validate_email(self, email):
        """dj-rest-auth's check, plus: no email another account already answers to (#1221).

        dj-rest-auth only refuses an address some account has *verified*, so
        REST signup could create a second account with an existing account's
        unverified ``User.email`` — making it ambiguous, which switches off
        that account's email login (the resolver fails closed on ambiguity).
        An address equal to another account's username is refused too: the
        username would always win at login, so it could never log in the new
        account.

        This check is scoped to the REST signup path deliberately (not
        ``RegistrationAdapter.clean_email``, which every allauth flow that
        cleans an email shares, including password reset — see the NOTE on
        ``RegistrationAdapter`` in accounts/adapter.py, #1312). The HTML
        signup form gets the equivalent check via
        ``accounts.forms.VisibanSignupForm.clean_email``.

        Under ``EMAIL_VERIFICATION=mandatory`` an address in use is not an
        error (#1877): the request is accepted like any other registration and
        answered the same way, and no account is created — see
        ``answers_in_use_address_as_new``. Otherwise it is refused with
        dj-rest-auth's own message, identical to the one a verified address
        gets from dj-rest-auth, so the answer says nothing about which kind of
        match it was.

        This replaces dj-rest-auth's ``validate_email`` rather than wrapping
        it, so the two "in use" checks share one outcome; ``clean_email`` and
        the ``UNIQUE_EMAIL`` condition are kept as dj-rest-auth has them.
        """
        from allauth.account import app_settings as allauth_account_settings
        from allauth.account.adapter import get_adapter
        from allauth.account.models import EmailAddress

        email = get_adapter().clean_email(email)
        in_use = bool(email) and (
            (allauth_account_settings.UNIQUE_EMAIL and EmailAddress.objects.is_verified(email))
            or email_collides_with_identifier(email)
        )
        if in_use:
            if answers_in_use_address_as_new():
                self.address_in_use = True
                return email
            raise serializers.ValidationError(
                "User is already registered with this e-mail address."
            )
        return email

    def decline_in_use_address(self, request):
        """Answer a registration for an address in use without creating an account (#1877).

        Called by ``InviteRegisterView.perform_create`` in place of ``save``
        when ``validate_email`` set ``address_in_use``. It runs the same steps
        as dj-rest-auth's ``RegisterSerializer.save`` up to the point where the
        account would be written, so the request meets the same checks and
        does roughly the same work as a new registration:

        - ``save_user(commit=False)`` refuses a CLOSED instance with the same
          403, and hashes the password just as a new account's is hashed;
        - the password is re-validated against the unsaved account's
          attributes, as dj-rest-auth does, so a password the new account
          would be refused for is refused here with the same 400.

        Then, instead of ``complete_signup``, allauth's login flow runs for an
        account-less signup — the same flow a new registration goes through
        under mandatory verification. It sends the address allauth's "account
        already exists" mail (pointing at password reset) in place of the
        confirmation mail, under the same verification-mail rate limit, and
        through ``RegistrationAdapter.render_mail``, so an invite registration
        still sends it after commit (#1639). Nothing is saved, no signup
        signal is sent and no session is logged in.
        """
        from allauth.account.adapter import get_adapter
        from allauth.account.internal.flows.login import perform_login
        from allauth.account.models import Login

        adapter = get_adapter()
        user = adapter.new_user(request)
        self.cleaned_data = self.get_cleaned_data()
        adapter.save_user(request, user, self, commit=False)
        try:
            adapter.clean_password(self.cleaned_data["password1"], user=user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(detail=serializers.as_serializer_error(exc))
        perform_login(
            request,
            Login(user=None, email=self.cleaned_data["email"], signup=True),
        )


class LoginSerializer(DjRestAuthLoginSerializer):
    """Authenticate through allauth's adapter instead of bare Django auth (#1199).

    dj-rest-auth's own ``authenticate()`` calls ``django.contrib.auth.authenticate()``
    directly. That bypasses ``allauth.account.adapter.DefaultAccountAdapter
    .pre_authenticate()`` — the only place ``ACCOUNT_RATE_LIMITS["login_failed"]`` is
    ever consumed — so the per-account lockout allauth is configured for never
    actually engaged on this endpoint (the SPA/API login path every real client
    uses). Only the coarser, per-IP ``LoginRateThrottle`` (#924) applied, which does
    nothing against a distributed attacker spreading failed attempts across many
    source IPs at one target account.

    Routing through ``get_adapter(request).authenticate()`` instead reuses allauth's
    own pre_authenticate -> authenticate -> rollback-on-success sequence, so this
    view now shares the same per-account bucket allauth's own login views consume.
    The adapter still ultimately calls Django's ``authenticate()`` for the actual
    credential check, so the credential check is whatever ``AUTHENTICATION_BACKENDS``
    says — since #1206 that is ``ModelBackend`` plus ``accounts.backends.EmailBackend``,
    so the ``username`` field accepts a username or an email address. The
    per-account lockout key is resolved to the account itself (see
    ``accounts.adapter.RegistrationAdapter._get_login_attempts_cache_key``), so
    failures by username and by email accumulate into one lockout.

    On lockout, ``pre_authenticate()`` raises ``django.core.exceptions.
    ValidationError`` (code ``too_many_login_attempts``) *before* the password is
    checked at all, with allauth's own generic "too many attempts" message -- it
    never reveals whether the account exists, and the account/email used as the
    rate-limit key is SHA-256-hashed by allauth before it ever reaches the cache,
    so nothing PII-bearing is logged. DRF's default field validation converts that
    Django-style ``ValidationError`` into a plain 400 response automatically, same
    as any other login validation failure.

    Demo-mode carve-out (#1199 gate finding): when ``DEMO_MODE`` is on, the demo
    login page publishes ``DEMO_LOGIN_USERNAME``'s password to every visitor
    (that publication is the whole point of a public demo — see
    visiban/settings.py's "Hosted demo mode" block). A per-account lockout on a
    published credential protects nothing — everyone already has the password —
    and instead becomes a trivial, repeatable DoS lever: any anonymous visitor
    can send 5 wrong passwords for that one shared username and lock out every
    other visitor for 5 minutes, indefinitely. So for that one identifier only,
    ``authenticate()`` skips the allauth adapter (and its per-account
    ``login_failed`` consult) and falls back to plain Django ``authenticate()``.
    The per-IP ``LoginRateThrottle`` (#924) still applies regardless, and every
    other account on a demo instance — including any real user accounts — keeps
    the full per-account lockout.
    """

    def authenticate(self, **kwargs):
        from allauth.account.adapter import get_adapter
        from django.conf import settings
        from django.contrib.auth import authenticate as django_authenticate

        request = self.context["request"]
        if settings.DEMO_MODE and self._is_demo_account(kwargs, request):
            return django_authenticate(request, **kwargs)
        return get_adapter(request).authenticate(request, **kwargs)

    @staticmethod
    def _is_demo_account(credentials, request=None):
        """Whether these credentials target the published demo account.

        Mirrors the identifier-precedence order (email over username) that
        ``RegistrationAdapter._get_login_attempts_cache_key`` (#1206) uses to
        *resolve* which account a login attempt is against — the lockout
        itself now keys on that resolved account's pk, not on the identifier
        string, but this carve-out only needs to know which credentials name
        the demo account, so it reuses the same resolution order — plus a
        strip, since a demo visitor pasting the published credential is more
        likely to pick up incidental whitespace than a real login attempt.
        """
        from django.conf import settings

        from .backends import resolve_login_user

        demo_username = settings.DEMO_LOGIN_USERNAME.strip().lower()
        if not demo_username:
            return False
        identifier = credentials.get("email", credentials.get("username", "")) or ""
        if identifier.strip().lower() == demo_username:
            return True
        # #1206: the demo account can also be named by its email address. The
        # lockout now keys on the resolved account, so without this a visitor
        # typing the demo email could lock the shared account's bucket.
        user = resolve_login_user(identifier.strip(), request)
        return user is not None and user.get_username().strip().lower() == demo_username


class VisibanPasswordResetSerializer(PasswordResetSerializer):
    """Wires our custom password-reset form so the reset email link points at
    the frontend SPA rather than reversing the Django built-in URL name."""

    @property
    def password_reset_form_class(self):
        return VisibanPasswordResetForm


# Pinned to the 1.1 OpenAPI component name (#1825). Without it the component
# is named after this subclass ("Visiban..."), so every generated client saw
# the request type renamed in 1.2 although the endpoint and wire shape are
# dj-rest-auth's, as in 1.1. Schema only; with COMPONENT_SPLIT_REQUEST the
# request component is this name plus "Request".
@extend_schema_serializer(component_name="PasswordResetConfirm")
class VisibanPasswordResetConfirmSerializer(DjRestAuthPasswordResetConfirmSerializer):
    """Clears the per-account login lockout on a successful password reset (#1203).

    dj-rest-auth's stock ``PasswordResetConfirmSerializer.save()`` calls Django's
    plain ``SetPasswordForm.save()`` and nothing else — it never touches
    allauth's ``login_failed`` rate-limit bucket. Only allauth's own reset flow
    (``finalize_password_reset``) does that, and Visiban's reset-confirm
    endpoint never runs it (see ``accounts.adapter.clear_login_lockout`` for
    the full explanation, including why both the username and email keys are
    cleared). Without this override, a user locked out by 5 failed login
    attempts (#1199) who then successfully reset their password was still
    refused login — including with the brand-new, correct password — until the
    5-minute window expired on its own.

    ``self.user`` and ``self.context["request"]`` are both set by the base
    class's ``validate()`` (the user from the decoded ``uid``/``token``; the
    request via DRF's ``GenericAPIView.get_serializer`` context) before
    ``save()`` ever runs, so both are guaranteed present here.
    """

    def validate(self, attrs):
        """Re-check, when the link is used, the condition that allowed sending it (#1314).

        A password-less account only ever gets a real reset link because its
        address was verified (``VisibanPasswordResetForm``). Links stay valid
        for days, so that has to still hold now: if the account no longer has
        a verified address, the link is refused exactly like an invalid token
        — setting a password would hand the account to whoever holds a mailbox
        the account no longer vouches for. Accounts that already have a
        password are unaffected (resetting it changes no trust boundary).
        """
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from .forms import password_reset_still_allowed

        attrs = super().validate(attrs)
        if not password_reset_still_allowed(self.user):
            raise DRFValidationError({"token": ["Invalid value"]})
        self._reset_token = attrs["token"]
        return attrs

    def save(self):
        """Set the password, apply the reset side effects, then clear the lockout.

        A reset ends with the same state as the other web and API password-setting routes
        (#1551): ``must_change_password`` cleared, Personal Access Tokens and
        the DRF auth ``Token`` deleted (``accounts.credentials``). The password
        save and those writes share one transaction so they commit together;
        the lockout is cleared only once they have.
        """
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from . import credentials as credentials_module
        from .forms import reset_link_still_valid

        with transaction.atomic():
            # The reset link is re-validated under the user row lock (#1623).
            try:
                locked = credentials_module.lock_user_row(self.user)
            except get_user_model().DoesNotExist:
                raise DRFValidationError({"token": ["Invalid value"]}) from None
            if not reset_link_still_valid(locked, self._reset_token):
                raise DRFValidationError({"token": ["Invalid value"]})
            # Read before the save: a first password gets its own notice.
            first_password = not locked.has_usable_password()
            original = self.user
            self.user = locked
            self.set_password_form.user = locked
            # Only the password column is written (#1619): the stock
            # ``SetPasswordForm.save()`` would write every column back.
            result = self.set_password_form.save(commit=False)
            self.user.save(update_fields=["password"])
            original.password = locked.password
            finalize_password_reset(self.user, first_password=first_password)
        clear_login_lockout(self.context["request"], self.user)
        return result


# Pinned to the 1.1 OpenAPI component name (#1825). Without it the component
# is named after this subclass ("Visiban..."), so every generated client saw
# the request type renamed in 1.2 although the endpoint and wire shape are
# dj-rest-auth's, as in 1.1. Schema only; with COMPONENT_SPLIT_REQUEST the
# request component is this name plus "Request".
@extend_schema_serializer(component_name="PasswordChange")
class VisibanPasswordChangeSerializer(DjRestAuthPasswordChangeSerializer):
    """dj-rest-auth's password change, with the current password always verified (#1257).

    dj-rest-auth only checks ``old_password`` when its
    ``OLD_PASSWORD_FIELD_ENABLED`` setting is on; with the default (off) it pops
    the field and changes the password for any authenticated caller. That made
    ``POST /api/v1/auth/password/change/`` a way for anyone holding a session or
    a Personal Access Token to take over the account's password without knowing
    it — while ``/auth/change-password/`` has always required
    ``current_password``. The check is forced on here rather than left to the
    setting alone, so a future edit to ``REST_AUTH`` cannot silently reopen it.

    Making ``old_password`` required is a deliberate break of the "new body
    fields must be optional" API rule: the only client that omits it is one
    relying on the vulnerability. No Visiban client (SPA, docs examples) calls
    this endpoint; the SPA uses ``/auth/change-password/``.

    Social-only accounts (no usable password) are exempt, matching
    ``ChangePasswordView``: they have no current password to prove, and this is
    how they set their first one. That exemption applies to an interactive
    session only: a request authenticated with any token credential is
    refused with 403 (#1609, ``accounts.credentials.first_password_requires_session``),
    and so is a session without a recent provider sign-in to the account
    (#1260, ``accounts.credentials.first_password_requires_recent_login``).
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # #1619: TokenRevokingPasswordChangeView passes the user row it read
        # under the row lock, so the current password is checked against, and
        # the new one written to, the stored row rather than the copy loaded
        # when the request started.
        locked_user = self.context.get("locked_user")
        if locked_user is not None:
            self.user = locked_user
        self.old_password_field_enabled = True
        if "old_password" not in self.fields:
            self.fields["old_password"] = serializers.CharField(max_length=128)
        # #1781: drf-spectacular instantiates the serializer with the view's
        # AnonymousUser, which has no has_usable_password(). Without this guard
        # schema generation dropped the whole request body, hiding the required
        # old_password (#1257) from the OpenAPI contract. An anonymous/absent
        # user keeps the field required, which is the documented contract.
        if (
            self.user is not None
            and hasattr(self.user, "has_usable_password")
            and not self.user.has_usable_password()
        ):
            self.fields["old_password"].required = False
            self.fields["old_password"].allow_blank = True

    def validate_old_password(self, value):
        if self.user is not None and self.user.has_usable_password():
            from . import password_attempts

            request = self.context.get("request")
            attempt = (
                password_attempts.begin_current_password_check(request, self.user)
                if request is not None
                else None
            )
            if not self.user.check_password(value):
                raise serializers.ValidationError(
                    "Your old password was entered incorrectly. Please enter it again."
                )
            password_attempts.current_password_accepted(attempt)
        return value

    def validate(self, attrs):
        from rest_framework.exceptions import PermissionDenied

        from . import credentials as credentials_module

        # #1609: raised as PermissionDenied (403), not a field error, so both
        # password-change routes answer the same way. Runs against the row the
        # view read under the lock when one was passed in.
        if self.user is not None and credentials_module.first_password_requires_session(
            self.request, self.user
        ):
            raise PermissionDenied(credentials_module.FIRST_PASSWORD_SESSION_REQUIRED_MESSAGE)
        # #1260: the session must also hold a recent provider sign-in to this
        # account. A dict detail renders as ``{"detail": ..., "code": ...}``,
        # the same body ChangePasswordView returns.
        if self.user is not None and credentials_module.first_password_requires_recent_login(
            self.request, self.user
        ):
            raise PermissionDenied(
                {
                    "detail": credentials_module.FIRST_PASSWORD_RECENT_LOGIN_REQUIRED_MESSAGE,
                    "code": credentials_module.RECENT_LOGIN_REQUIRED_CODE,
                }
            )
        return super().validate(attrs)

    def save(self):
        """dj-rest-auth's ``save``, writing only the password column (#1619).

        Django's ``SetPasswordForm.save()`` ends in a full ``user.save()``;
        saving just ``password`` means no other column (``is_active``, the
        forced-change flags) can be written back from an earlier read.
        """
        from django.contrib.auth import update_session_auth_hash

        self.set_password_form.save(commit=False)
        self.user.save(update_fields=["password"])
        if not self.logout_on_password_change:
            update_session_auth_hash(self.request, self.user)


class PublicUserSerializer(serializers.ModelSerializer):
    """Minimal user representation returned by the user-search endpoint.

    Intentionally omits email, notification preferences, and other private
    fields — the search endpoint is accessible to all authenticated users
    regardless of whether they share a board with the result.
    """

    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        normalize_username_field_validators(self.fields["username"])

    class Meta:
        model = User
        fields = ["id", "username", "display_name", "avatar_url"]


class BoardUserSerializer(serializers.ModelSerializer):
    """Slim user representation for embedding in board resources.

    Exposes only the fields that are safe to share with all board members.
    UserSerializer (full shape) is reserved for /api/auth/me/ only.

    This keeps notification preferences, UI preferences, and the
    can_access_all_content privilege flag private — board members must not
    be able to read these fields for other users via the board API.
    """

    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        normalize_username_field_validators(self.fields["username"])

    class Meta:
        model = User
        fields = ["id", "username", "display_name", "avatar_url"]


class UserSerializer(serializers.ModelSerializer):
    has_usable_password = serializers.SerializerMethodField()
    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)
    email = EmailOrBlankField(max_length=254, allow_blank=True, required=False)
    # Write-only and optional: needed only in a request that changes ``email``
    # on an account with a usable password (see ``to_internal_value``). Never
    # stored, never echoed back, and ignored by requests that leave the email
    # alone, so existing clients are unaffected.
    current_password = serializers.CharField(
        write_only=True,
        required=False,
        allow_blank=True,
        trim_whitespace=False,
        max_length=4096,
        style={"input_type": "password"},
    )
    # default_board_id is injected as a writable PrimaryKeyRelatedField in
    # __init__ rather than at class level to avoid a premature import of
    # boards.models during test collection (app registry may not be ready when
    # this module is first imported in some Django startup orderings).

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # The auto-generated `username` field carries the model's
        # UnicodeUsernameValidator, which both accepts astral-plane code
        # points (#1120) and, being a RegexValidator, gets its regex
        # surfaced verbatim as a JSON-Schema `pattern` that rejects the
        # Unicode usernames this app intentionally supports (breaks
        # backend-schema-fuzz on every endpoint embedding a user). Swap it
        # for UsernameFormatValidator rather than replacing the field, so
        # its other auto-derived behavior (max_length, uniqueness) is
        # untouched.
        normalize_username_field_validators(self.fields["username"])
        # After super().__init__ the fields BindingDict is built; we can now
        # replace the auto-generated read-only FK field with a writable one.
        from boards.models import Board, BoardMembership  # deferred to avoid startup ordering issues
        # Scope to boards the requesting user is a member of to prevent IDOR —
        # without this a user could set any board PK as their default, confirming
        # existence of boards they have no access to. A membership whose stored
        # role is outside the enum grants no access (get_board_role), so it does
        # not count either (#1829). Both conditions in one filter() so they apply
        # to the same membership row.
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            board_qs = Board.objects.filter(
                memberships__user=request.user,
                memberships__role__in=BoardMembership.Role.values,
            )
        else:
            board_qs = Board.objects.none()
        self.fields["default_board_id"] = serializers.PrimaryKeyRelatedField(
            source="default_board",
            queryset=board_qs,
            allow_null=True,
            required=False,
        )

    def get_has_usable_password(self, obj) -> bool:
        return obj.has_usable_password()

    def to_internal_value(self, data):
        """Check ``current_password`` for an email change before any field is validated.

        Run ahead of field validation on purpose: ``validate_email`` can answer
        "address taken", and that answer must not reach a caller who has not
        proved they know the password. See
        ``accounts.credentials.email_change_requires_current_password`` for the
        rule and why accounts without a password are exempt from it; they need a
        recent provider sign-in in the session instead
        (``email_change_requires_recent_login``, #1932), checked at the same
        point for the same reason.
        """
        self._check_username_change_needs_session(data)
        self._check_current_password_for_email_change(data)
        return super().to_internal_value(data)

    def _check_username_change_needs_session(self, data):
        """Refuse a token credential that changes the username, before any field validation.

        Run ahead of field validation so a token caller gets the same 403
        whatever the name (``validate_username`` and the uniqueness validator
        would otherwise answer "taken" first). Covers ``PATCH``/``PUT
        /auth/user/`` and ``PATCH /auth/me/``, which share this serializer.
        """
        from rest_framework.exceptions import PermissionDenied

        from . import credentials as credentials_module

        if self.instance is None or not hasattr(data, "get"):
            return
        requested = data.get("username")
        # DRF's CharField coerces an int or float to its string form, so such a
        # value is a real rename and must be judged like the string it becomes.
        # Absent, bool, or any other type is rejected by the field itself (400).
        if isinstance(requested, bool) or not isinstance(requested, (str, int, float)):
            return
        # The field trims surrounding whitespace, so compare the trimmed value.
        if credentials_module.username_change_requires_session(
            self.context.get("request"), self.instance.username, str(requested).strip()
        ):
            raise PermissionDenied(credentials_module.USERNAME_CHANGE_SESSION_REQUIRED_MESSAGE)

    def _check_current_password_for_email_change(self, data):
        from . import credentials as credentials_module
        from . import password_attempts

        request = self.context.get("request")
        # Without a request there is no remote caller to verify (the same
        # exemption as ``email_change_requires_session``); every route that
        # writes the profile passes one, and no request-less caller exists.
        if self.instance is None or request is None or not hasattr(data, "get"):
            return
        requested = data.get("email")
        if not isinstance(requested, str):
            # Absent, or a malformed value the email field rejects on its own.
            return
        # The email field trims surrounding whitespace before validate_email
        # compares, so compare the same trimmed value here.
        requested = requested.strip()
        if credentials_module.email_change_requires_session(
            request, self.instance.email, requested
        ):
            # A token caller gets the session rule's 403 from validate_email;
            # whether it knows the password is irrelevant.
            return
        # #1932: an account with no usable password has no password to prove,
        # so its session must hold a recent provider sign-in instead, the
        # first-password rule (#1260). The same 403 body and ``code`` as that
        # rule, raised here so no "address taken" answer comes first.
        if credentials_module.email_change_requires_recent_login(
            request, self.instance, requested
        ):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                {
                    "detail": credentials_module.EMAIL_CHANGE_RECENT_LOGIN_REQUIRED_MESSAGE,
                    "code": credentials_module.RECENT_LOGIN_REQUIRED_CODE,
                }
            )
        if not credentials_module.email_change_requires_current_password(
            self.instance, requested
        ):
            return
        password = data.get("current_password")
        if not isinstance(password, str) or not password:
            raise serializers.ValidationError(
                {"current_password": [credentials_module.EMAIL_CHANGE_PASSWORD_REQUIRED_MESSAGE]}
            )
        # A wrong password draws on the same per-account failed-attempt budget
        # as login and the password-change routes, so this cannot be used to
        # guess the password.
        attempt = password_attempts.begin_current_password_check(request, self.instance)
        if not self.instance.check_password(password):
            raise serializers.ValidationError(
                {"current_password": [credentials_module.EMAIL_CHANGE_PASSWORD_INCORRECT_MESSAGE]}
            )
        password_attempts.current_password_accepted(attempt)
        # The hash the password was accepted against; ``update`` re-checks it
        # under the user-row lock (#1711).
        self._verified_password_hash = self.instance.password

    def validate(self, attrs):
        # Checked in to_internal_value; never a column to write.
        attrs.pop("current_password", None)
        return super().validate(attrs)

    def validate_email(self, value):
        """Format check, plus: no blanking the address when verification is mandatory (#1273).

        ``User.email`` is ``blank=True`` and a blank address stays valid under
        ``optional``/``none``. Under ``mandatory`` an account is expected to hold
        a verified address; writing ``""`` directly would leave the verified
        primary ``EmailAddress`` row behind (so ``User.email`` and allauth
        disagree) and a still-pending change could later "un-blank" it. Only a
        change *to* blank is refused, so an account that already has no address
        (e.g. SSO without an email claim) can still save the rest of its profile.
        """
        from rest_framework.exceptions import PermissionDenied

        from . import credentials as credentials_module
        from .email_change import email_verification_mandatory

        # Changing the address (or requesting a confirmed change under
        # ``mandatory``) needs an interactive session, like setting a first
        # password. Checked first, before the format and
        # collision checks, so a token caller gets the same 403 whatever the
        # address. Raised as PermissionDenied (403), not a field error, the
        # same shape as the first-password session rule. Covers both
        # ``PATCH``/``PUT /auth/user/`` and ``PATCH /auth/me/``, which share
        # this serializer.
        if self.instance is not None and credentials_module.email_change_requires_session(
            self.context.get("request"), self.instance.email, value
        ):
            raise PermissionDenied(credentials_module.EMAIL_CHANGE_SESSION_REQUIRED_MESSAGE)

        value = validate_optional_email_format(value)
        if (
            not value
            and email_verification_mandatory()
            and self.instance is not None
            and self.instance.email
        ):
            raise serializers.ValidationError("An email address is required.")
        # #1221: an address another account answers to at login (its active
        # email, or its username) would switch off that account's email login
        # — see accounts.validators.email_collides_with_identifier. Checked only
        # when the address actually changes (ignoring case, like update()):
        # accounts that already collide from before this check existed must
        # keep saving the rest of their profile, and a client that round-trips
        # the full object re-sends the current email on every save. The
        # message doesn't say which account or which kind of match.
        #
        # Not under EMAIL_VERIFICATION=mandatory: there a changed address is
        # never written to User.email (the only field the login resolver
        # reads) until it is confirmed from that mailbox, so nobody can take
        # over another person's address without owning it, and #1293
        # deliberately gives the requester no signal about whether an address
        # is taken. Rejecting here would add exactly that signal.
        current = (self.instance.email if self.instance is not None else "") or ""
        if (
            value
            and value.strip().lower() != current.strip().lower()
            and not email_verification_mandatory()
        ):
            exclude_pk = self.instance.pk if self.instance is not None else None
            if email_collides_with_identifier(value, exclude_pk=exclude_pk):
                raise serializers.ValidationError(EMAIL_TAKEN_MESSAGE)
        return value

    def validate_username(self, value):
        """Case-insensitive uniqueness, the same rule as POST /auth/choose-username/ (#1273).

        The auto-generated UniqueValidator only checks an exact match, so on its
        own it let ``Alice`` through next to ``alice`` (then the
        ``unique_username_ci`` index turned the save into a 500).
        """
        exclude_pk = self.instance.pk if self.instance is not None else None
        if is_username_taken(value, exclude_pk=exclude_pk):
            raise serializers.ValidationError(USERNAME_TAKEN_MESSAGE)
        # #1221: a username equal to another active account's email would
        # intercept that account's email login. Reported as "taken" — the same
        # answer as an ordinary clash, naming no account. Only checked when the
        # username actually changes (a re-casing is not a change to the
        # resolver's case-insensitive view): a pre-existing collision must not
        # make every later profile save fail.
        current = self.instance.username if self.instance is not None else ""
        if value.lower() != (current or "").lower() and username_collides_with_email(
            value, exclude_pk=exclude_pk
        ):
            raise serializers.ValidationError(USERNAME_TAKEN_MESSAGE)
        return value

    def update(self, instance, validated_data):
        """Apply a profile update, enforcing the username and email rules (#1273).

        - A changed username satisfies a pending ``must_change_username``, exactly
          as POST /auth/choose-username/ does: it has passed the same format and
          case-insensitive uniqueness checks.
        - A changed email under ``EMAIL_VERIFICATION=mandatory`` is not written to
          ``User.email``; it becomes a pending change confirmed by email (see
          accounts/email_change.py). Otherwise it is written directly, as before.
        - Under ``mandatory``, sending the current address back while a change is
          pending withdraws that change.
        """
        from contextlib import nullcontext

        from django.db import IntegrityError, transaction

        from .email_change import (
            cancel_email_change,
            email_verification_mandatory,
            request_email_change,
        )

        new_username = validated_data.get("username")
        if new_username is not None and new_username != instance.username:
            validated_data["must_change_username"] = False

        pending_email = None
        cancel_pending = False
        new_email = validated_data.get("email")
        if new_email and email_verification_mandatory():
            if new_email.lower() != (instance.email or "").lower():
                pending_email = validated_data.pop("email")
            elif instance.pending_email_address_id is not None:
                # Setting the email back to the current address withdraws a
                # change that is still awaiting confirmation.
                cancel_pending = True

        # An email equal to the stored value is not a change (that is how a
        # token client round-trips the profile past validate_email), so it is
        # not written: rewriting it from this request's copy of the row could
        # put back an address another request has changed in the meantime.
        if "email" in validated_data and validated_data["email"] == (instance.email or ""):
            validated_data.pop("email")

        verified_hash = getattr(self, "_verified_password_hash", None)
        # One transaction from the lock to the last write, so the password
        # that was accepted is still the stored one when the address changes.
        with transaction.atomic() if verified_hash is not None else nullcontext():
            if verified_hash is not None:
                # #1711: the current password was checked against the copy of
                # the row loaded when the request started. Re-read the row
                # under the user-row lock (serialized with every credential
                # change) and refuse when the stored hash is no longer the one
                # that was checked. A hash re-encoded by a login (same
                # password, new salt) is refused too and the client retries.
                from . import credentials as credentials_module

                locked = credentials_module.lock_user_row(instance)
                if locked.password != verified_hash or not locked.is_active:
                    raise serializers.ValidationError(
                        {"current_password": [credentials_module.EMAIL_CHANGE_PASSWORD_INCORRECT_MESSAGE]}
                    )
            try:
                with transaction.atomic():
                    instance = self._save_changed_fields(instance, validated_data)
            except IntegrityError:
                # unique_username_ci is the backstop for a concurrent rename racing
                # validate_username (same TOCTOU handling as ChooseUsernameView).
                if new_username is not None:
                    raise serializers.ValidationError({"username": [USERNAME_TAKEN_MESSAGE]})
                raise

            if pending_email is not None:
                try:
                    request_email_change(self.context.get("request"), instance, pending_email)
                except DjangoValidationError:
                    # #1312: the address is already verified for this account but
                    # collides with another account's username/email — see
                    # request_email_change's docstring for why this one branch
                    # checks (it bypasses confirmation entirely).
                    raise serializers.ValidationError({"email": [EMAIL_TAKEN_MESSAGE]})
                instance.refresh_from_db(fields=["email"])
            elif cancel_pending:
                cancel_email_change(instance)
        return instance

    @staticmethod
    def _save_changed_fields(instance, validated_data):
        """``ModelSerializer.update``, but writing only the columns the request sets (#1619).

        *instance* is the user as loaded when the request started. DRF's stock
        ``update`` ends in a full ``instance.save()``, which writes every column
        from that copy, so a password change, deactivation or forced-change flag
        committed by another request in the meantime would be overwritten with
        the earlier value. Restricting the save to the validated fields leaves
        every other column as it is stored.
        """
        from rest_framework.utils import model_meta

        info = model_meta.get_field_info(instance)
        many_to_many = {}
        for attr, value in validated_data.items():
            if attr in info.relations and info.relations[attr].to_many:
                many_to_many[attr] = value
            else:
                setattr(instance, attr, value)
        update_fields = [attr for attr in validated_data if attr not in many_to_many]
        if update_fields:
            instance.save(update_fields=update_fields)
        for attr, value in many_to_many.items():
            getattr(instance, attr).set(value)
        return instance

    class Meta:
        model = User
        fields = [
            "id", "username", "email", "first_name", "last_name", "avatar_url",
            "display_name", "is_site_admin", "can_access_all_content",
            "must_change_password", "must_change_username", "has_usable_password",
            "timezone", "date_format", "time_format", "number_locale",
            "close_editor_on_enter",
            "has_completed_tour",
            "theme",
            "notif_card_assigned", "notif_mentioned", "notif_due_soon",
            "notif_card_moved", "notif_comment_added", "notif_board_invite",
            "notif_stale",
            # Email delivery opt-ins (#356). Additive and optional on PATCH, all
            # default False — see the User model for why an upgrade must not
            # start emailing anyone.
            "email_notif_card_assigned", "email_notif_mentioned",
            "email_notif_due_soon", "email_notif_card_moved",
            "email_notif_comment_added",
            "default_board_id",
            "current_password",
        ]
        read_only_fields = ["id", "is_site_admin", "can_access_all_content", "must_change_password", "must_change_username", "has_usable_password"]


# #1872: these four instance flags also live on /auth/site-config/, which is where
# instance-level state belongs. They stay here for the 1.x contract (never removed
# before a major bump), but the schema marks them deprecated so a generated client
# reads them from site-config. git_lens_enabled is NOT deprecated: #1666 froze it here
# as a normal field, so it is mirrored on site-config without a deprecation.
CURRENT_USER_DEPRECATED_INSTANCE_FLAGS = (
    "maintenance_mode",
    "maintenance_message",
    "demo_mode",
    "demo_next_reset_at",
)
_DEPRECATED_FOR_SITE_CONFIG = (
    "Deprecated (#1872): read this from GET /api/v1/auth/site-config/, which returns the "
    "same value. Kept on this object for the 1.x contract; removal needs a major version."
)


@extend_schema_serializer(deprecate_fields=list(CURRENT_USER_DEPRECATED_INSTANCE_FLAGS))
class CurrentUserSerializer(UserSerializer):
    """Extends UserSerializer with site-wide settings for the /api/auth/me/ endpoint.

    Kept separate from UserSerializer because UserSerializer is embedded in
    board/card serializers for assignee, author, and member fields — calling
    get_uploads_enabled() there would issue a SiteSetting DB query on every
    board full response before the cache is warm.
    """

    # FROZEN (#1664): the instance-wide flags below (uploads_enabled .. demo_next_reset_at)
    # are a closed list. New instance flags go on SiteConfig (/auth/site-config/), not here;
    # see docs/api/authentication.md#frozen-instance-flags-on-authuser. The "lives here
    # for the same reason" notes below explain history, not a pattern to repeat.
    uploads_enabled = serializers.SerializerMethodField()
    # Surfaces the Issue Board Lens experiment flag to the SPA so it can show or
    # hide the lens entry point. Read from settings (no DB hit), so it stays on
    # CurrentUserSerializer rather than the embedded UserSerializer.
    git_lens_enabled = serializers.SerializerMethodField()
    # Maintenance mode (#783). Lives here for the same reason uploads_enabled
    # does: the SPA bootstraps from GET /auth/user/, so this is where an
    # instance-wide flag reaches it without adding a SiteSetting read to every
    # embedded assignee/member object in a board payload.
    #
    # maintenance_message is always populated when maintenance_mode is True —
    # the built-in default is substituted server-side for a blank operator
    # message — so the client never has to carry a fallback string of its own
    # and the banner can never render empty.
    maintenance_mode = serializers.SerializerMethodField(help_text=_DEPRECATED_FOR_SITE_CONFIG)
    maintenance_message = serializers.SerializerMethodField(help_text=_DEPRECATED_FOR_SITE_CONFIG)
    # Hosted demo (#1179). Here for the same reason as maintenance_mode: the
    # SPA bootstraps from GET /auth/user/, so this is where the in-app demo bar
    # learns the mode and the next reset instant. Settings-only reads — no DB.
    # demo_next_reset_at is null unless DEMO_MODE is on.
    demo_mode = serializers.SerializerMethodField(help_text=_DEPRECATED_FOR_SITE_CONFIG)
    demo_next_reset_at = serializers.SerializerMethodField(help_text=_DEPRECATED_FOR_SITE_CONFIG)
    # #1273: an email change awaiting confirmation (EMAIL_VERIFICATION=mandatory),
    # or null. ``email`` keeps the current, verified value until the link is
    # followed, so this is how a client learns the PATCH was accepted but is not
    # yet in effect. Only on the current-user serializer: it costs a query, and
    # it is nobody else's business.
    pending_email = serializers.SerializerMethodField()
    # #1314: the provider a collided OAuth attempt tried to use, while the
    # "Connect {Provider}?" prompt is still owed to this account, or null.
    # Read from the session (no query unless one is stashed); cleared by
    # DELETE /auth/me/pending-connect/ or by any connect attempt for it.
    pending_connect_provider = serializers.SerializerMethodField()
    # #1314: how the provider names the account that tried (its username,
    # else its email), so the prompt can say *which* account it would
    # connect — a shared-browser safeguard. Null whenever the provider is.
    pending_connect_identity = serializers.SerializerMethodField()

    def get_uploads_enabled(self, obj) -> bool:
        return get_uploads_enabled()

    # The five instance flags read from accounts.instance_flags, the same helpers
    # SiteConfigView uses (#1872), so /auth/user/ and /auth/site-config/ cannot drift.
    def get_git_lens_enabled(self, obj) -> bool:
        return instance_flags.git_lens_enabled()

    def _maintenance_state(self):
        """Read the cached state once per serialization, not once per field.

        Two SerializerMethodFields need the same tuple; without this they would
        each issue their own cache round trip for an identical answer.
        """
        if not hasattr(self, "_cached_maintenance_state"):
            self._cached_maintenance_state = instance_flags.maintenance_notice()
        return self._cached_maintenance_state

    def get_maintenance_mode(self, obj) -> bool:
        return self._maintenance_state()[0]

    def get_maintenance_message(self, obj) -> str:
        return self._maintenance_state()[1]

    def get_demo_mode(self, obj) -> bool:
        return instance_flags.demo_mode()

    @extend_schema_field(serializers.DateTimeField(allow_null=True, read_only=True))
    def get_demo_next_reset_at(self, obj) -> str | None:
        return instance_flags.demo_next_reset_at()

    @extend_schema_field(serializers.EmailField(allow_null=True, read_only=True))
    def get_pending_email(self, obj) -> str | None:
        from .email_change import get_pending_email

        return get_pending_email(obj)

    def _pending_connect(self, obj):
        """``(provider, identity)`` read once per serialization (one query at most)."""
        from .social_connect import get_pending_connect

        cache = self.__dict__.setdefault("_cached_pending_connect", {})
        if obj.pk not in cache:
            request = self.context.get("request")
            if request is None or getattr(request, "user", None) is None or request.user.pk != obj.pk:
                cache[obj.pk] = (None, None)
            else:
                cache[obj.pk] = get_pending_connect(request, obj)
        return cache[obj.pk]

    @extend_schema_field(serializers.CharField(allow_null=True, read_only=True))
    def get_pending_connect_provider(self, obj) -> str | None:
        return self._pending_connect(obj)[0]

    @extend_schema_field(serializers.CharField(allow_null=True, read_only=True))
    def get_pending_connect_identity(self, obj) -> str | None:
        return self._pending_connect(obj)[1]

    class Meta(UserSerializer.Meta):
        # ``is_superuser`` is here and never on UserSerializer, which is embedded
        # as the assignee, author and member of board and card payloads: whether
        # another account is a superuser is not for other members to read. This
        # is the caller's own state, so the admin users page can tell a superuser
        # from a site admin and leave out what the API refuses the latter (#1644).
        # It is changed only through the Django admin.
        fields = UserSerializer.Meta.fields + [
            "is_superuser",
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
            "demo_mode",
            "demo_next_reset_at",
            "pending_email",
            "pending_connect_provider",
            "pending_connect_identity",
        ]
        read_only_fields = UserSerializer.Meta.read_only_fields + [
            "is_superuser",
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
            "demo_mode",
            "demo_next_reset_at",
            "pending_email",
            "pending_connect_provider",
            "pending_connect_identity",
        ]


class PersonalAccessTokenSerializer(serializers.ModelSerializer):
    # Declared explicitly, rather than left to the auto-generated JSONField,
    # so drf-spectacular publishes an array-of-strings schema instead of an
    # untyped one (#1294) — read_only/allow_null match the model field
    # (null=True means "legacy token, full authority"; see the class
    # docstring). Documentation only: this field is already read_only via
    # Meta.read_only_fields below, so representation is unaffected.
    scopes = serializers.ListField(child=serializers.CharField(), read_only=True, allow_null=True)

    class Meta:
        model = PersonalAccessToken
        fields = [
            "id",
            "name",
            "prefix",
            "created_at",
            "last_used_at",
            "expires_at",
            "scopes",
        ]
        read_only_fields = [
            "id",
            "name",
            "prefix",
            "created_at",
            "last_used_at",
            "expires_at",
            "scopes",
        ]


class PersonalAccessTokenCreateResponseSerializer(PersonalAccessTokenSerializer):
    """Documents the creation response only (#1294) — extends
    ``PersonalAccessTokenSerializer`` with the raw token, included once at
    creation only. Never instantiated: ``PersonalAccessTokenListCreateView.post``
    builds this exact shape by hand (``PersonalAccessTokenSerializer(pat).data``
    plus an injected ``token`` key) so the raw value is never persisted or
    reachable again; this class exists purely so drf-spectacular can describe
    that response.
    """

    token = serializers.CharField(read_only=True)

    class Meta(PersonalAccessTokenSerializer.Meta):
        fields = PersonalAccessTokenSerializer.Meta.fields + ["token"]
        read_only_fields = PersonalAccessTokenSerializer.Meta.read_only_fields + ["token"]


class PersonalAccessTokenCreateSerializer(serializers.Serializer):
    """Validate the scopes requested for a new personal access token.

    Validation lives here, not in the view, per the project's
    validate-at-the-boundary rule — `scopes` is the most security-sensitive
    input in the token flow and is the one field that must not be hand-parsed
    out of `request.data`. Shaped after `validate_allowed_priorities` in
    groups/serializers.py.

    The rest of the create payload (name, expires_at) is still parsed in the
    view; moving it here is tracked separately so this change stays scoped.
    """

    scopes = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        allow_empty=False,
    )

    def validate_scopes(self, value):
        """Reject anything outside the known vocabulary.

        An unrecognised scope string is *ambiguous authority*: nothing can
        decide what it grants, so it must not be stored and silently ignored.
        Adding a scope later is a one-line edit to PAT_SCOPES, which is the
        right place for that decision to be visible.
        """
        unknown = sorted(set(value) - set(PAT_SCOPES))
        if unknown:
            raise serializers.ValidationError(
                f"Unknown scope(s): {', '.join(unknown)}. "
                f"Valid scopes are: {', '.join(PAT_SCOPES)}."
            )
        # Preserve the declared vocabulary order and drop duplicates so the
        # stored value is canonical and comparable.
        return [scope for scope in PAT_SCOPES if scope in set(value)]


class ConnectedAccountSerializer(serializers.Serializer):
    """One row of ``GET /auth/me/connected-accounts/`` (#1314).

    Read-only and never bound to request data — built from
    ``social_connect.connected_accounts_status``. ``email`` and
    ``connected_at`` are always present, ``null`` on a disconnected row (#1871). Exposes nothing a
    provider token could be recovered from: no uid, no ``extra_data``.
    """

    provider = serializers.CharField(read_only=True)
    connected = serializers.BooleanField(read_only=True)
    email = serializers.EmailField(read_only=True, allow_null=True)
    connected_at = serializers.DateTimeField(read_only=True, allow_null=True)
