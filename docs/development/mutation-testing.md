# Mutation Testing Baseline

!!! note "Baseline is manual; a report-only CI pilot also runs"
    The numbers below are a **manual** baseline on the backend modules that 1.2 changes the most (movement record, RBAC, import/export). Since #1384 a report-only CI job, `backend-mutation`, also runs on the Nightly schedule against `boards/permissions.py` and publishes a score artifact. Nothing here fails a pipeline: the job is `allow_failure: true` and has no floor yet. See [CI pilot](#ci-pilot-backend-mutation).

Line coverage says a line ran. Mutation testing says whether a test would notice if the line were wrong. A tool makes one small change at a time (flip `==` to `!=`, change a string, replace a value with `None`), runs the tests, and counts the change as **killed** if a test fails or **survived** if every test still passes. The kill rate is `killed / (killed + survived)`.

## What was measured

- **Tool:** [mutmut](https://github.com/boxed/mutmut) 2.5.1. Version 2.x is used on purpose: it runs `pytest` against the source tree in place, so `pytest-django` needs no changes. It is **not** in any `requirements*.txt` and must stay out of them.
- **Date and base:** 2026-10-04, on top of `main` at `25bcfdf1e`.
- **Database:** the isolated SQLite database from `backend/.env` (no PostgreSQL). Anything that is only observable on PostgreSQL, such as row locks, cannot be killed by this setup.
- **Scope:** each module was mutated against its own test files only, not the whole suite.

| Area | Mutated code | Tests it ran against |
|---|---|---|
| Movement service | `boards/services/cards.py` | `test_card_services`, `test_card_move`, `test_card_archiving`, `test_card_mutation_hooks`, `test_card_edge_cases`; the #1454 re-measure of `update_card` adds `test_card_service_mutation_gaps` and, to find what view suites already kill, `test_views_cards`, `test_notifications`, `test_card_timeline`, `test_views_extra`, `test_board_events`, `test_security_fixes`, `test_movement_record_mutation_gaps` |
| Movement model | `CardMovement` in `boards/models.py` (lines 358-423 only) | same as above |
| RBAC | `boards/permissions.py` | `test_rbac`, `test_rbac_boundaries`, `test_explicit_permissions` |
| Import/export | `boards/views/import_export.py` | `test_export`, `test_export_controls`, `test_export_edge_cases`, `test_import`, `test_moderator_export`; the "after" runs add `test_import_export_mutation_gaps` (#1453, extended by #1484) |

`CardMovement` has no methods, so mutmut only finds field and `Meta` arguments in it. To keep the run to that class, a `pre_mutation` hook skips every line outside its range (see below). Running mutmut on all of `boards/models.py` would have generated tens of thousands of mutants for no signal.

## Baseline numbers

"Before" is the state of `main`. "After" includes the tests added with this page (`test_movement_record_mutation_gaps.py`, `test_permissions_unit_mutation_gaps.py`).

| Module | Mutants | Killed before | Kill rate before | Killed after | Kill rate after | Timeouts |
|---|---:|---:|---:|---:|---:|---:|
| `boards/services/cards.py` (2026-10-07 re-measure after #1454: 228 of 243) | 243 | 166 | 68.3% | 228 | 93.8% | 0 |
| `CardMovement` (`boards/models.py`) | 73 | 28 | 38.4% | 45 | 61.6% | 0 |
| `boards/permissions.py` | 118 | 44 | 37.3% | 114 | 96.6% | 0 |
| `boards/views/import_export.py` (2026-10-05 re-measure, first 823 paired mutants) | 1364 | 331 of 823 paired | 40.2% | 656 of 823 paired | 79.7% | 2 (see below) |
| `boards/views/import_export.py`, `_import_csv` + `export` + `export_history` (2026-10-06, #1484) | 492 | 290 of 492 | 58.9% | 465 of 492 (447 with the #1453 tests only) | 94.5% (90.9%) | 0 |

**The 2 timeouts** in the 2026-10-05 row: both are in `_imported_board_name`, in the first run's range. Mutating the `if candidate not in taken` check or the `n += 1` step makes its uniqueness loop spin forever, so pytest hangs and mutmut kills the run. Timeouts are counted as killed. The 2026-10-06 run (`_import_csv`, `export`, `export_history`) had none.

Import/export was re-measured on 2026-10-05 against `main` at `a5e4b7d20`, after the module was rewritten (selective import #119, naming #1446). The module now has **1364 mutants** (it had 1078 at `25bcfdf1e`), so the 2026-10-04 figure is not comparable. "Before" is the five scoped files only; "after" adds `test_import_export_mutation_gaps.py` (#1453).

**The 2026-10-05 measurement is a partial, paired measurement, not a whole-module run.** The 2026-10-06 run below (#1484) measures the remainder. Sixteen shards (8 before, 8 after) were started on one laptop that was swapping (about 23 of 24 GB swap, load average above 250), and the after run reached about 60% of the module before being stopped. Mutants are processed in file order, so the paired set covers lines up to the middle of `_import_csv` and **does not reach `export` or `export_history`**. Only mutants that have a verdict in both runs are compared (823 of 1364):

| Region (paired mutants) | Before killed | After killed |
|---|---:|---:|
| helpers and `import_board` (305) | 87 (28.5%) | 236 (77.4%) |
| `_import_json` (436) | 227 (52.1%) | 372 (85.3%) |
| `import_trello` (54) | 1 (1.9%) | 37 (68.5%) |
| `_import_csv` (28, sample only) | 16 | 11 (15 more are suspicious, not counted as killed) |
| **Total (823)** | **331 (40.2%)** | **656 (79.7%)** |

The before run alone tested 1138 of 1364 mutants: 474 killed, 637 survived, 27 suspicious (41.7%). `export` was reached only by that before run, which stopped early (38 killed, 32 survived of 70 tested); it is measured in full by the 2026-10-06 run below. Suspicious mutants are counted as survivors in the rates above. Timeouts are counted as killed: the 2 in the table are both from the after run, in the `_imported_board_name` uniqueness loop (mutating `if candidate not in taken` or `n += 1` makes the loop never return), so "656 killed after" is 654 killed plus those 2. The before run had no timeouts in the paired set.

### Remainder re-measure (2026-10-06, #1484)

Run on `main` at `4a5de6273` (`import_export.py` is unchanged since `a5e4b7d20`), 0-based line range `MM_LO=1317 MM_HI=2118`: the whole of `_import_csv`, `export` and `export_history`. Mutants with a verdict are all 492 mutants in range; none were left untested, suspicious or timed out. The machine (18 cores, 64 GB) was not swapping: four shards for each of "before" and "after" (8 processes), then 8 shards for the final run, load average 9 to 15. "Before" and "after" use the same five and six test files as above, so the numbers are comparable; the final column adds the #1484 tests to the gaps file.

| Region (mutants) | Before killed | After #1453 killed | After #1484 killed |
|---|---:|---:|---:|
| `_import_csv` (240) | 142 (59.2%) | 208 (86.7%) | 220 (91.7%) |
| `export` (229) | 137 (59.8%) | 224 (97.8%) | 225 (98.3%) |
| `export_history` (23) | 11 (47.8%) | 15 (65.2%) | 20 (87.0%) |
| **Total (492)** | **290 (58.9%)** | **447 (90.9%)** | **465 (94.5%)** |

Together with the 2026-10-05 table, the regions the first run could not reach have now been measured after #1453. The two runs were made on different days and the first covered only the mutants that had a verdict in both its before and after run, so the two tables are not summed into one whole-module percentage.

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

### Movement service (`cards.py`): 15 survivors left of 77

Measured 2026-10-07 (#1454) with the line range of `update_card` only, run in 8 shards against the scoped files, then against the scoped files plus the view suites listed in the table above, then with `test_card_service_mutation_gaps.py` added to each. The 14 survivors outside `update_card` are unchanged from the #1443 baseline.

| Bucket | Count | Detail |
|---|---:|---|
| Missing assertion, **fixed** (#1454) | 43 | The 44 `update_card` survivors of the #1443 baseline: per-field `CardActivity` rows (title, priority, weight, assignee, description, labels, due date), the assignment and mention notification contents, the weight-increase limit check, and the `force` default. The view suites (`test_views_cards`, `test_notifications`, `test_card_timeline` and the others in the table above) already killed 25 of them; `test_card_service_mutation_gaps.py` kills the other 18, and on its own with the scoped files kills 40 of the 44. |
| Latent bug, **fixed** (#1511) | 1 | `parts.append(f"-{', '.join(names)}")` in the label diff (`'XX, XX'.join(names)`). The removed label names were looked up in the labels on the card *after* the write, so the list was always empty and the activity row for a removal read `-` with no name. That was a real bug, not an equivalent mutant. #1511 resolves removed names from the pre-write label snapshot, and `test_removed_labels_are_listed_with_minus`, `test_several_removed_labels_join_with_comma_space` and `test_add_and_remove_in_one_update` now pin the corrected output, so the mutant dies. |
| Equivalent | 8 | `_archive_movement` falls back to `""` when `card.column` or `card.swimlane` is `None`. Both foreign keys are non-null on `Card`, so the branch is unreachable. Left alone here; tracked in #1505. |
| Equivalent here | 6 | `select_for_update` guard conditions in `move_card` and `enforce_column_limits` (the `select_for_update` calls on the card, column and sibling rows). The lock is not observable on SQLite. Only a PostgreSQL concurrency test can kill these (`test_concurrent_moves.py` is the place). Tracked in #1504 and #1503. |
| Missing assertion, fixed (#1443) | 19 | Creation-movement origin fields, the `position` bypass guard in `update_card`, the `or 0` weight fallback on an empty column, the role-hint rejection warning, the restore ownership message, the delete broadcast payload, and the create-time mention notification. |

With every `update_card` survivor killed, `cards.py` goes from 185 of 243 (76.1%) to 228 of 243 (93.8%) killed, above the 90% mutation-score target for every scored category (tracked in #1503 and #1502).

The activity and notification paths in `boards/views/cards.py` (comment added with comment and mention notifications, checklist item added, deleted and toggled) have the same missing-assertion shape. They are not part of the `cards.py` score above and are unmeasured; a mutation run on `boards/views/cards.py` would be needed to know their kill rate.

### Movement model (`CardMovement`): 28 survivors left of 45

All remaining survivors change a field argument (`max_length`, `blank`, `db_index`, `related_name`, `Meta.indexes`). These are schema constants. They have no behavior to assert at the test level, and a drift against the migrations is already caught by the CI `migration-check` job, so they are treated as equivalent. The behavioral parts (default type, wire values, ordering, `SET_NULL` history retention) are now asserted.

### RBAC (`permissions.py`): 4 survivors left of 74

| Mutant | Bucket | Why |
|---|---|---|
| `break` to `continue` in the prefetched-membership scan (line 235) | Equivalent | A user has at most one membership per board, so scanning on finds nothing new. |
| `getattr(settings, "DEMO_MODE", False)` default flipped to `True` (line 346) | Equivalent | `DEMO_MODE` is always defined in settings. |
| `or ""` / `"XXXX"` defaults on `user.username` (line 351, two mutants) | Equivalent | A real user always has a non-empty username. |

### Import/export: survivors after #1453 (first 823 paired mutants: 134 survivors plus 33 suspicious)

Not triaged line by line. By region, among the paired mutants:

The "Survivors after" column counts only mutants that survived. The 33 suspicious mutants (8 in helpers and `import_board`, 10 in `_import_json`, 15 in `_import_csv`) are not in it, but the kill rates above count them as not killed, so 823 - 656 = 167 = 134 survivors + 33 suspicious.

| Region | Survivors after | Bucket |
|---|---:|---|
| helpers and `import_board` | 69 | Mostly missing assertion: throttle rate strings and the `_parse_import_options` / `_imported_board_name` defaults. A handful are equivalent (logger message strings and `or ""` fallbacks that cannot be observed). |
| `_import_json` | 56 | Missing assertion on the field-level validation messages added by selective import, plus equivalent mutants in `.get(..., default)` calls whose default is always overridden. |
| `import_trello` | 7 | Missing assertion (mapping defaults). |
| `_import_csv`, `export`, `export_history` | see below | Measured in full on 2026-10-06 and triaged in the next subsection. |

The tests mostly pin exact error bodies, the 500/50/100 import cap boundaries, JSON key sets and order, and the movement-history cell format. The remaining survivors are expected to be dominated by log-message strings and unobservable defaults (equivalent); that classification is an estimate from sampling the diffs, not a full triage.

### Import/export: `_import_csv`, `export`, `export_history` after #1484 (27 survivors of 492)

Triaged with the three questions in [How to read the results](#how-to-read-the-results). The 18 additional kills from #1484 (45 survivors after #1453, 27 now) come from `test_import_export_mutation_gaps.py` (`ImportCsvTailGapTests`, `ExportGapTests`, `ExportHistoryGapTests`: the lowercase `labels` header, absent optional columns, a repeated label in one cell, the response `member_count`/`card_count`/`archived_card_count`, the group id, `?expand=group` and group broadcast on a grouped import, the `Movement History` cell for a movement with no destination column, the unpaginated `export-history` fallback, and the OpenAPI summary and description). All 27 remaining survivors are equivalent or covered elsewhere:

| Survivors | Count | Bucket | Why |
|---|---:|---|---|
| `file.name or ""` default (line 1433) | 1 | Equivalent | An uploaded file always has a name. |
| `column_map` / `swimlane_map` / `label_map` placeholder `None` to `""`, and `col_name and ...` to `or` (lines 1465-1477) | 5 | Equivalent | The required-field check above rejects an empty column or swimlane, and every placeholder is overwritten with the created object before it is read. Re-assigning an existing key keeps dict order. |
| `not column or not swimlane` to `and`, `continue` to `break` (lines 1522-1523) | 2 | Equivalent | Every column and swimlane name was just created, so the lookup cannot fail. Defensive code. |
| `row.get("Priority", "medium")` and `row.get("Weight", "1")` sentinel defaults (lines 1525, 1533) | 2 | Equivalent | A sentinel such as `XXmediumXX` is not a valid priority or integer, so the existing fallback to `medium` and `1` produces the same card. |
| `row.get("Labels", "")` in the second pass (line 1574) | 1 | Equivalent | A sentinel label name is never in `label_map`, so nothing is attached. (The first-pass default, line 1469, was a real gap and is killed.) |
| `(row.get("Assignee") or "")` sentinels (lines 1516, 1530) | 2 | Equivalent in practice | Only observable if a user is literally named `XXXX`. |
| `row.get(field, "")` and `row.get("Column"/"Swimlane", "")` defaults (lines 1399, 1415, 1416) | 3 | Equivalent | `Title`, `Column` and `Swimlane` are required headers, so the key is always present and the default is never used. The value is another matter: `csv.DictReader` fills missing trailing cells with `None`. A short row makes `.get(field, "")` return `None`, so `.strip()` raises; tracked in #1496. |
| `CSV file has no headers.` key and text (line 1383) | 2 | Equivalent | `DictReader` has no fieldnames only for an empty file, which the earlier `CSV file is empty.` check already rejected. Dead code. |
| `distinct=False` on `_card_count` and `_archived_card_count` (lines 1608-1609) | 2 | Equivalent | The imported board has one membership, so the join cannot duplicate card rows. (`_member_count` `distinct=False` and the `isnull` filters were real gaps and are killed.) |
| 403 body `detail` key and text for a role outside the four member roles (line 1658) | 2 | Equivalent | `get_board_for_user` raises 404 or 403 for a non-member, so `export` never sees another role. The membership message is unreachable through the API. |
| `board.export_min_role or "viewer"` (line 1672) | 1 | Equivalent | The restriction branch is entered only when `export_min_role` is set. |
| `request.query_params.get("format", "csv")` default (line 1676) | 1 | Equivalent | Any value other than `json` takes the CSV branch. |
| `BoardExportLogSerializer(..., context={"request": request})` (lines 2116, 2118) | 2 | Equivalent | The actor serializer only reads the request when a `board` is also in its context, which this view does not pass. |
| `responses=BoardExportLogSerializer(many=False)` on `export_history` (line 2093) | 1 | Covered elsewhere | `test_board_schema_contract.py::test_export_history_matches_schema` fails on it; that file is outside the scoped list. |

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
    boards/tests/test_rbac.py boards/tests/test_rbac_boundaries.py boards/tests/test_explicit_permissions.py \
    boards/tests/test_permissions_unit_mutation_gaps.py"
```

- `-x` stops each mutant's test run at the first failure, which is what makes a kill cheap.
- These are the same four test files the CI pilot runs (`[mutmut] runner` in `backend/setup.cfg`).
- mutmut 2.5.1 starts the runner without a shell, resolving the first word through the inherited `PATH`. The command above calls `.venv/bin/python` without activating the venv, so the runner names the venv interpreter too; a plain `python` would resolve to whatever is first on `PATH` (often none at all on macOS). The committed `setup.cfg` runner uses plain `python`, which is right in CI (the job's interpreter is the one with the dependencies) and locally only after `source .venv/bin/activate`.
- `--tests-dir` is required even though the runner lists its own files.
- Results are stored in `.mutmut-cache`. Delete it before changing the test list, or mutmut will reuse stale verdicts.

For the other modules, swap `--paths-to-mutate` and the test files using the table above.

### Restricting to one class

mutmut imports `mutmut_config.py` from the working directory automatically. The committed `backend/mutmut_config.py` is the CI shard hook (it skips nothing when `MUTATION_SHARDS` is unset). To restrict a run to a line range, overwrite it **in the throwaway copy only**:

```python
# mutmut_config.py -- in the throwaway copy only; do not commit over the shard hook
import os

LO = int(os.environ.get("MM_LO", "0"))              # first line, 0-based
HI = int(os.environ.get("MM_HI", "1000000000"))     # last line, 0-based

def pre_mutation(context):
    if not (LO <= context.current_line_index <= HI):
        context.skip = True
```

Then export `MM_LO=357 MM_HI=423` and run with `--paths-to-mutate boards/models.py` to cover `CardMovement` only. Check the range against the current file before trusting it; the numbers above were right at the baseline commit.

### Parallel runs

mutmut 2.x is single-process. To use many cores, make N copies of the tree (each has its own SQLite file) and give each copy a share of the lines. The committed hook already does this with `MUTATION_SHARDS=N MUTATION_SHARD=k`; to combine sharding with a line range, use this variant in the copies instead:

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

### Reproducing the `update_card` re-measure (#1454)

Measured against `main` at `ab38c4688`. The line range moves whenever `cards.py` changes, so re-derive it (`grep -n "^def update_card\|^def move_card" backend/boards/services/cards.py`) before reusing it: `update_card` was 0-based lines 492 to 696 (`MM_LO=492 MM_HI=696`) at that commit.

1. Make 8 throwaway copies as in [Parallel runs](#parallel-runs), each with the sharded variant of `mutmut_config.py` (`MM_N=8`, `MM_SHARD=0..7`, `MM_LO=492`, `MM_HI=696` fixed in the file or exported).
2. Baseline run, same runner as above with these test files: `test_card_services.py test_card_move.py test_card_archiving.py test_card_mutation_hooks.py test_card_edge_cases.py`. Result: 44 survivors.
3. Second run (delete `.mutmut-cache` first): the same files plus `test_views_cards.py test_notifications.py test_card_timeline.py test_views_extra.py test_board_events.py test_security_fixes.py test_movement_record_mutation_gaps.py`. Result: 19 survivors, so the view suites kill 25.
4. Third run: the second run's files plus `test_card_service_mutation_gaps.py`. Result: 1 survivor (#1511). With only the baseline files plus the new file, 4 survive, which is 40 of the 44 killed.

Sum the survivors over the 8 copies (`select count(*) from Mutant where status='bad_survived'` in each `.mutmut-cache`). Run `mutmut show` with `MM_SHARD` and `MM_N` exported, or the config import fails.

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

## CI pilot (`backend-mutation`)

Tracked in #1384, ported from TruePPM's `api:mutation` and `scheduler:mutation`. It is a **pilot, not a gate**: it runs on the Nightly schedule only (`MUTATION_TEST=true`, never on an MR or a `main` push), both jobs are `allow_failure: true`, and `MUTATION_MIN` is unset. The report job prints the score and says the floor is unset. The floor is set later from observed scores, never chosen up front and never set to 0.

### Beachhead: `boards/permissions.py`

| | |
|---|---|
| Module | `backend/boards/permissions.py` (role and permission rule helpers) |
| Mutants | 118 |
| Tests | `test_rbac`, `test_rbac_boundaries`, `test_explicit_permissions`, `test_permissions_unit_mutation_gaps` (132 tests, 44 s once, SQLite) |
| Kill rate | 96.6% by the manual baseline above (before the pilot) |

Why this module: it is pure rule logic with the strongest existing test files and the best baseline, so a nightly score can move because of a real change rather than noise. `boards/services/cards.py` (243 mutants, ~1.9 CPU-h) is the next candidate once this one has a record. It is not in the pilot because it would need about four times the CI time, and after #1454 the remaining survivors there are 8 dead `else ""` branches in `_archive_movement`, 6 `select_for_update` guards that need PostgreSQL, and no `update_card` survivors (the label-diff latent bug was fixed in #1511).

Runtime evidence, measured 2026-10-04 on a loaded laptop (another mutmut run was using the CPUs), SQLite, mutmut 2.5.1, one process, `-x` per mutant:

| Run | Mutants run | Wall time |
|---|---:|---:|
| shard 0 of 16 | 4 | 183 s |
| shard 3 of 16 | 9 | 311 s |
| one full test pass, no mutation | n/a | 44 s |

Each mutant costs about 25 s, nearly all of it pytest and Django start-up, not the tests themselves. That is consistent with the manual baseline (~0.85 CPU-hours for 118 mutants). A serial run would take about 50 minutes, which is over the 15 to 20 minute target, so CI runs **4 parallel shards** (`parallel: 4`), each with its own Postgres service, which brings each shard to roughly 14 minutes of mutants plus one baseline run. This is an estimate, not a CI measurement: the first nightlies will give the real number, and `timeout: 40m` leaves headroom. PostgreSQL start-up and migrations may cost more than SQLite did here.

### How it works

- `backend/setup.cfg` `[mutmut]` holds the scope (`paths_to_mutate`, the test files). `backend/mutmut_config.py` gives shard k of N the lines where `line_index % N == k` (`MUTATION_SHARDS` and `MUTATION_SHARD`).
- mutmut is installed **inside the job** with `pip install "mutmut==2.5.1"`. It stays out of `requirements*.txt`. Bumping the pin changes the mutants generated and so moves the score; bump it on purpose and re-baseline.
- mutmut 2.5.1 has no `export-cicd-stats` command (that is 3.x). `scripts/check_mutation_score.py --export-cache` reads `.mutmut-cache` instead and writes one stats file per shard.
- `backend-mutation-report` sums the shards, prints the score and writes `mutmut-cicd-stats.json` (kept 30 days). It is told how many shards to expect (`--expect-shards 4`, matching `parallel: 4`) and exits 2 (yellow), even in report-only mode, if fewer stats files arrive (a shard timed out or failed before writing its file), if a file is malformed, or if mutants were left untested. It also checks that the shards are one run: every shard registers the whole module's mutants (other shards' lines as `skipped`), so every shard's `total` must be equal, and the shards' non-skipped mutants must add up to exactly that total. A stale or mismatched shard, or a shard hook that covers a line twice or not at all, is exit 2. A run that is incomplete is never summed into a smaller, apparently complete score. The merged file's `total` is the module's mutant count (not 4 x total), and on a not-measured exit 2 it is still written, with a `not_measured` key giving the reason. A floor configuration error (for example `MUTATION_MIN=95`) exits 2 before anything is read, so no merged file is written for that run.
- Dependency review for mutmut 2.5.1: BSD-3-Clause; dependencies click (BSD-3), glob2 (BSD), parso (MIT), pony (Apache-2.0), junit-xml (MIT), toml (MIT); no OSV advisories for any of them on 2026-10-04. 2.x rather than 3.x because 3.x copies the tree into a sandbox (needs `also_copy` bookkeeping for every file the suite reads), which does not suit a Django suite.

### Maintainer steps and what comes next

1. After the pilot MR merges, add `MUTATION_TEST=true` to the Nightly schedule (4176726). Until then the jobs never run. `MUTATION_TEST` is in `SCHEDULE_AUDIT_ACCEPTED_GAPS` so `schedule-config-check` does not report it MISSING.
2. Remove `MUTATION_TEST` from `SCHEDULE_AUDIT_ACCEPTED_GAPS` in `.gitlab-ci.yml` once the schedule carries it (not machine-checked).
3. After about a week of nightly artifacts, set `MUTATION_MIN` one point under the lowest observed score, written as a fraction: a 96% low gives `MUTATION_MIN=0.95`, not `95`. The checker rejects `0` and anything outside (0, 1] (exit 2). Record the decision on #1384. #1384 stays open until then.
4. Triage survivors as described in [How to read the results](#how-to-read-the-results).

## Limits of this baseline

- Mutation operators in mutmut 2.x are shallow (operators, constants, `None` replacements). A high kill rate here does not prove the tests are strong, and a low one on string literals is partly noise.
- Kill rate depends on which tests were allowed to run. The 44 `update_card` survivors would likely drop with the view-level suites included. They are tracked in #1454.
- SQLite hides locking and concurrency behavior. The `select_for_update` survivors need a PostgreSQL run.
- The `CardMovement` figure (61.6%) is capped by schema-constant mutants (`max_length`, `db_index`, and similar). The behavioral tests added for it cover the default type, choice labels, ordering, and `SET_NULL` retention; the rest is guarded by CI `migration-check`, not by tests.
- It is a point-in-time number on one commit. Re-run it before the 1.2 movement-record and permission changes merge to see how the rate moved.
