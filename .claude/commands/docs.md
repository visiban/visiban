# Documentation

You are writing or updating user-facing documentation for Visiban. Docs live in `docs/` alongside the code and are built with MkDocs Material and versioned with `mike`.

## What to do

Given the feature, change, or section described in `$ARGUMENTS` (or infer from the current branch and git diff if no argument is provided):

### 1. Identify the correct location

```
docs/
├── getting-started/    — installation, first boot, OAuth setup, Docker
├── features/           — one page per feature (board, cards, analytics, notifications, etc.)
├── api/                — API reference (use /api-docs for these)
├── architecture/       — data model, deployment, overview
├── administration/     — site admins, Django admin
└── changelog.md        — auto-symlinked from repo root, do not edit here
```

- New feature → `docs/features/<feature-name>.md`
- Changed behaviour → update the existing page for that feature
- New admin capability → `docs/administration/`
- Architecture change → `docs/architecture/`
- Do not edit `docs/changelog.md` directly — edit `CHANGELOG.md` at the repo root

### 2. Apply version callouts

Every **net-new feature** (not changes or fixes) must have a version callout immediately after the section heading:

```markdown
## Feature Name

> **Added in 1.1**
```

Rules:
- Pre-1.0.0: include the full tag — `> **Added in 1.0.0-rc.5**`
- 1.0.0 and later: minor version only — `> **Added in 1.1**` (never `1.1.0`)
- Patch releases (e.g. 1.1.1) do not get version callouts — only minor and pre-releases
- Do **not** add version callouts to changed or fixed behaviour — only net-new features
- Check `CHANGELOG.md` or the git tag for the correct version if unsure

### 3. Apply enterprise callouts

Any feature that requires the enterprise edition must have this callout immediately after the section heading (after the version callout if both apply):

```markdown
> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).
```

Rules:
- Only add to features that genuinely require enterprise — run `/enterprise-check` if unsure
- Do **not** add to OSS features
- For features with both an OSS and enterprise tier, describe the distinction inline rather than using the callout (e.g. "Basic analytics are available in all editions. Advanced analytics — including velocity, dwell time, and bottleneck reports — require Visiban Enterprise.")

### 4. Write the content

- Use US English throughout — "color" not "colour", "canceled" not "cancelled"
- Prefer short sentences and active voice
- Use admonition blocks for tips, warnings, and notes:
  ```markdown
  !!! tip
      Use this when...

  !!! warning
      This action cannot be undone.
  ```
- Code blocks must specify the language for syntax highlighting
- Screenshots go in `docs/assets/` — use descriptive filenames, not `screenshot1.png`

### 5. Update navigation

If adding a new page, add it to `mkdocs.yml` under the correct nav section:

```yaml
nav:
  - Features:
    - New Feature: features/new-feature.md
```

The page will not appear in the sidebar or search until it is in the nav.

### 6. Cross-check with code

- Field names, endpoint paths, and config keys in the docs must match the current code exactly
- If a feature was renamed or removed, find and update every reference in `docs/`
- Run a search for the old name before marking the update complete:
  ```bash
  grep -r "old_name" docs/
  ```

### 7. Verify the build

```bash
mkdocs build --strict
```

`--strict` treats warnings as errors — catches broken links, missing nav entries, and invalid admonition syntax before push.
