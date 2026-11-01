# See GitHub and GitLab issues as a kanban pivot

<a id="issue-board-lens"></a>

<span class="vb-version" title="Added in 1.2">1.2+</span>

Set `GIT_LENS_ENABLED=true`, then pick a provider and `owner/repo` in **Board Settings → Lens**. A read-only **Lens** tab shows that repository's issues as a kanban board.

**Why it matters:** You get a configurable two-dimensional pivot (columns on one axis, swimlanes on the other) that native GitHub and GitLab boards don't offer.

> **OSS core** — The Issue Board Lens is part of the open-source core; no enterprise license is required. See [Open-Core Boundary](../architecture/open-core-boundary.md#issue-board-lens-oss) for the full ruling.

!!! warning "Experimental feature"
    The Issue Board Lens is experimental. Its configuration options and behavior may change in future releases.

**The big picture:** the lens is a live view of the source repository, which stays the single source of truth. There's no sync, no webhooks, and no write-back to the provider. Visiban only reads.

**Yes, but:** public repositories only, read-only, 300 issues per refresh, and manual refresh. See [Limitations in this release](#limitations-in-this-release).

---

## Prerequisites

- **Operator:** sets `GIT_LENS_ENABLED=true`. When it is absent or `false`, there is no Lens tab, no Lens settings, and no related API surface.
- **Board admin configuring the lens:** needs a linked GitHub account (GitHub repositories) or a Visiban login (GitLab public repositories are read anonymously).
- **Repository:** only **public repositories** are supported in this release. Private repositories are not accessible.

---

## Enabling the lens (operators)

Set the environment variable before starting the backend:

```bash
GIT_LENS_ENABLED=true
```

In Docker Compose add it to your `.env` file:

```bash
GIT_LENS_ENABLED=true
```

With the Helm chart, set the chart value instead:

> **Added in 1.3**

```yaml
backend:
  settings:
    gitLensEnabled: true
```

Pass the values file on every install and upgrade (`helm upgrade --install visiban helm/visiban -f my-values.yaml`). Chart versions before 0.8.0 reject this key.

The chart renders `GIT_LENS_ENABLED=true` on every backend pod. Turning it on adds the `git_lens` tables, so the backend pod's `migrate` init container applies them on rollout.

When the variable isn't set, or is `false`, the feature is completely absent from the UI and API. No frontend restart is needed: the UI reads a capability flag from the backend on load.

To monitor how many GitHub/GitLab API calls the lens makes on your instance, see [Issue Board Lens Usage](../administration/issue-board-lens-usage.md).

---

## Configuring the lens on a board

Only **board admins** can configure the lens.

1. Open the board and click **Settings** (the gear icon in the toolbar).
2. Select the **Lens** tab.
3. Choose the **Provider**: GitHub or GitLab.
4. Enter the repository in `owner/repo` format, for example `acme/backend` or `torvalds/linux`.
5. Click **Save**.

A **Lens** tab appears in the board sub-navigation, visible to all board members regardless of role.

**Landing tab:** once a lens is configured, opening the board (with no `?view=`, `?card=`, or `?focus=` in the URL) lands on the **Lens** tab instead of the native Board. This is automatic; there's no per-board setting.

**Lens-only boards:** if the board has **no native swimlanes**, the **Board** tab shows in a muted (italic, lower-contrast) style with the tooltip "This board mirrors a repo — no native cards", so it doesn't look like two competing boards. The Board tab is never disabled or hidden: it stays one click (or the `B` key) away, and returns to normal styling as soon as the board has one native swimlane.

**Disconnect:** go to **Settings → Lens** and click **Remove lens**. The Lens tab disappears immediately.

---

## Using the lens

### The board view

The Lens tab renders issues as cards on a read-only kanban grid. You can scroll, filter, and inspect issues but cannot drag them, edit them, or create new ones.

### Resizing columns and the swimlane label panel

Drag the thin edge between a column and its neighbor to widen or narrow it, or drag the edge of the swimlane label panel on the left to give milestone, label, or assignee names more (or less) room. This is view-only chrome, like scrolling; it changes nothing in the source repository.

- Columns resize between roughly 160px and 640px; the swimlane label panel between roughly 120px and 480px.
- Each column edge doubles as a keyboard control: focus it with Tab and press the left/right arrow keys to resize in small steps (hold Shift for larger steps).
- Sizes are remembered per board, on the device and browser you resized them in. They don't travel with a shared lens link and aren't synced across devices.

### Columns — the horizontal dimension

> **Changed in 1.2** — a newly configured lens now defaults to the **Pipeline** column view. Existing lenses keep whatever view they were saved with.

A new lens defaults to **Pipeline**: it derives a Backlog → To Do → Doing → Review → Done workflow from repository state, rather than from status labels. Pipeline is the most useful view; Status labels degrades to a plain open/closed split for repositories with no `status::`-style labels.

Change the column dimension in **Settings → Lens → Columns**:

| Option | What becomes a column |
|---|---|
| Pipeline *(default for new lenses)* | A derived Backlog / To Do / Doing / Review / Done workflow — see [Pipeline columns](#pipeline-columns) below |
| Status labels | Labels that match status-style naming conventions (for example `status: in review`, `state: blocked`, or `stage/done`); falls back to **Open** / **Closed** if none are detected |
| Open / Closed | A simple two-column split based on issue state |

#### Pipeline columns

The pipeline view derives a workflow from what's actually happening in the repository, using a first-match ladder:

| Column | An issue lands here when... |
|---|---|
| **Backlog** | None of the below apply — an open issue with no milestone, branch, or open MR |
| **To Do** | The issue has a milestone, but no linked branch or open MR |
| **Doing** | A feature branch for the issue exists in the repository |
| **Review** | An open merge/pull request references or closes the issue |
| **Done** | The issue is closed |

Each card shows the branch name or MR that placed it there, so you see the evidence without opening the issue.

- Branch and open-MR detection requires the repository to be on **github.com** or **gitlab.com**; GitLab reads are anonymous.
- This evidence is fetched only for the Pipeline view, bounded by the lens's shared cache.
- For the full precedence rules and payload shape, see [Pipeline column dimension](../api/git-lens.md#pipeline-column-dimension) in the API reference.

### Swimlanes — the vertical dimension

By default, swimlanes group issues by **milestone**. Issues with no milestone appear in an **Ungrouped** swimlane at the bottom.

Change the swimlane dimension in **Settings → Lens → Swimlanes**:

| Option | What becomes a swimlane |
|---|---|
| Milestone *(default)* | The issue's assigned milestone |
| Label | Each distinct label becomes a swimlane |
| Assignee | Each assignee becomes a swimlane |

Issues matching multiple swimlane values (for example, an issue with two labels when swimlanes are by label) appear once in each matching swimlane.

#### The current milestone is promoted

When swimlanes are grouped by milestone, the milestone you're working on sorts to the **top** with a **Current** badge. Every other milestone stays visible below it; nothing is hidden or filtered away.

Visiban works out the current milestone itself; there's nothing to configure:

- The open milestone whose due date is nearest wins. If every open milestone is past due, the most recently due one is used, since an overdue milestone is still the one in progress.
- If none have due dates and you use the **Pipeline** column view, the milestone with the most issues in *Doing* and *Review* wins instead.
- If neither applies, no milestone is marked.

The **Ungrouped** swimlane is never marked current.

### Filtering the board

Click **Filters** in the Lens toolbar (or press <kbd>f</kbd>) to open the filter row.

| Filter | Behavior |
|---|---|
| **State** | Show only open or only closed issues. |
| **Milestone** | Scope the board to one milestone. Type a title, pick one of the suggestions, or choose **(no milestone)** to see only issues that have not been assigned to one. |
| **Label** | Tick up to five labels. Labels combine with **and** — an issue must carry *every* ticked label to appear. |
| **Assignee** | Scope to a single person. One at a time: GitHub and GitLab cannot filter by several assignees in one request. |
| **Title or number** | Narrows what is already on screen by issue title or `#number`. |

State, milestone, label, and assignee are applied **at the provider**, before issues are fetched. On a large repository that matters: filtering to a milestone or label reaches issues beyond the 300-issue cap, so a filtered board can show work an unfiltered one can't. The title/number box only narrows the issues already loaded.

All filters are stored in the page URL, so you can copy and share a filtered board as a link. The **Filters** button shows how many are active; **Clear** removes them all.

!!! note
    Label and assignee suggestions are gathered from the issues loaded so far, so a label used only by issues beyond the cap may not be offered. You can still type a milestone or assignee not in the list — the filter is sent to the provider either way.

### Refreshing data

The lens doesn't poll. Click **Refresh** in the Lens toolbar to fetch the latest issues. A **Synced X ago** indicator below the toolbar shows when data was last fetched. Refresh is available to every board role, including viewers.

!!! tip
    Refresh after closing a sprint or milestone to update the board before your retrospective.

**Watch out:** to protect your provider's API rate limit, which everyone viewing the same repository shares, fetches are capped:

- **Refresh:** once every 30 seconds per person, per repository.
- **Pivots and filter changes too:** 12 fetches per five minutes.
- **Overall:** 48 fetches per five minutes across every repository you're viewing.

Clicking Refresh inside the cooldown keeps showing the data you already have; the **Synced X ago** indicator won't advance.

---

### Toolbar and view options

> **Changed in 1.2**

The lens shares the board's toolbar row instead of rendering its own. The pivot dropdowns, a board-style **Filters** toggle, and the card-layout toggle sit on the same Row 2 as the view tabs, so switching between **Board** and **Lens** no longer shifts the layout.

- **Compact layout** matches the board: cards flow two-per-row rather than shrinking, and the lens reuses your existing per-board card-layout preference.
- **Narrow screens:** below the large breakpoint, the card-layout toggle moves into a **Lens actions** menu instead of pushing the row into a sideways scroll.
- **Shortcuts:** the lens picks up the board's keyboard shortcuts. <kbd>F</kbd> toggles the filter row, and <kbd>⌘⇧L</kbd> / <kbd>Ctrl+Shift+L</kbd> switches card layout (see [Keyboard shortcuts](keyboard-shortcuts.md)).

On the lens, **Compact** goes a step further than on the native board: it strips cards down to the essentials (issue number, state, multi-lane indicator, title) for an at-a-glance scan. This is separate from the board's admin-set [Card density](board.md#card-density); the lens has no admin-controlled density, only this one per-user toggle.

The lens also gained the native board's other view comforts, both shareable via the URL:

- **Collapse** individual swimlanes, or **focus** a single lane (`?lens_collapsed=` and `?lens_focus=`).

---

## GitHub authentication

GitHub reads use the OAuth account linked to the signed-in Visiban user. If your account isn't connected to GitHub, the lens prompts you to link one in **Settings → Connected accounts**.

If your GitHub token expires or is revoked, the lens shows an authentication error with a link to re-authorize. Other board members with a linked GitHub account aren't affected, because reads are per-user.

GitLab public repositories are read anonymously and need no linked account.

---

## Large repositories

Repositories with more than **300 open issues** are capped. The lens shows the first 300 issues and a notice:

> Showing the first 300 issues. This repository has more — consider filtering by milestone or label.

The cap applies per refresh and cannot be raised in this release.

---

## Limitations in this release

| Limitation | Detail |
|---|---|
| Public repositories only | Private repositories are not supported. Attempting to configure one produces an error. |
| Read-only | Issues cannot be created, edited, closed, or labeled from Visiban. |
| Single repository per board | Each board can have at most one lens configuration. |
| No automatic refresh | Data must be refreshed manually. |
| 300-issue cap | Only the first 300 issues are loaded per refresh. |
| GitHub OAuth required | GitHub repositories require a linked GitHub account for the user viewing the Lens tab. |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| The Lens tab doesn't appear. | The operator hasn't set `GIT_LENS_ENABLED=true`, or you're not a board member. Confirm the environment variable is set and restart the backend. |
| "Repository not found" error after saving settings. | The repository is private or doesn't exist. The Issue Board Lens only supports public repositories. |
| "GitHub account not linked" prompt. | Link your GitHub account in **Settings → Connected accounts** and reload the Lens tab. |
| "GitHub API error (301)" or another upstream error after the repository was renamed or transferred. | The Lens does not follow redirects, so a moved repository returns an upstream error. Update the connection's repository slug to the new `owner/name`. |
| Issues are missing or stale. | Click **Refresh** in the Lens toolbar to pull the latest data from the provider. |
| The 300-issue cap notice appears. | Filter the view by milestone, label, or assignee to focus on a subset of work. Those filters are applied at the provider, so they reach issues beyond the cap. The cap itself can't be removed in this release. |
| A GitHub milestone filter returns an empty board. | No milestone with that exact title exists in the repository. Milestone titles are matched exactly, including capitalization, so pick one from the suggestions to be sure. |
