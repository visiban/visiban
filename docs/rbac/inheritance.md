# Group Inheritance

Roles are inherited through the group ancestry chain. A user with any role in a parent group automatically has that same role on all boards and sub-groups within it.

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

The `collaborator` and `viewer` roles only exist at the board level and are not part of group membership. They can only be assigned via `BoardMembership`.
