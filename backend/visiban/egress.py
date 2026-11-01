"""Guarded outbound HTTP to user-supplied destinations (#863).

Why this module exists
----------------------
Visiban's other outbound calls go to hosts an operator chose (SMTP) or to
hard-coded provider APIs (the Git Lens). A webhook URL is different: any board
admin types it, and the request is made from inside the deployment's network.
Without a guard, that one text field reaches whatever the backend can reach:
the cloud metadata service, the database, an admin panel bound to localhost.

Every outbound request to a user-supplied destination therefore goes through
this module and nowhere else (security-invariants Rule 15). The guard has three
parts, and each one closes a gap the others leave open:

1. **Classify every resolved address.** :func:`classify_ip` sorts an address
   into ``global``, ``private``, ``sensitive`` or ``never``, after unwrapping
   the IPv6 forms that embed an IPv4 address (IPv4-mapped, 6to4, Teredo,
   NAT64). Unwrapping matters because ``::ffff:127.0.0.1`` is loopback with a
   different spelling. Python's ``is_global`` is not enough on its own: it
   reports multicast ``224.0.0.0/4`` and the NAT64 prefix as global.
2. **Check every record, then pin one.** :func:`resolve_destination` resolves
   all A and AAAA records and refuses the URL if *any* of them is not
   admitted, because a resolver may hand a later connection any one of them.
   :func:`guarded_post` then connects to the address it checked, not to the
   name, so a second lookup at connect time cannot return a different answer
   (DNS rebinding). TLS still verifies the certificate against the hostname:
   SNI and ``assert_hostname`` are set to the name while the socket goes to
   the pinned address.
3. **Never follow anything.** No redirects, no retries, no proxy environment
   variables (urllib3 reads none), a bounded timeout, and only the status line
   is read. A 3xx is reported as an HTTP error, not followed.

What the operator can open
--------------------------
``WEBHOOK_ALLOWED_PRIVATE_TARGETS`` (see :func:`parse_allowlist`) admits
specific LAN destinations such as a self-hosted n8n. Hostname and CIDR entries
admit ``private`` addresses (RFC 1918, CGNAT, IPv6 ULA). ``sensitive``
addresses (loopback, link-local, known cloud metadata endpoints) are admitted
only by an exact single-address entry, so a broad ``10.0.0.0/8`` entry cannot
open the metadata service by accident. ``never`` addresses are never admitted.

Error codes are deliberately coarse
-----------------------------------
The caller sees one of a handful of fixed codes, never exception text: an
exception message from a failed connection carries the host and sometimes the
path, which for a Slack or Zapier URL is the credential. At save time every
"you may not send there" outcome is the single code ``url_not_allowed``, so
the save endpoint does not tell a caller which internal names resolve.
"""

from __future__ import annotations

import dataclasses
import ipaddress
import socket
import ssl
import urllib.parse

import urllib3
from urllib3.exceptions import (
    ConnectTimeoutError,
    HTTPError as Urllib3HTTPError,
    NewConnectionError,
    ReadTimeoutError,
    SSLError as Urllib3SSLError,
)

# ─── Error codes (public: they reach the API as `code` / `last_error_code`) ───

INVALID_URL = "invalid_url"
URL_NOT_ALLOWED = "url_not_allowed"
CONNECTION_FAILED = "connection_failed"
TLS_ERROR = "tls_error"
TIMEOUT = "timeout"
HTTP_ERROR = "http_error"

MAX_URL_LENGTH = 2048

# ─── Address classification ──────────────────────────────────────────────────

GLOBAL = "global"
PRIVATE = "private"
SENSITIVE = "sensitive"
NEVER = "never"

_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",  # CGNAT (RFC 6598)
        "fc00::/7",  # IPv6 unique local (RFC 4193)
    )
)

_SENSITIVE_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in (
        "127.0.0.0/8",
        "::1/128",
        "169.254.0.0/16",
        "fe80::/10",
    )
)

# Cloud metadata and host-agent endpoints. Some sit inside a private or even a
# global range (Alibaba's is CGNAT, AWS's IPv6 one is ULA, Azure's is global),
# so they are matched by exact address before the range checks run.
_METADATA_ADDRESSES = frozenset(
    ipaddress.ip_address(a)
    for a in (
        "169.254.169.254",  # AWS, GCP, Azure, OCI, DigitalOcean
        "169.254.170.2",  # AWS ECS task metadata
        "fd00:ec2::254",  # AWS IPv6 metadata
        "100.100.100.200",  # Alibaba Cloud
        "168.63.129.16",  # Azure WireServer
    )
)

_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")
# RFC 8215 local-use NAT64. Its embedding of the IPv4 address depends on the
# operator's prefix length, so it cannot be unwrapped reliably: refuse it.
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")


def _unwrap(ip: ipaddress.IPv4Address | ipaddress.IPv6Address):
    """Return the IPv4 addresses embedded in *ip*, or ``None`` if it embeds none.

    Teredo embeds two (server and client); both must pass.
    """
    if ip.version != 6:
        return None
    if ip.ipv4_mapped is not None:
        return [ip.ipv4_mapped]
    if ip.sixtofour is not None:
        return [ip.sixtofour]
    if ip.teredo is not None:
        return list(ip.teredo)
    if ip in _NAT64_WELL_KNOWN:
        return [ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)]
    return None


_RANK = {GLOBAL: 0, PRIVATE: 1, SENSITIVE: 2, NEVER: 3}


def classify_ip(value) -> str:
    """Return ``global``, ``private``, ``sensitive`` or ``never`` for an address.

    *value* is a string or an ``ipaddress`` object. An unparsable value is
    ``never``. An address that embeds IPv4 addresses gets the most restrictive
    class of the addresses it embeds, and never less restrictive than its own.
    """
    try:
        ip = value if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address)) else ipaddress.ip_address(str(value).split("%", 1)[0])
    except ValueError:
        return NEVER
    if ip in _NAT64_LOCAL:
        return NEVER
    embedded = _unwrap(ip)
    if embedded is not None:
        return max((_classify_plain(e) for e in embedded), key=_RANK.__getitem__)
    return _classify_plain(ip)


def _classify_plain(ip) -> str:
    if ip in _METADATA_ADDRESSES:
        return SENSITIVE
    if any(ip in net for net in _SENSITIVE_NETWORKS):
        return SENSITIVE
    if any(ip in net for net in _PRIVATE_NETWORKS):
        return PRIVATE
    if ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return NEVER
    if ip.is_global:
        return GLOBAL
    # Everything left is special-purpose and not globally reachable:
    # 0.0.0.0/8, documentation, benchmarking, IETF protocol assignments,
    # discard-only, and the like. None of it is a legitimate webhook target.
    return NEVER


# ─── Operator allowlist ──────────────────────────────────────────────────────


class AllowlistError(ValueError):
    """An entry in ``WEBHOOK_ALLOWED_PRIVATE_TARGETS`` is unusable."""


@dataclasses.dataclass(frozen=True)
class Allowlist:
    hosts: frozenset = frozenset()
    networks: tuple = ()

    def __bool__(self):
        return bool(self.hosts or self.networks)


EMPTY_ALLOWLIST = Allowlist()


def parse_allowlist(raw) -> Allowlist:
    """Parse ``WEBHOOK_ALLOWED_PRIVATE_TARGETS`` into an :class:`Allowlist`.

    *raw* is a comma-separated string (or an iterable of entries). Each entry
    is an exact hostname, an IP address, or a CIDR. Raises
    :class:`AllowlistError` for an entry that would open something it must
    not: a ``/0``, a range that contains any address outside the private and
    sensitive ranges (a global range adds nothing and widens the meaning of
    "allowlisted" for ``http``), or a ``never`` address. ``visiban.checks``
    turns that into a system check error so a bad value fails at startup.
    """
    if raw is None:
        return EMPTY_ALLOWLIST
    entries = raw.split(",") if isinstance(raw, str) else list(raw)
    hosts = set()
    networks = []
    for entry in entries:
        entry = str(entry).strip()
        if not entry:
            continue
        candidate = entry[1:-1] if entry.startswith("[") and entry.endswith("]") else entry
        try:
            net = ipaddress.ip_network(candidate, strict=False)
        except ValueError:
            net = None
        if net is not None:
            if net.prefixlen == 0:
                raise AllowlistError(f"{entry!r}: a /0 entry admits everything")
            single = net.prefixlen == net.max_prefixlen
            if single:
                if classify_ip(net.network_address) not in (PRIVATE, SENSITIVE):
                    raise AllowlistError(
                        f"{entry!r}: only private, loopback, link-local or metadata "
                        "addresses can be allowlisted"
                    )
            elif not any(net.subnet_of(r) for r in _PRIVATE_NETWORKS + _SENSITIVE_NETWORKS if r.version == net.version):
                raise AllowlistError(
                    f"{entry!r}: the range is not entirely inside a private, loopback "
                    "or link-local range"
                )
            networks.append(net)
            continue
        host = _normalize_host(entry)
        if host is None:
            raise AllowlistError(f"{entry!r}: not a hostname, IP address or CIDR")
        hosts.add(host)
    return Allowlist(hosts=frozenset(hosts), networks=tuple(networks))


def _normalize_host(host: str) -> str | None:
    host = host.strip().rstrip(".").lower()
    if not host or len(host) > 253:
        return None
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    labels = ascii_host.split(".")
    for label in labels:
        if not label or len(label) > 63:
            return None
        if not all(c.isalnum() or c in "-_" for c in label):
            return None
    return ascii_host


def _admitted(ip, category: str, host: str, allowlist: Allowlist) -> bool:
    if category == GLOBAL:
        return True
    if category == NEVER:
        return False
    if category == SENSITIVE:
        # Only an exact single-address entry opens loopback, link-local or a
        # metadata address. A hostname or a range never does.
        return any(
            net.prefixlen == net.max_prefixlen and ip in net for net in allowlist.networks
        )
    # PRIVATE
    if host in allowlist.hosts:
        return True
    return any(ip in net for net in allowlist.networks if net.version == ip.version)


# ─── URL validation and resolution ───────────────────────────────────────────


class EgressError(Exception):
    """A destination was refused or a delivery failed.

    ``code`` is one of the module constants and is the ONLY thing a caller may
    store or return. The exception message is fixed text, never derived from
    the URL or an underlying exception.
    """

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclasses.dataclass(frozen=True)
class Destination:
    scheme: str
    host: str  # normalized hostname, or the IP literal without brackets
    port: int
    target: str  # path + query, what goes on the request line
    is_ip_literal: bool


def parse_url(url) -> Destination:
    """Validate the syntax of a webhook URL. Raises ``EgressError(invalid_url)``.

    Refuses: anything but ``https`` / ``http``, userinfo, a missing or
    malformed host, a bad port, whitespace or control characters, and URLs
    longer than :data:`MAX_URL_LENGTH`. The fragment is dropped (it is never
    sent). Whether ``http`` or a low port is acceptable depends on the
    allowlist and is decided in :func:`resolve_destination`.
    """
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise EgressError(INVALID_URL)
    if any(c.isspace() or ord(c) < 0x20 or ord(c) == 0x7F for c in url):
        raise EgressError(INVALID_URL)
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        raise EgressError(INVALID_URL) from None
    scheme = parts.scheme.lower()
    if scheme not in ("https", "http"):
        raise EgressError(INVALID_URL)
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise EgressError(INVALID_URL)
    raw_host = parts.hostname
    # A zone id ("fe80::1%eth0") names a local interface; never valid here.
    if not raw_host or "%" in raw_host:
        raise EgressError(INVALID_URL)
    try:
        ipaddress.ip_address(raw_host)
        host, is_ip = raw_host, True
    except ValueError:
        if ":" in raw_host:
            raise EgressError(INVALID_URL) from None
        host, is_ip = _normalize_host(raw_host), False
        if host is None:
            raise EgressError(INVALID_URL)
    if port is None:
        port = 443 if scheme == "https" else 80
    if not 1 <= port <= 65535:
        raise EgressError(INVALID_URL)
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    return Destination(scheme=scheme, host=host, port=port, target=target, is_ip_literal=is_ip)


def _resolve(host: str, port: int) -> list:
    """Every address *host* resolves to. Patched in tests; raises OSError."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        if ip not in seen:
            seen.append(ip)
    return seen


def resolve_destination(url, allowlist: Allowlist = EMPTY_ALLOWLIST):
    """Validate *url* and resolve it to admitted addresses.

    Returns ``(destination, addresses)``. Raises ``EgressError(invalid_url)``
    for a syntax problem and ``EgressError(url_not_allowed)`` for every other
    refusal: the name does not resolve, any record is not admitted, ``http``
    to a destination that is not allowlisted, or a port below 1024 other than
    443 to a destination that is not allowlisted.
    """
    dest = parse_url(url)
    if dest.is_ip_literal:
        addresses = [ipaddress.ip_address(dest.host)]
    else:
        try:
            addresses = _resolve(dest.host, dest.port)
        except (OSError, UnicodeError, ValueError):
            raise EgressError(URL_NOT_ALLOWED) from None
    if not addresses:
        raise EgressError(URL_NOT_ALLOWED)
    categories = [classify_ip(ip) for ip in addresses]
    for ip, category in zip(addresses, categories):
        if not _admitted(ip, category, dest.host, allowlist):
            raise EgressError(URL_NOT_ALLOWED)
    # "Allowlisted" for the http and port rules: the hostname is listed, or
    # every address is a non-global one that a listed entry admitted.
    allowlisted = dest.host in allowlist.hosts or all(c != GLOBAL for c in categories)
    if dest.scheme == "http" and not allowlisted:
        raise EgressError(URL_NOT_ALLOWED)
    if dest.port < 1024 and dest.port != 443 and not allowlisted:
        raise EgressError(URL_NOT_ALLOWED)
    return dest, addresses


def display_url(url) -> str:
    """``scheme://host/…`` for a URL, with no path, query or port.

    Slack and Zapier URLs carry their credential in the path, so after creation
    the API only ever shows this form. An unparsable value yields ``""``.
    """
    try:
        dest = parse_url(url)
    except EgressError:
        return ""
    host = f"[{dest.host}]" if ":" in dest.host else dest.host
    return f"{dest.scheme}://{host}/…"


# ─── The one outbound call ───────────────────────────────────────────────────


def _ca_certs():
    try:
        import certifi
    except ImportError:  # pragma: no cover - certifi ships with requests
        return None
    return certifi.where()


def guarded_post(
    url,
    body: bytes,
    headers: dict,
    *,
    allowlist: Allowlist = EMPTY_ALLOWLIST,
    connect_timeout: float = 3.0,
    total_timeout: float = 10.0,
    ca_certs: str | None = None,
) -> int:
    """POST *body* to *url* and return the HTTP status code.

    The destination is re-validated and re-resolved on every call, then the
    connection is pinned to the first admitted address. Raises
    :class:`EgressError` with ``connection_failed`` (refused destination,
    failed lookup, refused or reset connection), ``tls_error`` or ``timeout``.
    Any status code is returned as-is, 3xx included; the caller decides what
    counts as success. The response body is never read.

    *ca_certs* overrides the CA bundle; it exists for the TLS pinning test.
    """
    try:
        dest, addresses = resolve_destination(url, allowlist)
    except EgressError:
        raise EgressError(CONNECTION_FAILED) from None
    ip = str(addresses[0])
    default_port = 443 if dest.scheme == "https" else 80
    host_header = f"[{dest.host}]" if ":" in dest.host else dest.host
    if dest.port != default_port:
        host_header = f"{host_header}:{dest.port}"
    send_headers = {k: v for k, v in headers.items() if k.lower() != "host"}
    send_headers["Host"] = host_header
    timeout = urllib3.Timeout(connect=connect_timeout, total=total_timeout)
    if dest.scheme == "https":
        pool = urllib3.HTTPSConnectionPool(
            ip,
            port=dest.port,
            timeout=timeout,
            retries=False,
            maxsize=1,
            cert_reqs=ssl.CERT_REQUIRED,
            ca_certs=ca_certs or _ca_certs(),
            # SNI and certificate verification use the NAME, while the socket
            # goes to the address checked above (DNS rebinding defense).
            server_hostname=None if dest.is_ip_literal else dest.host,
            assert_hostname=dest.host,
        )
    else:
        pool = urllib3.HTTPConnectionPool(
            ip, port=dest.port, timeout=timeout, retries=False, maxsize=1,
        )
    try:
        response = pool.urlopen(
            "POST",
            dest.target,
            body=body,
            headers=send_headers,
            retries=False,
            redirect=False,
            preload_content=False,
            assert_same_host=False,
        )
        status = int(response.status)
        response.close()
        return status
    except Urllib3SSLError:
        raise EgressError(TLS_ERROR) from None
    except NewConnectionError:
        # Checked before the timeout classes: urllib3 makes it a subclass of
        # ConnectTimeoutError, but a refused connection is not a timeout.
        raise EgressError(CONNECTION_FAILED) from None
    except (ConnectTimeoutError, ReadTimeoutError, socket.timeout, TimeoutError):
        raise EgressError(TIMEOUT) from None
    except (Urllib3HTTPError, OSError, ValueError):
        raise EgressError(CONNECTION_FAILED) from None
    finally:
        pool.close()
