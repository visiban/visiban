# Regression Check

You are auditing a branch for regressions before it is merged. Your job is to find existing behaviour that the change could silently break — not new features, but things that worked before and might not work now.

## What to do

Given the branch or change description in `$ARGUMENTS` (or infer from the current branch if nothing is provided):

### 1. Map the diff to risk zones

Run:
```bash
git diff main...HEAD --name-only
```

Classify every changed file into one of these risk zones:

| File pattern | Risk zone |
|---|---|
| `backend/*/models.py` | Schema — field renames/removals break serializers, migrations, and any code reading those fields |
| `backend/*/serializers.py` | API contract — removed/renamed fields break frontend TypeScript interfaces |
| `backend/*/views.py` | Endpoint behaviour — changed queryset filters, permission checks, or response shapes |
| `backend/*/migrations/` | Data integrity — destructive ops, missing defaults, dependency order |
| `frontend/src/types/index.ts` | Type contract — interface changes must match backend serializer fields exactly |
| `frontend/src/api/*.ts` | API client — changed signatures break every caller |
| `frontend/src/hooks/*.ts` | Hook contract — changed return shapes or callback signatures break every consumer |
| `frontend/src/components/**` | Component contract — changed prop signatures break parent components |
| `frontend/src/test/**` | Test validity — check for stale mocks (see step 3) |

### 2. Identify indirect dependencies

For each changed file, ask: **what else depends on this?**

- A changed serializer field → find every TypeScript interface, every frontend component reading that field, every test fixture that includes it
- A changed hook return value → find every component that destructures it
- A changed API function signature → find every call site
- A changed model field → find every serializer that serializes it, every test that creates that model

Use grep to find callers:
```bash
# Find all uses of a changed export
grep -r "functionName\|FieldName" frontend/src/ backend/ --include="*.ts" --include="*.tsx" --include="*.py" -l

# Find test fixtures that include a model field
grep -r "field_name" frontend/src/test/ backend/*/tests/ -l
```

### 3. Audit stale mocks and fixtures

This is the most common regression vector. When a module's exported API changes, every test that mocks it must be updated. A stale mock silently breaks the component under test without failing the mock itself.

For each changed backend serializer field or frontend API function:
- Find every `vi.mock(...)` block that references the changed module
- Verify the mock returns/accepts the new shape
- Find every test fixture object (inline `const fakeBoard = {...}`) that includes the changed field
- Verify the fixture includes any new required fields

Flag any mock or fixture that does not reflect the current API as a **stale mock regression**.

### 4. Check permission boundary regressions

For any changed view or permission class:
- Verify that the role that previously had access still has access (no accidental tightening)
- Verify that the role that was previously blocked is still blocked (no accidental widening)
- Check `test_rbac.py` and `test_rbac_boundaries.py` — do they cover the changed endpoint?

### 5. Check broadcast regressions

For any changed write operation (create, update, delete, move):
- Verify `broadcast_board_event()` is still called with the correct event type
- Verify it is still inside `transaction.on_commit()`
- Cross-reference `backend/boards/tests/test_broadcast_on_commit.py`

### 6. Run the affected test suites

Determine which suites to run based on what was touched:
```bash
# Backend — run the specific app(s) touched
docker compose exec backend python manage.py test <app> --verbosity=2

# Frontend — run all (Vitest is fast; isolation is cheap)
cd frontend && npx vitest run
```

Report results in this format:
- ✅ N tests passed — no regressions found in this suite
- ❌ N failures — list each failing test with the assertion error

### 7. Produce a regression report

Structure the output as:

```
## Regression check — <branch name>

### Risk zones touched
- <file> → <risk zone> → <what depends on it>

### Stale mock audit
- ✅ No stale mocks found
  OR
- ❌ <test file>: mock for `<module>` does not include `<new field>` added in <changed file>

### Permission boundary audit
- ✅ No permission changes
  OR
- ⚠️ <view> changed — verify <role> access in test_rbac.py

### Broadcast audit
- ✅ No write operations changed
  OR
- ⚠️ <action> in <view> — verify on_commit wrapper still present

### Test results
- Backend: <suite> — X passed / Y failed
- Frontend: X passed / Y failed

### Verdict
- ✅ No regressions detected
  OR
- ❌ Regressions found — do not merge until fixed: <list>
```

## What NOT to do

- Do not re-run tests just to clear a failure without a code fix
- Do not mark a stale mock as "not a regression" because the test still passes — a passing test with a stale mock is a false green, not a clean bill of health
- Do not skip the indirect dependency check — most regressions are indirect
