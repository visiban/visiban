# Propose fast-path table edits from yield data
<a id="kaizen-fast-path-proposal"></a>

`scripts/kaizen_fastpath_proposal.py` reads the yield state and **proposes** fast-path table edits as a diff plus a ready-to-paste evidence section. It never edits the table.

**Why it matters:** The fast-path table (which change class runs which gates) used to change only when someone noticed a pattern by hand. The "Settings sub-page wiring" row exists because kaizen finding #682 showed `architect` and `ux-design` finding nothing on repeated form-to-serializer sub-pages. The [yield watch](kaizen-yield-watch.md) (#1144) now keeps a per-gate, per-diff-shape streak of `0 findings` runs, so the evidence can come from data instead of memory (#1145).

**How it works:** The table is a local file (see below). Its owner reviews the diff, applies it with `patch`, and pastes the evidence section into the issue or MR that records the change (in the repository that carries the table, if there's one).

**Yes, but:** This changes where the table's evidence comes from, not who decides on a table change.

## Running it

The table lives in the global `~/.claude/CLAUDE.md`, which isn't in this repository, so pass its path. Without `--table` the script searches the repository's `CLAUDE.md` files and exits 2 if none holds the table.

```bash
OUT="${TMPDIR:-/tmp}"   # macOS: $TMPDIR (/var/folders/...); a literal /tmp/... path is rejected
python3 scripts/kaizen_fastpath_proposal.py --table ~/.claude/CLAUDE.md \
  --evidence-out "$OUT/fastpath-evidence.md" > "$OUT/fastpath.diff"
patch ~/.claude/CLAUDE.md < "$OUT/fastpath.diff"      # only after review
python3 scripts/kaizen_fastpath_proposal.py --self-test
```

| Option | Default | Meaning |
|---|---|---|
| `--state FILE` | `.claude/kaizen-yield-state.json` | Yield state from the watch. Use the nightly job's `kaizen-yield-state.json` artifact for the newest data. A file that doesn't exist exits 2 (it would otherwise read as "no candidates"). |
| `--declined FILE` | `.claude/kaizen-declined.json` | Gates declined as `<gate>:fast-path-candidate` aren't proposed. |
| `--table FILE` | search repo `CLAUDE.md` files | The file holding the table. Read only. |
| `--evidence-out FILE` | stderr | Where the `## Fast-path evidence` section goes. Must not be the table file, or a hard link to it. |
| `--now ISO` | the current time | Reference time for the staleness check; for tests. |

**Output:**

- **Stdout** is only the diff, so you can redirect it straight into `patch`. Line endings (CRLF included) carry through, and an edited last line without a trailing newline gets the `\ No newline at end of file` marker.
- **The last line of stderr** is a one-line summary (after the evidence section when that goes to stderr), such as `3 candidate(s) over threshold, 1 diff edit(s),
2 evidence-only note(s)`.
- **An empty diff doesn't mean nothing reached the threshold.** Candidates with no automatic edit appear only in the evidence section, so read it (or the summary) every time.
- **Paths** follow the [path containment rules](ci-gates.md#path-containment-for-cli-arguments); `--table` may also live under `~/.claude/`. On macOS the temp root is `$TMPDIR`, not `/tmp`. A rejected path exits 2 with the allowed roots listed.
- **Any other error** (a malformed state, an unreadable table) exits 2 with a message and no proposal.

**Stale signal.** If the state's watermark (`last_merged_at`, the newest merge folded in) is more than **30 days** old (`STALE_DAYS`), or the state has no watermark:

- the first line of stderr is a `STALE SIGNAL` warning,
- the evidence section carries the same warning, and
- the summary line ends with `[STALE SIGNAL]`.

The committed `.claude/kaizen-yield-state.json` only advances when someone commits the nightly artifact (its watermark was !925, 2026-09-26, when this was written), so prefer the newest artifact with `--state`.

## What it proposes

A **candidate** is a (gate, diff shape) pair whose streak reached the state's threshold (10 consecutive `0 findings` runs, `/kaizen`'s `MIN_RUNS_FOR_VERDICT`) and that isn't declined. `n/a` and `skipped` lines never count, as in the watch. A pair the watch already filed an issue for is still proposed: the issue and the table edit are separate steps.

Diff shape is the branch prefix, mapped to table rows by the start of the "Change class" cell:

| Shape | Rows |
|---|---|
| `fix` | Pure bugfix |
| `docs` | Docs-only |
| `chore` | Chore / CI config, Dependency bump |
| `feat` | Backend-only feature, Frontend-only feature, Settings sub-page wiring, New user-visible feature |
| `other` | none |

`feat` covers every feature row, so a `feat` streak is evidence about all of them together. The reviewer decides whether the narrowing holds for each row.

For each candidate:

- **Gate named in a mapped row** (for example `` `security-review` `` in "Settings sub-page wiring"): the diff removes that item from the row, including its qualifier text, and one adjacent separator (`+` inside a group, else the step arrow). Arrows may be `→` or `->` with any spacing; an arrow inside a parenthesized qualifier is part of the item. The ledger name `voc` matches the table's `voice-of-customer`.
- **Edit would remove the gate from every row that runs it** (by name or through the pre-MR gate cluster): no diff. That is a gate deletion, which `/kaizen`'s hard rule (narrow, never delete) reserves for a human. The evidence section says so.
- **Cell cannot be split safely**: no edit, and the evidence section names the row with the reason. The script never writes markdown it couldn't parse. The triggers:
    - unbalanced parentheses or backticks,
    - the gate named inside prose rather than as an item,
    - text after the gate other than one parenthesized qualifier (for example "`` `b` `` (if x) or `` `c` `` (if y)", where the item boundary is ambiguous),
    - the gate named more than once in the cell, or
    - the gate as the cell's only item.
- **Gate covered only by "batched pre-MR gate cluster"**: no diff. The evidence section lists it as a hand edit, because the cluster's applicability list is prose.
- **No mapped row names the gate**, or the shape is `other`: no diff, listed with the reason. A streak on a gate the table doesn't require for that shape means it was run outside the table, so there's nothing to narrow.

**Yes, but:** Adding a row is out of reach of this data. A branch prefix can't tell a sub-class of `feat` (like Settings sub-page wiring) from the rest, so new rows still come from `/kaizen` and human review. Path-based diff shapes, which would let the proposer add rows, are tracked in #1652.

## The evidence section

Paste the `## Fast-path evidence` section as-is into the issue or MR that records the table change. It names:

- the state file and its watermark,
- the threshold, and
- for each candidate: the gate, diff shape, consecutive 0-finding runs, lifetime runs (with how many had findings), the MRs in the streak (the most recent 10 the state keeps), and the rows narrowed or the reason no edit was made.

The table's rationale stays auditable the same way the #682 citation is.

The diff edits only the table, but the same file restates when gates fire (the Gate reference rows, and prose such as "before the push, run `completeness-check`"). For every narrowed gate the evidence section adds a checklist line to review those too, before you apply the diff.

**Watch out:** A streak is absence of evidence. Before merging, confirm the gate wasn't only run on trivially safe diffs. Narrow a trigger; never delete a gate.

## `/kaizen` stays the fallback

Manual `/kaizen` runs (`.claude/skills/kaizen/SKILL.md`) aren't deprecated. They read a window of merged MRs directly and report adoption, phantom gates and load-bearing gates. Use them as the cross-check when the proposal looks wrong or the state file is stale.

## Tests

`bash scripts/tests/kaizen_fastpath_proposal.test.sh` (no network; fixture state and table in `scripts/tests/fixtures/kaizen/`). The nightly `kaizen-yield-watch` job runs `--self-test`.
