# Jump between boards from the sidebar

<a id="navigation"></a>

The left sidebar shows your full group and board hierarchy on every authenticated page, on desktop-sized viewports. Collapse it to a 48 px icon rail with the toggle in its header.

**Why it matters:** With dozens of boards across several workstreams, the sidebar is how you jump between them without hunting through menus.

**How it works:** star a board or group with the ☆/★ button in the top navbar breadcrumb. Starred items appear at the top of the sidebar, on the Dashboard, and in the command palette.

**Yes, but:** the sidebar's state (collapsed, expanded groups, recent boards) lives in `localStorage`, so it is per browser and device.

## What the sidebar shows

The sidebar renders sections in this order, omitting any empty section entirely:

1. **Dashboard** — always present; navigates to `/` and highlights when the current path is `/`.
2. **Favorite Boards** — boards you have starred, in the order you starred them. Shown only when at least one board is starred.
3. **Favorite Groups** — groups you have starred. Shown only when at least one group is starred.
4. **Recent Boards** — the last 5 boards you visited, most recent first. Shown only when at least one board has been visited. See [Recent Boards](#recent-boards) below.
5. **Groups and their boards** — all top-level groups (groups with no parent). Expand a group to reveal its boards. Only direct membership in a group is required to see it here; boards within nested subgroups are not flattened into a parent group's list.
6. **Personal** — boards that do not belong to any group, under a "Personal" heading. Shown only when at least one such board exists.

A 3D engraved separator (`h-px bg-slate-900` / `h-px bg-slate-600/50`) appears between each pair of visible sections.

**Data loading:** groups and personal boards load from a single API call on mount (`GET /api/v1/groups/` and `GET /api/v1/boards/`). Favorite boards and groups come from `GET /api/v1/boards/?starred=true` and `GET /api/v1/groups/?starred=true`, re-fetched whenever the star version counter increments, which happens any time a board or group is starred or unstarred.

## Recent Boards

**Recent Boards** tracks the last 5 boards you visited, most recent first, between the Favorites sections and the Groups tree.

- Visits are recorded automatically whenever you navigate to a board page.
- The list is stored in `localStorage` under a per-account key (`user:prefs:recent-boards:<user id>`). It persists across page reloads but is device-local and not synced across browsers or devices. Because it holds board and group names, it is cleared when you sign out or your session expires, and one account on a shared browser never sees another account's list.
- Entries are deduplicated: revisiting a board moves it to the top instead of adding a duplicate.
- The section is hidden when no boards have been visited yet.

In the **collapsed sidebar rail**, the Recent section is a clock icon. Clicking it opens a flyout panel showing the same 5 boards.

## Starring boards and groups

The star button (☆/★) appears in the **breadcrumb in the top navbar**, right after the board or group name. Click it to toggle. Starred boards and groups appear in the **Favorite Boards** and **Favorite Groups** sections at the top of the sidebar. The star updates optimistically and rolls back on failure.

Starred boards also surface in two more places so they stay one click away from anywhere in the app:

> **Added in 1.1** — the Dashboard Favorite Boards section and command palette starred-boards ranking (#450)

- **Dashboard — Favorite Boards section.** A dedicated section above *My Boards* lists every starred board (personal or grouped) alphabetically. It is hidden entirely when no boards are starred, so the Dashboard stays uncluttered.
- **Command palette default view.** Opening the palette (`⌘K` / `Ctrl+K`) with an empty query lists your starred boards first, alphabetically, followed by your recent visits. A ★ glyph marks the starred rows.

## Collapse and expand

A toggle button in the sidebar header switches between two states:

| State | Width | Content |
|---|---|---|
| Expanded (default) | 220 px | Section headings, group names with expand/collapse chevrons, board names, footer shortcuts |
| Collapsed (icon rail) | 48 px | One trigger icon per section; no text labels; no footer shortcuts |

In the collapsed state, fixed destinations (Dashboard, Site Admin) render as direct icon links. Variable-length sections (Favorites, Groups, Personal boards) each render as a single trigger icon, however many items the section holds:

| Section | Collapsed icon |
|---|---|
| Dashboard | Grid (four squares) icon |
| Favorites | Filled star ★ (yellow) |
| Groups | Folder icon |
| Personal boards | Clipboard icon |

Every icon in the collapsed rail shows a tooltip on hover with the section name. The collapsed state persists across sessions via `localStorage`.

### Collapsed rail flyout panels

> **Added in 1.0**

In the 48 px icon rail, clicking a section trigger icon opens a flyout panel to its right with the full, scrollable list for that section, so you can browse and navigate without expanding the sidebar.

Three sections produce flyouts:

| Trigger icon | Flyout contents |
|---|---|
| Filled star (Favorites) | Starred boards and starred groups, split into labeled sub-sections when both are present |
| Folder (Groups) | All groups and their boards, flattened in depth-first pre-order with indentation |
| Clipboard (Personal) | All boards not belonging to any group |

Each flyout panel is 224 px wide (`w-56`), dark-themed (`bg-slate-800`), and scrollable up to 320 px tall (`max-h-80`), with an uppercase muted section header at the top. Items are links that navigate to the board or group and close the flyout.

**Watch out:** only one flyout can be open at a time; opening one closes any other. Flyouts also close on outside click, Escape, or a second click on the same trigger icon.

The active board or group's trigger icon gets the blue active highlight (`text-blue-400 bg-blue-600/20`) even while its flyout is closed, so "you are here" is visible without opening it.

### Groups flyout ordering

The Groups flyout flattens the sidebar tree in depth-first pre-order, matching the expanded tree: within each group, boards appear before subgroups.

- **Indent:** by depth in the group hierarchy (`paddingLeft: 12 + depth * 12` pixels). Visual depth is capped at 3: groups nested deeper render at depth-3 indentation but are never omitted.
- **Text:** root-level items (`depth 0`) use brighter text (`text-slate-300`); nested items (`depth > 0`) use slightly muted text (`text-slate-400`).

## localStorage persistence

Two keys are written to `localStorage` to survive page reloads and navigation:

| Key | Type | Description |
|---|---|---|
| `user:prefs:sidebar-collapsed` | `"true"` \| `"false"` | Whether the sidebar is in icon-rail mode |
| `user:prefs:sidebar-groups-expanded` | JSON array of group IDs (numbers) | Which groups have their board list open |

`user:prefs:sidebar-collapsed` is written on every toggle; `user:prefs:sidebar-groups-expanded` on every group expand or collapse. Both are read synchronously during component initialization, so there's no flash of the default state on load.

Before 1.2 these keys were named `sidebar-collapsed` and `sidebar-groups-expanded`. On first load the old value is copied to the new key and the old key is removed; if the new key already exists it wins. The theme preference moved the same way (`visiban-theme` to `user:prefs:theme`, and its `visiban-theme-synced` sentinel to `user:prefs:theme-synced`).

If `user:prefs:sidebar-groups-expanded` can't be parsed as valid JSON, the error is silently caught and the set of expanded groups starts empty.

## Active board highlight

The sidebar reads the current URL via React Router's `useLocation` hook and extracts a board ID from paths matching `/boards/<id>`. The matching board item gets a blue highlight (`bg-blue-600/20 text-blue-400 font-medium`); other board items use muted slate text. The active ID is derived from the route on every render, so navigating away clears the highlight immediately, with no extra state management.

## Mobile behavior

> **Changed in 1.1** — replaced the desktop-only viewport gate with a responsive layout (#524)

Below the `lg` breakpoint (1024 px), the persistent sidebar collapses into a hamburger drawer. Tap the menu icon in the mobile top bar to slide it in as a full-height overlay; tap the backdrop, the close button, or a nav item to dismiss it. The rest of the app (Dashboard, boards, groups, settings) renders normally at any width, with nothing blocked.

- **Board toolbar:** the strip scrolls horizontally when it runs out of room, while the overflow kebab menu (`⋮`) and connection status stay pinned at the right edge so they're always reachable.
- **Board grid:** scrolls horizontally too. The Kanban grid, swimlane panel, and card interactions stay fully usable on a phone or portrait-mode tablet.
- **Public routes:** join links, share links, email confirmation, and password reset render outside the authenticated shell, so invites and account recovery always work from a phone.

## Footer shortcuts

In the expanded state, a footer pinned to the bottom of the sidebar offers two quick-action links:

- **New board** — opens the board creation modal directly
- **New group** — opens the group creation modal directly

The footer is hidden entirely when the sidebar is collapsed to the icon rail.

## Unknown pages

A link to a page that doesn't exist, such as a mistyped address or an out-of-date bookmark, shows a "Page not found" page with a **Go to dashboard** button instead of silently sending you to the dashboard. Expired share links keep their own messages. A board or group that was deleted, or that you no longer have access to, shows "This board isn't available" (or "This group isn't available") with a **Back to dashboard** button instead of redirecting. The page is the same either way, and it does not say which happened. It also replaces the board or group if it is deleted or you lose access while it is open, except for the person who deleted it, who is taken back to the dashboard as before. Other load failures keep the existing "Failed to load" message. `/login` takes a signed-in user to the dashboard. If you sign in from an address that doesn't exist, you see the same "Page not found" page.
