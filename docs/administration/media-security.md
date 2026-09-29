# Media Storage Security

Visiban validates every attachment before it's written to storage and serves
downloads through an authenticated view, not a public file mount. Below:
both controls, plus what to configure if you move attachment storage to S3,
GCS, or Azure Blob.

---

## Attachment upload validation

Every file uploaded as a card attachment is validated by two independent
checks before it is written to storage.

### MIME type allowlist

The `Content-Type` header supplied by the browser is checked against an
allowlist of permitted types. Anything not in the list is rejected with
`HTTP 400` before any bytes are written to disk or object storage.

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

For all binary file types, Visiban reads the first 12 bytes of the uploaded
file and compares them against a table of known file signatures before
accepting the upload. This prevents a renamed or misrepresented file (for
example, an executable renamed to `.jpg`) from bypassing the allowlist by
manipulating its `Content-Type` header.

If the magic bytes do not match any recognized signature for the declared
type, the upload is rejected with `HTTP 400` and the file is never written to
storage.

### Content-Disposition

Attachment download URLs include `Content-Disposition: attachment` so that
browsers always prompt the user to save the file rather than rendering it
inline. The frontend also sets the HTML `download` attribute on attachment
links as defense-in-depth.

### Authenticated serving, not a bare static-file mount

`/media/` is **not** a raw Nginx file mount — that would serve any
attachment to anyone who guessed its URL. Every download is proxied through
Django's `ServeMediaView`, which checks board membership before serving the
file, then hands off delivery one of two ways controlled by
`USE_X_ACCEL_REDIRECT`:

- **On** (production default): Django returns an `X-Accel-Redirect` header
  and Nginx streams the file itself from the internal-only
  `/protected-media/` location — no Python I/O in the transfer path, and that
  location rejects any request that doesn't come from Django's redirect.
- **Off** (development default, and the Helm chart): Django streams the file
  body directly via `FileResponse`. Helm sets this because the frontend Nginx
  pod doesn't mount the media PVC — only the backend does, so a
  `ReadWriteOnce` storage class works even with multiple backend replicas.

A request that can't be matched to a real, permitted attachment gets `404`
(never `403`), so a guessed path can't be used to confirm a file exists.

---

## External object storage (S3, GCS, Azure Blob)

Visiban stores attachments on the local filesystem (`MEDIA_ROOT`) by
default — there is no `django-storages` (or equivalent) dependency in the
shipped image, and `STORAGES` in `backend/visiban/settings.py` is hardcoded
to `FileSystemStorage`. Moving to S3-compatible storage is a supported
customization, not a built-in toggle: see
[Scaling → Attachment storage](../architecture/scaling.md#attachment-storage)
for the `django-storages` install and settings override, which you need
before running more than one backend replica.

Because every download still goes through the authenticated `ServeMediaView`
(see [above](#authenticated-serving-not-a-bare-static-file-mount)) — Django's
storage backend only changes where bytes are read from, not who can request
them — most bucket-level hardening below is defense-in-depth, not the primary
access control. `X-Accel-Redirect` only works for local files Nginx can read
directly, so `USE_X_ACCEL_REDIRECT` has no effect once you switch to S3;
Django streams every download itself via `FileResponse` after fetching it
from the bucket.

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

Attachment downloads are always proxied through the application backend, never
served directly from the bucket to the browser. There is no need to enable a
permissive CORS policy on the bucket. If your infrastructure requires a CORS
policy, restrict `AllowedOrigins` to your application's own domain.

### Enable server-side encryption

Enable server-side encryption on the bucket using managed keys (SSE-S3 /
Google-managed / Azure-managed) or customer-managed keys (SSE-KMS / CMEK)
according to your compliance requirements. Visiban does not require a
specific key type.

---

## Related settings

| Setting | Description |
|---|---|
| `MAX_UPLOAD_SIZE_BYTES` | Maximum attachment size in bytes (default: `10485760` — 10 MB). Set in `settings.py` or override via environment. |
| `USE_X_ACCEL_REDIRECT` | Delivery mode for `/media/` downloads — see [Authenticated serving](#authenticated-serving-not-a-bare-static-file-mount) above. Default: enabled in production, disabled in development. |
| `MEDIA_ROOT` | Local filesystem path where media files are stored when using the default Django file storage backend. |
| `MEDIA_URL` | URL prefix for attachment downloads (default: `/media/`). Requests are authenticated by `ServeMediaView`, not served directly by Nginx — see above. |
