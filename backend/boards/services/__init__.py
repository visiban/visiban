"""Domain services for board mutations.

A service function owns the *invariants* of a state transition — the role
allow-list, the ownership gate, optimistic-concurrency check, row locks, WIP and
weight enforcement, the audit-trail write, and the deferred broadcast and
extension hooks. A DRF view is one caller of that, not the home of it (#1107).

Nothing in this package imports ``rest_framework`` or touches a request or a
response. Callers translate: ``boards.views.cards`` maps the typed errors in
:mod:`boards.services.errors` onto today's exact HTTP bodies, and a non-HTTP
caller (an MCP write tool, a webhook consumer, a management command) catches the
same errors and renders them however it likes.

``cards`` is the first module here. Swimlane and column reorder and the other
structural mutations are slated to follow in this package; that is why it is a
package rather than a single module.
"""
