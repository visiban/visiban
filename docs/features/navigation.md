# Navigation

The application sidebar provides persistent, at-a-glance access to your full group and board hierarchy. It lives on the left edge of every authenticated page and is available on desktop-sized viewports.

## What the sidebar shows

The sidebar is divided into two sections, rendered in this order:

**Groups and their boards** — all top-level groups (groups with no parent) are listed first. Each group can be expanded to reveal the boards that belong to it. Only direct membership in a group is required to see it here; boards within nested subgroups are not flattened into a parent group's list.

**Personal boards** — boards that do not belong to any group are collected at the bottom of the tree under a "Personal" heading. The section is only shown when at least one such board exists.

Both sections are populated from a single API call on mount (`GET /api/groups/` and `GET /api/boards/`) and are not automatically refreshed while the sidebar is open.

## Collapse and expand

A toggle button sits in the header of the sidebar. Clicking it switches between two states:

| State | Width | Content |
|---|---|---|
| Expanded (default) | 220 px | Group names, expand/collapse chevrons, board names, footer shortcuts |
| Collapsed (icon rail) | 48 px | First letter of each group name as an avatar; "P" marker for personal boards; no footer shortcuts |

In the collapsed state, each group avatar still responds to clicks and toggles that group's expanded/collapsed state. The change is persisted immediately so the correct state is restored when the sidebar is next expanded.

## localStorage persistence

Two keys are written to `localStorage` to survive page reloads and navigation:

| Key | Type | Description |
|---|---|---|
| `sidebar-collapsed` | `"true"` \| `"false"` | Whether the sidebar is in icon-rail mode |
| `sidebar-groups-expanded` | JSON array of group IDs (numbers) | Which groups have their board list open |

`sidebar-collapsed` is written on every toggle. `sidebar-groups-expanded` is written on every group expand or collapse. Both are read synchronously during component initialization, so there is no flash of the default state on load.

If `sidebar-groups-expanded` cannot be parsed as valid JSON (for example, if the stored value was corrupted), the error is silently caught and the set of expanded groups starts empty.

## Active board highlight

The sidebar reads the current URL via React Router's `useLocation` hook and extracts a board ID from paths that match `/boards/<id>`. The matching board item is rendered with a blue highlight (`bg-blue-600/20 text-blue-400 font-medium`) to indicate the active board. All other board items use muted slate text. The active ID is derived from the route on every render, so navigating away immediately clears the highlight without any additional state management.

## Mobile behavior

The sidebar is hidden below the `lg` breakpoint (1024 px). The Tailwind class `hidden lg:flex` is applied to the `<aside>` element, so on smaller viewports the element is not rendered at all — it takes up no space and receives no interaction.

On mobile, use the top navigation bar for board and group access. The sidebar does not have a drawer or overlay mode; it is desktop-only.

## Footer shortcuts

When the sidebar is in its expanded state, a footer section is pinned to the bottom with two quick-action links:

- **New board** — navigates to the dashboard (`/`) where a new board can be created
- **New group** — navigates to the dashboard (`/`) where a new group can be created

The footer is hidden entirely when the sidebar is collapsed to the icon rail.
