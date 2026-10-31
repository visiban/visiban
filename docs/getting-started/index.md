# From zero to a board your team trusts

Install, log in once as the admin, mark your Done columns, then invite people. Do it in that order.

**Why it matters:** Two of those steps are easy to skip, and skipping them costs you later. If cards move before the Done column is marked, your analytics start out skewed.

## The path

| Step | Page | You'll come away with |
|---|---|---|
| 1. Decide | [Why Visiban](why-visiban.md) | Whether Visiban fits, and when to pick something else |
| 2. Install | [Install with Docker Compose](installation.md) | A running stack, local or production with TLS |
| 3. Log in | [First boot](first-boot.md) | Your own admin password and a registration mode |
| 4. Set up a board | [Board setup](board-setup.md) | Columns, with Done marked so analytics stay accurate |
| 5. Explore | [Sample boards](sample-boards.md) | A fully populated board to learn on |

**Branch to what you need:**

- **On Kubernetes?** Use [Kubernetes (Helm)](kubernetes.md) instead of step 2.
- **Want Google, GitHub, GitLab, or OIDC login?** See [OAuth and SSO](oauth.md).
- **Wondering what new users see?** See the [onboarding tour](onboarding-tour.md).

<a id="quick-start-checklist"></a>

## Before you share the instance

Work through these five steps after your first successful login:

1. **Change the default admin password.** You're prompted on first login. Confirm it's done before you go on.
2. **Configure registration mode.** Go to **Admin → Settings** and pick Open, Invite-only, or Closed. Invite-only is the right choice for most teams. See [Inviting your team](first-boot.md#inviting-your-team).
3. **Mark your Done column(s).** On each column where work finishes, open the header's overflow menu → **Edit** → check **Mark as done column**. Without this, the analytics heatmap counts finished work and dwell times are wrong. See [Marking the Done column](board-setup.md#marking-the-done-column).
4. **Invite your team.** In Invite-only mode, go to **Admin → Invite Links** to create links and share them. See [Inviting your team](first-boot.md#inviting-your-team).
5. **Import a sample board.** Samples cover sales (including enterprise overlay coverage), support, hiring, and more. Each comes with custom fields, movement history, and analytics data already filled in. The backend image ships the JSON files; the CSVs are only in the repository. See [where to get the files](sample-boards.md#where-to-get-the-files).
