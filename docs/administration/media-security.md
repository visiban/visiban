# Keep attachments private, on disk or in a bucket

Visiban validates every attachment before it's written to storage and serves downloads through an authenticated view, not a public file mount. If you move attachment storage to S3, GCS, or Azure Blob, keep the bucket private.

**Why it matters:** attachments hold sensitive user content. The board-membership check in `ServeMediaView` is the primary access control, and bucket hardening is defense-in-depth.

**The big picture:** this page covers upload validation, authenticated serving, external object storage hardening, and cleaning up orphaned files.

---

## Attachment upload validation

Two independent checks validate every card attachment before it is written to storage.

### MIME type allowlist

The browser-supplied `Content-Type` header is checked against an allowlist. Anything not listed is rejected with `HTTP 400` before any bytes reach disk or object storage.

| Category | Allowed MIME types |
|---|---|
| Images | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| Documents | `application/pdf` |
| Office (OOXML) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX), `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX) |
| Archives | `application/zip` |
| Text | `text/plain`, `text/csv` |

!!! warning
    The allowlist is enforced on the declared `Content-Type`. The magic-byte
    check described below provides an additional layer of defense for binary
    types, but text types (`text/plain`, `text/csv`) are trusted on their
    declared MIME alone because they have no distinguishing byte signatures.

### Magic-byte validation

For all binary file types, Visiban reads the first 12 bytes of the upload and compares them against known file signatures. This stops a renamed or misrepresented file (for example, an executable renamed to `.jpg`) from bypassing the allowlist by manipulating its `Content-Type` header. If the magic bytes match no recognized signature for the declared type, the upload is rejected with `HTTP 400` and never written to storage.

### Content-Disposition

Attachment download URLs send `Content-Disposition: attachment`, so browsers prompt to save rather than render inline. The frontend also sets the HTML `download` attribute on attachment links as defense-in-depth.

### Authenticated serving, not a bare static-file mount

`/media/` is **not** a raw Nginx file mount, which would serve any attachment to anyone who guessed its URL. Every download is proxied through Django's `ServeMediaView`, which checks board membership before serving the file. It then hands off delivery one of two ways, controlled by `USE_X_ACCEL_REDIRECT`:

- **On** (production default): Django returns an `X-Accel-Redirect` header
  and Nginx streams the file itself from the internal-only
  `/protected-media/` location — no Python I/O in the transfer path, and that
  location rejects any request that doesn't come from Django's redirect.
- **Off** (development default, and the Helm chart): Django streams the file
  body directly via `FileResponse`. Helm sets this because the frontend Nginx
  pod doesn't mount the media PVC — only the backend does, so a
  `ReadWriteOnce` storage class works even with multiple backend replicas.

A request that matches no real, permitted attachment gets `404` (never `403`), so a guessed path can't confirm a file exists.

---

## External object storage (S3, GCS, Azure Blob)

Visiban stores attachments on the local filesystem (`MEDIA_ROOT`) by default. There is no `django-storages` (or equivalent) dependency in the shipped image, and `STORAGES` in `backend/visiban/settings.py` is hardcoded to `FileSystemStorage`.

**Yes, but:** moving to S3-compatible storage is a supported customization, not a built-in toggle. See
[Scaling → Attachment storage](../architecture/scaling.md#attachment-storage)
for the `django-storages` install and settings override, which you need
before running more than one backend replica.

Every download still goes through the authenticated `ServeMediaView` (see [above](#authenticated-serving-not-a-bare-static-file-mount)); Django's storage backend changes only where bytes are read from, not who can request them. Most bucket-level hardening below is therefore defense-in-depth, not the primary access control. `X-Accel-Redirect` works only for local files Nginx can read, so `USE_X_ACCEL_REDIRECT` has no effect on S3: Django streams every download itself via `FileResponse` after fetching it from the bucket.

### Block public access

!!! warning
    Attachment files contain potentially sensitive user content. The storage
    bucket **must not** be publicly accessible — `ServeMediaView`'s board
    membership check is the only thing standing between a card attachment and
    the internet if the bucket itself is public.

- **AWS S3:** Enable "Block all public access" on the bucket.
- **Google Cloud Storage:** Do not grant `allUsers` or `allAuthenticatedUsers` any role on the bucket.
- **Azure Blob:** Set the container's public access level to `Private`.

### Set a restrictive bucket policy

Restrict `s3:GetObject` (or equivalent) to only the IAM role or service
account used by the Visiban backend. Example AWS S3 bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-visiban-media-bucket/*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::123456789012:role/visiban-backend"
        }
      }
    }
  ]
}
```

### Disable CORS on the bucket

Attachment downloads always proxy through the backend, never straight from the bucket to the browser, so the bucket needs no permissive CORS policy. If your infrastructure requires one, restrict `AllowedOrigins` to your application's own domain.

### Enable server-side encryption

Enable server-side encryption on the bucket with managed keys (SSE-S3 / Google-managed / Azure-managed) or customer-managed keys (SSE-KMS / CMEK), per your compliance requirements. Visiban requires no specific key type.

---

## Removing orphaned attachment files

> **Added in 1.2** (#1817)

Deleting a card, column, swimlane or board, or deleting attachments in the Django admin, removes the attachment files once the delete commits. If the delete rolls back, the files stay. A file also stays while another attachment row points at the same path.

Some files can still be left with no attachment row pointing at them:

- files from deletes made before upgrading to 1.2, which never removed them
- files whose removal failed (for example, storage was unavailable at the time)
- files from an upload whose request failed after the file was written

`purge_orphaned_attachments` finds and removes them. It is a dry run unless you pass `--yes`:

```bash
# Report orphaned files without deleting anything
docker compose exec backend python manage.py purge_orphaned_attachments

# Delete them
docker compose exec backend python manage.py purge_orphaned_attachments --yes
```

- It only looks under `attachments/` in the configured default storage.
- It skips files modified within the last 24 hours, because an upload writes the file before its row. Change this with `--min-age-hours N` (at least 1).
- It checks the database again immediately before each deletion.
- It prints counts only. Add `--verbosity 2` to list file names, which can contain a user's original upload name; avoid that under a scheduled job whose output is collected. It never writes paths to the application log.
- Removal runs one file at a time after the delete commits, inside the request that deleted. On local storage that is quick. Deleting a board with thousands of attachments on S3-style storage can take long enough to hit a proxy timeout even though the delete itself committed; any file not removed is picked up by the next run of this command.
- Bulk database operations that fire no signals, such as `TRUNCATE` (which `seed_demo_data --reset-database` uses) or raw SQL deletes, leave their files behind; this command removes them.
- With the default `FileSystemStorage` on a volume that is not shared between replicas, it sees only the files on the node it runs on. Run it on each node.

---

## Related settings

| Setting | Description |
|---|---|
| `MAX_UPLOAD_SIZE_BYTES` | Maximum attachment size in bytes (default: `10485760` — 10 MB). Set in `settings.py` or override via environment. |
| `USE_X_ACCEL_REDIRECT` | Delivery mode for `/media/` downloads — see [Authenticated serving](#authenticated-serving-not-a-bare-static-file-mount) above. Default: enabled in production, disabled in development. |
| `MEDIA_ROOT` | Local filesystem path where media files are stored when using the default Django file storage backend. |
| `MEDIA_URL` | URL prefix for attachment downloads (default: `/media/`). Requests are authenticated by `ServeMediaView`, not served directly by Nginx — see above. |
