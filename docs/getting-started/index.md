# Getting Started

Everything you need to go from zero to a running Visiban instance.

| Guide | Description |
|---|---|
| [Installation](installation.md) | Docker Compose setup, local dev, environment variables |
| [Kubernetes (Helm)](kubernetes.md) | Deploy to a Kubernetes cluster with the bundled Helm chart |
| [First Boot](first-boot.md) | Logging in for the first time, changing the generated password |
| [OAuth Setup](oauth.md) | Configuring Google, GitHub, and GitLab OAuth login |
| [Board Setup](board-setup.md) | Configuring columns, marking done columns for accurate analytics |
| [Sample Boards](sample-boards.md) | Importing pre-built board templates with realistic data |
| [Onboarding Tour](onboarding-tour.md) | The guided walkthrough shown to new users on their first board visit |

## Quick start checklist

After your first successful login, work through these four steps before sharing the instance with your team:

1. **Change the default admin password** — you will be prompted automatically on first login, but confirm it is done before continuing.
2. **Configure registration mode** — go to **Admin → Settings** and choose Open, Invite-only, or Closed. Invite-only is recommended for most teams. See [Inviting your team](first-boot.md#inviting-your-team).
3. **Mark your Done column(s)** — open the column header overflow menu on each terminal column, choose **Edit**, and check **Mark as done column**. Without this, the analytics heatmap includes completed work and dwell times are inaccurate. See [Board Setup](board-setup.md#marking-the-done-column).
4. **Invite your team** — if using Invite-only mode, go to **Admin → Invite Links** to generate and share links with new users. See [Inviting your team](first-boot.md#inviting-your-team).
5. **Import a sample board** — Visiban ships with 11 ready-to-import board templates covering sales, support, hiring, and more. Import one to see a fully populated board with cards, movement history, and analytics data. See [Sample Boards](sample-boards.md).
