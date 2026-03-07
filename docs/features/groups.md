# Groups

Groups organize boards and users into a hierarchy. A board can belong to one group; a group can have one parent group (unlimited nesting, traversal capped at 6 levels).

## Structure

```
Acme Corp  (top-level group)
├── Engineering
│   ├── Backend Team
│   └── Frontend Team
└── Sales
```

## Membership

Each group has members with one of two roles: `admin` or `member`. Membership is inherited — a member of "Acme Corp" is automatically a member of "Engineering" and all its descendants (see [Group Inheritance](../rbac/inheritance.md)).

## Boards inside groups

Boards belonging to a group are visible to all group members. Group admins can create new boards inside the group from the group detail page.

## Subgroups

Group admins can create subgroups. Any user can create a top-level group.

## Invite links

Group admins can generate a shareable invite link. Anyone with the link can join the group as a `member`. Links can be deactivated at any time.

## Dashboard

The dashboard shows all groups the user has access to in a collapsible tree. Groups are collapsed by default. Click the chevron to expand.
