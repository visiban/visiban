"""Shared assertion for board-import error bodies (#1903).

Every import error body is exactly ``{detail, code}``. The message tests pin
``detail``; this checks the rest of the contract for them, so a site that
drops ``code`` (or grows another key) fails wherever its message is tested.
The specific code per site is pinned in ``test_import_envelope_1903``.
"""

from boards.import_errors import ImportErrorCode


def assert_import_error(testcase, resp, detail, code=None):
    body = resp.json()
    testcase.assertEqual(set(body), {"detail", "code"}, body)
    testcase.assertEqual(body["detail"], detail)
    testcase.assertIn(body["code"], ImportErrorCode.ALL, body)
    if code is not None:
        testcase.assertEqual(body["code"], code, body)
