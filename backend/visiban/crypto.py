"""Symmetric encryption for secrets stored at rest in the database (#306).

Why this module exists
----------------------
Visiban stores exactly one at-rest secret today: the SMTP password on
``accounts.SiteEmailSetting``. An operator configuring outbound email from the
admin UI has to hand us a credential that we must be able to *use* later, so
hashing is not an option — this has to be reversible encryption.

Choice of primitive
-------------------
``cryptography.fernet.Fernet`` (AES-128-CBC + HMAC-SHA256, versioned token
format). ``cryptography`` is already a direct dependency, so this adds no new
package. The authenticated construction is what makes the key-rotation story
below work at all: Fernet raises ``InvalidToken`` on a wrong key rather than
returning plausible garbage that we would then hand to an SMTP server.

Key derivation, and why the key is derived rather than configured
-----------------------------------------------------------------
The key comes from ``VISIBAN_SECRET_ENCRYPTION_KEY`` when set, and otherwise is
derived from ``SECRET_KEY`` via HKDF-SHA256.

Deriving from ``SECRET_KEY`` by default is deliberate and is the reason #306 is
usable at all: requiring a dedicated key first would mean an operator had to
generate a value, edit ``.env`` and restart the container *before* the settings
form would accept a password — reinstating precisely the friction the issue
exists to remove. The dedicated variable is the escape hatch for operators who
rotate ``SECRET_KEY``, not the default path.

``info`` domain-separates this key so the same ``SECRET_KEY`` can derive an
unrelated key for some future secret (an OIDC client secret, say) without two
features ever sharing key material. Any future caller MUST pass its own
``info`` rather than reusing ``_SMTP_INFO``.

The rotation problem, and the fingerprint that makes it visible
---------------------------------------------------------------
``docs/administration/secret-rotation.md`` documents rotating
``DJANGO_SECRET_KEY`` as a supported, periodic operation, and lists its only
consequence as "users will need to log in again". Once a secret is encrypted
under a key derived from ``SECRET_KEY``, that runbook silently destroys the
stored SMTP password — and the symptom (password resets stop arriving) shows up
weeks later with nothing connecting it back to the rotation.

So every stored value carries the key fingerprint it was written under:

    v1:<first 8 hex of sha256(key)>:<fernet token>

``secret_is_decryptable()`` compares fingerprints and needs no crypto at all,
which lets the admin API report ``password_decryptable: false`` on a plain read
and warn the operator *before* the next send fails. Without the fingerprint the
only way to learn the key changed would be to attempt a decryption, and a
failure could not be distinguished from a corrupt column.

The ``v1`` appears in both the ``info`` string and the stored prefix, so a
future algorithm change is a version bump with a readable migration path rather
than a column full of undistinguishable ciphertext.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.views.decorators.debug import sensitive_variables

# Bumped only when the stored format or the primitive changes. Present in both
# the HKDF `info` and the stored prefix so the two can never disagree.
SECRET_FORMAT_VERSION = "v1"

# Domain-separation label for the SMTP password key. A future at-rest secret
# gets its OWN label — never reuse this one.
_SMTP_INFO = b"visiban.smtp-password.v1"

# A fixed, non-secret salt. HKDF's security does not rest on salt secrecy, and a
# stored random salt would have to live beside the ciphertext and be managed
# through the same rotation path it exists to protect.
_HKDF_SALT = b"visiban.secret-encryption.v1"

_FINGERPRINT_LEN = 8


class SecretDecryptionError(Exception):
    """A stored secret could not be decrypted under the current key.

    Deliberately its own exception type rather than a generic failure: the
    caller has to be able to tell "the encryption key changed, ask the operator
    to re-enter the password" apart from "the SMTP server rejected our
    credentials", because the two have completely different remedies and only
    one of them is the operator's fault.
    """


def _derive_key(info: bytes = _SMTP_INFO) -> bytes:
    """Return a urlsafe-base64 Fernet key derived from the instance secret."""
    configured = getattr(settings, "SECRET_ENCRYPTION_KEY", "") or ""
    ikm = (configured or settings.SECRET_KEY).encode("utf-8")
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=info,
    ).derive(ikm)
    return base64.urlsafe_b64encode(derived)


def _fingerprint(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:_FINGERPRINT_LEN]


@sensitive_variables("plaintext")
def encrypt_secret(plaintext: str, *, info: bytes = _SMTP_INFO) -> str:
    """Encrypt ``plaintext``, returning ``v1:<fingerprint>:<token>``.

    An empty string encrypts to an empty string — "no secret stored" is a real
    state and must not become a ciphertext that decrypts to "".
    """
    if not plaintext:
        return ""
    key = _derive_key(info)
    token = Fernet(key).encrypt(plaintext.encode("utf-8")).decode("ascii")
    return f"{SECRET_FORMAT_VERSION}:{_fingerprint(key)}:{token}"


def _split(stored: str) -> tuple[str, str, str] | None:
    # Defense in depth: password_ciphertext is a TextField and encrypt_secret is
    # its only writer, so bytes should be unreachable — but an unguarded
    # TypeError here would surface as a 500 with a traceback instead of the
    # typed error every other malformed input produces.
    if not isinstance(stored, str):
        raise SecretDecryptionError("stored secret is not a string")
    parts = stored.split(":", 2)
    if len(parts) != 3:
        return None
    return parts[0], parts[1], parts[2]


def secret_is_decryptable(stored: str, *, info: bytes = _SMTP_INFO) -> bool:
    """True if ``stored`` was written under the key currently in effect.

    Pure comparison — no decryption, so this is cheap enough for a read path
    such as ``GET /api/v1/admin/email-settings/``. An empty value is vacuously
    decryptable: there is nothing stored to fail on, and reporting False would
    make a fresh install look broken.
    """
    if not stored:
        return True
    parsed = _split(stored)
    if parsed is None:
        return False
    version, fingerprint, _ = parsed
    if version != SECRET_FORMAT_VERSION:
        return False
    return fingerprint == _fingerprint(_derive_key(info))


def decrypt_secret(stored: str, *, info: bytes = _SMTP_INFO) -> str:
    """Decrypt a value produced by :func:`encrypt_secret`.

    Raises :class:`SecretDecryptionError` — never returns a partial or
    placeholder value — so a caller cannot accidentally authenticate to an SMTP
    server with a garbled password and read the resulting rejection as "wrong
    credentials".
    """
    if not stored:
        return ""
    parsed = _split(stored)
    if parsed is None:
        raise SecretDecryptionError("stored secret is not in the expected format")
    version, fingerprint, token = parsed
    if version != SECRET_FORMAT_VERSION:
        raise SecretDecryptionError(f"unsupported stored secret version {version!r}")
    key = _derive_key(info)
    if fingerprint != _fingerprint(key):
        raise SecretDecryptionError(
            "stored secret was encrypted under a different key "
            "(the instance encryption key changed)"
        )
    try:
        return Fernet(key).decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise SecretDecryptionError("stored secret failed authentication") from exc
