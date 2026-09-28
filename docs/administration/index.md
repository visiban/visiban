# Administration

Guides for running and maintaining a Visiban instance.

| Guide | Description |
|---|---|
| [Configuration](configuration.md) | Required credentials reference for local development, CI pipeline, and production |
| [Admin Panel](admin-panel.md) | Managing users, registration mode, and instance settings via the `/admin` UI |
| [Maintenance Mode](maintenance-mode.md) | Putting the instance into read-only mode for an upgrade or migration |
| [Issue Board Lens Usage](issue-board-lens-usage.md) | Monitoring the lens's outbound GitHub/GitLab API calls: admin usage report, structured log line, and the limits that bound them |
| [Scheduled Jobs](scheduled-jobs.md) | Running the notification scans and retention prunes: Compose `scheduler` profile, Helm CronJobs, or host cron |
| [Site Admins](site-admins.md) | What site admins can do, how to grant and revoke site admin access |
| [Django Admin](django-admin.md) | Using the built-in Django `/django-admin` panel for direct data management |
| [Secret Rotation](secret-rotation.md) | How to rotate `DJANGO_SECRET_KEY`, `DB_PASSWORD`, and `CORS_ALLOWED_ORIGINS`; admin IP restriction |
| [Media Storage Security](media-security.md) | Attachment upload validation, allowed file types, and S3/GCS bucket hardening |
| [Container Image Retention](container-image-retention.md) | GitLab/GHCR registry cleanup policies, the scheduled release-image survival check, and digest pinning |
| [Demo Data](demo-data.md) | How to seed demo boards for development and demos; production risks; cleanup instructions |
| [Rate Limits](../architecture/deployment.md#rate-limiting) | Per-client API throttle limits enforced in production |
