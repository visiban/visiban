# Issue Board Lens

> **Added in 1.2**

!!! warning "Experimental feature"
    The Issue Board Lens is experimental. Its configuration options and behavior may change in future releases.

The Issue Board Lens connects a public GitHub or GitLab repository to a Visiban board and renders its issues as a read-only kanban view. It gives you a configurable two-dimensional pivot — columns on one axis, swimlanes on the other — that native GitHub and GitLab boards do not offer.

The lens is a live view of the source repository. The repository remains the single source of truth. There is no sync, no webhooks, and no write-back to the provider — Visiban only reads.

---

## Prerequisites

- The operator must enable the feature with the `GIT_LENS_ENABLED=true` environment variable. When this variable is absent or set to `false`, no Lens tab, no Lens settings, and no related API surface is exposed.
- The board admin configuring the lens needs a linked GitHub account (for GitHub repositories) or a Visiban login (GitLab public repositories are read anonymously).
- Only **public repositories** are supported in this release. Private repositories are not accessible.

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

In a Helm deployment, pass it via your values file:

```yaml
backend:
  extraEnv:
    - name: GIT_LENS_ENABLED
      value: "true"
```

When the variable is not set or is set to `false`, the feature is completely absent from the UI and API. No restart of the frontend is required — the UI reads a capability flag from the backend on load.

---

## Configuring the lens on a board

Only **board admins** can configure the lens.

1. Open the board and click **Settings** (the gear icon in the toolbar).
2. Select the **Lens** tab.
3. Choose the **Provider** — GitHub or GitLab.
4. Enter the repository in `owner/repo` format, for example `acme/backend` or `torvalds/linux`.
5. Click **Save**.

A **Lens** tab appears in the board sub-navigation. It remains visible to all board members regardless of their role.

To disconnect the lens, return to **Settings → Lens** and click **Remove lens**. The Lens tab disappears immediately.

---

## Using the lens

### The board view

The Lens tab renders issues as cards on a read-only kanban grid. You can scroll, filter, and inspect issues but cannot drag them, edit them, or create new ones.

### Columns — the horizontal dimension

By default, columns are derived from the repository's **status labels** — any label whose name matches a common status prefix (for example `status: in review`, `state: blocked`, or `stage/done`). If no status labels are detected, issues fall back to two columns: **Open** and **Closed**.

You can override the column dimension in **Settings → Lens → Columns** and choose from:

| Option | What becomes a column |
|---|---|
| Status labels *(default)* | Labels that match status-style naming conventions |
| Open / Closed | A simple two-column split based on issue state |
| Any label | Every distinct label in the repository becomes a column |

### Swimlanes — the vertical dimension

By default, swimlanes group issues by **milestone**. Issues with no milestone appear in an **Ungrouped** swimlane at the bottom.

You can change the swimlane dimension in **Settings → Lens → Swimlanes**:

| Option | What becomes a swimlane |
|---|---|
| Milestone *(default)* | The issue's assigned milestone |
| Label | Each distinct label becomes a swimlane |
| Assignee | Each assignee becomes a swimlane |

Issues that match multiple swimlane values (for example, an issue with two labels when swimlanes are by label) appear once in each matching swimlane.

#### The current milestone is promoted

When swimlanes are grouped by milestone, the milestone you are actively working on sorts to the **top** of the board and is marked with a **Current** badge, so it is not buried among every other milestone. Every other milestone stays visible below it — nothing is hidden or filtered away.

Visiban works out which milestone is current on its own; there is nothing to configure:

- The open milestone whose due date is nearest wins. If every open milestone is already past due, the most recently due one is used — an overdue milestone is still the one in progress.
- If none of your milestones have due dates, and you are using the **Pipeline** column view, the milestone with the most issues in *Doing* and *Review* wins instead.
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

State, milestone, label and assignee are applied **at the provider**, before issues are
fetched. That matters on a large repository: filtering to a milestone or label reaches
issues that fall outside the 300-issue cap, so a filtered board can show work an
unfiltered one cannot. The title/number box, by contrast, only narrows the issues
already loaded.

All filters are stored in the page URL, so a filtered board can be copied and shared
as a link. The **Filters** button shows how many are active; **Clear** removes them all.

!!! note
    Label and assignee suggestions are gathered from the issues that have been loaded
    so far, so a label used only by issues beyond the cap may not be offered. You can
    still type a milestone or assignee that is not in the list — the filter is sent to
    the provider either way.

### Refreshing data

The lens does not poll automatically. Click **Refresh** in the Lens toolbar to fetch the latest issues from the provider. A **Synced X ago** indicator below the toolbar shows when data was last fetched so you always know how fresh the view is.

To protect your provider's API rate limit — which everyone viewing the same repository shares — Refresh is capped at once every 30 seconds per person, per repository, and there is a wider cap of 12 fetches per five minutes covering pivots and filter changes as well, plus an overall ceiling of 48 fetches per five minutes across every repository you are viewing. Clicking Refresh inside the cooldown simply keeps showing the data you already have; the **Synced X ago** indicator will not advance. Refresh is available to every board role, including viewers.

!!! tip
    Refresh after closing a sprint or milestone to update the board before your retrospective.

---

## GitHub authentication

GitHub reads use the OAuth account linked to the signed-in Visiban user. If your Visiban account is not connected to GitHub, the lens displays a prompt to link your account in **Settings → Connected accounts**.

If your GitHub token expires or is revoked, the lens shows an authentication error with a link to re-authorize. Other board members with a linked GitHub account will not be affected — reads are per-user.

GitLab public repositories are read anonymously and do not require a linked account.

---

## Large repositories

Repositories with more than **300 open issues** are capped. The lens displays the first 300 issues and shows a notice:

> Showing the first 300 issues. This repository has more — consider filtering by milestone or label.

This cap applies per refresh. It cannot be raised in this release.

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

**The Lens tab does not appear.**
The operator has not set `GIT_LENS_ENABLED=true`, or you are not a board member. Confirm the environment variable is set and restart the backend.

**"Repository not found" error after saving settings.**
The repository is private or does not exist. The Issue Board Lens only supports public repositories.

**"GitHub account not linked" prompt.**
Link your GitHub account in **Settings → Connected accounts** and then reload the Lens tab.

**Issues are missing or stale.**
Click **Refresh** in the Lens toolbar to pull the latest data from the provider.

**The 300-issue cap notice appears.**
Filter the view by milestone, label or assignee to focus on a subset of work — those filters are applied at the provider, so they reach issues beyond the cap. The cap itself cannot be removed in this release.

**A GitHub milestone filter returns an empty board.**
No milestone with that exact title exists in the repository. Milestone titles are matched exactly, including capitalization. Pick one from the suggestions to be sure.
