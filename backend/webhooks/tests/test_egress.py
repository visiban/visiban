"""SSRF guard for user-supplied outbound destinations (#863, visiban/egress.py).

Covers the classifier (including the IPv6 forms that embed IPv4), the operator
allowlist, URL syntax, resolution of every record, the http / low-port rules,
DNS rebinding, redirects, a real TLS handshake proving the connection is pinned
to the checked address while SNI and certificate verification use the
hostname, and a structural test that no other outbound call exists in the
webhooks app.
"""

import datetime
import ipaddress
import pathlib
import re
import socket
import ssl
import tempfile
import threading
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from django.test import SimpleTestCase

from visiban import egress
from visiban.egress import (
    GLOBAL,
    NEVER,
    PRIVATE,
    SENSITIVE,
    AllowlistError,
    EgressError,
    classify_ip,
    parse_allowlist,
    parse_url,
    resolve_destination,
)

PUBLIC = ipaddress.ip_address("93.184.216.34")


def _resolving(*addrs):
    return patch.object(egress, "_resolve", return_value=[ipaddress.ip_address(a) for a in addrs])


class ClassifyIpTests(SimpleTestCase):
    TABLE = [
        # global
        ("8.8.8.8", GLOBAL),
        ("93.184.216.34", GLOBAL),
        ("2606:4700:4700::1111", GLOBAL),
        # private: RFC 1918, CGNAT, ULA
        ("10.1.2.3", PRIVATE),
        ("172.16.0.1", PRIVATE),
        ("192.168.1.10", PRIVATE),
        ("100.64.0.1", PRIVATE),
        ("fd12:3456::1", PRIVATE),
        # sensitive: loopback, link-local, metadata (including ones inside
        # private and global ranges)
        ("127.0.0.1", SENSITIVE),
        ("127.255.0.9", SENSITIVE),
        ("::1", SENSITIVE),
        ("169.254.10.10", SENSITIVE),
        ("169.254.169.254", SENSITIVE),
        ("fe80::1", SENSITIVE),
        ("fd00:ec2::254", SENSITIVE),
        ("100.100.100.200", SENSITIVE),
        ("168.63.129.16", SENSITIVE),
        # never: unspecified, this-network, multicast (is_global True in
        # Python!), reserved, broadcast, documentation, benchmarking
        ("0.0.0.0", NEVER),
        ("0.1.2.3", NEVER),
        ("224.0.0.1", NEVER),
        ("239.1.1.1", NEVER),
        ("ff02::1", NEVER),
        ("240.0.0.1", NEVER),
        ("255.255.255.255", NEVER),
        ("192.0.2.1", NEVER),
        ("198.18.0.1", NEVER),
        ("::", NEVER),
        ("not-an-ip", NEVER),
        # IPv4-mapped IPv6
        ("::ffff:127.0.0.1", SENSITIVE),
        ("::ffff:10.0.0.1", PRIVATE),
        ("::ffff:169.254.169.254", SENSITIVE),
        ("::ffff:8.8.8.8", GLOBAL),
        # 6to4 (2002:WWXX:YYZZ::/48 embeds WW.XX.YY.ZZ)
        ("2002:7f00:0001::1", SENSITIVE),
        ("2002:0a00:0001::1", PRIVATE),
        ("2002:0808:0808::1", GLOBAL),
        # Teredo: server and (inverted) client are both checked
        # (RFC 4380's example: its client is 192.0.2.45, documentation space)
        ("2001:0:4136:e378:8000:63bf:3fff:fdd2", NEVER),
        ("2001:0:7f00:1:0:0:f5ff:fffe", SENSITIVE),
        # NAT64 well-known prefix embeds the last 32 bits
        ("64:ff9b::7f00:1", SENSITIVE),
        ("64:ff9b::a9fe:a9fe", SENSITIVE),
        ("64:ff9b::a00:1", PRIVATE),
        ("64:ff9b::808:808", GLOBAL),
        # NAT64 local-use prefix cannot be unwrapped reliably: refused
        ("64:ff9b:1::a00:1", NEVER),
    ]

    def test_classifier_table(self):
        for value, expected in self.TABLE:
            with self.subTest(value=value):
                self.assertEqual(classify_ip(value), expected)

    def test_zone_id_is_ignored(self):
        self.assertEqual(classify_ip("fe80::1%eth0"), SENSITIVE)


class ParseAllowlistTests(SimpleTestCase):
    def test_empty(self):
        self.assertFalse(parse_allowlist(""))
        self.assertFalse(parse_allowlist(None))

    def test_hosts_ips_and_cidrs(self):
        al = parse_allowlist(" n8n.lan , 10.0.0.0/8, 192.168.1.5, fd00::/8,127.0.0.1 ")
        self.assertEqual(al.hosts, frozenset({"n8n.lan"}))
        self.assertIn(ipaddress.ip_network("10.0.0.0/8"), al.networks)
        self.assertIn(ipaddress.ip_network("127.0.0.1/32"), al.networks)

    def test_refused_entries(self):
        for entry in [
            "0.0.0.0/0",
            "::/0",
            "8.8.8.0/24",  # global range
            "8.8.8.8",  # global single address
            "10.0.0.0/7",  # spills into global 11/8
            "224.0.0.1",  # multicast
            "0.0.0.0",  # never
            "192.0.2.0/24",  # documentation
            "bad host!",
        ]:
            with self.subTest(entry=entry), self.assertRaises(AllowlistError):
                parse_allowlist(entry)


class ParseUrlTests(SimpleTestCase):
    def test_accepts(self):
        dest = parse_url("https://Hooks.Example.com/a/b?x=1#frag")
        self.assertEqual((dest.scheme, dest.host, dest.port, dest.target), ("https", "hooks.example.com", 443, "/a/b?x=1"))
        self.assertEqual(parse_url("http://n8n.lan:5678/webhook").port, 5678)
        self.assertEqual(parse_url("https://[2606:4700::1]/x").host, "2606:4700::1")

    def test_refuses(self):
        for url in [
            "",
            "ftp://example.com/",
            "file:///etc/passwd",
            "gopher://example.com",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "https:///nohost",
            "https://example.com:0/",
            "https://example.com:99999/",
            "https://exa mple.com/",
            "https://example.com/\nX-Injected: 1",
            "https://bad_host!.com/",
            "https://[fe80::1%25eth0]/",
            "https://" + "a" * 2100 + ".com/",
            None,
            123,
        ]:
            with self.subTest(url=url), self.assertRaises(EgressError) as ctx:
                parse_url(url)
            self.assertEqual(ctx.exception.code, egress.INVALID_URL)


class ResolveDestinationTests(SimpleTestCase):
    def _refused(self, url, allowlist=egress.EMPTY_ALLOWLIST):
        with self.assertRaises(EgressError) as ctx:
            resolve_destination(url, allowlist)
        return ctx.exception.code

    def test_public_https_ok(self):
        with _resolving("93.184.216.34"):
            dest, addrs = resolve_destination("https://hooks.example.com/x")
        self.assertEqual(addrs, [PUBLIC])

    def test_every_record_is_checked(self):
        # One bad record among several A records refuses the whole URL.
        with _resolving("93.184.216.34", "10.0.0.5"):
            self.assertEqual(self._refused("https://mixed.example.com/"), egress.URL_NOT_ALLOWED)
        with _resolving("93.184.216.34", "::ffff:127.0.0.1"):
            self.assertEqual(self._refused("https://mixed.example.com/"), egress.URL_NOT_ALLOWED)

    def test_private_loopback_metadata_refused_by_default(self):
        for addr in ["10.0.0.5", "127.0.0.1", "169.254.169.254", "fd00:ec2::254", "0.0.0.0"]:
            with self.subTest(addr=addr), _resolving(addr):
                self.assertEqual(self._refused("https://internal.example.com/"), egress.URL_NOT_ALLOWED)

    def test_ip_literals_are_classified_without_dns(self):
        with patch.object(egress, "_resolve", side_effect=AssertionError("no DNS for a literal")):
            self.assertEqual(self._refused("https://127.0.0.1/"), egress.URL_NOT_ALLOWED)
            self.assertEqual(self._refused("https://[::ffff:169.254.169.254]/"), egress.URL_NOT_ALLOWED)
            resolve_destination("https://93.184.216.34/")

    def test_dns_failure_is_the_same_neutral_code(self):
        with patch.object(egress, "_resolve", side_effect=socket.gaierror("nope")):
            self.assertEqual(self._refused("https://nx.example.com/"), egress.URL_NOT_ALLOWED)
        with _resolving():
            self.assertEqual(self._refused("https://empty.example.com/"), egress.URL_NOT_ALLOWED)

    def test_hostname_entry_admits_private_but_not_loopback(self):
        al = parse_allowlist("n8n.lan")
        with _resolving("192.168.1.20"):
            resolve_destination("https://n8n.lan/hook", al)
        with _resolving("127.0.0.1"):
            self.assertEqual(self._refused("https://n8n.lan/hook", al), egress.URL_NOT_ALLOWED)
        # Another host on the same private address is not admitted by the name.
        with _resolving("192.168.1.20"):
            self.assertEqual(self._refused("https://other.lan/hook", al), egress.URL_NOT_ALLOWED)

    def test_cidr_entry_admits_private_but_not_metadata(self):
        al = parse_allowlist("100.64.0.0/10, 169.254.0.0/16")
        with _resolving("100.64.3.3"):
            resolve_destination("https://cgnat.example/", al)
        # A range never opens a sensitive address, even one inside it.
        with _resolving("100.100.100.200"):
            self.assertEqual(self._refused("https://meta.example/", al), egress.URL_NOT_ALLOWED)
        with _resolving("169.254.169.254"):
            self.assertEqual(self._refused("https://meta.example/", al), egress.URL_NOT_ALLOWED)

    def test_loopback_needs_an_exact_entry(self):
        with _resolving("127.0.0.1"):
            self.assertEqual(self._refused("https://local.test/", parse_allowlist("127.0.0.0/8")), egress.URL_NOT_ALLOWED)
            resolve_destination("https://local.test/", parse_allowlist("127.0.0.1/32"))
            resolve_destination("https://local.test/", parse_allowlist("127.0.0.1"))
        with _resolving("::1"):
            resolve_destination("https://local.test/", parse_allowlist("::1/128"))

    def test_http_only_for_allowlisted_targets(self):
        with _resolving("93.184.216.34"):
            self.assertEqual(self._refused("http://hooks.example.com/"), egress.URL_NOT_ALLOWED)
        with _resolving("192.168.1.20"):
            resolve_destination("http://n8n.lan:5678/hook", parse_allowlist("n8n.lan"))
            resolve_destination("http://n8n.lan/hook", parse_allowlist("192.168.0.0/16"))

    def test_low_ports_other_than_443_need_an_allowlisted_target(self):
        with _resolving("93.184.216.34"):
            self.assertEqual(self._refused("https://hooks.example.com:22/"), egress.URL_NOT_ALLOWED)
            self.assertEqual(self._refused("https://hooks.example.com:80/"), egress.URL_NOT_ALLOWED)
            resolve_destination("https://hooks.example.com:8443/")
            resolve_destination("https://hooks.example.com:443/")
        with _resolving("192.168.1.20"):
            resolve_destination("https://n8n.lan:80/", parse_allowlist("n8n.lan"))


class DisplayUrlTests(SimpleTestCase):
    def test_strips_path_query_and_port(self):
        self.assertEqual(egress.display_url("https://hooks.slack.com/services/T0/B0/secret?x=1"), "https://hooks.slack.com/…")
        self.assertEqual(egress.display_url("http://n8n.lan:5678/webhook/abc"), "http://n8n.lan/…")
        self.assertEqual(egress.display_url("garbage"), "")


# ─── Live sockets: pinning, TLS, redirects, rebinding ─────────────────────────


def _self_signed(hostname):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    tmp = tempfile.mkdtemp(prefix="visiban-863-")
    cert_path = pathlib.Path(tmp, "cert.pem")
    key_path = pathlib.Path(tmp, "key.pem")
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return str(cert_path), str(key_path)


class _OneShotServer:
    """Accepts connections on 127.0.0.1 and answers each with *status_line*.

    Records the SNI name, the request head and the number of connections.
    """

    def __init__(self, status_line=b"HTTP/1.1 204 No Content", tls=None, extra_headers=b""):
        self.status_line = status_line
        self.extra_headers = extra_headers
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.sock.settimeout(5)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self.sni = []
        self.heads = []
        self.ctx = None
        if tls:
            cert, key = tls
            self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.ctx.load_cert_chain(cert, key)
            self.ctx.sni_callback = lambda s, name, c: self.sni.append(name)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            try:
                if self.ctx is not None:
                    conn = self.ctx.wrap_socket(conn, server_side=True)
                conn.settimeout(5)
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                self.heads.append(data.split(b"\r\n\r\n", 1)[0].decode("latin-1"))
                conn.sendall(self.status_line + b"\r\nContent-Length: 0\r\n" + self.extra_headers + b"Connection: close\r\n\r\n")
            except (OSError, ssl.SSLError):
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self):
        self.sock.close()


class PinnedConnectionTests(SimpleTestCase):
    """The socket goes to the checked address; TLS verifies the hostname."""

    LOOPBACK = parse_allowlist("127.0.0.1/32")

    def test_tls_pins_ip_and_verifies_the_hostname(self):
        cert, key = _self_signed("webhook.test")
        server = _OneShotServer(tls=(cert, key))
        self.addCleanup(server.close)
        with _resolving("127.0.0.1"):
            status = egress.guarded_post(
                f"https://webhook.test:{server.port}/hook?a=1",
                b"{}",
                {"Content-Type": "application/json"},
                allowlist=self.LOOPBACK,
                ca_certs=cert,
            )
        self.assertEqual(status, 204)
        self.assertEqual(server.sni, ["webhook.test"])
        self.assertIn("POST /hook?a=1 HTTP/1.1", server.heads[0])
        self.assertIn(f"Host: webhook.test:{server.port}", server.heads[0])

    def test_certificate_for_another_name_is_refused(self):
        cert, key = _self_signed("other.test")
        server = _OneShotServer(tls=(cert, key))
        self.addCleanup(server.close)
        with _resolving("127.0.0.1"), self.assertRaises(EgressError) as ctx:
            egress.guarded_post(
                f"https://webhook.test:{server.port}/", b"{}", {}, allowlist=self.LOOPBACK, ca_certs=cert
            )
        self.assertEqual(ctx.exception.code, egress.TLS_ERROR)

    def test_untrusted_certificate_is_refused(self):
        cert, key = _self_signed("webhook.test")
        server = _OneShotServer(tls=(cert, key))
        self.addCleanup(server.close)
        with _resolving("127.0.0.1"), self.assertRaises(EgressError) as ctx:
            egress.guarded_post(f"https://webhook.test:{server.port}/", b"{}", {}, allowlist=self.LOOPBACK)
        self.assertEqual(ctx.exception.code, egress.TLS_ERROR)

    def test_redirects_are_not_followed(self):
        server = _OneShotServer(
            status_line=b"HTTP/1.1 302 Found",
            extra_headers=b"Location: http://169.254.169.254/latest/meta-data/\r\n",
        )
        self.addCleanup(server.close)
        with _resolving("127.0.0.1"):
            status = egress.guarded_post(
                f"http://hook.test:{server.port}/", b"{}", {}, allowlist=self.LOOPBACK
            )
        self.assertEqual(status, 302)
        self.assertEqual(server.connections, 1)

    def test_connection_refused_is_connection_failed(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with _resolving("127.0.0.1"), self.assertRaises(EgressError) as ctx:
            egress.guarded_post(f"http://hook.test:{port}/", b"{}", {}, allowlist=self.LOOPBACK)
        self.assertEqual(ctx.exception.code, egress.CONNECTION_FAILED)

    def test_dns_rebinding_public_at_save_private_at_connect(self):
        with _resolving("93.184.216.34"):
            resolve_destination("https://rebind.example.com/")  # save-time check passes
        with _resolving("127.0.0.1"), patch.object(
            egress.urllib3, "HTTPSConnectionPool", side_effect=AssertionError("must not connect")
        ), self.assertRaises(EgressError) as ctx:
            egress.guarded_post("https://rebind.example.com/", b"{}", {})
        self.assertEqual(ctx.exception.code, egress.CONNECTION_FAILED)

    def test_connects_to_the_checked_address_not_the_name(self):
        captured = {}

        class FakePool:
            def __init__(self, host, **kw):
                captured["host"] = host
                captured.update(kw)

            def urlopen(self, *a, **kw):
                captured["urlopen"] = kw

                class R:
                    status = 200

                    def close(self):
                        pass

                return R()

            def close(self):
                pass

        with _resolving("93.184.216.34"), patch.object(egress.urllib3, "HTTPSConnectionPool", FakePool):
            egress.guarded_post("https://hooks.example.com/x", b"{}", {"Host": "evil"})
        self.assertEqual(captured["host"], "93.184.216.34")
        self.assertEqual(captured["server_hostname"], "hooks.example.com")
        self.assertEqual(captured["assert_hostname"], "hooks.example.com")
        self.assertEqual(captured["cert_reqs"], ssl.CERT_REQUIRED)
        self.assertIs(captured["retries"], False)
        self.assertIs(captured["urlopen"]["redirect"], False)
        self.assertIs(captured["urlopen"]["preload_content"], False)
        # A caller-supplied Host header never overrides the checked name.
        self.assertEqual(captured["urlopen"]["headers"]["Host"], "hooks.example.com")


class NoOtherOutboundCallTests(SimpleTestCase):
    """Every outbound request in the webhooks app goes through visiban.egress."""

    FORBIDDEN = re.compile(
        r"\b(requests\.|urllib3|http\.client|urllib\.request|urlopen|httpx|aiohttp|socket\.)"
    )

    def test_webhooks_app_makes_no_direct_network_call(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        offenders = []
        for path in root.rglob("*.py"):
            if "tests" in path.parts or "migrations" in path.parts:
                continue
            for lineno, line in enumerate(path.read_text().splitlines(), 1):
                code = line.split("#", 1)[0]
                if self.FORBIDDEN.search(code):
                    offenders.append(f"{path.relative_to(root)}:{lineno}: {line.strip()}")
        self.assertEqual(offenders, [], "use visiban.egress.guarded_post")

    def test_egress_has_exactly_one_request_call(self):
        source = pathlib.Path(egress.__file__).read_text()
        self.assertEqual(len(re.findall(r"\.urlopen\(", source)), 1)
        self.assertNotIn("requests", re.sub(r'""".*?"""', "", source, flags=re.S).split("import urllib3")[0])
