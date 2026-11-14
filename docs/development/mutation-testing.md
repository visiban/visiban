# Which tests would notice a broken line
<a id="mutation-testing-baseline"></a>

This page records the manual mutation-testing baseline on the backend modules 1.2 changes the most. The weekly `backend-mutation` CI job runs those modules and reports the merged adjusted score against a 90% floor; its report job is blocking (`allow_failure: false`, #1384), so a score under the floor, or a run that wasn't measured, turns that schedule's pipeline red.

**Why it matters:** Line coverage says a line ran. Mutation testing says whether a test would notice if the line were wrong.

**How it works:** A tool makes one small change at a time (flip `==` to `!=`, change a string, replace a value with `None`), runs the tests, and counts the change as **killed** if a test fails or **survived** if every test still passes. The kill rate is `killed / (killed + survived)`.

!!! note "Baseline is manual; a weekly CI job also runs"
    The numbers below are a **manual** baseline on the backend modules that 1.2 changes the most (movement record, RBAC, import/export). Since #1384 a CI job, `backend-mutation`, runs every one of these modules on the Weekly mutation testing schedule (Sundays, 06:00 ET), publishes a score artifact and gates the merged score at 90%. Its report job, `backend-mutation-report`, is blocking (`allow_failure: false`, #1384); the shard jobs stay `allow_failure: true` because the report judges them. See [Weekly CI job](#weekly-ci-job-backend-mutation).

## What was measured

- **Tool:** [mutmut](https://github.com/boxed/mutmut) 2.5.1. Version 2.x is used on purpose: it runs `pytest` against the source tree in place, so `pytest-django` needs no changes. It's **not** in any `requirements*.txt` and must stay out of them.
- **Date and base:** 2026-10-04, on top of `main` at `25bcfdf1e`.
- **Database:** the isolated SQLite database from `backend/.env` (no PostgreSQL). Anything that's only observable on PostgreSQL, such as row locks, can't be killed by this setup.
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
| `boards/services/cards.py` (2026-10-07 re-measure after #1454: 228 of 243, measured before the #1511 fix and not re-measured since; #1504 found the 6 guard survivors in that count are killed, so the figure is 234 of 243 (96.3%) if they are removed from it) | 243 | 166 | 68.3% | 228 | 93.8% | 0 (the 8 #1503 exclusions were deleted in #1505) | 238 of 246 = 96.7% (2026-10-09 whole-module re-measure, see [below](#whole-module-re-measure-2026-10-09); 8 survivors, none excluded) | 0 |
| `CardMovement` (`boards/models.py`; re-measured 2026-10-08, was 28 survivors / 45 killed / 61.6%) | 73 | 28 | 38.4% | 46 | 63.0% | 27 | 46 of 46 = 100% | 0 |
| `boards/permissions.py` (116 of 120 expected after #1503's two new killed mutants; 114 of 118 = 96.6% measured) | 118 | 44 | 37.3% | 114 | 96.6% | 4 | 116 of 116 tested = 100%; 116 of 117 = 99.1% counting 1 mutant that never ran (2026-10-09 whole-module re-measure, see [below](#whole-module-re-measure-2026-10-09)) | 0 |
| `boards/views/import_export.py` (2026-10-05 re-measure, first 823 paired mutants) | 1364 | 331 of 823 paired | 40.2% | 656 of 823 paired | 79.7% | 2 (export 403 `detail` key and text, #1505; the head part of this module was triaged in #1502, see the next row) | n/a | 2 (see below) |
| `boards/views/import_export.py`, head: helpers, `import_board`, `_import_json`, `import_trello` (2026-10-08, #1502; whole-region run, 0-based lines 0 to 1802; at `f898bf683`, #1449's head code unmeasured, #1546) | 1145 | n/a (not measured on the current code) | n/a | 1111 of 1145 | 97.0% | n/a (unmarked; 32 of 34 survivors are documented as equivalent or redundant below, the other 2 are `_IMPORT_BACKFILL_BATCH` survivors tracked in #1545) | n/a | 2 (killed by timeout, see below) |
| `boards/views/import_export.py`, `_import_csv` + `export` + `export_history` (2026-10-06, #1484) | 492 | 290 of 492 | 58.9% | 465 of 492 (447 with the #1453 tests only) | 94.5% (90.9%) | 2 (export 403 `detail` key and text, #1505; #1502 covers only the head, the 27 survivors of this region are triaged below as equivalent or covered elsewhere, and none is marked with a pragma; deciding pragma exclusions has no owner other than #1547) | n/a | 0 |

**The 2 timeouts** in the 2026-10-05 row: both are in `_imported_board_name`, in the first run's range. Mutating the `if candidate not in taken` check or the `n += 1` step makes its uniqueness loop spin forever, so pytest hangs and mutmut kills the run. Timeouts are counted as killed. The 2026-10-06 run (`_import_csv`, `export`, `export_history`) had none.

Import/export was re-measured on 2026-10-05 against `main` at `a5e4b7d20`, after the module was rewritten (selective import #119, naming #1446). The module now has **1364 mutants** (it had 1078 at `25bcfdf1e`), so the 2026-10-04 figure isn't comparable. "Before" is the five scoped files only; "after" adds `test_import_export_mutation_gaps.py` (#1453).

**The 2026-10-05 measurement is a partial, paired measurement, not a whole-module run.** The 2026-10-06 run below (#1484) measures the remainder. Sixteen shards (8 before, 8 after) were started on one laptop that was swapping (about 23 of 24 GB swap, load average above 250), and the after run reached about 60% of the module before being stopped. Mutants are processed in file order, so the paired set covers lines up to the middle of `_import_csv` and **doesn't reach `export` or `export_history`**. Only mutants that have a verdict in both runs are compared (823 of 1364):

| Region (paired mutants) | Before killed | After killed |
|---|---:|---:|
| helpers and `import_board` (305) | 87 (28.5%) | 236 (77.4%) |
| `_import_json` (436) | 227 (52.1%) | 372 (85.3%) |
| `import_trello` (54) | 1 (1.9%) | 37 (68.5%) |
| `_import_csv` (28, sample only) | 16 | 11 (15 more are suspicious, not counted as killed) |
| **Total (823)** | **331 (40.2%)** | **656 (79.7%)** |

The before run alone tested 1138 of 1364 mutants: 474 killed, 637 survived, 27 suspicious (41.7%).

- **`export`** was reached only by that before run, which stopped early (38 killed, 32 survived of 70 tested). The 2026-10-06 run below measures it in full.
- **Suspicious mutants** count as survivors in the rates above (the 79.7% and the 40.2% use this convention). The head's 97.0% and the 2026-10-06 rows count them as killed, so those figures aren't directly comparable.
- **Timeouts** count as killed. The 2 in the table are both from the after run, in the `_imported_board_name` uniqueness loop (mutating `if candidate not in taken` or `n += 1` makes the loop never return), so "656 killed after" is 654 killed plus those 2. The before run had no timeouts in the paired set.

### Remainder re-measure (2026-10-06, #1484)

Run on `main` at `4a5de6273` (`import_export.py` is unchanged since `a5e4b7d20`), 0-based line range `MM_LO=1317 MM_HI=2118`: the whole of `_import_csv`, `export` and `export_history`. Mutants with a verdict are all 492 mutants in range; none were left untested, suspicious or timed out. The machine (18 cores, 64 GB) wasn't swapping: four shards for each of "before" and "after" (8 processes), then 8 shards for the final run, load average 9 to 15. "Before" and "after" use the same five and six test files as above, so the numbers are comparable; the final column adds the #1484 tests to the gaps file.

| Region (mutants) | Before killed | After #1453 killed | After #1484 killed |
|---|---:|---:|---:|
| `_import_csv` (240) | 142 (59.2%) | 208 (86.7%) | 220 (91.7%) |
| `export` (229) | 137 (59.8%) | 224 (97.8%) | 225 (98.3%) |
| `export_history` (23) | 11 (47.8%) | 15 (65.2%) | 20 (87.0%) |
| **Total (492)** | **290 (58.9%)** | **447 (90.9%)** | **465 (94.5%)** |

Together with the 2026-10-05 table, the regions the first run couldn't reach have now been measured after #1453. The two runs were made on different days and the first covered only the mutants that had a verdict in both its before and after run, so the two tables aren't summed into one whole-module percentage.

### Head re-measure (2026-10-08, #1502)

> **Scope of these figures.** Everything in this section describes the code at `f898bf683`, not current `main`. Code added after that commit is **not** in the 1145 measured mutants and hasn't been measured: that includes the roughly 140 lines #1449 added to the head: `_csv_custom_columns`, `_swimlane_values_from_rows`, `_csv_cell_value`, `_cap_warnings`, `_is_canonical_number`, and a change to `_csv_custom_field_cell` (`_import_field_values` and `_csv_custom_field_cell` themselves already existed at `f898bf683` and were measured). Measuring them is tracked in #1546. The head figures are for the `f898bf683` code, and the new head lines are unmeasured. The `MM_HI=1802` boundary and "`_import_csv` at 0-based line 1803" below are likewise valid only at `f898bf683`. Before reusing `MM_LO`/`MM_HI`, re-derive the range (`grep -n 'def _import_csv' backend/boards/views/import_export.py`, then subtract 1 to get the 0-based line), as the `update_card` section does.

The head of `import_export.py` (everything before `_import_csv`) was measured as **one whole-region run**, not a paired sample: 12 shards of the sharded variant in [Parallel runs](#parallel-runs), `MM_LO=0 MM_HI=1802` (0-based; `_import_csv` starts at 0-based line 1803), on `main` at `f898bf683` plus this branch's tests, 18-core machine. The module had grown to 2609 lines since the 2026-10-05 run (selective import, #1496, #1507), so the head has **1145 mutants**, not the 795 of the paired set. The runner used these nine files (all backend import/export tests; the full suite isn't needed): `test_import_export_head_gaps.py test_import_export_mutation_gaps.py test_import.py test_import_naming.py test_import_options.py test_import_user_scope.py test_import_custom_fields.py test_trello_import.py test_import_json_value_validation.py`.

Two details of the harness matter if you repeat this:

- `test_import.py::test_csv_import_accepts_committed_sample_csv` reads `sample-boards/` from the repository root, so each throwaway copy of `backend/` needs `sample-boards/` next to it, or the baseline run fails and mutmut tests nothing.
- mutmut 2.5.1 registers one extra mutant (id one past the printed total, line 422, `mutmut show` prints nothing for it) that every shard reports as `untested`. It has no diff, so it isn't counted in the 1145 and not a gap.

Line numbers in the region column are **1-based and inclusive**; the `MM_LO`/`MM_HI` range above is 0-based. So `1673 to 1803` here is 0-based 1672 to 1802, and `_import_csv` starts at 1-based line 1804 (0-based 1803).

| Region (1-based lines) | Mutants | Killed, first whole-region run | Killed, final run | Survivors left |
|---|---:|---:|---:|---:|
| helpers and `import_board` (to line 949) | 574 | 523 (91.1%) | 559 (97.4%) | 15 |
| `_import_json` (950 to 1672) | 440 | 416 (94.5%) | 427 (97.0%) | 13 |
| `import_trello` and `_broadcast_imported_board` (1673 to 1803) | 131 | 120 (91.6%) | 125 (95.4%) | 6 |
| **Head** | **1145** | **1059 (92.5%)** | **1111 (97.0%)** | **34** |

"First whole-region run" already includes the 538-line `test_import_export_head_gaps.py` of the first #1502 commit; "final run" adds the boundary, default and tail tests of this pass (`EchoBoundTests`, `CardRowsAndUsernamesTests`, `TimestampErrorTests`, `WriteGuardLogTests`, `ValidateValuesBoundaryTests`, `ImportJsonTailTests`, `ImportTrelloTailTests`, `ImportOpenApiResponseTests`). The final figure is the second whole-region run, except that two lines (the write-guard log and the Trello archived count, 0-based 806 and 1786) were re-run on their own after their tests were tightened; both mutants that changed are now killed. Killed counts include the 2 timeouts and 6 slow kills (below).

**The 33 suspicious mutants.** mutmut 2.5.1 marks a mutant `suspicious` when a test *failed* (so it's killed) but the run took more than twice the cached baseline time. The 2026-10-05 run did that on a swapping laptop (load average above 250), which is where the 33 came from. In this run six were suspicious (`swimlane["name"]` in the custom-field value copy, `description` and `created_at` key names, `to_column` `or` to `and`, `dry_run = None`, `event_id = None`); re-run alone on a quiet machine each is still `suspicious`, so they are killed late in the file order, not flaky. They are counted as killed. None survives.

**The 2 timeouts** are the `_imported_board_name` uniqueness loop (`if candidate not in taken` inverted, `n += 1` replaced with `n = 1`). Both make the loop spin forever, so they are a real kill by timeout, as in the 2026-10-05 run. They aren't made faster: the hang is the observable behavior.

#### Survivors left (34): 32 equivalent or redundant, 2 tracked in #1545

The 2 `_IMPORT_BACKFILL_BATCH` survivors could be killed by a PostgreSQL test (#1545, open), so they stay survivors under the policy below. The other 32 are equivalent or redundant; none is a missing assertion.

- They're listed so the next person doesn't re-triage them.
- None is marked with `# pragma: no mutate` yet. Most share a line with mutants that *are* killed, and the policy asks that a pragma cover the equivalent mutant only. Marking them is tracked in #1544.
- The nightly 90% floor doesn't need it: the floor is met with these 32 counted as survivors (see [Expected score](#expected-score)). Marking them would only make this module's adjusted score exact.

| Mutants | Where | Why no test can kill it |
|---:|---|---|
| 1 | `_EXPORT_ROLE_RANK` `ADMIN: 3` to `4` | The rank is only compared with another rank from the same dict, so any order-preserving value is equivalent. |
| 1 | `export_min_role or "viewer"` | An unknown threshold falls back to rank 0 through `.get(threshold, 0)`, which is what `viewer` maps to. |
| 1 | `_query_flag` default `""` to `"XXXX"` | Neither is in `("true", "1")`. |
| 1 | `_IMPORTED_NAME_MAX_SUFFIX` 12 to 13 | A shorter `startswith` head only widens the database query; the exact comparison is in Python. |
| 2 | `_IMPORT_BACKFILL_BATCH` 500 to 501 and to `None` | On SQLite `bulk_update` caps its own batch size at 499 (`connection.ops.bulk_batch_size`), so the constant isn't observable here; `test_timestamp_backfill_runs_in_batches_of_500` pins two UPDATEs for 501 rows. A PostgreSQL test could kill it. |
| 1 | `"unknown line"` text in `_json_import_write_guard` | The generator frame of the guard is always one of the importer frames, so `frames` is never empty. |
| 2 | `403` documented response on `import_board` and on `import_trello` (1 each) | `drf-spectacular` emits an object-typed `403` entry for the action anyway (`ImportOpenApiResponseTests` passes with the line mutated), so the generated document is unchanged. |
| 5 | `MAX_UPLOAD_SIZE` default `10 * 1024 * 1024` | `settings.MAX_UPLOAD_SIZE` is always defined, so the `getattr` default is never used. |
| 2 | `file.name` and `file.content_type` fallbacks to `"XXXX"` | `"XXXX"` ends in neither `.json`/`.csv` nor contains `json`/`csv`, same as `""`. |
| 1 | `data.get("schema_version", 0)` to `1` | Both are within the supported range and only a version above 2 logs a warning. |
| 4 | `_str_keys` names for `movements` | Redundant with the value-level check in `_validate_json_import_values`, which returns the same message for the same input. (`moved_by`, the one key it doesn't cover, is killed.) |
| 2 | `.get("name", "")` in `_valid_col_names` / `_valid_sw_names` | A column or swimlane without a string `name` is rejected by the shape check before this line. |
| 2 | `not column or not swimlane` to `and`, `continue` to `break` | Every card's column and swimlane was checked against the definitions above, so the lookup can't fail. Defensive code. |
| 1 | `card_data.get("priority", "medium")` sentinel | An unrecognized priority falls back to `medium` on the next line. |
| 1 | `act_data.get("event_type", "")` sentinel | Neither value is a valid event type, so the activity is skipped either way. |
| 2 | `distinct=False` on `_card_count` and `_archived_card_count` | The imported board has one membership, so the join can't duplicate card rows. (`_member_count` `distinct=False` is killed by `test_response_counts_distinguish_active_and_archived_cards`.) |
| 5 | Trello `file.size is not None`, `file.read(max_size + 1)` and the `'name' must be a string` response | `file.size` is always set for an upload and the `Content-Length` check precedes the bounded read; the endpoint takes `MultiPartParser` only, so `name` is always a string. Defense in depth. |

*Update 2026-10-24 (#1725):* the `export_min_role or "viewer"` mutant is now killed. An unrecognized threshold is treated as admin-only, so `ExportHelperUnitTests::test_can_export_at_min_role` fails on `or "XXviewerXX"`.

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

### Whole-module re-measure (2026-10-09)

Re-measures the two rows that were marked "expected, not re-measured". Run with mutmut 2.5.1 on throwaway copies of `backend/` at `b90447652` (`cards.py` in 8 shards, `permissions.py` in 4, `line_index % N` sharding, SQLite, `-x` per mutant). Both modules are byte-identical on `main` at `e8be1a22f`. `cards.py` ran against the full test list in the table above (scoped files, the view suites and both gap files); `permissions.py` against its four scoped files. Counts are summed over the shards' `.mutmut-cache` files.

| Module | Mutants | Killed | Survived | Untested | Kill rate |
|---|---:|---:|---:|---:|---:|
| `boards/services/cards.py` | 246 | 238 | 8 | 0 | 96.7% |
| `boards/permissions.py` | 117 | 116 | 0 | 1 | 99.1% (100% of the 116 that ran) |

- **`cards.py` survivors (8), not yet classified.** They sit on lines 217 and 218 (the `CARD_MUTATION_HOOKS` failure log's format string and its `__qualname__` argument), 329 and 330 (`check_wip=True`, `check_weight=True` and `lock=True` in a signature), 364 (`weight_enforced = check_weight and board.enforce_weight_limits`), 422 and 935 (`force=False` in two service signatures), and 460 (a call passing `lock=False`). The `lock` mutants are the kind the [PostgreSQL re-run](#postgresql-re-run-of-the-select_for_update-guards-1504) shows survive on SQLite; the others haven't been triaged. The #1511 label mutant isn't among them.
- **`permissions.py` untested mutant (1).** Mutant 117, on the `group_roles = dict(...)` statement (line 316, the closing `)`), was registered in the cache of every shard but never run, and `mutmut show 117` prints nothing for it. It was later explained as a mutmut 2.5.1 **phantom** row (see [How it works](#how-it-works) under the nightly job): no such mutant exists, and the export now drops it. Here it was reported as untested rather than as killed, so the raw rate is 116 of 117; without the phantom it's 116 of 116. The module has 117 mutants here against 118 in the baseline row; the two counts weren't reconciled, because the cache omits lines carrying `# pragma: no mutate`.

## Survivor classification

Every survivor was put in one of three buckets:

- **Missing assertion:** the code is exercised but no test checks the value. Fix by adding an assertion. These were fixed for the movement-record and RBAC paths.
- **Equivalent mutant:** the change can't alter observable behavior in this setup, for any production input, so no test can kill it. Mark it with `# pragma: no mutate -- <reason>` under the [policy](#equivalent-mutants-and-the-score-1503) rather than leaving it as a survivor.
- **Untested code:** no test in the scoped files reaches the line, or reaches it without checking the result. Needs new tests or a decision that it's covered elsewhere.

### Movement service (`cards.py`): 9 survivors left of 77 (measured before #1511; the 6 guard survivors were re-checked in #1504)

Measured 2026-10-07 (#1454) with the line range of `update_card` only, run in 8 shards against the scoped files, then against the scoped files plus the view suites listed in the table above, then with `test_card_service_mutation_gaps.py` added to each. The 14 survivors outside `update_card` are unchanged from the #1443 baseline: 8 `_archive_movement` equivalents and 6 guard-condition mutants. #1504 (2026-10-08) re-checked the six guard mutants against the current code and found them killed, so the survivor count is now 9 (8 equivalent plus the #1511 label mutant, also now fixed) and the 77-mutant table below adds up to 77 with the new bucket.

| Bucket | Count | Detail |
|---|---:|---|
| Missing assertion, **fixed** (#1454) | 43 | The 44 `update_card` survivors of the #1443 baseline: per-field `CardActivity` rows (title, priority, weight, assignee, description, labels, due date), the assignment and mention notification contents, the weight-increase limit check, and the `force` default. The view suites (`test_views_cards`, `test_notifications`, `test_card_timeline` and the others in the table above) already killed 25 of them; `test_card_service_mutation_gaps.py` kills the other 18, and on its own with the scoped files kills 40 of the 44. |
| Latent bug, **fixed** (#1511) | 1 | `parts.append(f"-{', '.join(names)}")` in the label diff (`'XX, XX'.join(names)`). The removed label names were looked up in the labels on the card *after* the write, so the list was always empty and the activity row for a removal read `-` with no name. That was a real bug, not an equivalent mutant. #1511 resolves removed names from the pre-write label snapshot, and `test_removed_labels_are_listed_with_minus`, `test_several_removed_labels_join_with_comma_space` and `test_add_and_remove_in_one_update` now pin the corrected output, so the mutant dies. |
| Equivalent, **deleted** (#1505) | 8 | `_archive_movement` fell back to `""` when `card.column` or `card.swimlane` was `None`. Both foreign keys are non-null on `Card` and every caller passes a persisted card, so the branch was unreachable. #1505 deleted the 8 fallbacks (and the #1503 pragmas with them). Mutant counts, enumerated with mutmut 2.5.1 (mutant counts only; the test suite wasn't re-run against them, so kill rates aren't re-measured; re-measuring is part of the nightly baseline work in #1384): `cards.py` goes from 246 honored / 254 raw on `main` to 246 / 246, exactly the 8 pragma'd mutants gone, i.e. 8 fewer than `main` (254 to 246 raw). |
| Guard condition, **no longer a survivor** (#1504) | 6 | The original six sat on the `column_changed and ((wip_enforced and ...wip_limit is not None) or (... weight_limit is not None))` condition in `move_card` (lines 614-616 at baseline `25bcfdf1e`), which has exactly six `and`/`or`/`is not` mutation points. #1428 moved that condition into `enforce_column_limits` (`wip_applies`, `weight_applies` and `if not (wip_applies or weight_applies)`). Applying the six analog mutants by hand on SQLite on 2026-10-08, all six are killed (`RoleAllowListTests` in `test_card_services.py` and `WipEnforcementTests` in `test_wip_enforcement.py`, including `test_hard_mode_applies_even_when_soft_enforcement_is_off`). The old "equivalent here, needs PostgreSQL" label was wrong for these, and had been stale since #1428. Separately, #1504 adds PostgreSQL race tests for the real lock calls; see [PostgreSQL re-run (#1504)](#postgresql-re-run-of-the-select_for_update-guards-1504). |
| Missing assertion, fixed (#1443) | 19 | Creation-movement origin fields, the `position` bypass guard in `update_card`, the `or 0` weight fallback on an empty column, the role-hint rejection warning, the restore ownership message, the delete broadcast payload, and the create-time mention notification. |

#### PostgreSQL re-run of the `select_for_update` guards (#1504)

> **Lock sites changed in #1522 (2026-10-09).** The measurements below are against the pre-#1522 code and stay as the record of that run, but the lock sites they name no longer exist. `move_card` no longer locks the card with a `select_related` join, and no longer has separate source- and target-sibling locks. It now reads the card unlocked and locks the card plus both cells in **one** pk-ordered statement (`_lock_move_cells`). It then locks the source and target column rows in one pk-ordered `FOR NO KEY UPDATE` statement (`_lock_move_columns`) on every move (since #1567; a same-cell reorder locks its one column); `enforce_column_limits` is called with `lock=False`. If the card changed between the read and the lock, the attempt is retried. `ColumnViewSet.reorder` locks the board's columns in pk order too. See [What #1522 changed](#what-1522-changed) below. Re-measuring these mutants is part of the nightly baseline work in #1384.

Measured 2026-10-08. `ConcurrentMoveLockTests` (`test_concurrent_moves.py`, skipped unless `connection.vendor == "postgresql"`) holds one move open inside its transaction, at a point after it took its locks and before it commits, and starts a second move while the first is held. With the locks the second move queues; without them it runs against stale state. The three tests cover the card-row lock (two moves of one card must produce a continuous movement chain), the target-column lock in `enforce_column_limits` (a hard WIP limit must not be exceeded by two racing moves) and the target-cell sibling lock (two cards entering one occupied cell must not end at the same position).

Second, separate set (a re-derivation, **not** the original six): mutmut 2.5.1 generated six mutants on the lines that carry the real lock calls (0-based lines 330, 372-373, 740-744, 816-819 and 827-830 at `f6d570d55`), ids 35, 168, 169, 170, 188 and 193: `lock=True` to `lock=False`, `select_related("column", ...)` and `select_related(..., "swimlane")` to `XX...XX`, the locked card read replaced by `None`, and `order_by("pk")` to `order_by("XXpkXX")` on the source and target sibling locks. mutmut can't delete the `.select_for_update()` call or negate `if lock:`, so the lock calls themselves were flipped by hand instead.

| Mutant | SQLite, scoped files | PostgreSQL, `ConcurrentMoveLockTests` |
|---|---|---|
| `lock=True` to `lock=False` (`enforce_column_limits`) | **Survives** (since killed on SQLite by a spy on `select_for_update`, #1931: [details](#remaining-cards-and-card_movement-survivors-1931)) | Killed by `test_column_lock_serializes_moves_into_a_full_column` |
| `select_related` name mutants (2), card read replaced by `None`, `order_by("XXpkXX")` (2) | Killed (`FieldError` or `AttributeError` on any database) | Killed |

| Hand-flipped guard | Killed by |
|---|---|
| Drop `select_for_update()` on the card read in `move_card` | `test_card_row_lock_serializes_two_moves_of_the_same_card` |
| Drop `select_for_update()` on the column in `enforce_column_limits`, or `if lock:` to `if not lock:` | `test_column_lock_serializes_moves_into_a_full_column` |
| Drop `select_for_update()` on the target cell's cards | `test_target_cell_lock_keeps_positions_distinct` |
| Drop `select_for_update()` on the **source** cell's cards | **Survives on PostgreSQL**; proven equivalent by argument, see below |

The source-cell sibling lock survives. It's a hand-flip, not a mutmut mutant, so a `# pragma: no mutate` can't apply to it. Classification: proven equivalent by argument (the `select_related` join-row locks make it redundant), not mutmut-excludable; recorded here, not pragma'd. No two-transaction schedule found distinguishes it: every other writer that could touch a source sibling either takes the same card, column and swimlane row locks through the join, or takes its own sibling lock that includes the card the first move already holds. A comment on #1503 names it so that policy can say how hand-flipped guards are recorded.

Two findings came out of the test design, neither fixed in #1504 because `services/cards.py` was out of scope. First, two moves out of the *same* cell deadlocked on PostgreSQL (`deadlock detected`, a 500): each held its own card row and waited for the other's while taking the source-sibling locks (#1522, now fixed, see below). Second, two concurrent moves of the *same* card returned 404 for the loser, because PostgreSQL re-checked the `select_related` join on the locked read against the pre-commit column row after the wait (#1523). Since #1522 the locked read has no join, and a card that changed before its lock is re-read, so the loser gets 200 (or 409 when it sent a stale `version`). #1523 tightened the test to require 200 and added `test_same_card_move_race.py`, which also guards that the locked statement carries no join (`of=("self",)` alone doesn't prevent the drop-out).

#### What #1522 changed

- **Card rows:** one pk-ordered `SELECT … FOR UPDATE OF cards` covering the moved card and every card in its source and target cells (`_lock_move_cells`). Locking the card first and its siblings afterwards was the deadlock. The source-sibling lock that survived as "equivalent" above is now part of this single statement, so it can no longer be flipped on its own.
- **Re-check and retry:** the card is read unlocked, because its cell is only known after the read. Under the lock, the fields the gates and the lock depend on (version, column, swimlane, assignee, creator) are compared with that read. On any difference the attempt's savepoint is rolled back, which releases its locks, and the move is retried. After three attempts it returns `409 version_conflict`.
- **Column rows:** after the card rows, the source and target columns are locked in one pk-ordered `FOR NO KEY UPDATE` statement (`_lock_move_columns`) on every move; since #1567 that includes a reorder within one cell, which locks its single column. The `CardMovement` insert needs `FOR KEY SHARE` on both columns. A column reorder holds `FOR UPDATE` on every column, because `position` is part of a unique key. A plain `FOR UPDATE` limit lock blocks key-share locks. Any of these taken out of a shared order deadlocks. `enforce_column_limits` and `create_card` lock the column `FOR NO KEY UPDATE`, and `ColumnViewSet.reorder` locks its columns in pk order.
- **Tests, and what each one actually guards** (all verified on PostgreSQL):
  - `test_two_moves_out_of_the_same_cell_do_not_deadlock`, `…_in_reverse_pk_order_…` and `test_opposite_moves_between_two_cells_do_not_deadlock` fail with `deadlock detected` on origin/main. They pass once the card rows are locked in one pk-ordered statement (`_lock_move_cells`). They pass with any lock order that every move shares, so they don't pin the pk order.
  - `test_opposite_moves_between_limited_columns_do_not_deadlock` passes on origin/main, where the `select_related` join lock serialized the moves. It failed on the intermediate revision 2b12e2a02, which locked only the target column, with `FOR UPDATE`. On the current code it passes whether the column lock is `FOR UPDATE` or `FOR NO KEY UPDATE`.
  - `test_move_into_a_limited_column_does_not_deadlock_with_a_column_reorder` passes on origin/main and fails on 2b12e2a02. It passes once the move locks its source and target columns (`_lock_move_columns`), even without the reorder-side change.
  - `test_move_locks_cards_then_columns_in_pk_order` and `test_column_reorder_locks_columns_in_pk_order` fail on origin/main. They are the only tests that pin the pk ordering, the `FOR NO KEY UPDATE` column mode and the reorder's pk-ordered column lock, none of which a two-transaction race distinguishes from a consistent alternative.
  - The same-card test now holds on `_lock_move_cells`.
- **Cards committed into a locked cell (#1567):** the card-row statement locks only the rows in its pre-wait snapshot. After taking the column rows (now on every move, including a same-cell reorder), `move_card` re-reads its cells (`_require_cells_locked`) and retries if a card in them is unlocked. `test_move_cell_arrival_race.py` fails with `deadlock detected` without the re-check; the SQLite-runnable `MoveLockRevalidationTests` cases in `test_card_services.py` pin the retry and its 409 bound.
- **Known gaps (tracked):** `create_card` against a column reorder (which predates #1522) was fixed in #1566 and is covered by `test_card_create_reorder_race.py`.

Scope: this covers `move_card` and `enforce_column_limits` only. The other `select_for_update` sites are exercised by PostgreSQL race tests in `test_concurrent_lock_sites.py` (#1524: the column lock in `create_card`, the board-row locks on column/swimlane/custom-field create and swimlane reorder, the invite cap and revoke locks, the card-relation lock) and `test_card_create_reorder_race.py` (#1566: the column reorder's board lock against a column create, and a card create against a reorder); the same-card move race is covered by `test_same_card_move_race.py` (#1523).

With every `update_card` survivor except the #1511 label mutant killed, `cards.py` went from 185 of 243 (76.1%) to 228 of 243 (93.8%) killed in the 2026-10-07 measurement, taken before #1511. The #1511 fix and its corrected tests are expected to kill that last `update_card` mutant (which would make it 229 of 243), but mutmut wasn't re-run, so the figures above still count it as a survivor. The 6 guard-condition survivors counted in the 15 are killed (#1504, above), which would make it 234 of 243 (96.3%); neither adjustment was re-measured with mutmut. Either way the score is above the 90% mutation-score target for every scored category (tracked in #1503 and #1502).

With the 8 `_archive_movement` exclusions from #1503 the two numbers are, **expected and not re-measured**: raw 229 of 243 (94.2%) and adjusted 229 of 235 (97.4%), the remaining six survivors being the `select_for_update` guards. The pragmas only remove mutants, and the 8 excluded were survivors, so the killed count doesn't change. **Update (#1505):** the 8 excluded lines were deleted instead, so there's no `# pragma: no mutate` in `_archive_movement` and the module has 246 mutants (8 fewer than the 254 raw on `main`), enumerated with mutmut 2.5.1 (mutant counts only; the test suite wasn't re-run against them, so kill rates aren't re-measured; re-measuring is part of the nightly baseline work in #1384). The expected figure is 229 of 246 raw and adjusted alike, not re-measured.

The activity and notification paths in `boards/views/cards.py` (comment added with comment and mention notifications, checklist item added, deleted and toggled) have the same missing-assertion shape. They aren't part of the `cards.py` score above and are unmeasured; a mutation run on `boards/views/cards.py` would be needed to know their kill rate.

### Movement model (`CardMovement`): 27 survivors left of 73 (all excluded, #1503)

Re-measured 2026-10-08 on `main` at `f6d570d55` (4 shards, lines of the class only, the six scoped test files from the table above including `test_movement_record_mutation_gaps`): 46 killed, 27 survived, none untested. The earlier baseline in this page counted 28 survivors; the difference of one is a field the tests now cover, not a different set of mutants.

All 27 survivors change a field argument that's a **schema constant**: `max_length` (+1) and `blank` (`True` to `False`) on the eight `*_name` / `*_uid` fields and on `notes`, `max_length` on `movement_type`, `db_index` on `moved_at`, `related_name="+"` on the four FKs, and the two strings and the field list of the `movement_card_moved_idx` index. They aren't claimed to be unobservable (a `blank` flip changes validation and the admin change form, `max_length` the form field). They are excluded as the **schema constant guarded by `migration-check`** category in the [policy](#equivalent-mutants-and-the-score-1503): a drift against the migrations fails the CI `migration-check` job, and testing Django `_meta` directly would be brittle. The behavioral arguments (`default`, `on_delete`, `null`, `choices`, `ordering`, `db_table`) are killed and stay mutated.

#1503 marks the 27 with `# pragma: no mutate -- schema constant (migration-check)`. mutmut's pragma is per physical line, so the fields in this class are written one argument per line: that keeps the constants on their own lines and the behavioral arguments (which were killed) outside any pragma. This was checked by generating the class's mutants with pragmas ignored and with them honored: the same 73 mutants exist in both, and the 27 that disappear are exactly the 27 survivors above (nothing that was killed is excluded). Expected result: raw 46 of 73 (63.0%), adjusted 46 of 46 (100%).

### RBAC (`permissions.py`): 4 survivors left of 118 (all excluded, #1503)

Re-measured 2026-10-08 on the lines of `get_board_role` and `_is_demo_visitor` that hold them: the same four survivors, all equivalent. (The page used to say "of 74"; the module has 118 mutants, 114 of them killed.)

| Mutant | Bucket | Why |
|---|---|---|
| `break` to `continue` in the prefetched-membership scan | Equivalent, excluded | A user has at most one membership per board, so scanning on finds nothing new. |
| `getattr(settings, "DEMO_MODE", False)` default flipped to `True` | Equivalent, excluded | `DEMO_MODE` is always defined in settings. |
| `""` default flipped to `"XXXX"` in `getattr(user, "username", "")` | Equivalent, excluded | A real user always has a username. |
| `or ""` fallback flipped to `or "XXXX"` on `user.username` | Equivalent, excluded | A real user always has a non-empty username. |

The last three shared a line with mutants that tests *do* kill (the setting name, `is not`, the `or` operator, `==`), so a line-level pragma would have hidden killed mutants too. `_is_demo_visitor` is therefore written with the defaults on their own lines, and the `or` on the closing line outside any pragma.

- **The split adds two mutants** (`demo_mode = None` and `username = None`, so the module now has 120). Both are killed: a re-run over the changed lines (116 mutants honoring the pragmas, 26 killed, 0 survived; the rest belong to other lines) leaves no survivor.
- **As with `CardMovement`,** the 4 mutants that disappear under the pragmas were checked to be exactly the 4 survivors.
- **Expected for the module** (114 killed before, plus the 2 new): raw 116 of 120 (96.7%), adjusted 116 of 116 (100%). Not a whole-module re-run.

### Import/export: survivors after #1453 (first 823 paired mutants: 134 survivors plus 33 suspicious)

Triaged and re-measured on 2026-10-08 (#1502): see [Head re-measure](#head-re-measure-2026-10-08-1502) above. The 2026-10-05 paired figures above predate #1496, #1507 and the other import fixes that grew the head, so they are kept as history, not as a baseline for the current code.

The tests mostly pin exact error bodies, the 500/50/100 import cap boundaries, JSON key sets and order, and the movement-history cell format. The survivors of the current head code were triaged in full in the Head re-measure section above: all 34 are equivalent or redundant.

### Import/export: `_import_csv`, `export`, `export_history` after #1484 (27 survivors of 492)

Triaged with the three questions in [How to read the results](#how-to-read-the-results). The 18 additional kills from #1484 (45 survivors after #1453, 27 now) come from `test_import_export_mutation_gaps.py` (`ImportCsvTailGapTests`, `ExportGapTests`, `ExportHistoryGapTests`: the lowercase `labels` header, absent optional columns, a repeated label in one cell, the response `member_count`/`card_count`/`archived_card_count`, the group id, `?expand=group` and group broadcast on a grouped import, the `Movement History` cell for a movement with no destination column, the unpaginated `export-history` fallback, and the OpenAPI summary and description). All 27 remaining survivors are equivalent or covered elsewhere:

| Survivors | Count | Bucket | Why |
|---|---:|---|---|
| `file.name or ""` default (line 1433) | 1 | Equivalent | An uploaded file always has a name. |
| `column_map` / `swimlane_map` / `label_map` placeholder `None` to `""`, and `col_name and ...` to `or` (lines 1465-1477) | 5 | Equivalent | The required-field check above rejects an empty column or swimlane, and every placeholder is overwritten with the created object before it's read. Re-assigning an existing key keeps dict order. |
| `not column or not swimlane` to `and`, `continue` to `break` (lines 1522-1523) | 2 | Equivalent, **deleted** (#1505; mutant counts in the note below, kill rates not re-measured) | Every column and swimlane name was just created, so the lookup can't fail. The guard was removed and the lookups index the maps directly. The JSON-import twin of this guard (card loop in `_import_json`) was deleted too: card references are validated against the payload's definitions, and the maps are keyed by exactly those names. |
| `row.get("Priority", "medium")` and `row.get("Weight", "1")` sentinel defaults (lines 1525, 1533) | 2 | Equivalent | A sentinel such as `XXmediumXX` isn't a valid priority or integer, so the existing fallback to `medium` and `1` produces the same card. |
| `row.get("Labels", "")` in the second pass (line 1574) | 1 | Equivalent | A sentinel label name is never in `label_map`, so nothing is attached. (The first-pass default, line 1469, was a real gap and is killed.) |
| `(row.get("Assignee") or "")` sentinels (lines 1516, 1530) | 2 | Equivalent in practice | Only observable if a user is literally named `XXXX`. |
| `row.get(field, "")` and `row.get("Column"/"Swimlane", "")` defaults (lines 1399, 1415, 1416) | 3 | Equivalent | `Title`, `Column` and `Swimlane` are required headers, so the key is always present and the default is never used. The value is another matter: `csv.DictReader` fills missing trailing cells with `None`. A short row makes `.get(field, "")` return `None`, so `.strip()` raises; tracked in #1496. |
| `CSV file has no headers.` key and text (line 1383) | 2 | Equivalent, **deleted** (#1505; mutant counts in the note below, kill rates not re-measured) | `DictReader` has no fieldnames only when it yields no rows, which the earlier `CSV file is empty.` check rejects (a BOM-only, whitespace-only or header-only file all give no rows or a list). The branch and the dead `fieldnames is not None` guard before it were removed. |
| `distinct=False` on `_card_count` and `_archived_card_count` (lines 1608-1609) | 2 | Equivalent | The imported board has one membership, so the join can't duplicate card rows. (`_member_count` `distinct=False` and the `isnull` filters were real gaps and are killed.) |
| 403 body `detail` key and text for a role outside the four member roles (line 1658) | 2 | Equivalent, **kept as a guard and excluded** (#1505, #1503; the pragma removes these 2 mutants, see the counts below) | `get_board_for_user` returns only the four roles or `SITE_ADMIN`, so no request reaches it via the API. It stays as a fail-closed permission guard against a stored role outside the enum (the column has no DB constraint), and the `detail` line carries `# pragma: no mutate` because killing it needs a patched-role or DB-level test. |

**Mutant counts for #1505** (enumerated with mutmut 2.5.1 (mutant counts only; the test suite wasn't re-run against them, so kill rates aren't re-measured; re-measuring is part of the nightly baseline work in #1384)): `cards.py` 246 honored / 254 raw on `main` to 246 / 246 at HEAD (the 8 pragma'd mutants gone). `import_export.py` 1721 / 1721 on `main` to 1707 / 1709 at HEAD: 12 mutants deleted with the dead branches, and the 2 excluded are the `detail` key and text of the export 403. Kill rates for the touched modules weren't re-measured.
| `board.export_min_role or "viewer"` (line 1672) | 1 | Equivalent | The restriction branch is entered only when `export_min_role` is set. *(Update 2026-10-24, #1725: that expression no longer exists; the 403 body reports `_effective_export_min_role(board)`, pinned by the export controls and movement export tests.)* |
| `request.query_params.get("format", "csv")` default (line 1676) | 1 | Equivalent | Any value other than `json` takes the CSV branch. |
| `BoardExportLogSerializer(..., context={"request": request})` (lines 2116, 2118) | 2 | Equivalent | The actor serializer only reads the request when a `board` is in its context, which this view doesn't pass. |
| `responses=BoardExportLogSerializer(many=False)` on `export_history` (line 2093) | 1 | Covered elsewhere | `test_board_schema_contract.py::test_export_history_matches_schema` fails on it; that file is outside the scoped list. |

## How to reproduce

!!! warning "Always mutate a throwaway copy"
    mutmut rewrites the source file in place while it runs and restores it afterward. Don't run it in your working tree. If a run is killed, the tree can be left with a mutant applied.

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
- These are the same four test files the nightly job runs for the `permissions` target (`TARGETS` in `backend/mutmut_config.py`; `python mutmut_config.py targets` prints every target's runner).
- mutmut 2.5.1 starts the runner without a shell, resolving the first word through the inherited `PATH`. The command above calls `.venv/bin/python` without activating the venv, so the runner names the venv interpreter too; a plain `python` would resolve to whatever is first on `PATH` (often none at all on macOS). The nightly driver avoids this by naming its own interpreter in the runner.
- `--tests-dir` is required even though the runner lists its own files.
- Results are stored in `.mutmut-cache`. Delete it before changing the test list, or mutmut will reuse stale verdicts.

For the other modules, swap `--paths-to-mutate` and the test files using the table above.

### Restricting to one class

mutmut imports `mutmut_config.py` from the working directory automatically. The committed `backend/mutmut_config.py` is the CI hook. With `MUTATION_TARGET=card_movement` exported it already restricts the run to `CardMovement` (range computed from the code) and, unless `MUTATION_SHARD=k` is set, runs every mutant of that range (the CI driver sets `MUTATION_SHARD` per job); with no variables set it skips nothing. The variant below is for an arbitrary range. To restrict a run to a line range, overwrite it **in the throwaway copy only**:

```python
# mutmut_config.py -- in the throwaway copy only; do not commit over the shard hook
import os

LO = int(os.environ.get("MM_LO", "0"))              # first line, 0-based
HI = int(os.environ.get("MM_HI", "1000000000"))     # last line, 0-based

def pre_mutation(context):
    if not (LO <= context.current_line_index <= HI):
        context.skip = True
```

Then export `MM_LO` and `MM_HI` and run with `--paths-to-mutate boards/models.py`. The old `MM_LO=357 MM_HI=423` for `CardMovement` is stale (the class now starts at 1-based line 551); `python mutmut_config.py targets` prints the current range.

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

Run shard `k` of `N` in copy `k` with `MM_SHARD=k MM_N=N`, then add up the per-copy counts. Don't copy a result cache over a copy that's still running; aggregate in a separate directory. The baseline used `N=16`.

### Reproducing the `update_card` re-measure (#1454)

Measured against `main` at `ab38c4688`. The line range moves whenever `cards.py` changes, so re-derive it (`grep -n "^def update_card\|^def move_card" backend/boards/services/cards.py`) before reusing it: `update_card` was 0-based lines 492 to 696 (`MM_LO=492 MM_HI=696`) at that commit.

1. Make 8 throwaway copies as in [Parallel runs](#parallel-runs), each with the sharded variant of `mutmut_config.py` (`MM_N=8`, `MM_SHARD=0..7`, `MM_LO=492`, `MM_HI=696` fixed in the file or exported).
2. Baseline run, same runner as above with these test files: `test_card_services.py test_card_move.py test_card_archiving.py test_card_mutation_hooks.py test_card_edge_cases.py`. Result: 44 survivors.
3. Second run (delete `.mutmut-cache` first): the same files plus `test_views_cards.py test_notifications.py test_card_timeline.py test_views_extra.py test_board_events.py test_security_fixes.py test_movement_record_mutation_gaps.py`. Result: 19 survivors, so the view suites kill 25.
4. Third run: the second run's files plus `test_card_service_mutation_gaps.py`. Result: 1 survivor (#1511). With only the baseline files plus the new file, 4 survive, which is 40 of the 44 killed.

Sum the survivors over the 8 copies (`select count(*) from Mutant where status='bad_survived'` in each `.mutmut-cache`). Run `mutmut show` with `MM_SHARD` and `MM_N` exported, or the config import fails.

## Equivalent mutants and the score (#1503)

Some modules can't reach the target by tests alone. A survivor that no test can kill is an **equivalent mutant** (bucket two in [Survivor classification](#survivor-classification)). Without a rule, a floor either demands brittle tests of Django `_meta` internals or sits permanently below target. The rule:

- **Two numbers per module.** The **adjusted** score leaves out the mutants proven equivalent. The **raw** score keeps them in the denominator, as not detected. Both are printed by `scripts/check_mutation_score.py` and both are in the `mutmut-cicd-stats.json` artifact (`score_adjusted`, `score_raw`, `excluded`), so an exclusion is always visible.
- **The floor gates the adjusted number.** `MUTATION_MIN` ([Weekly CI job](#weekly-ci-job-backend-mutation)) is compared with the merged adjusted score. A low raw score is reported, never failed.
- **An exclusion is a comment in the source, with a reason.** Put `# pragma: no mutate -- <reason>` on the line. A pragma with no `-- <reason>` (at least 10 characters) is rejected by `python3 scripts/check_mutation_score.py --check-pragmas backend`, which the `mutation-score-selftest` CI job runs on every MR that touches backend Python.
- **A claim that SQLite cannot observe the mutant is excluded only with a PostgreSQL note.** That is a gap in the test setup, not a property of the code, so the reason must say that a PostgreSQL test could kill it (the checker rejects a reason that names SQLite but not PostgreSQL). The exception is a mutant for which a PostgreSQL test is already **planned or filed**: it isn't excluded and stays a survivor until that test lands. The `select_for_update` guards were that case (#1504, since merged: the guard conditions turned out to be killed on SQLite). One rule, three places: here, the triage question in [How to read the results](#how-to-read-the-results), and the checker.
- **"Schema constant guarded by `migration-check`" is its own category, not an equivalence claim.** A change to `max_length`, `blank`, `db_index` or `related_name` can be observable (a `blank` flip changes model validation and the admin change form; `max_length` changes the form field). It's excluded because CI `migration-check` fails on any drift from the migrations, which is a stronger guard than a test of Django `_meta`, not because no caller could see it. The pragma reason says `schema constant (migration-check)` for exactly this.
- **"Unobservable" means for any production input.** A reason claims the mutant can't change behavior for any input the running system can produce (a non-null FK, a setting that's always defined, a user that always has a username). It doesn't claim no test could reach the line: a stub user, an `override_settings` deletion or an in-memory card with `column=None` could execute it. Say which production invariant makes it equivalent, not that it's dead.
- **Hand-flipped guards are recorded, not pragma'd.** A guard that isn't a mutmut mutant (for example the sibling-row lock added by hand in `cards.py`, #1504) can't carry a pragma. If it survives a hand-flip on PostgreSQL and is equivalent by argument, list it by name in the module's survivor table as "proven equivalent by argument, not mutmut-excludable", cite the issue, and leave it out of both the raw and the adjusted numbers: it isn't in either denominator because mutmut never counted it.
- **Triage first.** An equivalence claim is only made after the three questions in [How to read the results](#how-to-read-the-results); the reason states the answer to the first one.

The import/export survivor tables above keep their "Equivalent" rows unmarked. #1502 re-measured the head and left its 34 equivalent survivors unmarked too (most share a line with killed mutants); marking them, which splits those lines, is tracked in #1544. The nightly floor doesn't wait for it: the merged score clears 90% with them counted as survivors ([Expected score](#expected-score)).

### How mutmut 2.5.1 treats `# pragma: no mutate`

Checked on mutmut 2.5.1 (the CI pin) with a small module, and re-checked by the real-mutmut cases in `check_mutation_score.py --self-test` whenever mutmut is importable:

| Placement | Effect |
|---|---|
| Any line containing `# pragma:` followed, anywhere after it, by `no mutate` (so `# pragma: no cover, no mutate` counts) | No mutant is generated for that line. |
| Comment on `def f():` | **Only** the `def` line. The body is still mutated. |
| Comment on the last line of a multi-line call, `)  # pragma: no mutate` | Only that closing line. The argument lines above it (`max_length=10,`) are still mutated, and are the survivors you were trying to exclude. |
| Comment on the first line of a multi-line call, list or dict | Only that first line. |

So the scope is **one physical line, and the line the mutant is on**. A multi-line field definition needs the pragma on every line that carries a constant, including the closing `)` or `]` when mutmut mutates it. There's no block form in 2.5.1.

**Watch out:** Check by comparing the survivor list with and without the pragma, not by eye.

**The cache problem.** mutmut's cache is built from the mutants it generates, so a pragma'd line has **no row at all** in `.mutmut-cache`: it isn't killed, not survived, not skipped. A score computed from the cache alone would silently shrink its own denominator, and the raw number couldn't be recovered.

`check_mutation_score.py --export-cache` solves this. It reads the mutated source files named in the cache's `SourceFile` table and asks mutmut to enumerate their mutants twice, once as written and once with its pragma set emptied. The difference is `excluded`. Consequences:

- `excluded` is per target, like `total`: for a class target such as `card_movement` it counts only the pragmas inside the class's lines (`--line-range`). Every shard of a target reports the same value, the shards must agree (exit 2 otherwise), and the merged file carries it once per target, not N times; the merged score sums the targets.
- The export step needs mutmut importable (it's, in the `backend-mutation` job). If it isn't, the export exits 2 (not measured) rather than reporting a raw score equal to the adjusted one.
- The count assumes the run wasn't restricted by a `pre_mutation` hook that changes which lines are *generated*. The committed hook only skips mutants after generation (the shard split and the `CardMovement` class range alike), and the export applies the same class range with `--line-range`, so the counts cover exactly the class. A hand run with a different range must pass that range to `--line-range` too.

## How to read the results

```bash
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut results      # lists survivors by id
PYTHONPATH=/tmp/mutmut-tools .venv/bin/python -m mutmut show 42      # prints the diff for mutant 42
```

The score a run reports is the **adjusted** one (excluded mutants left out), with the **raw** one beside it; see [Equivalent mutants and the score](#equivalent-mutants-and-the-score-1503). `mutmut results` and the `Mutant` table don't list pragma'd lines at all, so a survivor count read from them is already adjusted.

Status meanings: killed (a test failed, good), survived (all tests passed, look at it), timeout (the mutant made the tests hang, counted as killed by most conventions), suspicious (slow but not a timeout). Statuses are in the `mutant` table of `.mutmut-cache` (SQLite) if you want counts: `sqlite3 .mutmut-cache "select status, count(*) from mutant group by status"`.

For each survivor, read the diff and ask in order:

1. **Can this change alter anything a caller or user could observe, for any production input?** If not (dead branch, default that's always overridden), it's an equivalent mutant. Don't write a test for it; mark it with `# pragma: no mutate -- <reason>` following the [policy](#equivalent-mutants-and-the-score-1503). A lock call that's only unobservable on SQLite is excluded only with a note that a PostgreSQL test could kill it, and stays a survivor if such a test is planned or filed (#1504). A schema constant guarded by `migration-check` is excluded as its own category (see the policy).
2. **Is the changed code reached by any test in scope?** If not, it's untested code. Either add a test or note which other suite covers it.
3. **Otherwise it is a missing assertion.** Add the smallest assertion that fails on the mutant: the exact message or key, the boundary value (`limit` and `limit + 1`), the empty-collection case, or the ordering.

Two patterns recur in this codebase. A string-literal mutant that adds `XX` around a message survives whenever a test uses `assertIn` with a fragment of the message, because the fragment is still a substring; assert the full message, or both its start and its end. A `>=` to `>` mutant on a limit survives unless a test sits exactly on the limit.

For the assertion patterns that kill these mutants, with examples, see [Writing tests that catch mutations](testing.md#writing-tests-that-catch-mutations).

## Weekly CI job (`backend-mutation`)

Tracked in #1384, ported from TruePPM's `api:mutation` and `scheduler:mutation`. It runs on the Weekly mutation testing schedule only (`MUTATION_TEST=true`, never on an MR or a `main` push; it started on the Nightly schedule and moved to its own weekly one after a manual run measured the cost, see [Runner load](#runner-load)) and covers **every module with a manual baseline on this page**. The report job gates the **merged adjusted** score at **90%** (`MUTATION_MIN=0.90`). `backend-mutation-report` is blocking (`allow_failure: false`, #1384), so a score under the floor, or a run that wasn't measured, is a red job. The `backend-mutation` shards stay `allow_failure: true`: a failed or timed-out shard doesn't skip the report (it `needs:` the shards with `artifacts: true`), which then exits 2 for the missing stats file, so the verdict is the report's alone.

The job started as a one-module pilot on `boards/permissions.py` (!1176) and was widened to all baselined modules by #1384.

### Targets

The list lives in one place, `TARGETS` in `backend/mutmut_config.py`. Each target names its source file, the test files every mutant runs against, an optional class to restrict the run to, and its shard count. Mutant counts are the `total` and excluded figures from the 2026-10-25 CI mutmut stats (pipeline 2986276266, main `fd859446e`); they were first enumerated with mutmut 2.5.1 on `main` at `e8be1a22f` (116 / 246 / 46 / 1780), and pragma-excluded mutants are never generated, so they are listed apart. Kill rates for that run, and what #1930 changed, are in [2026-10-25 run below the floor](#2026-10-25-run-below-the-floor-1930).

| Target | Code | Mutants scored | Excluded by pragma | Tests | Shards |
|---|---|---:|---:|---|---:|
| `permissions` | `boards/permissions.py` | 172 | 4 | the four RBAC files (`test_rbac`, `test_rbac_boundaries`, `test_explicit_permissions`, `test_permissions_unit_mutation_gaps`) | 3 |
| `cards` | `boards/services/cards.py` | 374 | 0 | the 13 files of the 2026-10-09 whole-module re-measure (movement suites, view suites, both gap files) | 16 |
| `card_movement` | `CardMovement` in `boards/models.py` only | 70 | 41 | the six movement-record files of the 2026-10-08 re-measure | 2 |
| `import_export` | `boards/views/import_export.py`, whole module | 1826 | 2 | 16 files: the nine of the head run (#1502), the remainder run's (#1484), `test_import_csv_custom_fields` for the #1449 code, and, last because only a mutant every other file let through reaches them, `test_import_history_attribution` and `test_import_export_schema_mutation_gaps` (#1930) | 29 |
| **Total** | | **2442** | **47** | | **50** |

The `CardMovement` range is computed from the code on every run (`ast`, the class's first to last line), never written down, so it follows the class when `models.py` changes. The mutants outside the range are registered by mutmut, skipped by the hook, and left out of every count by the export (`--line-range`).

### Shard arithmetic

Per-mutant cost is almost all the time the target's tests take to reach their first failure (`-x`); a survivor costs a full pass. Measured 2026-10-09 on an 18-core laptop, SQLite, mutmut 2.5.1, one process per sample, `--reuse-db`:

| Target | One full test pass | Sample | Cost per mutant (local) | CI estimate (x2) |
|---|---:|---|---:|---:|
| `permissions` | 25 s | 2026-10-04 baseline (loaded laptop) | ~25 s | ~30 s (the 2026-10-04 figure was taken under load) |
| `cards` | 78 s | 12 mutants, 376 s with a 78 s baseline | ~25 s | ~50 s (**measured in CI 2026-10-18: ~65-95 s**, see below) |
| `card_movement` | 35 s | shard 1 of 2 through the CI driver: 15 mutants, 332 s with a 35 s baseline | ~20 s | ~40 s |
| `import_export` | 65 s | 25 mutants, 480 s with a 65 s baseline | ~17 s | ~33 s |

CI is assumed twice as slow as the laptop (shared self-hosted runners, PostgreSQL instead of in-memory SQLite). A target's mutants are dealt round-robin over its shards, so shard sizes differ by at most one mutant (a split by `line_index % N`, used at first, left the fullest `import_export` shard with 75 mutants against an average of 54, because mutants cluster on a few lines). `python mutmut_config.py targets` prints the current sizes. Each shard is sized to about 30 minutes of mutants.

**Original sizing (2026-10-10, estimates; superseded by #1818):**

| Target | Mutants x CI cost | Shards | Mutants per shard | Slowest shard |
|---|---:|---:|---:|---:|
| `permissions` | 116 x 30 s = 58 min | 2 | 58 | ~29 min |
| `cards` | 246 x 50 s = 205 min | 7 | 35-36 | ~30 min |
| `card_movement` | 46 x 40 s = 31 min | 2 | 23 | ~15 min |
| `import_export` | 1780 x 33 s = 979 min | 33 | 53-54 | ~30 min |

**Re-derived from the 2026-10-18 scheduled run (#1818).** That run (pipeline 2960067085, main `6d440fb22`) timed out five shards at 60 minutes: four `cards` jobs (3/44, 4/44, 6/44, 9/44) and one `import_export` job (14/44, one hanging mutant). `cards.py` had grown to 361 mutants and measured ~65-95 s each in CI (not ~50 s); the job durations were:

| Target | Shards then | Mutants per shard then | Job wall time per shard (incl. ~5 min setup) |
|---|---:|---:|---|
| `permissions` | 2 | 74 | 45 m, 49 m |
| `cards` | 7 | ~52 | 60 m (timeout), 60 m (timeout), 43 m, 60 m (timeout), 40 m, 54 m, 60 m (timeout) |
| `card_movement` | 2 | 23 | 9 m, 28 m |
| `import_export` | 33 | 54-55 | 31 jobs 19-41 m, one 59.9 m (job 15/44, also a hanging mutant), one 60 m (job 14/44, timeout, a hanging mutant) |

Jobs 4/44 and 9/44 (`cards`) each finished only 35 of their ~52 assigned mutants (28 killed, 7 survived) before the 60 minute kill. The timed-out jobs' stats files were written but never uploaded, so the report exited 2 ("expected 7 shard stats files, got 3"), as designed. The new split, sized from those measurements:

| Target | Mutants x measured CI cost | Shards | Mutants per shard | Expected shard |
|---|---:|---:|---:|---:|
| `permissions` | 148 x ~37 s = 91 min (measured 36-39 s per mutant) | 3 | 49-50 | ~30 min |
| `cards` | 361 x ~80 s = 481 min | 16 | 22-23 | ~30 min |
| `card_movement` | 48 x ~65 s = 52 min (job 11/44: 24 mutants in ~26 min) | 2 | 24 | ~26 min (9 m and 28 m jobs measured) |
| `import_export` | 1786 x ~25 s = 744 min | 29 | 61-62 | ~26 min average at sizing. **Observed since the re-shard:** shards 35/50 and 36/50 are the slowest in every run, at 69.1 min (2026-10-25), 82.1 min (2026-10-28) and 66.9 min (2026-11-01) against the former `timeout: 90m`, i.e. as little as about 8 minutes of headroom; both near-60 m jobs of 2026-10-18 (14/44, 15/44) held a hanging mutant, which is the evidence for a long timeout. `timeout` is now `150m` (#2111) |

Each job spends about 5 minutes on setup on top of the mutants: services, `pip install` of the backend and test requirements, and mutmut's baseline test run (up to ~2.5 min for `cards` at the CI estimate).

- **Original estimate:** the slowest job at about 35 minutes with `timeout: 60m` (1.7x headroom). The 2026-10-10 sizing was an estimate; the 2026-10-18 run is the first measurement that exceeded it, and showed it was too low for `cards`.
- **Now:** with the re-derived split the average job is about 35 minutes including setup, and `timeout` is `150m` (`90m` until #2111).
- **Survivors** cost a full test pass instead of a pass to the first failure. At a 3 to 4% survivor rate that adds about a minute to a shard.
- **A shard that times out** makes the report exit 2 (not measured), never a smaller score.
- **Why the timeout, not more shards:** the default response to long shards is to raise that target's count (and `parallel:`), but the shard cap is now fully used (below). So the timeout was raised from 60m to 90m (#1818), then to 150m (#2111: the slowest shard reached 82.1 min, about 8 minutes under 90m). mutmut lets a single mutant run 10x the baseline, so one hanging mutant costs minutes that no split can remove, and only timeout headroom absorbs it.
- **The 150 minute `timeout:`** deliberately exceeds the project's 60 minute default job timeout. As of 2026-10-21 no runner caps it (all seven project runners have no maximum timeout, and GitLab SaaS shared runners allow up to 3 hours).
- **Why #2111 raised the timeout instead of rebalancing:** the dealing is round-robin, so every `import_export` shard has 61-62 mutants and the same expected cost. Shards 35/50 and 36/50 (`import_export` shards 14 and 15) are slow because of which mutants land on them (slow or hanging ones), not their count, and there is no per-mutant timing to deal them apart. Moving one shard from another target would cut `import_export` shards by about 3%, which is noise against a 55 to 82 minute spread. The 150m timeout leaves about 68 minutes over the worst observed shard and stays inside the 3 hour SaaS limit; a hung shard now burns up to 150 runner-minutes before it is killed. If a later run still goes near it, record per-mutant durations first and deal by cost.
- **If shards run long again** there's no room to add shards. Move the slowest target's tests or mutants, or revisit the cap, instead.

The shard total is capped at 50: `backend-mutation-report` `needs:` every shard, and GitLab allows a job to need at most 50 jobs. `mutmut_config.py self-test` fails the MR if the total goes over (50 now: at the cap, with no room left to add a shard).

#### Runner load

The run costs about 1270 runner-minutes of mutants plus about 220 of setup (44 x 5, at the then 44 shards) by the estimate, roughly 25 runner-hours. **Measured** on 2026-10-10 (a manual play of the mutation schedule, pipeline 2933313351, all 44 shards and the report green): the 44 shards (the count at that time) took 1181 runner-minutes in total, between 6.5 and 39.5 minutes each (mean 26.8) on five self-hosted runners, and the whole 100-job pipeline took 1 h 17 min wall clock. The estimate was therefore about 20 percent high, and the slowest shard (39.5 min) is well under `timeout: 60m`. The report job printed a merged adjusted score of 96.1% (raw 94.6%; `import_export` 95.6%, `cards` 96.7%), above the 90% floor.

**Re-measured** on the scheduled run of 2026-10-18 (pipeline 2960067085, main `6d440fb22`): the pipeline succeeded overall with 6 allow-failure warnings, all one cause, five shards hitting `timeout: 60m` (see Shard arithmetic). The 44 shards at the old 7 / 33 split therefore no longer fit; #1818 moved to 50 shards and `timeout: 90m`. Expected cost is about 26-29 runner-hours: 1368 mutant-minutes from the table above (91 + 481 + 52 + 744) plus 50 x 5 minutes of setup is ~27 hours, and 50 x ~35 min is ~29 hours. Not yet measured, the next scheduled run will say.

That is too much to share a night with the other scheduled jobs, so mutation testing has its own **Weekly mutation testing** schedule (4485984, `MUTATION_TEST=true`, Sundays 06:00 `America/New_York`) and the Nightly schedule no longer carries the variable.

- A scheduled pipeline on `main` runs the whole pipeline, so each weekly run also runs the ordinary `main` jobs. The Nightly jobs (the schedule-gated scans and the deep fuzz) stay on the Nightly schedule.
- The schedules sit in the 00:00 to 07:00 ET window at least 90 minutes apart, and clear of the TruePPM project's schedules, so the runners they share aren't asked for two heavy runs at once. See [CI gates](ci-gates.md) for the full schedule table.
- The jobs carry no `tags:`. [CI runners](../maintainers/ci-runners.md) has no pin convention for heavy scheduled jobs (`nuc` is reserved for the latency-sensitive load test, and pinning 50 jobs to two NUCs would only lengthen the queue), so like every untagged job they can be picked up by a GitLab SaaS runner if one is available to the project.
- `schedule-config-check` needs `MUTATION_TEST=true` on whichever schedule runs the job.

`--reuse-db` keeps pytest-django from creating the PostgreSQL test database and replaying every migration for each mutant. The schema comes from the migration files, which no mutant touches, so reusing it can't change a verdict.

### Expected score

From the manual baselines (SQLite; CI runs on PostgreSQL, so the first scheduled run may differ):

| Target | Killed / scored (adjusted) | Raw (pragma'd counted as not detected) | Source |
|---|---:|---:|---|
| `permissions` | 116 / 116 (100%) | 116 / 120 (96.7%) | 2026-10-09 re-measure |
| `cards` | 238 / 246 (96.7%) | 238 / 246 (96.7%) | 2026-10-09 re-measure |
| `card_movement` | 46 / 46 (100%) | 46 / 73 (63.0%) | 2026-10-08 re-measure |
| `import_export`, measured parts | 1576 / 1635 (96.4%) | 1576 / 1637 (96.3%) | head 1111 / 1145 (#1502, at `f898bf683`) plus remainder 465 / 490 (#1484, the 2 pragma'd 403 mutants removed) |
| **Merged, measured parts** | **1976 / 2043 (96.7%)** | **1976 / 2076 (95.2%)** | |

About 145 `import_export` mutants (1780 now against 1635 measured) belong to code added after those runs, mostly #1449's custom-field CSV helpers, and are unmeasured (#1546). Even if every one of them survived, the merged adjusted score would be 1976 / 2188 = 90.3% and the raw one 1976 / 2221 = 89.0%. So the 90% floor holds on the baseline without marking the 32 documented `import_export` equivalents (#1544), which are counted as survivors in all of the figures above. Two conventions can move the CI number down a little: the checker counts `suspicious` mutants as not detected (the head run counted its 6 as killed), and a mutant that only a PostgreSQL test can kill, or that only SQLite hides, can go either way.

### How it works

- `python mutmut_config.py run` (from `backend/`) is the whole job script. It maps `CI_NODE_INDEX` of `CI_NODE_TOTAL` to one (target, shard), refuses to run (exit 2) if `CI_NODE_TOTAL` isn't the sum of the shard counts, runs `mutmut run --paths-to-mutate <file> --runner "<python> -m pytest -x ... <test files>"`, prints `mutmut results`, and exports `mutmut-stats-<index>.json` with `check_mutation_score.py --export-cache --target <name> [--line-range LO:HI]`. Shard k of N of a target mutates the target's mutants whose ordinal, in (line, index) order, is k modulo N; the hook enumerates them with mutmut once per process.
- `python3 backend/mutmut_config.py self-test --ci-file .gitlab-ci.yml` runs in `mutation-score-selftest` on every MR that touches backend Python or the CI file: every source file, test file and class in `TARGETS` must exist, a class target's computed range must equal the class's span read independently from the text, the hook's decision run for every shard must run each in-range mutant exactly once and nothing outside the range, shard sizes may differ by at most one, the shard total may not exceed 50, and `parallel:` on `backend-mutation` must equal the shard total. A renamed test file fails the MR that renames it, not a night later.
- mutmut is installed **inside the job** with `pip install "mutmut==2.5.1"`. It stays out of `requirements*.txt`. Bumping the pin changes the mutants generated and so moves the score; bump it on purpose and re-baseline. `backend/setup.cfg` `[mutmut]` now holds only `tests_dir`; the driver passes the path and runner explicitly.
- mutmut 2.5.1 has no `export-cicd-stats` command (that's 3.x), so `--export-cache` reads `.mutmut-cache` instead. It counts only the mutants mutmut generates for the file (inside the line range, for `card_movement`):
  - a generated mutant with no cache row is `untested` (so the run isn't measured);
  - a cache row that's no generated mutant is a **phantom**, dropped and reported as `phantom`. A phantom is never run, so it's always `untested`;
  - a non-generated row with a verdict (killed, survived, timeout, suspicious, skipped) means the cache doesn't match the code, and the export exits 2 rather than guess.
  - **Where phantoms come from:** mutmut 2.5.1 makes one whenever two lines have the same text and both carry mutants (two closing `    )` lines, for example). Its status lookup is keyed by line text, so it files the later line's mutant under the earlier line, as a row that's never run.
  - That is the "extra untested mutant" the 2026-10-08 and 2026-10-09 re-measures couldn't explain (`permissions.py` line 316, `import_export.py` line 422). The real mutant is still run and scored correctly. Without the filter every nightly would be "unfinished".
- `backend-mutation-report` groups the stats files by target. `--expect-shards` gets `permissions=3,cards=16,...` from `python3 backend/mutmut_config.py expect-shards`; a missing shard, a missing target or an unexpected one is exit 2. Within a target, every shard registers the whole target's mutants (other shards' lines as `skipped`), so every shard's `total` must be equal and the shards' non-skipped mutants must add up to exactly that total; otherwise exit 2. The targets are then summed (each target's `total`, `excluded` and `phantom` once) into the merged score, which `MUTATION_MIN` gates. The log prints one line per target first, and names any target under the floor on its own (not gated).
- The artifact `mutmut-cicd-stats.json` (30 days) has the merged counts and `score_adjusted` / `score_raw` at the top level, and `targets.<name>` with each target's counts and scores. On exit 2 it's still written, with a `not_measured` key giving the reason. A floor configuration error (for example `MUTATION_MIN=90`) exits 2 before anything is read, so no merged file is written for that run. Every stats and cache path the script reads or writes goes through the shared `scripts/_paths.py` containment helper (`resolve_within(cli_roots(), path)`, #1377): it must resolve under the repo checkout, the working directory or the system temp directory, or the script prints `CONFIG ERROR` and exits 2.
- Dependency review for mutmut 2.5.1: BSD-3-Clause; dependencies click (BSD-3), glob2 (BSD), parso (MIT), pony (Apache-2.0), junit-xml (MIT), toml (MIT); no OSV advisories for any of them on 2026-10-04. 2.x rather than 3.x because 3.x copies the tree into a sandbox (needs `also_copy` bookkeeping for every file the suite reads), which doesn't suit a Django suite.

### 2026-10-25 run below the floor (#1930)

The scheduled run of 2026-10-25 (pipeline 2986276266, main `fd859446e`) scored a merged adjusted **89.8%**, under the 90% floor. The two scheduled runs before it were not measured (exit 2: on 2026-10-21 the first attempt of shard 35/50 was canceled and its retry was interrupted, and on 2026-10-18 five shards timed out), so it is the first run to fail on the score itself. See [Observed scores](#observed-scores-1384).

Nearly all the loss was code merged since the 2026-10-09 re-measures whose own tests aren't in its target's test list:

- `permissions.py`: the broadcast visibility predicates (#1677, #1705, #1714) and the analytics panel `min_role` filter (#1826).
- `cards.py`: the container-delete peer helpers (#1634).
- `import_export.py`: the `created_at` restore helpers (#1906), the export's OpenAPI declaration (#1783) and the imported-movement attribution in the CSV export (#1675).

#1930 kills them with direct assertions (`test_permissions_unit_mutation_gaps.py`, `test_card_service_mutation_gaps.py`, `test_import_export_mutation_gaps.py`, and the new `test_import_export_schema_mutation_gaps.py`) and adds `test_import_history_attribution.py` to the `import_export` list. Survivor ids were read from each shard's `mutmut results` in the job logs; mutmut 2.5.1 numbers mutants the same way on the same code, so the ids map to diffs with `mutmut show` in a fresh copy. The changed lines were then re-run locally (mutmut 2.5.1, SQLite, throwaway copies, the target's full test list): all 172 `permissions` mutants (172 killed), the 32 `cards` mutants on the lines the new tests cover, and the 55 `import_export` mutants on lines 0-based 1049-1092, 2585-2625 and 3040-3050.

| Target | 2026-10-25 CI: killed / survived / scored (adjusted) | Re-run locally (#1930) | Expected next run (a #1930-only projection, superseded by the #1931 section below) |
|---|---|---|---|
| `permissions` | 124 / 48 / 172 (72.1%) | 48 of the 48 survivors killed | 172 / 0 (100%) |
| `cards` | 326 / 48 / 374 (87.2%) | 12 of 13 killed; `lock=True` in the `enforce_column_limits` signature survives (needs PostgreSQL, see [#1504](#postgresql-re-run-of-the-select_for_update-guards-1504)); killed since by a spy on SQLite in [#1931](#remaining-cards-and-card_movement-survivors-1931) | 338 / 36 (90.4%) |
| `card_movement` | 54 / 16 / 70 (77.1%) | not re-run | 54 / 16 (77.1%) |
| `import_export` | 1690 (2 by timeout) / 136 / 1826 (92.6%) | 48 of 49 killed | 1738 / 88 (95.2%) |
| **Merged** | **2194 / 248 / 2442 (89.8%)** | **108 killed** | **2302 / 140 (94.3%)** |

"Expected next run" adds the local kills to the CI counts; it isn't a whole-module run, and the CI job (PostgreSQL) is the measurement. The one `import_export` mutant left in range is the `JSON export (?format=json).` description of the export's JSON media type: drf-spectacular emits one description per status code, taken from the first media type, so the generated document is unchanged (the same reason as the `403` survivors in the head table). It's left unmarked, like those. Triaged in #1931 (see the next section; kept here as the record of what #1930 left): the other 35 `cards` survivors (mostly in the lock helpers: `select_for_update(no_key=...)`, `lock=` and `flat=` arguments, the `lock_cards_for_cascade` guards and the two retry-attempt constants; also the two `CARD_MUTATION_HOOKS` failure-log arguments and the `-1` to `-2` clamp in the move position; not triaged by #1930) and the 16 `card_movement` survivors, plus the equivalent `import_export` description mutant above.

### Remaining `cards` and `card_movement` survivors (#1931)

#1930 left 35 `cards` survivors and 16 `card_movement` survivors untriaged. #1931 re-ran both targets locally exactly as CI does (`python mutmut_config.py run` for the 16 `cards` and 2 `card_movement` shards, mutmut 2.5.1, SQLite, throwaway copies of `backend/`) and triaged every survivor. The first local run, at a machine load of 100+, also reported 40 `suspicious` `cards` mutants in `update_card`; they were timeouts, and every one was killed when the run was repeated at normal load, so a `suspicious` count on a loaded machine is not a survivor list.

| Group | Resolution |
|---|---|
| `select_for_update(no_key=...)` and `of=("self",)` arguments (`enforce_column_limits`, `create_card`, `_lock_move_columns`, `_lock_move_cells`, `lock_card_row`, `lock_card_for_write`, the three cascade lock statements) | Killed on SQLite by `test_card_lock_mutation_gaps.py`: a spy wraps `QuerySet.select_for_update` and asserts the model and keyword arguments of each call, in order. SQLite ignores the clause, so the call itself is what is observed; the queueing it buys stays pinned on PostgreSQL by `test_concurrent_moves.py` and `test_concurrent_lock_sites.py`. |
| `lock=` arguments (`lock=True` in the `enforce_column_limits` signature, `lock=False` in `create_card` and `move_card`) | Killed by the same spy: the default takes exactly one column lock, and the two callers that already hold it take none. No PostgreSQL test is needed. |
| `lock_cards_for_cascade` guards and `delete_boards_locked` | Killed: all four combinations of `entry_columns` / `boards` outside a transaction (`TransactionTestCase`) with the exact `RuntimeError` text, the three branches' lock order, `delete_boards_locked` deleting only the given boards, and the retry (`continue`) and its bound. |
| `_CASCADE_LOCK_ATTEMPTS`, `_MOVE_LOCK_ATTEMPTS` constants | Killed by asserting the attempt count: the loop gives up after exactly three attempts and a retry that succeeds returns its result. |
| `values_list(..., flat=True)` on the pk sets the cascade compares | Killed by asserting the helpers return plain pks (`_lock_cascade_cards`, `_cascade_card_pks`, `delete_boards_locked`'s board pks). |
| `lock_card_cell_entry` branches | Killed: the card row is locked first only when a card id is given, and `None` column ids are dropped. |
| `lock_board_for_card_write` SQL dictionary (`"postgresql"` key and statement) | Killed with a mocked connection whose vendor is `postgresql`; the statement is asserted verbatim. |
| `CARD_MUTATION_HOOKS` failure log (format string, `__qualname__`) | Killed by asserting the logged message for a named handler and, for a handler with no `__qualname__`, its `repr`. |
| `-1` to `-2` move-position clamp | Not equivalent as a whole line, so no pragma. The bound is now `0 if highest is None else highest + 1` (identical result under `max(0, ...)`, since any negative bound clamps to 0): the old `-1` to `-2` mutant no longer exists, and the new `0` to `1` mutant is killed by `MovePositionTests.test_a_huge_position_in_an_empty_cell_is_zero`. All 6 mutants on the line were killed locally. |
| `flat=True` in `create_card`'s column lock read, and in `_lock_cascade_boards` / `_lock_entry_columns` | Equivalent: the first is only tested for `None`, the others' `list(...)` result is discarded. `# pragma: no mutate`, each on a line of its own (3 in total, the only pragmas in `cards.py`). |
| `CardMovement`: `default` / `db_default` of `card_uid` and `card_title`, the `save()` guards (`or`, `is not None`, the board and snapshot fills) and the two exception messages | Killed in `test_movement_record_mutation_gaps.py`. |
| `CardMovement`: `null=True` on `card`, `board` and `imported_from_username` | Killed by asserting the field declarations (the column constraint comes from the migrations, so the model argument is otherwise unobservable) and a row stored with NULLs. |
| `import_export`: the JSON media type description | Accepted, not marked: drf-spectacular emits one description per status code from the first media type, so the generated document is unchanged (same reason as the `403` survivors in the head table). |

Deviation from the issue text: #1931 expected the `lock=True` to `lock=False` mutant in the `enforce_column_limits` signature to need a PostgreSQL test. A spy on `select_for_update` kills it on SQLite instead. It pins the call arguments, not lock semantics; the queueing itself stays covered on PostgreSQL by `test_concurrent_moves.py` and `test_concurrent_lock_sites.py`.

Re-run result on the final code (local, SQLite): `cards` 369 of 369 mutants killed with 3 excluded by the pragmas above, i.e. 100%; `card_movement` 70 of 70 in range killed (41 excluded). That is a local measurement; the weekly CI job on PostgreSQL is the measurement that counts, and no merged score is projected here. `MUTATION_MIN` is unchanged.

### The floor (decision, #1384)

`MUTATION_MIN=0.90`, set on `backend-mutation-report`, applied to the merged adjusted score over all four targets.

- The maintainer chose 90% up front. That overrides the earlier plan on #1384 of reading the floor off a week of observed nightly scores. The floor is not read off the runs; whether the observation requirement was met is stated in [Observed scores](#observed-scores-1384).
- The baseline arithmetic above puts the expected score several points above it.
- The floor is a fraction (`0.90`, never `90`) and is never set to `0` as a placeholder.

### Observed scores (#1384)

The six pipelines of the Weekly mutation testing schedule (4485984) before the report became blocking, read from the `backend-mutation-report` job logs. All six report `source: schedule` on the GitLab API. Two of them (2026-10-21 and 2026-10-28) ran on a Wednesday, not on the Sunday 06:00 ET cron, so the schedule appears to have been played by hand on those days; the API does not mark that. The evidence is the weekday and the creation times (19:10 and 17:34 UTC, against about 10:07 to 11:07 UTC for the cron runs).

| Date | Pipeline / report job | Main | Shards | Result | Merged adjusted (raw) | Survived |
|---|---|---|---|---|---|---|
| 2026-10-11 (Sun) | 2935582754 / 17092072195 | `8d6b349e5` | 44, all passed | OK | 95.6% (94.2%) | 98 |
| 2026-10-18 (Sun) | 2960067085 / 17263987454 | `6d440fb22` | 39 of 44 passed, 5 failed `job_execution_timeout` | exit 2, not measured | 93.9% (92.3%), not a score: 3 of 7 `cards` shards arrived | 127 |
| 2026-10-21 (Wed) | 2973506543 / 17360636794 | `1346046b8` | 49 of 50 passed; shard 35/50 canceled externally, its retry `runner_interrupted` | exit 2, not measured | 91.5% (89.7%), not a score: 28 of 29 `import_export` shards arrived | 197 |
| 2026-10-25 (Sun) | 2986276266 / 17447016918 | `fd859446e` | 50 | exit 1, FAIL under the 90.0% floor | 89.8% (88.1%) | 248 |
| 2026-10-28 (Wed) | 3000496377 / 17549849301 | `8edd683df` | 50 | OK | 95.7% (93.8%) | 108 |
| 2026-11-01 (Sun) | 3014353120 / 17643226088 | `f2450ab9f` | 50 | OK | 95.7% (93.8%) | 108 |

The 2026-10-11 run was on the original 44 shards; the re-shard to 50 (!1498) came after the 2026-10-18 timeouts.

- **Tally.** Two of the six were not measured (2026-10-18, five shards hit the 60 minute timeout, which the re-shard to 50 and a longer `timeout: 90m` (!1498) addressed; 2026-10-21, a canceled shard and an interrupted retry), one was a real miss (2026-10-25) and three were clean (2026-10-11, 2026-10-28, 2026-11-01).
- **2026-10-21 was not measured, in two halves.** The first attempt of shard 35 of 50 (job 17360636778) ran 66.8 minutes and was "canceled externally (UI, API)" with 217 mutants untested; who or what canceled it is not recorded in the log, so the reason is unknown. Its retry (job 17362908118) failed with `runner_interrupted` after 30.7 minutes. So the report found 28 of the 29 expected `import_export` shard files and exited 2 rather than summing a smaller run. The merged number it printed is not a score.
- **2026-10-25 was a real miss.** The merged adjusted score was under the floor, and `permissions` (72.1%), `cards` (87.2%) and `card_movement` (77.1%) were each under 90% on their own. The cause and the fix are in [2026-10-25 run below the floor (#1930)](#2026-10-25-run-below-the-floor-1930).
- **Why it moved from 89.8% to 95.7% by 2026-10-28.** #1930 and #1931 merged on 2026-10-25, after that run started (09:59 and 12:37 EDT, against a pipeline created at 10:07 UTC), and they added killing tests. The per-target lines show survivors becoming kills, not mutants leaving the count: `permissions` went from 124 killed of 172 scored (48 survivors) to 172 of 172, the same denominator. `cards` went from 48 survivors to 2, and `import_export` from 136 to 106. `cards` scored 374 then 395 mutants and `import_export` 1826 then 1857, which is code merged in between (not itemized here) and new pragma exclusions (`excluded` 47 to 50, the three `flat=True` pragmas in `cards.py` from #1931), so `skipped` (other shards' lines) also grew, from 57152 to 58335. `card_movement` was unchanged in count and went from 54 to 70 killed, again with no change in its 41 excluded. Nothing indicates a dropped shard or target: the report checks every expected shard and target and exits 2 otherwise.
- **The observation requirement was not met.** The plan on #1384 was a week of scheduled runs without infrastructure failures. The six runs contain two that were not measured (2026-10-18, 2026-10-21) and one under the floor (2026-10-25); the last two runs (2026-10-28, 2026-11-01) are clean and span four days. The report was made blocking anyway, on the owner's decision to flip now and keep #1384 open; no waiver of the requirement is recorded. The 90% floor is the maintainer's choice rather than a value derived from these runs.
- **What a red means now.** On the Weekly mutation testing schedule, a red `backend-mutation-report` is either exit 1 (the merged adjusted score is under 90%: read the per-target lines, find the module that moved and triage its survivors) or exit 2 (not measured: a shard died or timed out, as on 2026-10-21, or a stats file is missing). Exit 2 is not a score. Re-run the schedule once; if it repeats, the shard that died is in the failed-jobs list. A runner interruption on one of the 50 shards now makes the weekly pipeline red where it used to be yellow, and the slowest shards are close to their timeout (#2111).
- **The last two clean runs scored 95.7%**, 5.7 points above the floor, with 108 survivors: 106 in `import_export` and 2 in `cards` (shards 18/50 and 19/50 in the 2026-11-01 run; not yet named or triaged). Survivor triage (plan item 5) status: `permissions` and `card_movement` have 0 survivors in both clean runs. `cards` is open: #1931's 369 of 369 was a local SQLite run, and CI still shows 2. `import_export` is open: of its head survivors, 32 are equivalent or redundant and 2 are killable with a PostgreSQL test (#1545); #1544 (marking the 32) and #1546 (the custom-column CSV helpers #1449 added) are open, but `import_export` grew from 1826 to 1857 mutants and its survivors reached 106 where #1930 projected 88, and no open issue covers that growth. That remainder stays on #1384.

### Maintainer steps and what comes next

1. Done: the **Weekly mutation testing** schedule (4485984, Sundays 06:00 ET) carries `MUTATION_TEST=true`, and `MUTATION_TEST` is no longer on the Nightly schedule (4176726) nor in `SCHEDULE_AUDIT_ACCEPTED_GAPS` (the list is empty). It was first proven by a manual play of the schedule on 2026-10-10: all 44 shards and the report passed, merged adjusted score 96.1%. The Nightly run at 05:06 UTC that day, before the nightly-targets MR had merged, ran `main`'s old 4-shard `permissions.py` pilot, whose report exits 2 (not measured) on the mutmut phantom row described above; that was expected and ended when the MR merged.
2. Observation (runs recorded in [Observed scores](#observed-scores-1384); the requirement of a week without infrastructure failures was not met): read each scheduled run's `backend-mutation-report` log (per-target lines and the merged score) and the shard durations. Resize shards in `TARGETS` (and `parallel:`) if any shard runs near the timeout. That rule has fired: the slowest shards were 66.8 min (canceled, 2026-10-21), 69.1 (2026-10-25), 82.1 (2026-10-28) and 66.9 (2026-11-01) against the then `timeout: 90m`; #2111 raised it to `150m` rather than resizing (see Shard arithmetic). The slowest shard in the manual run was 39.5 min.
3. Done: `backend-mutation-report` is `allow_failure: false` (#1384); the shard jobs keep `allow_failure: true`, since the report already judges them. The observed scores are recorded in [Observed scores](#observed-scores-1384) above.
4. Triage survivors as described in [How to read the results](#how-to-read-the-results).

## Limits of this baseline

- **Shallow operators.** Mutation operators in mutmut 2.x are shallow (operators, constants, `None` replacements). A high kill rate here doesn't prove the tests are strong, and a low one on string literals is partly noise.
- **Test selection matters.** Kill rate depends on which tests were allowed to run. The 44 `update_card` survivors would likely drop with the view-level suites included. They are tracked in #1454.
- SQLite hides locking and concurrency behavior. The `select_for_update` guards need a PostgreSQL run (`ConcurrentMoveLockTests`, #1504).
- The `CardMovement` figure (61.6% in the baseline table) is capped by schema-constant mutants (`max_length`, `db_index`, and similar). The behavioral tests added for it cover the default type, choice labels, ordering, and `SET_NULL` retention; the rest is guarded by CI `migration-check`, not by tests. Since #1503 those mutants are excluded with a reason in the source, so the module's *adjusted* score is 100% and its *raw* score stays at about 63%; the raw number is what shows how much of the module rests on `migration-check` rather than on tests.
- A line-level pragma also removes any *killed* mutants that share its line. Keep a pragma'd line to the equivalent argument only (split a call across lines); the `excluded` count in the artifact includes everything on those lines.
- It's a point-in-time number on one commit. Re-run it before the 1.2 movement-record and permission changes merge to see how the rate moved.
