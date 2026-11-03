from __future__ import annotations

import unittest

from visiban_client import verify_signature
from visiban_client.webhooks import MAX_SIGNATURE_VALUES

from .helpers import load_fixtures

SIG = load_fixtures()["signature"]


class SignatureTests(unittest.TestCase):
    def test_documented_vector(self):
        self.assertTrue(
            verify_signature(
                SIG["secret"],
                {"X-Visiban-Timestamp": SIG["timestamp"], "X-Visiban-Signature": SIG["signature"]},
                SIG["body"].encode(),
                now=1700000000,
            )
        )

    def test_shared_cases(self):
        for case in SIG["cases"]:
            with self.subTest(case["name"]):
                got = verify_signature(
                    case["secret"], case["headers"], case["body"].encode(), now=case["now"]
                )
                self.assertEqual(got, case["expected"])

    def test_refuses_a_signature_header_over_the_value_cap(self):
        signature = ",".join(["v2=x"] * MAX_SIGNATURE_VALUES + [SIG["signature"]])
        h = {"X-Visiban-Timestamp": SIG["timestamp"], "X-Visiban-Signature": signature}
        self.assertFalse(verify_signature(SIG["secret"], h, SIG["body"].encode(), now=1700000000))

    def test_rejects_str_body(self):
        with self.assertRaises(TypeError):
            verify_signature("s", {}, "not bytes")  # type: ignore[arg-type]

    def test_empty_secret_and_bad_tolerance_raise(self):
        h = {"X-Visiban-Timestamp": SIG["timestamp"], "X-Visiban-Signature": SIG["signature"]}
        with self.assertRaises(ValueError):
            verify_signature("", h, b"x")
        for tol in (float("nan"), float("inf"), -1):
            with self.subTest(tol), self.assertRaises(ValueError):
                verify_signature("s", h, b"x", tolerance=tol)

    def test_huge_timestamp_returns_false(self):
        h = {"X-Visiban-Timestamp": "9" * 5000, "X-Visiban-Signature": "v1=x"}
        self.assertFalse(verify_signature("s", h, b"x"))

    def test_bytes_secret_and_default_clock(self):
        # Default clock: a 2023 timestamp is far outside the tolerance.
        self.assertFalse(
            verify_signature(
                b"whsec_test",
                {"X-Visiban-Timestamp": SIG["timestamp"], "X-Visiban-Signature": SIG["signature"]},
                SIG["body"].encode(),
            )
        )

    def test_mixed_case_mapping(self):
        headers = {"x-VISIBAN-timestamp": SIG["timestamp"], "X-VISIBAN-SIGNATURE": SIG["signature"]}
        self.assertTrue(verify_signature(SIG["secret"], headers, SIG["body"].encode(), now=1700000000))


if __name__ == "__main__":
    unittest.main()
