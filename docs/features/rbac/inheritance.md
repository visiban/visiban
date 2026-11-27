# Add someone once, get access everywhere below

<a id="group-inheritance"></a>

A user with a role in a parent group automatically has that same role on all sub-groups and boards within it.

**Why it matters:** Add someone to a parent group once, and they get the right access everywhere below it, with no per-board setup.

**The big picture:** group roles are inherited through the group ancestry chain.

All four non-admin roles — `admin`, `member`, `collaborator`, and `viewer` — are valid at both the group and board level. An explicit `BoardMembership` record can override the inherited role for a specific board (see [Overrides](#overrides)).

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

An explicit `BoardMembership` takes precedence over inherited group membership. It can raise a user's role on a specific board or narrow it — for example, a group `member` set as a `viewer` on one sensitive board. *(1.3+)* The exception is a user who is an `admin` through the group (or a parent group): their direct role on the group's boards can't be set below `admin`. Remove their direct membership to return them to the group role, or change their group role.

## Collaborator and viewer

`collaborator` and `viewer` are valid at both the group and board level. As a group membership role, they're inherited by all boards within the group exactly like `admin` and `member`. An explicit `BoardMembership` overrides the inherited value for that specific board, except that it can't be set below `admin` for someone who is an admin through the group (see [Overrides](#overrides)).

## Visibility of descendant groups

Parent-group membership implies visibility into all descendant sub-groups and their boards. A user added to a parent group can:

- See descendant sub-groups listed under the parent (in the navigation drawer's group tree and the Group detail page)
- See and navigate to boards inside those sub-groups
- Have their effective role on those boards resolved by the inheritance rules above

**Watch out:** there's no way to grant membership on a parent group while hiding a specific sub-group from that member. If a sub-group holds content that shouldn't be visible to parent-group members, move it to a separate top-level group instead. This visibility model applies consistently across the navigation drawer, the Group detail page, and the `/api/v1/groups/{id}/subgroups/`, `/api/v1/groups/{id}/descendant-boards/` and `/api/v1/groups/{id}/descendant-boards/paged/` endpoints.
