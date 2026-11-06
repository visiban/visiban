# Record what each merge request cost
<a id="cost-ledger"></a>

`/wave` writes each MR's measured token usage and a list-price USD estimate in its `## Gates` section, and posts a readable cost table as an MR comment (#2128).

**Why it matters:** `## Gates` already records each gate's *yield*. Without its cost beside it, `/kaizen` can't ask the question that decides whether a gate or a rework round earns its slot: findings per dollar, by gate and by change class.

**The big picture:** One setting, `cost-ledger`, turns all of it on or off. It's **on by default**. Three scripts measure, one renders the comment, one checks the lines, and `/kaizen` reads them.

**Watch out:** `est-cost-usd:` is a **list-price equivalent**: what the same tokens would cost at the public API rates, not what a subscription charged.

This is a port of Blueprint's cost ledger (macrodream/blueprint#235, macrodream/blueprint#340, macrodream/blueprint#348, macrodream/blueprint#364, macrodream/blueprint#365, macrodream/blueprint#381, macrodream/blueprint#383, macrodream/blueprint#384 and macrodream/blueprint#386). Upstream references are always written `macrodream/blueprint#N`, in the scripts too, so they never link a Visiban issue.

## The pieces

| File | What it does |
|---|---|
| `scripts/cost-ledger` | The only reader of the setting: `status`, `enabled`, `on`, `off`, `--local` |
| `.claude/cost-ledger.json` | The project layer of the setting, committed |
| `scripts/subagent-tokens.py` | Prints `subagent-tokens: <N>`, measured from subagent transcripts |
| `scripts/orchestrator-tokens.py` | Prints `orchestrator-tokens: <N>`, measured from the orchestrating session's transcript |
| `scripts/est-cost.py` | Prints `est-cost-usd: <N.NN> (prices YYYY-MM-DD)`, the one estimate |
| `.claude/model-prices.json` | The price table `est-cost.py` reads |
| `scripts/lib/transcript_usage.py` | The transcript usage parser the three measuring scripts share |
| `scripts/cost-table.py` | Renders and posts the `## Cost of this MR` comment |
| `scripts/cost_ledger_lines.py` | Reads and checks the cost lines in a description; shared by `cost-table.py` and `/kaizen` |
| `scripts/kaizen_gate_ledger.py` | `/kaizen`'s reader; reports cost by change class and by gate |

Every script has a `--self-test`. The `cost-ledger-selftest` CI job runs them all, plus `scripts/tests/kaizen_gate_ledger.test.sh`, on MRs that touch any of them.

## Check it, and turn it on or off
<a id="the-setting"></a>

```bash
python3 scripts/cost-ledger status          # e.g. "cost-ledger: on (set by: project)"
python3 scripts/cost-ledger off             # project layer: edits .claude/cost-ledger.json
python3 scripts/cost-ledger on              #   commit the file on a chore/ branch and open an MR
python3 scripts/cost-ledger off --local     # you only, at once: git config --local visiban.costLedger false
python3 scripts/cost-ledger on --local      # you only: unsets that key (warns if the project says off)
```

- **For the whole project,** run `scripts/cost-ledger off` (or `on`) on a `chore/` branch, commit `.claude/cost-ledger.json` and open a chore MR. It takes effect for every branch made after the MR merges.
- **For yourself only,** run `scripts/cost-ledger off --local`. It takes effect on your next `/mr` or `/wave` run, in every worktree of the clone, and is never committed. `on --local` only removes your opt-out; it can't turn the ledger on over a project that chose off.
- `scripts/cost-ledger status` always says which layer decided.

### Where it lives, and which layer wins

| Layer | Where | Who changes it |
|---|---|---|
| Project | `.claude/cost-ledger.json`, committed: `{"_doc": ..., "schema": 1, "cost-ledger": "on"}` | the project, through a chore MR |
| Local opt-out | `git config visiban.costLedger false` (local, or `--global`) | one person, at once, untracked |

Effective value: **off** if `.claude/cost-ledger.json` says off; otherwise **off** if `git config visiban.costLedger` is false (local or global); otherwise **on**. A local setting can turn recording off, never on over a project that chose off. **An unreadable layer counts as off** (an unknown `schema`, any other value, or invalid JSON makes the file unreadable).

Local git config lives in the clone's git common dir, so one `off --local` covers every `scripts/wt` worktree of that clone. A local `true` has no effect: it can never override a project `off`, and on a project that's on it's already the default.

| Command | What it does |
|---|---|
| `scripts/cost-ledger status` | Prints the effective value and the layer that set it, e.g. `cost-ledger: off (set by: git config, local; project: on)`. `--json` prints `effective`, `layer`, `project`, `local`, `global` |
| `scripts/cost-ledger enabled` | Quiet. Exit 0 on, 1 off, 2 a layer is unreadable. Skills and scripts consult this |
| `scripts/cost-ledger off` / `on` | Edits `.claude/cost-ledger.json` in place (only the value changes, the file mode is kept) |
| `scripts/cost-ledger off --local` / `on --local` | `off` writes `visiban.costLedger false` to the local git config; `on` only unsets it, and warns when the project still says off |

### Why a setting, and why these two layers
<a id="why-a-setting"></a>

Blueprint recorded this decision as its ADR 0011; Visiban has no ADR directory, so the rationale lives here.

- **Recording is a choice.** `orchestrator-tokens:` reads the session transcript, which holds the conversation, to sum its usage fields. Some people won't want a tool reading transcripts at all, even for counts, and some won't want per-MR usage in a public MR description. Visiban's MRs mirror to a public GitHub repository.
- **One committed file, one reader, one precedence line.** The project layer is reviewable and versioned. Only `scripts/cost-ledger` reads either layer, so the precedence can't drift between callers.
- **The local layer is git config, not a file in the checkout,** because recording happens inside `scripts/wt` worktrees and git config is the one per-person store every worktree of a clone shares.
- **Toggling is switchable at any time, both ways.** The project layer changes through a chore MR (a branch made before it merges still has the old file). The local layer takes effect at once.
- **Known debt, stated rather than tracked:** nothing in CI checks that an MR's `cost-ledger: off` line matches the project file at the MR's base; the transcript layout the scripts read is undocumented and can change without notice; and a stale price table only omits the estimate, it doesn't warn anyone.

## What off records
<a id="what-off-records"></a>

With the ledger off, `/mr` and `/wave` write one line at the end of `## Gates`:

```text
cost-ledger: off
```

There's no `subagent-tokens:`, `turns:`, `orchestrator-tokens:`, `est-cost-usd:` or `cost:` line, and no cost comment (`scripts/cost-table.py` exits 3 and posts nothing). `/wave` doesn't run the three measuring scripts, and each of them also asks the setting first: when it's off or unreadable they exit 3, print nothing on stdout and open no transcript. When the setting is unreadable, the MR also carries the `## Notes` line "cost ledger setting unreadable; nothing recorded".

- **The marker never names the layer,** so a public MR doesn't say whether the project or one person turned recording off. It does show that recording was off for that MR.
- **It takes no other value.** With the ledger on there's no `cost-ledger:` line at all.
- **Off doesn't change `/wave`'s control flow.** A completion notification's `subagent_tokens` field is a context size that `/wave` may read to decide things; it's never recorded, so it applies either way.

## The lines in `## Gates`
<a id="the-lines"></a>

```text
subagent-tokens: 12186912
orchestrator-tokens: 1165345
est-cost-usd: 5.85 (prices 2026-11-03)
```

They go last in `## Gates`, after the `gate:` lines, unchanged from the scripts' stdout. They aren't in the `/mr` template: a template slot only invites an estimate. `/wave` is the one writer with real figures (`.claude/skills/wave/SKILL.md` Step 5.4); a plain `/mr` with no figures writes none of them, and that isn't a gap.

- **`subagent-tokens:` and `orchestrator-tokens:` are measured,** never estimates: digits only, summed per response (input + cache-write + cache-read + output), once per message id, so the two are in the same unit.
- **`subagent-tokens:`** covers the agents the orchestrator named (`--agent <id>`, the `agentId:` the Agent tool result prints) and their descendants through `parentAgentId` (the implementer's own gate batch), up to the go-ahead to push.
- **`orchestrator-tokens:` is session spend over the window, not attribution.** On a multi-issue wave the branches' windows overlap in one orchestrating session, so each figure is the session's spend while that branch was open. **Never add it to `subagent-tokens:` as the MR's cost, and never sum it across a wave's MRs.**
- **`turns: <N>` and `cost: usd <N>`** are allowed only for a literally reported, measured figure, never computed from `.claude/model-prices.json`.
- **`budget-exceeded: <N>`** is upstream's count of agents that reached their `/wave` budget. Visiban's `/wave` has no per-agent budget and doesn't write it; the readers accept it, and the cost comment shows it only when it's present.
- **The retired `tokens:` line** (upstream, before `macrodream/blueprint#365`) summed the latest notification's `subagent_tokens`, which tracks about one context plus output: measured against transcripts it ran a median ~30x below cumulative usage. It's rejected.
- **A script that exits non-zero writes no line,** and the reason goes in `## Notes`. A partial figure would read as a whole one.

**Check a draft** with `python3 scripts/cost_ledger_lines.py --file <body.md>`. It never requires a cost line. It rejects a malformed figure (`~5k`, `1,234`, `$1.00`, `1.2.3`, `.5`, non-ASCII digits), a second copy of any line, the bare `tokens:` line, a `cost-ledger:` line with any value but `off`, a second marker, and the marker together with any cost line. It reads only `## Gates`, outside code fences, with HTML comments stripped, and it never echoes the line it rejects: an MR description is written by whoever can edit it.

### The layout dependency

The scripts read `<projects-dir>/<slug>/<session-id>.jsonl` and `<session-id>/subagents/agent-<id>.jsonl` with its sibling `agent-<id>.meta.json` (default projects dir `~/.claude/projects`). That layout isn't documented by Claude Code (observed 2026-11-03), and transcripts are deleted after `cleanupPeriodDays` (30 days by default), so the lines are written at MR time or not at all.

- **The slug doesn't matter.** A session is found by its id under any slug (`<projects-dir>/*/<session-id>.jsonl`), so a session started in the main checkout (`-Users-...-visiban`) and one started inside a `../visiban-wt/<leaf>` worktree resolve the same way.
- **It fails closed.** An id with no transcript, or a session that doesn't resolve to exactly one directory, exits 1 and prints no line.
- **One gap remains:** descendants are found only through `parentAgentId` in the meta files, so a nested agent whose transcript exists but whose meta file is missing isn't found, and the sum is partial.
- **A branch resumed from another session** can't be read from this one: omit `subagent-tokens:` and say so; `orchestrator-tokens:` then covers the current session only.

## The `est-cost-usd:` line
<a id="est-cost-usd"></a>

```bash
python3 scripts/est-cost.py --agent <id> [--agent <id> ...] --since <T> --until <T>
```

It prices the orchestrating session's own usage over `--since`/`--until` plus the named agents and their descendants up to `--until`, each response at its own `message.model` and four usage classes, once per message id. The line goes on stdout; the per-model figures, or the reason for an omission as a `note:` line for `## Notes`, go to stderr. **Exit 0** priced, **1** omitted, **2** usage, **3** ledger off.

- **It's omitted, never guessed,** when the price table is older than 90 days, missing, malformed or has no row for a model used, or a response ran in fast mode (`speed` other than `standard`), with a non-global `inference_geo`, or a `service_tier` other than `standard` (the table has no multiplier for any).
- **Cache writes** are split by `message.usage.cache_creation.ephemeral_1h_input_tokens` (1-hour rate) and the rest (5-minute rate). A response without a valid split is priced entirely at the cheaper 5-minute rate, so the estimate can understate on that field and never overstates.

### The price table

`.claude/model-prices.json` holds full model ids as keys, USD per million tokens for `input`, `cache_write_5m`, `cache_write_1h`, `cache_read` and `output`, an optional `long_prompt` tier, a `checked` date and the `source` URL.

**Watch out:** Visiban's table was **copied from Blueprint's table** (`checked` 2026-11-03, `source` the platform.claude.com pricing page), not re-copied from the source page. Prices are copied from that page by a person and checked in review, never invented.

**Refresh it** (re-copy the source table and update `checked`) when `/kaizen` reports `subagent-tokens:` lines but no `est-cost-usd:` line in its window: a stale table only omits the estimate, it warns nobody.

## The cost comments
<a id="the-cost-records"></a>

GitLab renders the bare ledger lines run together as one paragraph, so the readable table is an MR comment, `## Cost of this MR (#<issue>)`, with a Sonnet vs Opus split. The description carries no `## Cost` section. The same setting governs it: ledger on, an MR carries the lines and the comment; off, neither.

Work on an MR after its first comment is a further comment, never an edit:

- **Record 1** covers the branch up to the go-ahead to push. Its figures are the description's ledger lines, and its heading has no record number.
- **Record K** (2, 3, ...) covers one later window: a fix round after the MR opened, or a re-measure. Its heading is `## Cost of this MR (#<issue>) — record K`, it states its window start and end, its figures come from the measuring scripts' own stdout for that window (not from the description), and it adds a running-total row across records 1..K.
- **The `## Gates` lines stay record 1's figures.** No reader sums the later records: `/kaizen` sees the branch up to the go-ahead.
- **One record per window.** A re-run for the same window (same start and end) updates that window's record, which must be the latest; a different window posts a new one. An earlier record is never edited: record 1 is refused (exit 5) once a record 2 exists, and so is a window that matches any record but the latest.
- **A subagent still running after a record's window end is counted in no record.** The subagent scripts have no per-window cut: they count an agent's usage up to `--until`. Name only agents spawned fresh in a record K's window; a resumed agent makes the subagent cells `n/a` (post the record without a `subagent-tokens:` / `est-cost-usd:` line). Nothing checks this but the prose (upstream's guard is `macrodream/blueprint#385`).
- **A window with no subagent** shows a **measured 0** for the Subagents row, only from the explicit `--no-agents`, given to both `subagent-tokens.py` (prints `subagent-tokens: 0`) and `est-cost.py` (prices the orchestrator alone). A forgotten `--agent` isn't a 0: without `--agent` and without `--no-agents` both exit 2, and the two together are a usage error.

### Running it

All modes are `scripts/cost-table.py`. `/wave` Step 6 has the exact commands.

- **Record 1:** `python3 scripts/cost-table.py --comment --file <description.md> --issue <N> --until <T> --split <file> --post --mr <iid>`. Without `--post` it prints the body.
- **The next window's start:** `python3 scripts/cost-table.py --next-since --mr <iid>` prints the latest record's window end (exit 1 when this user has no readable record with a window end).
- **Record K:** measure the window with the three scripts (`--since` the value above, `--until` now; `subagent-tokens.py` takes no `--since`), keeping their stdout in one file and their stderr in another, then `python3 scripts/cost-table.py --comment --ledger <stdout lines> --split <stderr> --since <S> --until <T> --issue <N> --mr <iid> --post`. Save the window as `<iid> <S> <T>` in `$(git rev-parse --git-dir)/wave-cost-window.txt`; a re-run of the same record reuses it only when the first field is this MR's iid, because `--next-since` returns the posted record's own end.
- **File arguments** (`--file`, `--ledger`, `--split`) must resolve under the checkout, the current directory, the system temp directory or the clone's git common dir. `/wave` keeps them in the git dir (`wave-cost-desc.md`, `wave-cost-split.txt`, `wave-cost-lines.txt`), which for a worktree is outside the checkout and is never committed.

Exit codes: **0** rendered (printed or posted); **1** no `## Gates` section; **2** usage, an unreadable file, or a file outside the allowed directories; **3** the ledger is off or unreadable, or the lines carry `cost-ledger: off`, so no record and no API call; **4** the notes or the token's user couldn't be read or written; **5** refused, the window belongs to an earlier record.

### What a record shows

- **Sonnet vs Opus.** A tokens and an estimated-cost column per model family, for subagents and for the orchestrator, plus the ledger lines' totals. The per-model figures come only from the exact `model` lines the measuring scripts print on stderr (`subagent-tokens: model <id> <N>`, `orchestrator-tokens: model <id> <N>`, `est-cost: subagent|orchestrator model <id> <USD> USD`); `--split <file>` is those stderr streams concatenated, and no other line in it is read. A third family gets an `Other` column.
- **n/a, never 0.** No split file, a model with no estimate, a missing, doubled or malformed ledger line, or no window end shows `n/a` with a fixed reason; it never echoes the line's text. A family a side didn't use shows `none used`. If a side's split doesn't sum to its ledger line, the record says so; the line is the record. The Total tokens cell is `n/a` unless both token lines are present.
- **States** the window, that the cost is a list-price estimate from `.claude/model-prices.json` with its price date, and that the orchestrator figure is shared by every branch of the same wave. A record K also states each stretch no record covers.

### Reading earlier records back

Earlier records are MR notes, which anyone who can comment can write, so the running total is built only from notes that pass every check:

- **Authored by the token's own user** (`glab api user`). A note with the heading by anyone else is counted ("N note(s) with this heading by another user were not read") and never read, numbered from or edited.
- **The generated heading** as the first line and **the generated footer** as the last.
- **At most 32 KB,** ASCII apart from the heading's dash, exactly one header row, one **Total** row and one window line, every Total cell a bold figure of a fixed shape (`1,234`, `0.40 USD`) or `n/a (...)`, and valid UTC times.

A failed check never becomes 0 or a guess: the running-total row reads `n/a` and the record states why, from a fixed list (an earlier record didn't parse; this user's earlier records aren't exactly records 1 to K-1; an earlier record states no window end; a window starts before the previous one ended). A time gap between windows isn't on the list: the total still adds up and the record states the uncovered stretch. No note text is echoed in any message or record, so a hostile note can't put text into the comment this script posts with your token.

- **It never overwrites a note it can't identify.** Record 1 is updated only when this user has exactly one, and it parses (otherwise exit 5). Two notes with the latest record number are both left alone.
- **It reads at most 2,000 notes** and exits 4 on an MR with more, so a flood of comments stops the records rather than skewing them.
- **Run one cost post per MR at a time.** Two sessions posting at once can both take the same number; the next record then reads `n/a`.
- **`glab api` paths** are built only from constants and integers (the iid, a note id, a page number), and the JSON body goes through stdin.

### An example

A record 2 for an MR whose window used 1,500 Sonnet tokens (the self-test's case; the per-side rows are elided):

```markdown
## Cost of this MR (#383) — record 2

| | Sonnet tokens | Sonnet est. cost | Opus tokens | Opus est. cost | Total tokens | Est. cost |
|---|---|---|---|---|---|---|
| ... | ... |
| **Total** | **1,500** | **0.40 USD** | **0** | **0.00 USD** | **1,500** | **0.40 USD** |
| **Running total, records 1-2** | **11,560,862** | **3.50 USD** | **0** | **0.00 USD** | **11,560,862** | **3.50 USD** |

- Window: 2026-11-04T15:38:24Z to 2026-11-04T17:00:00Z. This record counts only the work in this window; the running-total row adds the earlier records.
- Running total: the last row, records 1-2.
```

The amount is written `1.57 USD`, not with a dollar sign, so GitLab never reads a pair of `$` as inline math.

## What `/kaizen` reports
<a id="kaizen"></a>

`scripts/kaizen_gate_ledger.py` reads the lines through `scripts/cost_ledger_lines.py`, the same reader `cost-table.py` uses, and adds a `## Cost` section to its report (`cost` in `--json`).

- **Each MR is in one state:** `recorded` (a well-formed figure), `disabled` (`cost-ledger: off`: nothing recorded, by choice) or `none` (no figure yet). A disabled MR is never counted as 0 and never averaged. A window or change class whose MRs are all disabled reads "disabled", not a mean and not "not recorded yet". **A window of disabled MRs isn't evidence that cost fell.**
- **By change class** (the branch prefix `feat`, `fix`, `docs`, `chore`, else `other`, the same proxy as the [yield watch](kaizen-yield-watch.md)): mean `est-cost-usd` and mean `subagent-tokens` over the class's recorded MRs. `orchestrator-tokens:` is never averaged.
- **By gate:** the mean estimate of the MRs a gate ran on vs was `n/a` on, and findings per USD (the gate's findings on those MRs over their summed estimate). It's the MR-level cost, not the gate's own cost: the ledger records cost per MR, not per gate.
- **Malformed lines:** MRs whose cost lines fail the checker are listed; their malformed figures are ignored, not read as 0.

## What isn't ported

- **No MR-description CI lint.** Upstream's `mr-gate-ledger` job checks every MR description; Visiban has no gate-ledger lint job, and this port didn't add one. The cost rules live in `scripts/cost_ledger_lines.py`, run by hand before `glab mr create` (the `/mr` and `/wave` skills say when).
- **Not ported:** upstream's `gate-yield.py` and `mr-verdict.py` (the `/kaizen` adaptation above replaces the cost sections of `gate-yield.py`), its `change-class:` ledger line (Visiban classifies by branch prefix), and its context-nudge Stop hook.
