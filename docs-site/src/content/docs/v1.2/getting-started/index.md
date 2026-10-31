---
title: "Getting Started"
---

Everything you need to go from zero to a running Visiban instance.

| Guide | Description |
|---|---|
| [Installation](/v1.2/getting-started/installation/) | Docker Compose setup, local dev, environment variables |
| [Kubernetes (Helm)](/v1.2/getting-started/kubernetes/) | Deploy to a Kubernetes cluster with the bundled Helm chart |
| [First Boot](/v1.2/getting-started/first-boot/) | Logging in for the first time, changing the generated password |
| [OAuth Setup](/v1.2/getting-started/oauth/) | Configuring Google, GitHub, and GitLab OAuth login |
| [Board Setup](/v1.2/getting-started/board-setup/) | Configuring columns, marking done columns for accurate analytics |
| [Sample Boards](/v1.2/getting-started/sample-boards/) | Importing pre-built board templates with realistic data |
| [Onboarding Tour](/v1.2/getting-started/onboarding-tour/) | The guided walkthrough shown to new users on their first board visit |

## Quick start checklist

After your first successful login, work through these four steps before sharing the instance with your team:

1. **Change the default admin password** — you will be prompted automatically on first login, but confirm it is done before continuing.
2. **Configure registration mode** — go to **Admin → Settings** and choose Open, Invite-only, or Closed. Invite-only is recommended for most teams. See [Inviting your team](/v1.2/getting-started/first-boot/#inviting-your-team).
3. **Mark your Done column(s)** — open the column header overflow menu on each terminal column, choose **Edit**, and check **Mark as done column**. Without this, the analytics heatmap includes completed work and dwell times are inaccurate. See [Board Setup](/v1.2/getting-started/board-setup/#marking-the-done-column).
4. **Invite your team** — if using Invite-only mode, go to **Admin → Invite Links** to generate and share links with new users. See [Inviting your team](/v1.2/getting-started/first-boot/#inviting-your-team).
5. **Import a sample board** — Visiban ships ready-to-import sample boards covering sales (including enterprise overlay coverage), support, hiring, and more. Import one to see a fully populated board with custom fields, movement history, and analytics data. The backend image ships the JSON files (the CSVs are repo-only): [get the files from the repository](/v1.2/getting-started/sample-boards/#where-to-get-the-files).
