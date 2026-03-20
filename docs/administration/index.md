# Administration

Guides for running and maintaining a Visiban instance.

| Guide | Description |
|---|---|
| [Admin Panel](admin-panel.md) | Managing users, registration mode, and instance settings via the `/admin` UI |
| [Site Admins](site-admins.md) | What site admins can do, how to grant and revoke site admin access |
| [Django Admin](django-admin.md) | Using the built-in Django `/django-admin` panel for direct data management |
| [Secret Rotation](secret-rotation.md) | How to rotate `DJANGO_SECRET_KEY`, `DB_PASSWORD`, and `CORS_ALLOWED_ORIGINS`; admin IP restriction |
| [Media Storage Security](media-security.md) | Attachment upload validation, allowed file types, and S3/GCS bucket hardening |
| [Demo Data](demo-data.md) | How to seed demo boards for development and demos; production risks; cleanup instructions |
| [Rate Limits](../architecture/deployment.md#rate-limiting) | Per-client API throttle limits enforced in production |
