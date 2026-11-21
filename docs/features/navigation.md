# Get around with the header and the navigation drawer

<a id="navigation"></a>

> **Changed in 1.3**: the persistent left sidebar (and its collapsed icon rail) is gone. Every signed-in page has one header, and navigation opens on demand in a drawer (#2473).

Every signed-in page shares one header. Its menu button opens the **navigation drawer**, which lists your boards and groups; the drawer closes again when you pick a destination.

**Why it matters:** the board gets the full width of the screen, and the same header works the same way on every page, from a phone to a wide monitor.

**How it works:** click the menu button at the left of the header, or press `[` anywhere, to open the drawer. On a board, click the board name in the header to switch boards without opening the drawer.

**Yes, but:** the drawer does not stay open. There is no pinned or collapsed sidebar option.

## The header

Left to right:

1. **Menu button**: the menu icon and the Visiban logo. Opens the navigation drawer (`[`).
2. **Breadcrumb**: always starts at **Home**, then the group (on a board in a group), then the page. The last item is the page title. On a board, the title is a button that opens the [board switcher](#switch-boards).
3. **Star and status** on board pages, beside the title.
4. **Search**: opens the command palette (`⌘K` on macOS, `Ctrl K` on Windows and Linux). On a board it reads "Search cards, people, labels, fields"; everywhere else it reads "Jump to a board or action", because off a board the palette finds boards and actions only.
5. The page's **primary action**, where a page has one.
6. **Notifications** and your **account menu**.

On a phone (below 640 px) the header shows the menu button, the page title, a search icon, notifications and your account menu. Every control is at least 44 px.

## The navigation drawer

The drawer slides in from the left over the page, 300 px wide. It lists:

- **Home**.
- **Starred**: boards you have starred, each with its status dot.
- **Groups**: your groups as a tree, each with how many boards it holds.
- **Personal boards**: boards that are not in a group you can see, with status dots.
- At the bottom: **Site admin** (site admins only) and **Settings**.

A section with nothing in it is hidden. While your boards load, the sections show placeholder rows.

To close the drawer, press `Escape`, press `[` again, click the X, or click outside it. Focus goes back to the menu button.

## Home

Home (`/`) is a status page, not just a list of boards *(new in 1.3, #2474)*. The header shows **Home**; the page greets you ("Good morning, Jane") and sums up your workspace: how many boards across how many groups, how many boards are at risk, and the stale and blocked cards on the boards that have [auto health](health-status.md) on. A clause with a count of 0 is left out. The counts are a snapshot from each board's last health calculation, not a weekly total.

- **Jump back in** shows the last three boards you opened *on this device*, with the group (or "Personal"), the status, the card count, stale and blocked counts, and when you opened it. It is stored in this browser only, so it is empty on a new device, and the section is hidden when it has nothing to show.
- **All boards** lists every board you can open, personal and in groups. Filter by **All**, **Starred**, **Personal** or **At risk** (each shows its count; on a phone the filter is a select). Each row has a star toggle, the name and description, the "Not reviewed in N days" cue, stale and blocked counts, the status, and when the board was last updated. A board without auto health shows "Stale, blocked: no data" rather than 0. The **...** menu has **Move to group** and, if you may delete the board, **Delete**; on a phone it also holds **Star**. **At risk** includes boards whose status is Off track.
- **Groups** lists the groups you can see with their board and member counts.
- **Needs attention** lists boards and subgroups with stale or blocked cards, or whose health status is overdue for review, worst first (blocked, then stale, then days overdue). It is hidden when nothing needs attention.

**Import**, **New group** and **New board** sit beside the heading and in the header. In a hosted demo, creating and importing boards is disabled with the reason shown.

**First run.** With no boards and no groups, Home leads with joining a team: **I have an invite link** (paste a link or token), then the options for a board of your own: **Start from a template**, **Import a board** (Visiban or Trello) and **Blank board**. Boards you start there are personal. If you are in a group that has no boards yet, you see the normal page with its empty list.

## Switch boards

On a board, the board name in the header opens **Switch board**. Type to filter by name, use the arrow keys to move, `Enter` to open a board, and `Escape` to close. It lists, in order:

1. **Starred** boards.
2. **Recent on this device**: the last 5 boards you opened in this browser.
3. The rest of the current board's group (or **Personal boards**, on a personal board).

Each board appears once, in the first list that has it. The board you are on is marked **Current**. If nothing matches, press `⌘K` to search cards and actions too. On a phone the list opens as a sheet from the bottom of the screen.

Board admins rename a board with the **Rename board** (pencil) button beside its name.

## Recent boards

Visiban remembers the last 5 boards you opened, most recent first. The list is stored in this browser under a per-account key (`user:prefs:recent-boards:<user id>`), so it is not synced across devices. Because it holds board and group names, it is cleared when you sign out or your session expires, and one account on a shared browser never sees another account's list. Boards you can no longer open drop off the list.

## Starring boards and groups

The star button (☆/★) sits beside the board or group name in the header. Starred groups are not listed in the drawer. Starred boards appear in the drawer's **Starred** section, at the top of the board switcher, under **Starred** on Home, and first in the command palette when you open it with an empty query.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` / `Ctrl K` | Jump to a board or action |
| `[` | Open or close the navigation drawer |
| `g` then `u` | Open the account menu |
| `?` | Show the keyboard shortcuts help |

These work on every page, except while you are typing in a field. On a board, the help also lists the board's own shortcuts. You can also open the help from the account menu.

## Account menu

Click your avatar at the right of the header (or press `g` then `u`). The menu shows your name and email (and a **Site admin** chip for site admins), then:

- **Profile & settings**
- **Site admin** (site admins only)
- **Keyboard shortcuts**
- **Help & docs** (opens in a new tab)
- **Theme**: Dark, Light or System. It applies at once and is saved to your account, the same setting as **Settings › Appearance**.
- **Sign out**

## Unknown pages

An address that matches no page shows **Page not found**, with the same header, so the drawer and search still work.
