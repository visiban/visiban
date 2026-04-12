# Media Storage Security

This page covers how Visiban validates uploaded attachments and what operators
using external object storage (S3, GCS, Azure Blob) should configure to
complement the server-side controls.

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

---

## External object storage (S3, GCS, Azure Blob)

When Visiban is configured to store media files in an external object store,
apply these additional controls at the bucket or container level.

### Block public access

!!! warning
    Attachment files contain potentially sensitive user content. The storage
    bucket **must not** be publicly accessible. All access should go through
    the application server, which enforces board membership checks before
    returning a signed URL or proxying the file.

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

### Force Content-Disposition on pre-signed URLs

If the backend serves attachments via pre-signed URLs (rather than proxying),
ensure `Content-Disposition: attachment` is set in the pre-signed URL
parameters so browsers do not render files inline:

```python
# Example: boto3 pre-signed URL with forced Content-Disposition
url = s3_client.generate_presigned_url(
    "get_object",
    Params={
        "Bucket": "your-visiban-media-bucket",
        "Key": object_key,
        "ResponseContentDisposition": f'attachment; filename="{filename}"',
    },
    ExpiresIn=3600,
)
```

### Disable CORS on the bucket

Attachment downloads are served via the application backend, not directly from
the bucket. There is no need to enable a permissive CORS policy on the bucket.
If your infrastructure requires a CORS policy, restrict `AllowedOrigins` to
your application's own domain.

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
| `MEDIA_ROOT` | Local filesystem path where media files are stored when using the default Django file storage backend. |
| `MEDIA_URL` | URL prefix for serving media files (default: `/media/`). In production behind Nginx, map this to the location block that serves `MEDIA_ROOT`. |
