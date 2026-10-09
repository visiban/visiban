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
| Import/export | `boards/views/import_export.py` | `test_export`, `test_export_controls`, `test_export_edge_cases`, `test_import`, `test_moderator_export`; the "after" runs add `test_import_export_mutation_gaps` (#1453, extended by #1484); the head run (#1502) used nine files: `test_import_export_head_gaps`, `test_import_export_mutation_gaps`, `test_import`, `test_import_naming`, `test_import_options`, `test_import_user_scope`, `test_import_custom_fields`, `test_trello_import`, `test_import_json_value_validation` |

`CardMovement` has no methods, so mutmut only finds field and `Meta` arguments in it. To keep the run to that class, a `pre_mutation` hook skips every line outside its range (see below). Running mutmut on all of `boards/models.py` would have generated tens of thousands of mutants for no signal.

## Baseline numbers

"Before" is the state of `main`. "After" includes the tests added with this page (`test_movement_record_mutation_gaps.py`, `test_permissions_unit_mutation_gaps.py`).

| Module | Mutants | Killed before | Kill rate before | Killed after | Kill rate after (raw) | Excluded (#1503) | Adjusted after | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `boards/services/cards.py` (2026-10-07 re-measure after #1454: 228 of 243, measured before the #1511 fix and not re-measured since; #1504 found the 6 guard survivors in that count are killed, so the figure is 234 of 243 (96.3%) if they are removed from it) | 243 | 166 | 68.3% | 228 | 93.8% | 8 | 228 of 235 = 97.0% (expected, not re-measured) | 0 |
| `CardMovement` (`boards/models.py`; re-measured 2026-10-08, was 28 survivors / 45 killed / 61.6%) | 73 | 28 | 38.4% | 46 | 63.0% | 27 | 46 of 46 = 100% | 0 |
| `boards/permissions.py` (116 of 120 expected after #1503's two new killed mutants; 114 of 118 = 96.6% measured) | 118 | 44 | 37.3% | 114 | 96.6% | 4 | 114 of 114 = 100% (expected, not re-measured whole-module) | 0 |
| `boards/views/import_export.py` (2026-10-05 re-measure, first 823 paired mutants) | 1364 | 331 of 823 paired | 40.2% | 656 of 823 paired | 79.7% | n/a (unmarked; the head part of this module was triaged in #1502, see the next row) | n/a | 2 (see below) |
| `boards/views/import_export.py`, head: helpers, `import_board`, `_import_json`, `import_trello` (2026-10-08, #1502; whole-region run, 0-based lines 0 to 1802; at `f898bf683`, #1449's head code unmeasured, #1546) | 1145 | n/a (not measured on the current code) | n/a | 1111 of 1145 | 97.0% | n/a (unmarked; 32 of 34 survivors are documented as equivalent or redundant below, the other 2 are `_IMPORT_BACKFILL_BATCH` survivors tracked in #1545) | n/a | 2 (killed by timeout, see below) |
| `boards/views/import_export.py`, `_import_csv` + `export` + `export_history` (2026-10-06, #1484) | 492 | 290 of 492 | 58.9% | 465 of 492 (447 with the #1453 tests only) | 94.5% (90.9%) | n/a (unmarked; #1502 covers only the head, the 27 survivors of this region are triaged below as equivalent or covered elsewhere, and none is marked with a pragma; deciding pragma exclusions has no owner other than #1547) | n/a | 0 |

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

The before run alone tested 1138 of 1364 mutants: 474 killed, 637 survived, 27 suspicious (41.7%). `export` was reached only by that before run, which stopped early (38 killed, 32 survived of 70 tested); it is measured in full by the 2026-10-06 run below. Suspicious mutants are counted as survivors in the rates above (the 79.7% and the 40.2% use this convention; the head's 97.0% and the 2026-10-06 rows count suspicious mutants as killed, so those figures are not directly comparable). Timeouts are counted as killed: the 2 in the table are both from the after run, in the `_imported_board_name` uniqueness loop (mutating `if candidate not in taken` or `n += 1` makes the loop never return), so "656 killed after" is 654 killed plus those 2. The before run had no timeouts in the paired set.

### Remainder re-measure (2026-10-06, #1484)

Run on `main` at `4a5de6273` (`import_export.py` is unchanged since `a5e4b7d20`), 0-based line range `MM_LO=1317 MM_HI=2118`: the whole of `_import_csv`, `export` and `export_history`. Mutants with a verdict are all 492 mutants in range; none were left untested, suspicious or timed out. The machine (18 cores, 64 GB) was not swapping: four shards for each of "before" and "after" (8 processes), then 8 shards for the final run, load average 9 to 15. "Before" and "after" use the same five and six test files as above, so the numbers are comparable; the final column adds the #1484 tests to the gaps file.

| Region (mutants) | Before killed | After #1453 killed | After #1484 killed |
|---|---:|---:|---:|
| `_import_csv` (240) | 142 (59.2%) | 208 (86.7%) | 220 (91.7%) |
| `export` (229) | 137 (59.8%) | 224 (97.8%) | 225 (98.3%) |
| `export_history` (23) | 11 (47.8%) | 15 (65.2%) | 20 (87.0%) |
| **Total (492)** | **290 (58.9%)** | **447 (90.9%)** | **465 (94.5%)** |

Together with the 2026-10-05 table, the regions the first run could not reach have now been measured after #1453. The two runs were made on different days and the first covered only the mutants that had a verdict in both its before and after run, so the two tables are not summed into one whole-module percentage.

### Head re-measure (2026-10-08, #1502)

> **Scope of these figures.** Everything in this section describes the code at `f898bf683`, not current `main`. Code added after that commit is **not** in the 1145 measured mutants and has not been measured: that includes the roughly 140 lines #1449 added to the head: `_csv_custom_columns`, `_swimlane_values_from_rows`, `_csv_cell_value`, `_cap_warnings`, `_is_canonical_number`, and a change to `_csv_custom_field_cell` (`_import_field_values` and `_csv_custom_field_cell` themselves already existed at `f898bf683` and were measured). Measuring them is tracked in #1546. The head figures are for the `f898bf683` code, and the new head lines are unmeasured. The `MM_HI=1802` boundary and "`_import_csv` at 0-based line 1803" below are likewise valid only at `f898bf683`. Before reusing `MM_LO`/`MM_HI`, re-derive the range (`grep -n 'def _import_csv' backend/boards/views/import_export.py`, then subtract 1 to get the 0-based line), as the `update_card` section does.

The head of `import_export.py` (everything before `_import_csv`) was measured as **one whole-region run**, not a paired sample: 12 shards of the sharded variant in [Parallel runs](#parallel-runs), `MM_LO=0 MM_HI=1802` (0-based; `_import_csv` starts at 0-based line 1803), on `main` at `f898bf683` plus this branch's tests, 18-core machine. The module had grown to 2609 lines since the 2026-10-05 run (selective import, #1496, #1507), so the head has **1145 mutants**, not the 795 of the paired set. The runner used these nine files (all backend import/export tests; the full suite is not needed): `test_import_export_head_gaps.py test_import_export_mutation_gaps.py test_import.py test_import_naming.py test_import_options.py test_import_user_scope.py test_import_custom_fields.py test_trello_import.py test_import_json_value_validation.py`.

Two details of the harness matter if you repeat this:

- `test_import.py::test_csv_import_accepts_committed_sample_csv` reads `sample-boards/` from the repository root, so each throwaway copy of `backend/` needs `sample-boards/` next to it, or the baseline run fails and mutmut tests nothing.
- mutmut 2.5.1 registers one extra mutant (id one past the printed total, line 422, `mutmut show` prints nothing for it) that every shard reports as `untested`. It has no diff, so it is not counted in the 1145 and not a gap.

Line numbers in the region column are **1-based and inclusive**; the `MM_LO`/`MM_HI` range above is 0-based. So `1673 to 1803` here is 0-based 1672 to 1802, and `_import_csv` starts at 1-based line 1804 (0-based 1803).

| Region (1-based lines) | Mutants | Killed, first whole-region run | Killed, final run | Survivors left |
|---|---:|---:|---:|---:|
| helpers and `import_board` (to line 949) | 574 | 523 (91.1%) | 559 (97.4%) | 15 |
| `_import_json` (950 to 1672) | 440 | 416 (94.5%) | 427 (97.0%) | 13 |
| `import_trello` and `_broadcast_imported_board` (1673 to 1803) | 131 | 120 (91.6%) | 125 (95.4%) | 6 |
| **Head** | **1145** | **1059 (92.5%)** | **1111 (97.0%)** | **34** |

"First whole-region run" already includes the 538-line `test_import_export_head_gaps.py` of the first #1502 commit; "final run" adds the boundary, default and tail tests of this pass (`EchoBoundTests`, `CardRowsAndUsernamesTests`, `TimestampErrorTests`, `WriteGuardLogTests`, `ValidateValuesBoundaryTests`, `ImportJsonTailTests`, `ImportTrelloTailTests`, `ImportOpenApiResponseTests`). The final figure is the second whole-region run, except that two lines (the write-guard log and the Trello archived count, 0-based 806 and 1786) were re-run on their own after their tests were tightened; both mutants that changed are now killed. Killed counts include the 2 timeouts and 6 slow kills (below).

**The 33 suspicious mutants.** mutmut 2.5.1 marks a mutant `suspicious` when a test *failed* (so it is killed) but the run took more than twice the cached baseline time. The 2026-10-05 run did that on a swapping laptop (load average above 250), which is where the 33 came from. In this run six were suspicious (`swimlane["name"]` in the custom-field value copy, `description` and `created_at` key names, `to_column` `or` to `and`, `dry_run = None`, `event_id = None`); re-run alone on a quiet machine each is still `suspicious`, so they are killed late in the file order, not flaky. They are counted as killed. None survives.

**The 2 timeouts** are the `_imported_board_name` uniqueness loop (`if candidate not in taken` inverted, `n += 1` replaced with `n = 1`). Both make the loop spin forever, so they are a real kill by timeout, as in the 2026-10-05 run. They are not made faster: the hang is the observable behavior.

#### Survivors left (34): 32 equivalent or redundant, 2 tracked in #1545

The 2 `_IMPORT_BACKFILL_BATCH` survivors could be killed by a PostgreSQL test (#1545, open), so they stay survivors under the policy below. The other 32 are equivalent or redundant; none of those 32 is a missing assertion. They are listed so the next person does not re-triage them; none is marked with `# pragma: no mutate` yet, because most share a line with mutants that *are* killed and the policy asks that a pragma cover the equivalent mutant only. Marking the 32 equivalent ones is tracked in #1544 and is the open step before a floor can use the adjusted score. The 2 `_IMPORT_BACKFILL_BATCH` survivors that a PostgreSQL test could kill are tracked in #1545.

| Mutants | Where | Why no test can kill it |
|---:|---|---|
| 1 | `_EXPORT_ROLE_RANK` `ADMIN: 3` to `4` | The rank is only compared with another rank from the same dict, so any order-preserving value is equivalent. |
| 1 | `export_min_role or "viewer"` | An unknown threshold falls back to rank 0 through `.get(threshold, 0)`, which is also what `viewer` maps to. |
| 1 | `_query_flag` default `""` to `"XXXX"` | Neither is in `("true", "1")`. |
| 1 | `_IMPORTED_NAME_MAX_SUFFIX` 12 to 13 | A shorter `startswith` head only widens the database query; the exact comparison is in Python. |
| 2 | `_IMPORT_BACKFILL_BATCH` 500 to 501 and to `None` | On SQLite `bulk_update` caps its own batch size at 499 (`connection.ops.bulk_batch_size`), so the constant is not observable here; `test_timestamp_backfill_runs_in_batches_of_500` pins two UPDATEs for 501 rows. A PostgreSQL test could kill it. |
| 1 | `"unknown line"` text in `_json_import_write_guard` | The generator frame of the guard is always one of the importer frames, so `frames` is never empty. |
| 2 | `403` documented response on `import_board` and on `import_trello` (1 each) | `drf-spectacular` emits an object-typed `403` entry for the action anyway (`ImportOpenApiResponseTests` passes with the line mutated), so the generated document is unchanged. |
| 5 | `MAX_UPLOAD_SIZE` default `10 * 1024 * 1024` | `settings.MAX_UPLOAD_SIZE` is always defined, so the `getattr` default is never used. |
| 2 | `file.name` and `file.content_type` fallbacks to `"XXXX"` | `"XXXX"` ends in neither `.json`/`.csv` nor contains `json`/`csv`, same as `""`. |
| 1 | `data.get("schema_version", 0)` to `1` | Both are within the supported range and only a version above 2 logs a warning. |
| 4 | `_str_keys` names for `movements` | Redundant with the value-level check in `_validate_json_import_values`, which returns the same message for the same input. (`moved_by`, the one key it does not cover, is killed.) |
| 2 | `.get("name", "")` in `_valid_col_names` / `_valid_sw_names` | A column or swimlane without a string `name` is rejected by the shape check before this line. |
| 2 | `not column or not swimlane` to `and`, `continue` to `break` | Every card's column and swimlane was checked against the definitions above, so the lookup cannot fail. Defensive code. |
| 1 | `card_data.get("priority", "medium")` sentinel | An unrecognized priority falls back to `medium` on the next line. |
| 1 | `act_data.get("event_type", "")` sentinel | Neither value is a valid event type, so the activity is skipped either way. |
| 2 | `distinct=False` on `_card_count` and `_archived_card_count` | The imported board has one membership, so the join cannot duplicate card rows. (`_member_count` `distinct=False` is killed by `test_response_counts_distinguish_active_and_archived_cards`.) |
| 5 | Trello `file.size is not None`, `file.read(max_size + 1)` and the `'name' must be a string` response | `file.size` is always set for an upload and the `Content-Length` check precedes the bounded read; the endpoint takes `MultiPartParser` only, so `name` is always a string. Defense in depth. |

Everything the first commit on this branch and this pass pinned is a value a caller or client can observe (the echo caps are pinned through the length of the response message, not by reading the constants): throttle scopes and rates, option and flag parsing, the exact echo cut-offs of `_bounded_repr` and `_bounded_text`, the per-card caps and the username cap on both sides of the limit, `_card_rows` and `_card_usernames`, naive-timestamp acceptance, the write-guard log line, JSON and Trello response counts, the group broadcast, label colors, empty movement destinations, the weight-change activity, and the OpenAPI text.

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
- **Equivalent mutant:** the change cannot alter observable behavior in this setup, for any production input, so no test can kill it. Mark it with `# pragma: no mutate -- <reason>` under the [policy](#equivalent-mutants-and-the-score-1503) rather than leaving it as a survivor.
- **Untested code:** no test in the scoped files reaches the line, or reaches it without checking the result. Needs new tests or a decision that it is covered elsewhere.

### Movement service (`cards.py`): 9 survivors left of 77 (measured before #1511; the 6 guard survivors were re-checked in #1504)

Measured 2026-10-07 (#1454) with the line range of `update_card` only, run in 8 shards against the scoped files, then against the scoped files plus the view suites listed in the table above, then with `test_card_service_mutation_gaps.py` added to each. The 14 survivors outside `update_card` are unchanged from the #1443 baseline: 8 `_archive_movement` equivalents and 6 guard-condition mutants. #1504 (2026-10-08) re-checked the six guard mutants against the current code and found them killed, so the survivor count is now 9 (8 equivalent plus the #1511 label mutant, also now fixed) and the 77-mutant table below adds up to 77 with the new bucket.

| Bucket | Count | Detail |
|---|---:|---|
| Missing assertion, **fixed** (#1454) | 43 | The 44 `update_card` survivors of the #1443 baseline: per-field `CardActivity` rows (title, priority, weight, assignee, description, labels, due date), the assignment and mention notification contents, the weight-increase limit check, and the `force` default. The view suites (`test_views_cards`, `test_notifications`, `test_card_timeline` and the others in the table above) already killed 25 of them; `test_card_service_mutation_gaps.py` kills the other 18, and on its own with the scoped files kills 40 of the 44. |
| Latent bug, **fixed** (#1511) | 1 | `parts.append(f"-{', '.join(names)}")` in the label diff (`'XX, XX'.join(names)`). The removed label names were looked up in the labels on the card *after* the write, so the list was always empty and the activity row for a removal read `-` with no name. That was a real bug, not an equivalent mutant. #1511 resolves removed names from the pre-write label snapshot, and `test_removed_labels_are_listed_with_minus`, `test_several_removed_labels_join_with_comma_space` and `test_add_and_remove_in_one_update` now pin the corrected output, so the mutant dies. |
| Equivalent, **excluded** (#1503) | 8 | `_archive_movement` falls back to `""` when `card.column` or `card.swimlane` is `None`. Both foreign keys are non-null on `Card`, so the branch is unreachable. Each of the 8 lines carries `# pragma: no mutate -- ...`, and each holds this one mutant only, so nothing killed is excluded with it. #1505 may delete the dead branches instead, at which point the pragmas go with them. |
| Guard condition, **no longer a survivor** (#1504) | 6 | The original six sat on the `column_changed and ((wip_enforced and ...wip_limit is not None) or (... weight_limit is not None))` condition in `move_card` (lines 614-616 at baseline `25bcfdf1e`), which has exactly six `and`/`or`/`is not` mutation points. #1428 moved that condition into `enforce_column_limits` (`wip_applies`, `weight_applies` and `if not (wip_applies or weight_applies)`). Applying the six analog mutants by hand on SQLite on 2026-10-08, all six are killed (`RoleAllowListTests` in `test_card_services.py` and `WipEnforcementTests` in `test_wip_enforcement.py`, including `test_hard_mode_applies_even_when_soft_enforcement_is_off`). The old "equivalent here, needs PostgreSQL" label was wrong for these, and had been stale since #1428. Separately, #1504 adds PostgreSQL race tests for the real lock calls; see [PostgreSQL re-run (#1504)](#postgresql-re-run-of-the-select_for_update-guards-1504). |
| Missing assertion, fixed (#1443) | 19 | Creation-movement origin fields, the `position` bypass guard in `update_card`, the `or 0` weight fallback on an empty column, the role-hint rejection warning, the restore ownership message, the delete broadcast payload, and the create-time mention notification. |

#### PostgreSQL re-run of the `select_for_update` guards (#1504)

Measured 2026-10-08. `ConcurrentMoveLockTests` (`test_concurrent_moves.py`, skipped unless `connection.vendor == "postgresql"`) holds one move open inside its transaction, at a point after it took its locks and before it commits, and starts a second move while the first is held. With the locks the second move queues; without them it runs against stale state. The three tests cover the card-row lock (two moves of one card must produce a continuous movement chain), the target-column lock in `enforce_column_limits` (a hard WIP limit must not be exceeded by two racing moves) and the target-cell sibling lock (two cards entering one occupied cell must not end at the same position).

Second, separate set (a re-derivation, **not** the original six): mutmut 2.5.1 generated six mutants on the lines that carry the real lock calls (0-based lines 330, 372-373, 740-744, 816-819 and 827-830 at `f6d570d55`), ids 35, 168, 169, 170, 188 and 193: `lock=True` to `lock=False`, `select_related("column", ...)` and `select_related(..., "swimlane")` to `XX...XX`, the locked card read replaced by `None`, and `order_by("pk")` to `order_by("XXpkXX")` on the source and target sibling locks. mutmut cannot delete the `.select_for_update()` call or negate `if lock:`, so the lock calls themselves were flipped by hand instead.

| Mutant | SQLite, scoped files | PostgreSQL, `ConcurrentMoveLockTests` |
|---|---|---|
| `lock=True` to `lock=False` (`enforce_column_limits`) | **Survives** | Killed by `test_column_lock_serializes_moves_into_a_full_column` |
| `select_related` name mutants (2), card read replaced by `None`, `order_by("XXpkXX")` (2) | Killed (`FieldError` or `AttributeError` on any database) | Killed |

| Hand-flipped guard | Killed by |
|---|---|
| Drop `select_for_update()` on the card read in `move_card` | `test_card_row_lock_serializes_two_moves_of_the_same_card` |
| Drop `select_for_update()` on the column in `enforce_column_limits`, or `if lock:` to `if not lock:` | `test_column_lock_serializes_moves_into_a_full_column` |
| Drop `select_for_update()` on the target cell's cards | `test_target_cell_lock_keeps_positions_distinct` |
| Drop `select_for_update()` on the **source** cell's cards | **Survives on PostgreSQL**; proven equivalent by argument, see below |

The source-cell sibling lock survives. It is a hand-flip, not a mutmut mutant, so a `# pragma: no mutate` cannot apply to it. Classification: proven equivalent by argument (the `select_related` join-row locks make it redundant), not mutmut-excludable; recorded here, not pragma'd. No two-transaction schedule found distinguishes it: every other writer that could touch a source sibling either takes the same card, column and swimlane row locks through the join, or takes its own sibling lock that includes the card the first move already holds. A comment on #1503 names it so that policy can say how hand-flipped guards are recorded.

Two findings came out of the test design, neither fixed here because `services/cards.py` is out of scope. First, two moves out of the *same* cell deadlock on PostgreSQL (`deadlock detected`, a 500): each holds its own card row and waits for the other's while taking the source-sibling locks, which contradicts the card-then-siblings order that `move_card` documents (#1522). Second, two concurrent moves of the *same* card return 404 for the loser, because PostgreSQL re-checks the `select_related` join against the pre-commit column row after the wait (#1523). The test accepts 200 or 404 for the loser and asserts the movement history is continuous.

Scope: this covers `move_card` and `enforce_column_limits` only. The other `select_for_update` sites (such as the column lock in `create_card`) are not yet exercised by a PostgreSQL race test; that is tracked in #1524.

With every `update_card` survivor except the #1511 label mutant killed, `cards.py` went from 185 of 243 (76.1%) to 228 of 243 (93.8%) killed in the 2026-10-07 measurement, taken before #1511. The #1511 fix and its corrected tests are expected to kill that last `update_card` mutant (which would make it 229 of 243), but mutmut was not re-run, so the figures above still count it as a survivor. The 6 guard-condition survivors counted in the 15 are killed (#1504, above), which would make it 234 of 243 (96.3%); neither adjustment was re-measured with mutmut. Either way the score is above the 90% mutation-score target for every scored category (tracked in #1503 and #1502).

With the 8 `_archive_movement` exclusions from #1503 the two numbers are, **expected and not re-measured**: raw 229 of 243 (94.2%) and adjusted 229 of 235 (97.4%), the remaining six survivors being the `select_for_update` guards. The pragmas only remove mutants, and the 8 excluded were survivors, so the killed count does not change.

The activity and notification paths in `boards/views/cards.py` (comment added with comment and mention notifications, checklist item added, deleted and toggled) have the same missing-assertion shape. They are not part of the `cards.py` score above and are unmeasured; a mutation run on `boards/views/cards.py` would be needed to know their kill rate.

### Movement model (`CardMovement`): 27 survivors left of 73 (all excluded, #1503)

Re-measured 2026-10-08 on `main` at `f6d570d55` (4 shards, lines of the class only, the six scoped test files from the table above including `test_movement_record_mutation_gaps`): 46 killed, 27 survived, none untested. The earlier baseline in this page counted 28 survivors; the difference of one is a field the tests now cover, not a different set of mutants.

All 27 survivors change a field argument that is a **schema constant**: `max_length` (+1) and `blank` (`True` to `False`) on the eight `*_name` / `*_uid` fields and on `notes`, `max_length` on `movement_type`, `db_index` on `moved_at`, `related_name="+"` on the four FKs, and the two strings and the field list of the `movement_card_moved_idx` index. They are not claimed to be unobservable (a `blank` flip changes validation and the admin change form, `max_length` the form field). They are excluded as the **schema constant guarded by `migration-check`** category in the [policy](#equivalent-mutants-and-the-score-1503): a drift against the migrations fails the CI `migration-check` job, and testing Django `_meta` directly would be brittle. The behavioral arguments (`default`, `on_delete`, `null`, `choices`, `ordering`, `db_table`) are killed and stay mutated.

#1503 marks the 27 with `# pragma: no mutate -- schema constant (migration-check)`. mutmut's pragma is per physical line, so the fields in this class are written one argument per line: that keeps the constants on their own lines and the behavioral arguments (which were killed) outside any pragma. This was checked by generating the class's mutants with pragmas ignored and with them honored: the same 73 mutants exist in both, and the 27 that disappear are exactly the 27 survivors above (nothing that was killed is excluded). Expected result: raw 46 of 73 (63.0%), adjusted 46 of 46 (100%).

### RBAC (`permissions.py`): 4 survivors left of 118 (all excluded, #1503)

Re-measured 2026-10-08 on the lines of `get_board_role` and `_is_demo_visitor` that hold them: the same four survivors, all equivalent. (The page used to say "of 74"; the module has 118 mutants, 114 of them killed.)

| Mutant | Bucket | Why |
|---|---|---|
| `break` to `continue` in the prefetched-membership scan | Equivalent, excluded | A user has at most one membership per board, so scanning on finds nothing new. |
| `getattr(settings, "DEMO_MODE", False)` default flipped to `True` | Equivalent, excluded | `DEMO_MODE` is always defined in settings. |
| `""` default flipped to `"XXXX"` in `getattr(user, "username", "")` | Equivalent, excluded | A real user always has a username. |
| `or ""` fallback flipped to `or "XXXX"` on `user.username` | Equivalent, excluded | A real user always has a non-empty username. |

The last three shared a line with mutants that tests *do* kill (the setting name, `is not`, the `or` operator, `==`), so a line-level pragma would have hidden killed mutants too. `_is_demo_visitor` is therefore written with the defaults on their own lines, and the `or` on the closing line outside any pragma. The split adds two mutants (`demo_mode = None` and `username = None`, so the module now has 120). Both are killed: a re-run over the changed lines (116 mutants honoring the pragmas, 26 killed, 0 survived; the rest belong to other lines) leaves no survivor. As with `CardMovement`, the 4 mutants that disappear under the pragmas were checked to be exactly the 4 survivors. Expected for the module (114 killed before, plus the 2 new): raw 116 of 120 (96.7%), adjusted 116 of 116 (100%); not a whole-module re-run.

### Import/export: survivors after #1453 (first 823 paired mutants: 134 survivors plus 33 suspicious)

Triaged and re-measured on 2026-10-08 (#1502): see [Head re-measure](#head-re-measure-2026-10-08-1502) above. The 2026-10-05 paired figures above predate #1496, #1507 and the other import fixes that grew the head, so they are kept as history, not as a baseline for the current code.

The tests mostly pin exact error bodies, the 500/50/100 import cap boundaries, JSON key sets and order, and the movement-history cell format. The survivors of the current head code were triaged in full in the Head re-measure section above: all 34 are equivalent or redundant.

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

## Equivalent mutants and the score (#1503)

Some modules cannot reach the target by tests alone. A survivor that no test can kill is an **equivalent mutant** (bucket two in [Survivor classification](#survivor-classification)). Without a rule, a floor either demands brittle tests of Django `_meta` internals or sits permanently below target. The rule:

- **Two numbers per module.** The **adjusted** score leaves out the mutants proven equivalent. The **raw** score keeps them in the denominator, as not detected. Both are printed by `scripts/check_mutation_score.py` and both are in the `mutmut-cicd-stats.json` artifact (`score_adjusted`, `score_raw`, `excluded`), so an exclusion is always visible.
- **The floor gates the adjusted number.** `MUTATION_MIN` ([CI pilot](#ci-pilot-backend-mutation)) is compared with the adjusted score. A low raw score is reported, never failed.
- **An exclusion is a comment in the source, with a reason.** Put `# pragma: no mutate -- <reason>` on the line. A pragma with no `-- <reason>` (at least 10 characters) is rejected by `python3 scripts/check_mutation_score.py --check-pragmas backend`, which the `mutation-score-selftest` CI job runs on every MR that touches backend Python.
- **A claim that SQLite cannot observe the mutant is excluded only with a PostgreSQL note.** That is a gap in the test setup, not a property of the code, so the reason must also say that a PostgreSQL test could kill it (the checker rejects a reason that names SQLite but not PostgreSQL). The exception is a mutant for which a PostgreSQL test is already **planned or filed**: it is not excluded and stays a survivor until that test lands. The `select_for_update` guards were that case (#1504, since merged: the guard conditions turned out to be killed on SQLite). One rule, three places: here, the triage question in [How to read the results](#how-to-read-the-results), and the checker.
- **"Schema constant guarded by `migration-check`" is its own category, not an equivalence claim.** A change to `max_length`, `blank`, `db_index` or `related_name` can be observable (a `blank` flip changes model validation and the admin change form; `max_length` changes the form field). It is excluded because CI `migration-check` fails on any drift from the migrations, which is a stronger guard than a test of Django `_meta`, not because no caller could see it. The pragma reason says `schema constant (migration-check)` for exactly this.
- **"Unobservable" means for any production input.** A reason claims the mutant cannot change behavior for any input the running system can produce (a non-null FK, a setting that is always defined, a user that always has a username). It does not claim no test could reach the line: a stub user, an `override_settings` deletion or an in-memory card with `column=None` could execute it. Say which production invariant makes it equivalent, not that it is dead.
- **Hand-flipped guards are recorded, not pragma'd.** A guard that is not a mutmut mutant (for example the sibling-row lock added by hand in `cards.py`, #1504) cannot carry a pragma. If it survives a hand-flip on PostgreSQL and is equivalent by argument, list it by name in the module's survivor table as "proven equivalent by argument, not mutmut-excludable", cite the issue, and leave it out of both the raw and the adjusted numbers: it is not in either denominator because mutmut never counted it.
- **Triage first.** An equivalence claim is only made after the three questions in [How to read the results](#how-to-read-the-results); the reason states the answer to the first one.

The import/export survivor tables above keep their "Equivalent" rows unmarked. #1502 re-measured the head and left its 34 equivalent survivors unmarked too (most share a line with killed mutants); marking them, which splits those lines, is the open step before a floor can use the adjusted score for this module.

### How mutmut 2.5.1 treats `# pragma: no mutate`

Checked on mutmut 2.5.1 (the CI pin) with a small module, and re-checked by the real-mutmut cases in `check_mutation_score.py --self-test` whenever mutmut is importable:

| Placement | Effect |
|---|---|
| Any line containing `# pragma:` followed, anywhere after it, by `no mutate` (so `# pragma: no cover, no mutate` counts) | No mutant is generated for that line. |
| Comment on `def f():` | **Only** the `def` line. The body is still mutated. |
| Comment on the last line of a multi-line call, `)  # pragma: no mutate` | Only that closing line. The argument lines above it (`max_length=10,`) are still mutated, and are the survivors you were trying to exclude. |
| Comment on the first line of a multi-line call, list or dict | Only that first line. |

So the scope is **one physical line, and the line the mutant is on**. A multi-line field definition needs the pragma on every line that carries a constant, including the closing `)` or `]` when mutmut mutates it. Check by comparing the survivor list with and without the pragma, not by eye. There is no block form in 2.5.1.

Because mutmut's cache is built from the mutants it generates, a pragma'd line has **no row at all** in `.mutmut-cache`: it is not killed, not survived, not skipped. A score computed from the cache alone would therefore silently shrink its own denominator and the raw number could not be recovered. `check_mutation_score.py --export-cache` solves this by reading the mutated source files named in the cache's `SourceFile` table and asking mutmut to enumerate their mutants twice, once as written and once with its pragma set emptied. The difference is `excluded`. Consequences:

- `excluded` is module-wide, like `total`. Every shard reports the same value, the shards must agree (exit 2 otherwise), and the merged file carries it once, not N times.
- The export step needs mutmut importable (it is, in the `backend-mutation` job). If it is not, the export exits 2 (not measured) rather than reporting a raw score equal to the adjusted one.
- The count assumes the run was not restricted to a line range by a `pre_mutation` hook that changes which lines are *generated*. The sharding hook only skips mutants after generation, so it is fine. A hand-restricted run (such as the `CardMovement` line range) can still be read from `.mutmut-cache` directly.

## How to read the results

```bash
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut results      # lists survivors by id
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut show 42      # prints the diff for mutant 42
```

The score a run reports is the **adjusted** one (excluded mutants left out), with the **raw** one beside it; see [Equivalent mutants and the score](#equivalent-mutants-and-the-score-1503). `mutmut results` and the `Mutant` table do not list pragma'd lines at all, so a survivor count read from them is already adjusted.

Status meanings: killed (a test failed, good), survived (all tests passed, look at it), timeout (the mutant made the tests hang, counted as killed by most conventions), suspicious (slow but not a timeout). Statuses are also in the `mutant` table of `.mutmut-cache` (SQLite) if you want counts: `sqlite3 .mutmut-cache "select status, count(*) from mutant group by status"`.

For each survivor, read the diff and ask in order:

1. **Can this change alter anything a caller or user could observe, for any production input?** If not (dead branch, default that is always overridden), it is an equivalent mutant. Do not write a test for it; mark it with `# pragma: no mutate -- <reason>` following the [policy](#equivalent-mutants-and-the-score-1503). A lock call that is only unobservable on SQLite is excluded only with a note that a PostgreSQL test could kill it, and stays a survivor if such a test is planned or filed (#1504). A schema constant guarded by `migration-check` is excluded as its own category (see the policy).
2. **Is the changed code reached by any test in scope?** If not, it is untested code. Either add a test or note which other suite covers it.
3. **Otherwise it is a missing assertion.** Add the smallest assertion that fails on the mutant: the exact message or key, the boundary value (`limit` and `limit + 1`), the empty-collection case, or the ordering.

Two patterns recur in this codebase. A string-literal mutant that adds `XX` around a message survives whenever a test uses `assertIn` with a fragment of the message, because the fragment is still a substring; assert the full message, or both its start and its end. A `>=` to `>` mutant on a limit survives unless a test sits exactly on the limit.

For the assertion patterns that kill these mutants, with examples, see [Writing tests that catch mutations](testing.md#writing-tests-that-catch-mutations).

## CI pilot (`backend-mutation`)

Tracked in #1384, ported from TruePPM's `api:mutation` and `scheduler:mutation`. It is a **pilot, not a gate**: it runs on the Nightly schedule only (`MUTATION_TEST=true`, never on an MR or a `main` push), both jobs are `allow_failure: true`, and `MUTATION_MIN` is unset. The report job prints the score and says the floor is unset. The floor is set later from observed scores, never chosen up front and never set to 0.

### Beachhead: `boards/permissions.py`

| | |
|---|---|
| Module | `backend/boards/permissions.py` (role and permission rule helpers) |
| Mutants | 120 (116 scored plus 4 excluded by `# pragma: no mutate`; the nightly artifact reports `total` 116 and `excluded` 4; expected after #1503, not re-measured) |
| Tests | `test_rbac`, `test_rbac_boundaries`, `test_explicit_permissions`, `test_permissions_unit_mutation_gaps` (132 tests, 44 s once, SQLite) |
| Kill rate | 96.6% raw by the manual baseline above (114 of 118, before the pilot); expected 100% adjusted and 96.7% raw (116 of 120) after #1503, not re-measured |

Why this module: it is pure rule logic with the strongest existing test files and the best baseline, so a nightly score can move because of a real change rather than noise. `boards/services/cards.py` (243 mutants, ~1.9 CPU-h) is the next candidate once this one has a record. It is not in the pilot because it would need about four times the CI time, and after #1454 the remaining survivors there are 8 dead `else ""` branches in `_archive_movement`, no longer any guard-condition survivors (killed on SQLite, see #1504; the 6 were stale since #1428), and no `update_card` survivors (the label-diff latent bug was fixed in #1511).

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
- `backend-mutation-report` sums the shards, prints the score and writes `mutmut-cicd-stats.json` (kept 30 days). It is told how many shards to expect (`--expect-shards 4`, matching `parallel: 4`) and exits 2 (yellow), even in report-only mode, if fewer stats files arrive (a shard timed out or failed before writing its file), if a file is malformed, or if mutants were left untested. It also checks that the shards are one run: every shard registers the whole module's mutants (other shards' lines as `skipped`), so every shard's `total` must be equal, and the shards' non-skipped mutants must add up to exactly that total. A stale or mismatched shard, or a shard hook that covers a line twice or not at all, is exit 2. A run that is incomplete is never summed into a smaller, apparently complete score. The merged file's `total` is the module's mutant count (not 4 x total), and on a not-measured exit 2 it is still written, with a `not_measured` key giving the reason. A floor configuration error (for example `MUTATION_MIN=95`) exits 2 before anything is read, so no merged file is written for that run. Every stats and cache path the script reads or writes goes through the shared `scripts/_paths.py` containment helper (`resolve_within(cli_roots(), path)`, #1377): it must resolve under the repo checkout, the working directory or the system temp directory. A path that escapes them (an absolute path elsewhere, a `..` climb, or a symlink pointing out) is a configuration error: the script prints `CONFIG ERROR` and exits 2 before it is read or written.
- Dependency review for mutmut 2.5.1: BSD-3-Clause; dependencies click (BSD-3), glob2 (BSD), parso (MIT), pony (Apache-2.0), junit-xml (MIT), toml (MIT); no OSV advisories for any of them on 2026-10-04. 2.x rather than 3.x because 3.x copies the tree into a sandbox (needs `also_copy` bookkeeping for every file the suite reads), which does not suit a Django suite.

### Maintainer steps and what comes next

1. After the pilot MR merges, add `MUTATION_TEST=true` to the Nightly schedule (4176726). Until then the jobs never run. `MUTATION_TEST` is in `SCHEDULE_AUDIT_ACCEPTED_GAPS` so `schedule-config-check` does not report it MISSING.
2. Remove `MUTATION_TEST` from `SCHEDULE_AUDIT_ACCEPTED_GAPS` in `.gitlab-ci.yml` once the schedule carries it (not machine-checked).
3. After about a week of nightly artifacts, set `MUTATION_MIN` one point under the lowest observed **adjusted** score (the raw one is reported, not gated, #1503), written as a fraction: a 96% low gives `MUTATION_MIN=0.95`, not `95`. The checker rejects `0` and anything outside (0, 1] (exit 2). Record the decision on #1384. #1384 stays open until then.
4. Triage survivors as described in [How to read the results](#how-to-read-the-results).

## Limits of this baseline

- Mutation operators in mutmut 2.x are shallow (operators, constants, `None` replacements). A high kill rate here does not prove the tests are strong, and a low one on string literals is partly noise.
- Kill rate depends on which tests were allowed to run. The 44 `update_card` survivors would likely drop with the view-level suites included. They are tracked in #1454.
- SQLite hides locking and concurrency behavior. The `select_for_update` guards need a PostgreSQL run (`ConcurrentMoveLockTests`, #1504).
- The `CardMovement` figure (61.6% in the baseline table) is capped by schema-constant mutants (`max_length`, `db_index`, and similar). The behavioral tests added for it cover the default type, choice labels, ordering, and `SET_NULL` retention; the rest is guarded by CI `migration-check`, not by tests. Since #1503 those mutants are excluded with a reason in the source, so the module's *adjusted* score is 100% and its *raw* score stays at about 63%; the raw number is what shows how much of the module rests on `migration-check` rather than on tests.
- A line-level pragma also removes any *killed* mutants that share its line. Keep a pragma'd line to the equivalent argument only (split a call across lines); the `excluded` count in the artifact includes everything on those lines.
- It is a point-in-time number on one commit. Re-run it before the 1.2 movement-record and permission changes merge to see how the rate moved.
