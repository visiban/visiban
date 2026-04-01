# API Versioning

## No URL version prefix — intentional and stable

All Visiban API endpoints are served at `/api/` with no version prefix (e.g. `/api/boards/`, not `/api/v1/boards/`). This is a deliberate architectural decision, not an oversight.

Visiban is a self-hosted product. Operators run a specific release and upgrade on their own schedule. Because there is never a situation where two incompatible API versions must coexist on the same server, a URL version prefix adds complexity without delivering the benefit it provides for cloud SaaS products (where many clients connect to the same host simultaneously and must be migrated gradually).

The stability guarantee is provided instead through a strict backward-compatibility policy applied at the field and behavior level.

## Backward-compatibility policy

The following changes are **never** made in a patch or minor release:

| Change type | Rule |
|---|---|
| Remove or rename a response field | Never — add new fields, deprecate old ones, never delete |
| Change a field's type | Never (e.g. string → integer, nullable → required) without a major version bump |
| Remove an endpoint | Never — endpoints receive a `410 Gone` response with a deprecation notice for at least one minor release first |
| Add a required query parameter to an existing endpoint | Never — new parameters must be optional with a sensible default |
| Add a required body field to an existing endpoint | Never — new body fields must be optional with a sensible default |

These rules are enforced by code review and are documented in `CLAUDE.md` so they apply to every contribution.

## How deprecation works

When a field or endpoint needs to be removed in a future release:

1. **Announce deprecation** — add `Deprecation` and `Sunset` response headers to the relevant endpoint for at least one minor release before removing the behavior:

    ```
    Deprecation: true
    Sunset: <ISO 8601 date of planned removal>
    ```

2. **Document in CHANGELOG** — the deprecation notice must appear in `CHANGELOG.md` under the release that introduced the headers, and the planned removal must appear under the release that performs it.

3. **Remove after the sunset date** — the field or endpoint may be removed once the sunset release has shipped. Clients that read the `Sunset` header have advance notice to update.

For endpoints being retired, return `410 Gone` with a JSON body explaining what replaced it:

```json
{
  "detail": "This endpoint was removed in 1.x.0. Use /api/replacement/ instead.",
  "docs": "https://docs.visiban.com/api/replacement/"
}
```

## Why this approach

- **Operators run specific versions.** A self-hosted operator who upgrades from 1.2 to 1.3 has full control over when the transition happens. They are not sharing the API with clients on older versions.
- **Field-level compatibility is sufficient.** Adding new optional fields is non-breaking for existing clients. Removing fields is the only genuinely dangerous operation, and the policy above prevents it.
- **URL prefixes create permanent technical debt.** A `/v1/` prefix implies a `/v2/` will eventually exist. Maintaining parallel URL namespaces for a self-hosted product imposes ongoing maintenance cost with no corresponding benefit for the operator.
- **Simpler for integrators.** Scripts, webhooks, and CI pipelines that call the Visiban API do not need to track a version prefix or negotiate capability with the server. The URL they use today will continue to work in future minor releases.
