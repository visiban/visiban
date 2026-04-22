# Group Inheritance

Group roles are inherited through the group ancestry chain. A user with a role in a parent group automatically has that same role on all sub-groups and boards within it. All four non-admin roles — `admin`, `member`, `collaborator`, and `viewer` — are valid at both the group and board level. An explicit `BoardMembership` record can override the inherited role for a specific board.

## How it works

When resolving a user's effective role on a board, Visiban checks in this order:

1. Is the user a `site_admin`? → role is `site_admin`
2. Is the user the board owner? → role is `admin`
3. Does an explicit `BoardMembership` record exist? → use that role
4. Walk up the group ancestor chain (up to 6 levels):
   - Does the user have a `GroupMembership` at this level? → use that role
5. No match found → access denied

## Example

```
Acme Corp  (Alice = admin)
└── Engineering  (no explicit membership)
    └── Backend Team  (no explicit membership)
        └── Board: "Sprint 12"
```

Alice is an `admin` on "Sprint 12" because she is an admin of "Acme Corp" and no more specific membership overrides it.

## Overrides

An explicit `BoardMembership` always takes precedence over inherited group membership. This lets you grant a user a narrower role on a specific board — for example, a group `admin` can be explicitly set as a `viewer` on one sensitive board.

## Collaborator and viewer

`collaborator` and `viewer` are valid at both the group and board level. When assigned as a group membership role they are inherited by all boards within the group exactly like `admin` and `member`. An explicit `BoardMembership` always overrides the inherited value for that specific board.

## Visibility of descendant groups

Parent-group membership implies visibility into all descendant sub-groups and their boards. A user added to a parent group can:

- See descendant sub-groups listed under the parent (in the sidebar tree and the Group detail page)
- See and navigate to boards inside those sub-groups
- Have their effective role on those boards resolved by the inheritance rules above

There is no way to grant membership on a parent group while hiding a specific sub-group from that member. If a sub-group holds content that should not be visible to parent-group members, move it to a separate top-level group instead. This visibility model is applied consistently across the sidebar, the Group detail page, and the `/api/groups/{id}/subgroups/` and `/api/groups/{id}/descendant-boards/` endpoints.
