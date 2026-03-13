# Navigation

The application sidebar provides persistent, at-a-glance access to your full group and board hierarchy. It lives on the left edge of every authenticated page and is available on desktop-sized viewports.

## What the sidebar shows

The sidebar renders sections in this order, omitting any empty section entirely:

1. **Dashboard** — always present; navigates to `/` and highlights when the current path is `/`.
2. **Favorite Boards** — boards the current user has starred, in the order they were starred. Only shown when at least one board is starred.
3. **Favorite Groups** — groups the current user has starred. Only shown when at least one group is starred.
4. **Groups and their boards** — all top-level groups (groups with no parent). Each group can be expanded to reveal the boards that belong to it. Only direct membership in a group is required to see it here; boards within nested subgroups are not flattened into a parent group's list.
5. **Personal** — boards that do not belong to any group, collected under a "Personal" heading. Only shown when at least one such board exists.

A 3D engraved separator (`h-px bg-slate-900` / `h-px bg-slate-600/50`) appears between each pair of visible sections.

Groups and personal boards are populated from a single API call on mount (`GET /api/groups/` and `GET /api/boards/`). Favorite boards and groups are fetched from `GET /api/boards/?starred=true` and `GET /api/groups/?starred=true` and are re-fetched whenever the star version counter increments (i.e. any time a board or group is starred or unstarred).

## Collapse and expand

A toggle button sits in the header of the sidebar. Clicking it switches between two states:

| State | Width | Content |
|---|---|---|
| Expanded (default) | 220 px | Section headings, group names with expand/collapse chevrons, board names, footer shortcuts |
| Collapsed (icon rail) | 48 px | Icon for each item; no text labels; no footer shortcuts |

In the collapsed state, each item is represented by an icon:

| Section | Collapsed icon |
|---|---|
| Dashboard | Grid (four squares) icon |
| Favorite Boards | Filled star ★ (yellow) |
| Favorite Groups | Filled star ★ (yellow) |
| Groups | Folder icon |
| Personal boards | Person (user silhouette) icon |

Every icon in the collapsed rail shows an immediate tooltip on hover with the item's name. The collapsed state persists across sessions via `localStorage`.

## localStorage persistence

Two keys are written to `localStorage` to survive page reloads and navigation:

| Key | Type | Description |
|---|---|---|
| `sidebar-collapsed` | `"true"` \| `"false"` | Whether the sidebar is in icon-rail mode |
| `sidebar-groups-expanded` | JSON array of group IDs (numbers) | Which groups have their board list open |

`sidebar-collapsed` is written on every toggle. `sidebar-groups-expanded` is written on every group expand or collapse. Both are read synchronously during component initialization, so there is no flash of the default state on load.

If `sidebar-groups-expanded` cannot be parsed as valid JSON, the error is silently caught and the set of expanded groups starts empty.

## Active board highlight

The sidebar reads the current URL via React Router's `useLocation` hook and extracts a board ID from paths that match `/boards/<id>`. The matching board item is rendered with a blue highlight (`bg-blue-600/20 text-blue-400 font-medium`) to indicate the active board. All other board items use muted slate text. The active ID is derived from the route on every render, so navigating away immediately clears the highlight without additional state management.

## Mobile behavior

The sidebar is hidden below the `lg` breakpoint (1024 px). The Tailwind class `hidden lg:flex` is applied to the `<aside>` element, so on smaller viewports the element is not rendered at all — it takes up no space and receives no interaction.

On mobile, use the top navigation bar for board and group access. The sidebar does not have a drawer or overlay mode; it is desktop-only.

## Footer shortcuts

When the sidebar is in its expanded state, a footer section is pinned to the bottom with two quick-action links:

- **New board** — navigates to the dashboard (`/`) where a new board can be created
- **New group** — navigates to the dashboard (`/`) where a new group can be created

The footer is hidden entirely when the sidebar is collapsed to the icon rail.
