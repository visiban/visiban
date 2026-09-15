The `dep-scan-osv` CI job now runs on every MR and on `main` (previously gated to
lockfile changes plus a weekly schedule), and gates on advisory severity instead of a
blanket non-blocking `allow_failure: true` — HIGH/CRITICAL findings now block the
pipeline, MEDIUM/LOW/unscored findings warn without blocking.
