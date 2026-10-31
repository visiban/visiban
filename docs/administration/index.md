# Run and maintain your Visiban instance

Find the guide for the admin task in front of you: configure, upgrade, secure, schedule, or demo.

**Why it matters:** start from the table below, then follow the **Go deeper** links on each page.

**Go deeper:** upgrading? Start with [Upgrading](upgrade.md). First install or secrets? Start with [Configuration](configuration.md).

| Guide | Description |
|---|---|
| [Configuration](configuration.md) | Required credentials reference for local development, CI pipeline, and production |
| [Admin Panel](admin-panel.md) | Managing users, registration mode, and instance settings via the `/admin` UI |
| [Maintenance Mode](maintenance-mode.md) | Putting the instance into read-only mode for an upgrade or migration |
| [Issue Board Lens Usage](issue-board-lens-usage.md) | Monitoring the lens's outbound GitHub/GitLab API calls: admin usage report, structured log line, and the limits that bound them |
| [Scheduled Jobs](scheduled-jobs.md) | Running the notification scans and retention prunes: Compose `scheduler` profile, Helm CronJobs, or host cron |
| [Site Admins](site-admins.md) | What site admins can do, how to grant and revoke site admin access |
| [Card History Retention](card-history-retention.md) | What a deleted card's movement history keeps and who sees it; erasing it on request with `purge_card_history` |
| [Django Admin](django-admin.md) | Using the built-in Django `/admin/` panel for direct data management — not to be confused with the site-admin panel at `/admin` (no trailing slash) |
| [Secret Rotation](secret-rotation.md) | How to rotate `DJANGO_SECRET_KEY`, `DB_PASSWORD`, and `CORS_ALLOWED_ORIGINS`; admin IP restriction |
| [Media Storage Security](media-security.md) | Attachment upload validation, allowed file types, and S3/GCS bucket hardening |
| [Verifying Release Images](image-verification.md) | Cosign-verifying the release images and Helm chart, and reading each image's per-architecture CycloneDX SBOM |
| [Container Image Retention](container-image-retention.md) | GitLab/GHCR registry cleanup policies, the scheduled release-image survival check, and digest pinning |
| [Demo Data](demo-data.md) | How to seed demo boards for development and demos; production risks; cleanup instructions |
| [Rate Limits](../architecture/deployment.md#rate-limiting) | Per-client API throttle limits enforced in production |
