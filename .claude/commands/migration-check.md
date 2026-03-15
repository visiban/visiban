# Migration Safety Check

You are reviewing Django model changes for migration safety before the branch is pushed. The CI `migration-check` job runs `makemigrations --check --dry-run` and will fail if a migration is missing. More importantly, some migration patterns are dangerous in production and must be caught before merge.

## What to do

Given the model changes described in `$ARGUMENTS` (or infer from the current git diff of `backend/*/models.py` if no argument is provided):

### 1. Check for missing migrations
- Review all changes to `backend/*/models.py`
- Determine if any change requires a new migration: adding/removing/renaming fields, adding/removing models, changing constraints, changing indexes
- If a migration is needed and does not exist, flag it clearly and offer to scaffold it

### 2. Audit for dangerous migration patterns

Flag each of the following as 🔴 **Blocking** (must be addressed before merge) or 🟡 **Risky** (needs explicit sign-off):

**🔴 Blocking:**
- `DROP COLUMN` / removing a field that is still read by running application code — causes immediate errors on old pods during rolling deploy
- `NOT NULL` constraint added to an existing column without a `default` — fails on non-empty tables
- Renaming a column or table without a transition period — breaks old code immediately
- Unique constraint added to a column that may have duplicates in production data

**🟡 Risky (requires explicit acknowledgement):**
- Adding a new `NOT NULL` field with a `default` — safe but locks table on large tables in PostgreSQL without `CONCURRENTLY`
- Adding an index — use `Meta: indexes` with `db_index=True`; for large tables, prefer a separate `RunSQL` migration with `CREATE INDEX CONCURRENTLY`
- Changing a field type (e.g. `CharField` → `TextField`) — usually safe in PostgreSQL but confirm
- Data migrations (`RunPython`) — verify idempotency and that they handle empty tables

### 3. Verify migration file quality
If a migration file exists or is being created:
- Name follows the convention: `{number}_{descriptive_slug}.py` (e.g. `0016_column_automation_skip.py`)
- Number is sequential — no gaps, no duplicates
- Migration has a `dependencies` entry pointing to the correct previous migration
- Reversible where possible (`reverse_migrations` defined for `RunPython`)

### 4. Multi-step deploy recommendation
For any 🔴 blocking pattern, recommend the safe multi-step sequence:
1. **Step 1**: Make the column nullable / add with default / keep old column (deploy)
2. **Step 2**: Backfill data if needed (deploy or management command)
3. **Step 3**: Add `NOT NULL` constraint / remove old column (deploy after confirming step 2 complete)

### 5. Output
Produce a clear summary:
- ✅ Safe to merge as-is
- ⚠️ Safe with acknowledgement of risk (list risks)
- 🔴 Blocking issues found (list each with recommended fix)
