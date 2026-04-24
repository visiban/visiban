# Navigation

The application sidebar provides persistent, at-a-glance access to your full group and board hierarchy. It lives on the left edge of every authenticated page and is available on desktop-sized viewports.

## What the sidebar shows

The sidebar renders sections in this order, omitting any empty section entirely:

1. **Dashboard** — always present; navigates to `/` and highlights when the current path is `/`.
2. **Favorite Boards** — boards the current user has starred, in the order they were starred. Only shown when at least one board is starred.
3. **Favorite Groups** — groups the current user has starred. Only shown when at least one group is starred.
4. **Recent Boards** — the last 5 boards the current user visited, most recent first. Only shown when at least one board has been visited. See [Recent Boards](#recent-boards) below.
5. **Groups and their boards** — all top-level groups (groups with no parent). Each group can be expanded to reveal the boards that belong to it. Only direct membership in a group is required to see it here; boards within nested subgroups are not flattened into a parent group's list.
6. **Personal** — boards that do not belong to any group, collected under a "Personal" heading. Only shown when at least one such board exists.

A 3D engraved separator (`h-px bg-slate-900` / `h-px bg-slate-600/50`) appears between each pair of visible sections.

Groups and personal boards are populated from a single API call on mount (`GET /api/v1/groups/` and `GET /api/v1/boards/`). Favorite boards and groups are fetched from `GET /api/v1/boards/?starred=true` and `GET /api/v1/groups/?starred=true` and are re-fetched whenever the star version counter increments (i.e. any time a board or group is starred or unstarred).

## Recent Boards

The **Recent Boards** section tracks the last 5 boards you visited, most recent first. It appears in the sidebar between the Favorites sections and the Groups tree.

- Visits are recorded automatically whenever you navigate to a board page.
- The list is stored in `localStorage` under the key `user:prefs:recent-boards` — it persists across page reloads but is device-local and not synced across browsers or devices.
- Entries are deduplicated: navigating to a board you already visited moves it to the top of the list rather than adding a duplicate.
- The section is hidden when no boards have been visited yet.

In the **collapsed sidebar rail**, the Recent section is represented by a clock icon. Clicking it opens a flyout panel showing the same 5 boards.

## Starring boards and groups

The star button (☆/★) appears in the **breadcrumb in the top navbar** when viewing a board or group — immediately after the board or group name. Click it to toggle the starred state. Starred boards and groups appear in the **Favorite Boards** and **Favorite Groups** sections at the top of the sidebar for quick access. The star updates optimistically and rolls back on failure.

Starred boards also surface in two more places so they stay one click away from anywhere in the app:

> **Added in 1.1** — the Dashboard Favorite Boards section and command palette starred-boards ranking (#450)

- **Dashboard — Favorite Boards section.** A dedicated section above *My Boards* lists every starred board (personal or grouped) in alphabetical order. The section is hidden entirely when no boards are starred, so the Dashboard stays uncluttered for users who haven't yet starred anything.
- **Command palette default view.** Opening the palette (`⌘K` / `Ctrl+K`) with an empty query lists your starred boards first — alphabetically — followed by your recent visits. A ★ glyph next to the board name marks the starred rows.

## Collapse and expand

A toggle button sits in the header of the sidebar. Clicking it switches between two states:

| State | Width | Content |
|---|---|---|
| Expanded (default) | 220 px | Section headings, group names with expand/collapse chevrons, board names, footer shortcuts |
| Collapsed (icon rail) | 48 px | One trigger icon per section; no text labels; no footer shortcuts |

In the collapsed state, fixed destinations (Dashboard, Site Admin) render as direct icon links. Variable-length sections (Favorites, Groups, Personal boards) each render as a single trigger icon regardless of how many items the section contains:

| Section | Collapsed icon |
|---|---|
| Dashboard | Grid (four squares) icon |
| Favorites | Filled star ★ (yellow) |
| Groups | Folder icon |
| Personal boards | Clipboard icon |

Every icon in the collapsed rail shows an immediate tooltip on hover with the section name. The collapsed state persists across sessions via `localStorage`.

### Collapsed rail flyout panels

> **Added in 1.0**

When the sidebar is collapsed to the 48 px icon rail, clicking a section trigger icon opens a flyout panel to the right of the rail. The flyout contains the full list of items for that section with scroll support, so you can browse and navigate without expanding the sidebar.

Three sections produce flyouts:

| Trigger icon | Flyout contents |
|---|---|
| Filled star (Favorites) | Starred boards and starred groups, split into labeled sub-sections when both are present |
| Folder (Groups) | All groups and their boards, flattened in depth-first pre-order with indentation |
| Clipboard (Personal) | All boards not belonging to any group |

Each flyout panel is 224 px wide (`w-56`), dark-themed (`bg-slate-800`), and scrollable up to 320 px tall (`max-h-80`). A section header appears at the top in uppercase muted text. Items in the list are clickable links that navigate to the board or group and close the flyout.

**Mutual exclusion** — only one flyout can be open at a time. Opening a flyout automatically closes any other open flyout. Flyouts are also closed by clicking outside the panel, pressing Escape, or clicking the same trigger icon a second time.

**Active route indicator** — when the currently active board or group belongs to items inside a collapsed flyout, the trigger icon receives the blue active highlight (`text-blue-400 bg-blue-600/20`) even while the flyout is closed. This communicates "you are here" without requiring the flyout to be open.

### Groups flyout ordering

The Groups flyout flattens the sidebar tree in depth-first pre-order. Within each group, boards appear before subgroups. This matches the ordering you see in the expanded sidebar tree.

Items are indented based on their depth in the group hierarchy. The indentation formula is `paddingLeft: 12 + depth * 12` pixels. Visual depth is capped at 3 — groups nested deeper than three levels are rendered at the same indentation as depth 3, but they are never omitted. Root-level items (`depth 0`) use brighter text (`text-slate-300`); nested items (`depth > 0`) use slightly muted text (`text-slate-400`).

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

Below the `lg` breakpoint (1024 px) the authenticated app is gated by a desktop-only notice rather than a degraded layout. Viewports narrower than 1024 px see a centered card explaining that Visiban is optimized for larger displays; the notice is dismissed automatically when the viewport grows past the breakpoint (for example, when a tablet is rotated into landscape).

Public routes — join links, share links, email confirmation, and password reset — remain fully accessible on any viewport so invites and account recovery still work from a phone.

!!! note "Board view — desktop only"
    The Kanban grid, swimlane panel, and sidebar require horizontal space that phones and portrait-mode tablets can't provide. Mobile support for the board view is planned for a future release; until then, the viewport gate avoids a broken experience.

## Footer shortcuts

When the sidebar is in its expanded state, a footer section is pinned to the bottom with two quick-action links:

- **New board** — opens the board creation modal directly
- **New group** — opens the group creation modal directly

The footer is hidden entirely when the sidebar is collapsed to the icon rail.
