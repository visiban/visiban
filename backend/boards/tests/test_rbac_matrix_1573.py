"""Generated role x endpoint authorization matrix at the API level (#1573).

Existing authorization tests (``test_rbac.py``, ``test_rbac_boundaries.py``,
``test_explicit_permissions.py``) check one case at a time, and ``rbac-coverage``
(#1143) is a static check. Nothing walked *every* board-scoped write endpoint for
*every* role, so a new route could ship with a role gap no test exercised. This
does, in three steps:

1. **Enumerate** every POST/PUT/PATCH/DELETE under ``/api/v1/boards/`` from the
   generated OpenAPI schema (never a hand-kept list), so a new route shows up
   here by itself.
2. **Require an entry** in ``EXPECTED`` for each one. ``test_every_write_route_has_an_expected_outcome``
   fails, naming the route, when a route is missing or when an entry no longer
   matches a route. The entry is a policy name from ``rbac_matrix.POLICIES``, or
   ``"skip:<reason>"`` for a route the harness cannot address yet.
3. **Run** each non-skipped route as the seven principals (non-member, viewer,
   collaborator, member, board admin, site admin, access-all-content account)
   and compare the outcome to the policy. A denied principal must also leave
   every audited row count unchanged (the #1402 idea, applied here).

How an outcome is classified: the request carries an empty JSON body (the
``needed`` route gets the one field it reads first), so an admitted principal
reaches the handler and sees a 400, 404, or 2xx; a denied one sees 401 or 403.
A non-member also sees 404 (the board's existence is not disclosed). The matrix
checks the permission layer, not the handler's validation.

Ownership: members and collaborators may edit only content they created, a
separate gate covered by ``test_ownership_gating.py``. Each request therefore
runs as the author of the fixture card, comment, and checklist item
(``rbac_matrix.assign_ownership``) so the role gate is what is measured.

Adding a route: the failing test names it. Add an ``EXPECTED`` entry from the
route's documented minimum role (``docs/features/rbac/roles.md``), never from
what the route happens to return today. To fill a ``skip:`` entry, give
``MatrixWorld`` a fixture for its path parameter and replace the entry with a
policy.

Not yet covered (``Refs #1573``): group-scoped routes (``/api/v1/groups/...``),
and the ``skip:`` rows below, which need a fixture for an attachment, child
link, relation, custom field, webhook, or a join token.
"""

from django.test import TestCase
from rest_framework.test import APIClient

from boards.models import (
    Board,
    BoardInviteLink,
    BoardMembership,
    CardDimensionPlan,
    Column,
    CustomFieldDefinition,
    CustomFieldSet,
    Label,
    SavedFilter,
    Swimlane,
)
from boards.tests.conftest import _denied_write_counts
from boards.tests.rbac_matrix import (
    NON_MEMBER,
    POLICIES,
    PRINCIPALS,
    SKIP_PREFIX,
    MatrixWorld,
    assign_ownership,
    enumerate_write_routes,
    route_params,
    run_rolled_back,
)

# Models whose row counts must not move when a request is denied, on top of the
# card-family models ``_denied_write_counts`` already audits.
_EXTRA_AUDITED = (
    Board, BoardMembership, BoardInviteLink, Column, CustomFieldDefinition, CustomFieldSet,
    Label, SavedFilter, Swimlane, CardDimensionPlan,
)

# Request bodies for routes whose handler validates a field before it checks the
# role. Everything else is sent ``{}``.
BODIES = {
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/needed/"): {"needed_at_column": None},
    ("PUT", "/api/v1/boards/{board_pk}/cards/{id}/dimension-plans/{field_pk}/"): {"next_action": "ship it"},
}

# (method, path template) -> policy name from ``rbac_matrix.POLICIES``,
# ``"content_admin"`` (only the instance-wide content flag), or ``"skip:<reason>"``.
# ``content_admin`` rows are board delete: only the board owner or an
# access-all-content account may delete a board, and the owner is not one of the
# seven principals, so a plain board admin is denied.
EXPECTED = {
    ("POST", "/api/v1/boards/"): "authenticated",
    ("POST", "/api/v1/boards/import/"): "authenticated",
    ("POST", "/api/v1/boards/import/trello/"): "authenticated",
    ("POST", "/api/v1/boards/join/{token}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/cards/"): "mutate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/"): "mutate",
    ("PATCH", "/api/v1/boards/{board_pk}/cards/{id}/"): "mutate",
    ("PUT", "/api/v1/boards/{board_pk}/cards/{id}/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/archive/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/attachments/"): "annotate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/block/"): "mutate",
    ("PUT", "/api/v1/boards/{board_pk}/cards/{id}/dimension-plans/{field_pk}/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/checklist/"): "annotate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/checklist/reorder/"): "annotate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/checklist/{item_pk}/"): "annotate",
    ("PATCH", "/api/v1/boards/{board_pk}/cards/{id}/checklist/{item_pk}/"): "annotate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/children/"): "mutate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/children/{child_pk}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/comments/"): "annotate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/comments/{comment_pk}/"): "annotate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/move/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/needed/"): "mutate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/parent/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/parent/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/relations/"): "mutate",
    ("DELETE", "/api/v1/boards/{board_pk}/cards/{id}/relations/{relation_pk}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/unarchive/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/cards/{id}/unblock/"): "mutate",
    ("POST", "/api/v1/boards/{board_pk}/columns/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/columns/reorder/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/columns/{id}/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/columns/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{board_pk}/columns/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{board_pk}/columns/{id}/stage/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/custom-fields/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/custom-fields/reorder/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("PATCH", "/api/v1/boards/{board_pk}/custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("PUT", "/api/v1/boards/{board_pk}/custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/field-sets/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/field-sets/copy/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/field-sets/reorder/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/field-sets/{id}/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/field-sets/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{board_pk}/field-sets/{id}/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/labels/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/labels/{id}/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/labels/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{board_pk}/labels/{id}/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/swimlane-custom-fields/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/swimlane-custom-fields/reorder/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/swimlane-custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("PATCH", "/api/v1/boards/{board_pk}/swimlane-custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("PUT", "/api/v1/boards/{board_pk}/swimlane-custom-fields/{id}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/swimlanes/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/swimlanes/reorder/"): "admin",
    ("DELETE", "/api/v1/boards/{board_pk}/swimlanes/{id}/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/swimlanes/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{board_pk}/swimlanes/{id}/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/swimlanes/{id}/set-collapsed/"): "admin",
    ("PATCH", "/api/v1/boards/{board_pk}/swimlanes/{id}/set_collapsed/"): "admin",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/"): "skip:webhooks are feature-gated: every principal gets 403 in this fixture; needs the webhooks setup",
    ("DELETE", "/api/v1/boards/{board_pk}/webhooks/{id}/"): "skip:no path-parameter fixture yet",
    ("PATCH", "/api/v1/boards/{board_pk}/webhooks/{id}/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/{id}/disable/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/{id}/end-overlap/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/{id}/reenable/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/{id}/rotate/"): "skip:no path-parameter fixture yet",
    ("POST", "/api/v1/boards/{board_pk}/webhooks/{id}/test/"): "skip:no path-parameter fixture yet",
    ("DELETE", "/api/v1/boards/{id}/"): "content_admin",
    ("PATCH", "/api/v1/boards/{id}/"): "admin",
    ("PUT", "/api/v1/boards/{id}/"): "admin",
    ("POST", "/api/v1/boards/{id}/health-recompute/"): "admin",
    ("POST", "/api/v1/boards/{id}/health-status/"): "admin",
    ("POST", "/api/v1/boards/{id}/invite-links/"): "admin",
    ("POST", "/api/v1/boards/{id}/invite-links/send/"): "admin",
    ("DELETE", "/api/v1/boards/{id}/invite-links/{link_id}/"): "admin",
    ("POST", "/api/v1/boards/{id}/members/"): "admin",
    ("DELETE", "/api/v1/boards/{id}/members/{user_id}/"): "admin",
    ("POST", "/api/v1/boards/{id}/move-group/"): "admin",
    ("POST", "/api/v1/boards/{id}/saved-filters/"): "any_member",
    ("DELETE", "/api/v1/boards/{id}/saved-filters/{filter_pk}/"): "any_member",
    ("DELETE", "/api/v1/boards/{id}/share/"): "admin",
    ("POST", "/api/v1/boards/{id}/share/"): "admin",
    ("DELETE", "/api/v1/boards/{id}/star/"): "any_member",
    ("POST", "/api/v1/boards/{id}/star/"): "any_member",
}

CONTENT_ADMIN = frozenset(("site_admin", "all_content"))


def _admitted(policy):
    return CONTENT_ADMIN if policy == "content_admin" else POLICIES[policy]


def _is_denied(principal, status_code):
    if status_code in (401, 403):
        return True
    # A non-member is told the board does not exist.
    return principal == NON_MEMBER and status_code == 404


class RbacMatrixTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.world = MatrixWorld()

    def test_every_write_route_has_an_expected_outcome(self):
        routes = set(enumerate_write_routes())
        self.assertGreater(len(routes), 50, "route enumeration looks empty")
        missing = sorted(routes - set(EXPECTED))
        stale = sorted(set(EXPECTED) - routes)
        self.assertEqual(
            missing, [],
            "Write routes with no EXPECTED entry in test_rbac_matrix_1573.py "
            "(add one from the route's documented minimum role):",
        )
        self.assertEqual(stale, [], "EXPECTED entries that match no route (remove or rename):")

    def test_every_expected_entry_names_a_known_policy(self):
        known = set(POLICIES) | {"content_admin"}
        for route, policy in EXPECTED.items():
            if policy.startswith(SKIP_PREFIX):
                self.assertGreater(len(policy), len(SKIP_PREFIX) + 8, f"{route}: give a reason")
            else:
                self.assertIn(policy, known, f"{route}: unknown policy")

    def test_skipped_routes_are_exactly_those_without_a_fixture(self):
        """A route marked ``skip:`` only because a fixture is missing must lose the
        marker once a fixture exists, and a route with a fixture must not be skipped."""
        for (method, path), policy in EXPECTED.items():
            if route_params(path) and self.world.resolve_url(path) is None:
                self.assertTrue(
                    policy.startswith(SKIP_PREFIX),
                    f"{method} {path} has no fixture, so it cannot be exercised; mark it skip:",
                )

    def test_unresolvable_parameter_is_never_silently_addressed(self):
        """Guard for the absent-input branch (#1075): no fixture means no URL."""
        self.assertIsNone(self.world.resolve_url("/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/"))
        self.assertIsNone(self.world.resolve_url("/api/v1/boards/join/{token}/"))

    def test_role_matrix(self):
        mismatches = []
        exercised = 0
        for (method, path), policy in sorted(EXPECTED.items()):
            if policy.startswith(SKIP_PREFIX):
                continue
            url = self.world.resolve_url(path)
            self.assertIsNotNone(url, f"{method} {path} has a policy but no fixture")
            body = BODIES.get((method, path), {})
            admitted = _admitted(policy)
            for principal in PRINCIPALS:
                exercised += 1
                client = APIClient()
                client.force_authenticate(self.world.users[principal])

                def request():
                    assign_ownership(self.world, self.world.users[principal])
                    before = _denied_write_counts(_EXTRA_AUDITED)
                    response = getattr(client, method.lower())(url, body, format="json")
                    return response.status_code, before, _denied_write_counts(_EXTRA_AUDITED)

                status_code, before, after = run_rolled_back(request)
                denied = _is_denied(principal, status_code)
                if denied == (principal in admitted):
                    mismatches.append(
                        f"{method} {path} as {principal}: got {status_code}, "
                        f"policy {policy!r} says {'deny' if principal not in admitted else 'allow'}"
                    )
                if denied and before != after:
                    mismatches.append(
                        f"{method} {path} as {principal}: denied with {status_code} but rows changed "
                        f"{ {k: (before[k], after[k]) for k in before if before[k] != after[k]} }"
                    )
        self.assertGreater(exercised, 300, "matrix exercised too few requests")
        self.assertEqual(mismatches, [], "role x endpoint mismatches:")
