# Mutation Testing Baseline

!!! note "One-off and non-gating"
    This page records a **manual** mutation-testing baseline on the backend modules that 1.2 changes the most (movement record, RBAC, import/export). Nothing here runs in CI and nothing fails a pipeline. A recurring CI pilot with a floor is tracked separately (#1384).

Line coverage says a line ran. Mutation testing says whether a test would notice if the line were wrong. A tool makes one small change at a time (flip `==` to `!=`, change a string, replace a value with `None`), runs the tests, and counts the change as **killed** if a test fails or **survived** if every test still passes. The kill rate is `killed / (killed + survived)`.

## What was measured

- **Tool:** [mutmut](https://github.com/boxed/mutmut) 2.5.1. Version 2.x is used on purpose: it runs `pytest` against the source tree in place, so `pytest-django` needs no changes. It is **not** in any `requirements*.txt` and must stay out of them.
- **Date and base:** 2026-10-04, on top of `main` at `25bcfdf1e`.
- **Database:** the isolated SQLite database from `backend/.env` (no PostgreSQL). Anything that is only observable on PostgreSQL, such as row locks, cannot be killed by this setup.
- **Scope:** each module was mutated against its own test files only, not the whole suite.

| Area | Mutated code | Tests it ran against |
|---|---|---|
| Movement service | `boards/services/cards.py` | `test_card_services`, `test_card_move`, `test_card_archiving`, `test_card_mutation_hooks`, `test_card_edge_cases` |
| Movement model | `CardMovement` in `boards/models.py` (lines 358-423 only) | same as above |
| RBAC | `boards/permissions.py` | `test_rbac`, `test_rbac_boundaries`, `test_explicit_permissions` |
| Import/export | `boards/views/import_export.py` | `test_export`, `test_export_controls`, `test_export_edge_cases`, `test_import`, `test_moderator_export` |

`CardMovement` has no methods, so mutmut only finds field and `Meta` arguments in it. To keep the run to that class, a `pre_mutation` hook skips every line outside its range (see below). Running mutmut on all of `boards/models.py` would have generated tens of thousands of mutants for no signal.

## Baseline numbers

"Before" is the state of `main`. "After" includes the tests added with this page (`test_movement_record_mutation_gaps.py`, `test_permissions_unit_mutation_gaps.py`).

| Module | Mutants | Killed before | Kill rate before | Killed after | Kill rate after | Timeouts |
|---|---:|---:|---:|---:|---:|---:|
| `boards/services/cards.py` | 243 | 166 | 68.3% | 185 | 76.1% | 0 |
| `CardMovement` (`boards/models.py`) | 73 | 28 | 38.4% | 45 | 61.6% | 0 |
| `boards/permissions.py` | 118 | 44 | 37.3% | 114 | 96.6% | 0 |
| `boards/views/import_export.py` | 1078 | 543 | 50.4% | not re-run (see note) | n/a | 0 |

Import/export was deliberately **not** strengthened wholesale. After the baseline, only the movement-history part of the JSON export (lines 1396-1450) was re-run: 36 mutants there, 24 killed before and 29 after. If the 5 newly killed mutants are added to the module total the rate is about 50.8%, but that figure is an estimate, not a measurement.

### Runtime

Each module was split across 16 parallel copies of the tree (see [Parallel runs](#parallel-runs)) on an 18-core machine. "Wall" is the slowest shard; "CPU total" is the sum of every shard's elapsed time, which is roughly what a single serial run would cost under the same load.

| Module | Wall | CPU total |
|---|---:|---:|
| `boards/services/cards.py` | ~12 min | ~1.9 h |
| `CardMovement` | ~6 min | ~0.9 h |
| `boards/permissions.py` | ~6.5 min | ~0.85 h |
| `boards/views/import_export.py` | ~31 min | ~7.2 h |

Plan on the whole-module `import_export.py` run being the expensive one. A serial run of the movement service alone is about two hours.

## Survivor classification

Every survivor was put in one of three buckets:

- **Missing assertion:** the code is exercised but no test checks the value. Fix by adding an assertion. These were fixed for the movement-record and RBAC paths.
- **Equivalent mutant:** the change cannot alter observable behavior in this setup, so no test can kill it. Leave it alone.
- **Untested code:** no test in the scoped files reaches the line, or reaches it without checking the result. Needs new tests or a decision that it is covered elsewhere.

### Movement service (`cards.py`): 58 survivors left of 77

| Bucket | Count | Detail |
|---|---:|---|
| Untested code | 44 | `update_card`: the per-field `CardActivity` rows (title, weight, assignee, description, labels, due date) and the assignment notification text. Not movement-record code, and some of it is probably covered by view-level suites outside the scoped file list. Not verified. |
| Equivalent | 8 | `_archive_movement` falls back to `""` when `card.column` or `card.swimlane` is `None`. Both foreign keys are non-null on `Card`, so the branch is unreachable. |
| Equivalent here | 6 | `select_for_update` guard conditions (lines 614-616). The lock is not observable on SQLite. Only a PostgreSQL concurrency test can kill these (`test_concurrent_moves.py` is the place). |
| Missing assertion, **fixed** | 19 | Creation-movement origin fields, the `position` bypass guard in `update_card`, the `or 0` weight fallback on an empty column, the role-hint rejection warning, the restore ownership message, the delete broadcast payload, and the create-time mention notification. |

### Movement model (`CardMovement`): 28 survivors left of 45

All remaining survivors change a field argument (`max_length`, `blank`, `db_index`, `related_name`, `Meta.indexes`). These are schema constants. They have no behavior to assert at the test level, and a drift against the migrations is already caught by the CI `migration-check` job, so they are treated as equivalent. The behavioral parts (default type, wire values, ordering, `SET_NULL` history retention) are now asserted.

### RBAC (`permissions.py`): 4 survivors left of 74

| Mutant | Bucket | Why |
|---|---|---|
| `break` to `continue` in the prefetched-membership scan (line 235) | Equivalent | A user has at most one membership per board, so scanning on finds nothing new. |
| `getattr(settings, "DEMO_MODE", False)` default flipped to `True` (line 346) | Equivalent | `DEMO_MODE` is always defined in settings. |
| `or ""` / `"XXXX"` defaults on `user.username` (line 351, two mutants) | Equivalent | A real user always has a non-empty username. |

### Import/export: 535 survivors of 1078 (not triaged line by line)

| Where | Survivors | Dominant kind |
|---|---:|---|
| `_import_json` | 207 | error-message and key strings, limit boundaries (`>` vs `>=` on the 500/50/100 caps), field validation bounds |
| `export` | 97 | JSON key names, comment and checklist ordering, CSV cell formatting |
| `_import_csv` | 79 | error-message strings, row-level validation |
| `import_trello` | 68 | mapping defaults and error strings |
| other (`import_board`, broadcast, throttle, helpers, `export_history`) | 84 | mixed |

By kind, 334 are string literals (messages or dict keys that the tests never read back), 153 are value or default changes, 45 are boolean/comparison operator flips, and 3 replace a value with `None`. The tests mostly assert status codes and counts, not exact error bodies or boundary values. This is the lowest-signal area of the three and the one most worth a follow-up before the compliance-grade history export lands.

## How to reproduce

!!! warning "Always mutate a throwaway copy"
    mutmut rewrites the source file in place while it runs and restores it afterward. Do not run it in your working tree. If a run is killed, the tree can be left with a mutant applied.

Set up once. Keep the tool outside the repo:

```bash
# any directory outside the repo
pip install --target /tmp/mutmut-tools "mutmut==2.5.1"

# throwaway copy of the backend, with the project venv linked in
mkdir -p /tmp/mm/backend
rsync -a --exclude .venv --exclude __pycache__ --exclude '*.sqlite3' backend/ /tmp/mm/backend/
ln -sfn "$PWD/backend/.venv" /tmp/mm/backend/.venv
```

The copy keeps `backend/.env`, so it uses its own SQLite database.

### One module, one process

```bash
cd /tmp/mm/backend
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut run \
  --paths-to-mutate boards/permissions.py \
  --tests-dir boards/tests/ \
  --runner ".venv/bin/python -m pytest -x -q -p no:cacheprovider \
    boards/tests/test_rbac.py boards/tests/test_rbac_boundaries.py boards/tests/test_explicit_permissions.py"
```

- `-x` stops each mutant's test run at the first failure, which is what makes a kill cheap.
- The runner must name the venv interpreter explicitly; `python` is not on the path mutmut uses.
- `--tests-dir` is required even though the runner lists its own files.
- Results are stored in `.mutmut-cache`. Delete it before changing the test list, or mutmut will reuse stale verdicts.

For the other modules, swap `--paths-to-mutate` and the test files using the table above.

### Restricting to one class

Create `mutmut_config.py` in the copy's `backend/` directory. mutmut imports it automatically:

```python
# mutmut_config.py -- not committed
import os

LO = int(os.environ.get("MM_LO", "0"))              # first line, 0-based
HI = int(os.environ.get("MM_HI", "1000000000"))     # last line, 0-based

def pre_mutation(context):
    if not (LO <= context.current_line_index <= HI):
        context.skip = True
```

Then export `MM_LO=357 MM_HI=423` and run with `--paths-to-mutate boards/models.py` to cover `CardMovement` only. Check the range against the current file before trusting it; the numbers above were right at the baseline commit.

### Parallel runs

mutmut 2.x is single-process. To use many cores, make N copies of the tree (each has its own SQLite file) and give each copy a share of the lines through the same hook:

```python
# mutmut_config.py -- sharded variant
import os
SHARD, N = int(os.environ["MM_SHARD"]), int(os.environ["MM_N"])
LO = int(os.environ.get("MM_LO", "0"))
HI = int(os.environ.get("MM_HI", "1000000000"))

def pre_mutation(context):
    i = context.current_line_index
    if i < LO or i > HI or i % N != SHARD:
        context.skip = True
```

Run shard `k` of `N` in copy `k` with `MM_SHARD=k MM_N=N`, then add up the per-copy counts. Do not copy a result cache over a copy that is still running; aggregate in a separate directory. The baseline used `N=16`.

## How to read the results

```bash
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut results      # lists survivors by id
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut show 42      # prints the diff for mutant 42
```

Status meanings: killed (a test failed, good), survived (all tests passed, look at it), timeout (the mutant made the tests hang, counted as killed by most conventions), suspicious (slow but not a timeout). Statuses are also in the `mutant` table of `.mutmut-cache` (SQLite) if you want counts: `sqlite3 .mutmut-cache "select status, count(*) from mutant group by status"`.

For each survivor, read the diff and ask in order:

1. **Can this change alter anything a caller or user could observe?** If not (dead branch, default that is always overridden, lock call on SQLite, schema constant guarded by `migration-check`), it is an equivalent mutant. Do not write a test for it.
2. **Is the changed code reached by any test in scope?** If not, it is untested code. Either add a test or note which other suite covers it.
3. **Otherwise it is a missing assertion.** Add the smallest assertion that fails on the mutant: the exact message or key, the boundary value (`limit` and `limit + 1`), the empty-collection case, or the ordering.

Two patterns recur in this codebase. A string-literal mutant that adds `XX` around a message survives whenever a test uses `assertIn` with a fragment of the message, because the fragment is still a substring; assert the full message, or both its start and its end. A `>=` to `>` mutant on a limit survives unless a test sits exactly on the limit.

## Limits of this baseline

- Mutation operators in mutmut 2.x are shallow (operators, constants, `None` replacements). A high kill rate here does not prove the tests are strong, and a low one on string literals is partly noise.
- Kill rate depends on which tests were allowed to run. The 44 `update_card` survivors would likely drop with the view-level suites included.
- SQLite hides locking and concurrency behavior. The `select_for_update` survivors need a PostgreSQL run.
- It is a point-in-time number on one commit. Re-run it before the 1.2 movement-record and permission changes merge to see how the rate moved.
