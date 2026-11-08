# Record what each merge request cost
<a id="cost-ledger"></a>

`/wave` writes each MR's measured token usage and a list-price USD estimate in its `## Gates` section, and posts a readable cost table as an MR comment (#2128).

**Why it matters:** `## Gates` already records each gate's *yield*. Without its cost beside it, `/kaizen` can't ask the question that decides whether a gate or a rework round earns its slot: findings per dollar, by gate and by change class.

**The big picture:** One setting, `cost-ledger`, turns all of it on or off. It's **on by default**. Three scripts measure, one renders the comment, one checks the lines, and `/kaizen` reads them.

**Watch out:** `est-cost-usd:` is a **list-price equivalent**: what the same tokens would cost at the public API rates, not what a subscription charged.

This is a port of Blueprint's cost ledger (macrodream/blueprint#235, macrodream/blueprint#340, macrodream/blueprint#348, macrodream/blueprint#364, macrodream/blueprint#365, macrodream/blueprint#381, macrodream/blueprint#383, macrodream/blueprint#384, macrodream/blueprint#386 and macrodream/blueprint#387). Upstream references are always written `macrodream/blueprint#N`, in the scripts too, so they never link a Visiban issue.

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
| `scripts/cost-table.py` | Renders and posts the `## Cost of this MR` comment; its record parser is also what `/kaizen` reads per-MR cost with |
| `scripts/post-mr-cost.py` + `.claude/hooks/post-mr-cost.sh` | The only code that measures and posts a record: the PostToolUse hook after `glab mr create` (record 1), `--round` (record K), `--measure` (the go-ahead lines) |
| `scripts/tests/cost-ledger-golden/` | The golden fixture `post-mr-cost.py --self-test` replays; byte-identical to the one in the other repos that carry this harness |
| `scripts/cost_ledger_lines.py` | Reads and checks the cost lines in a description; shared by `cost-table.py` and `/kaizen` |
| `scripts/kaizen_gate_ledger.py` | `/kaizen`'s reader; reports cost by change class and by gate |

Every script has a `--self-test`; `post-mr-cost.py`'s also replays the golden fixture. The `cost-ledger-selftest` CI job runs them all, plus `scripts/tests/kaizen_gate_ledger.test.sh`, on MRs that touch any of them.

## It posts on its own
<a id="auto-post"></a>

After any `glab mr create` run by Claude Code, the `.claude/hooks/post-mr-cost.sh` hook posts the `## Cost of this MR` comment, so the comment no longer depends on `/wave` being the path that opened the MR. Before this, only MRs opened through `/wave` got one (of !1736-!1744 only !1737 did).

- **Opt out** with the existing setting: `scripts/cost-ledger off --local` (you only) or `scripts/cost-ledger off` through a chore MR (everyone). Either makes the hook do nothing. A `cost-ledger: off` line in the MR description also opts that one MR out.
- **No double comment:** if the MR already has a `## Cost of this MR` comment (for example `/wave` posted one), the hook leaves it alone.
- **Window:** what this session has not yet claimed in an earlier record, from per-session state (`${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.json`, one file per session across repos; a symlinked `mr-cost-state` that escapes the config directory is refused with "path escapes the config directory"), to now; see [Non-overlap](#non-overlap). The legacy shared `mr-cost-last-until` marker and the old per-repo state files are never read. A subagent is attributed to the MR whose worktree it acts in (where its `Edit`/`Write` calls land, else its `cd` / `git -C` targets), and only when that is unknown, by its brief. Start time is never used.
- **Fail-soft:** if the transcript layout changed or `glab` fails, the hook never blocks the MR. It prints the `python3 scripts/post-mr-cost.py --retry --mr <iid> --session <sid>` command to run in the right checkout.
- **One repo per hook.** It posts only when the project in the printed MR URL equals the `origin` project of the repo it runs in, and every `glab api` call names its project explicitly (`cost-table.py --project`), so a session in one repo can't post a record on another repo's MR.
- **It logs every `glab mr create` it sees,** one line each, to `mr-cost-hook.log` in the clone's git common dir: time, session id, MR number and a fixed outcome (`posted`, `cost-ledger off`, `a cost comment already exists`, `could not read its notes`, `no usable session id`, and so on). It never logs command text or tokens, and it rotates at 256 KB. **No line for an MR you opened through Claude Code means the hook never ran in that session**, usually because the session started before the hook was in the checkout (hooks load at session start) or the MR was opened another way. A line with an outcome means it ran and says why it stayed quiet. A notes read that fails now says so in the session instead of silently skipping.
- **Fix rounds:** the hook can't see them. `/fix-mr` runs `python3 scripts/post-mr-cost.py --round --mr <N>` after its push, which posts `## Cost of this MR (#N) — record K` for the window since the latest record, with the running total. It posts nothing when the ledger is off, the MR carries `cost-ledger: off`, record 1 is missing, or nothing was measured, and it prints one line saying which. It advances the per-session state, so the next record doesn't re-count the round. Run it by hand the same way for any other work on an open MR.
- **Limit:** it only sees `glab mr create` run through Claude Code's Bash tool. An MR opened in the GitLab UI or a plain terminal gets no comment.

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
- **The transcript layout the scripts read is undocumented** and can change without notice. That's a property of Claude Code, not work this repo can schedule; see [The layout dependency](#the-layout-dependency).

### Known debt

Each item below is tracked in #2131, except the last (Sonar suppressions), which #2153 tracks.

- **The off marker isn't checked against the project file.** Nothing in CI checks that an MR's `cost-ledger: off` line matches `.claude/cost-ledger.json` at the MR's base.
- **A stale price table warns nobody.** It only omits the estimate. The shipped table (`checked` 2026-11-03) lapses on 2027-02-01, 90 days later; see [The price table](#the-price-table).
- **No CI lint reads MR descriptions.** The cost-line rules run by hand; see [What isn't ported](#what-isnt-ported).
- **Sonar suppressions on `scripts/post-mr-cost.py` await re-verification.** The scan ran and #2152 handled its findings: state and session paths are confined in code, and the rest carry narrow per-file ignore entries (`pythonsecurity:S8707`, `S2083`, `S8705`, `S6350`) because Sonar doesn't treat `scripts/_paths.py` `resolve_within` as a sanitizer. #2153 tracks re-checking them after the first nightly scan.

## What off records
<a id="what-off-records"></a>

With the ledger off, `/mr` and `/wave` write one line at the end of `## Gates`:

```text
cost-ledger: off
```

There's no `subagent-tokens:`, `turns:`, `orchestrator-tokens:`, `est-cost-usd:` or `cost:` line, and no cost comment (`scripts/cost-table.py` exits 3 and posts nothing). `/wave` doesn't run `scripts/post-mr-cost.py`, the only code that measures, which stops before it reads a transcript, and each of the three measuring scripts also asks the setting first: when it's off or unreadable they exit 3, print nothing on stdout and open no transcript. When the setting is unreadable, the MR also carries the `## Notes` line "cost ledger setting unreadable; nothing recorded".

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

They go last in `## Gates`, after the `gate:` lines, unchanged from the scripts' stdout. They aren't in the `/mr` template: a template slot only invites an estimate. `/wave` is the one writer with real figures (`.claude/skills/wave/SKILL.md` Step 5.4, from `python3 scripts/post-mr-cost.py --measure`); a plain `/mr` with no figures writes none of them, and that isn't a gap.

- **`subagent-tokens:` and `orchestrator-tokens:` are measured,** never estimates: digits only, summed per response (input + cache-write + cache-read + output), once per message id, so the two are in the same unit.
- **`subagent-tokens:`** covers the agents the orchestrator named (`--agent <id>`, the `agentId:` the Agent tool result prints) and their descendants through `parentAgentId` (the implementer's own gate batch), up to the go-ahead to push.
- **`orchestrator-tokens:` is session spend over the window, not attribution.** Never add it to `subagent-tokens:` as the MR's cost.
- **The `## Cost of this MR` records of one session do not overlap, so they add up (macrodream/blueprint#387).** Each record claims only what no earlier record of that session claimed (see [Non-overlap](#non-overlap)). The `## Gates` ledger lines are different (and the comments are a source, not only a rendering: `/kaizen` reads them): they are `post-mr-cost.py --measure` snapshots taken at the go-ahead, which claim nothing, so the lines of two MRs from one session can still cover the same stretch. Read the comments, not the lines, when adding up a session; `/kaizen` does (#2154).
- **`turns: <N>` and `cost: usd <N>`** are allowed only for a literally reported, measured figure, never computed from `.claude/model-prices.json`.
- **`budget-exceeded: <N>`** is upstream's count of agents that reached their `/wave` budget. Visiban's `/wave` has no per-agent budget and doesn't write it; the readers accept it, and the cost comment shows it only when it's present.
- **The retired `tokens:` line** (upstream, before `macrodream/blueprint#365`) summed the latest notification's `subagent_tokens`, which tracks about one context plus output: measured against transcripts it ran a median ~30x below cumulative usage. It's rejected.
- **A line the measuring can't print is not written,** and the reason goes in `## Notes`. A partial figure would read as a whole one.

**Check a draft** with `python3 scripts/cost_ledger_lines.py --file <body.md>`. It never requires a cost line. It rejects a malformed figure (`~5k`, `1,234`, `$1.00`, `1.2.3`, `.5`, non-ASCII digits), a second copy of any line, the bare `tokens:` line, a `cost-ledger:` line with any value but `off`, a second marker, and the marker together with any cost line. It reads only `## Gates`, outside code fences, with HTML comments stripped, and it never echoes the line it rejects: an MR description is written by whoever can edit it.

### The layout dependency

The scripts read `<projects-dir>/<slug>/<session-id>.jsonl` and `<session-id>/subagents/agent-<id>.jsonl` with its sibling `agent-<id>.meta.json` (default projects dir `~/.claude/projects`). That layout isn't documented by Claude Code (observed 2026-11-03), and transcripts are deleted after `cleanupPeriodDays` (30 days by default), so the lines are written at MR time or not at all.

- **The slug doesn't matter.** A session is found by its id under any slug (`<projects-dir>/*/<session-id>.jsonl`), so a session started in the main checkout (`-Users-...-visiban`) and one started inside a `../visiban-wt/<leaf>` worktree resolve the same way.
- **A session directory that symlinks out is refused.** A `<projects-dir>/<slug>/<session-id>` directory that resolves outside the projects dir (a symlink) makes the run post nothing and say "the session's subagent directory resolves outside the projects directory, so nothing was measured", rather than record a `subagent-tokens: 0` that was never measured, or drop a named `--agent` silently (#2152).
- **It fails closed.** An id with no transcript, or a session that doesn't resolve to exactly one directory, exits 1 and prints no line.
- **One gap remains:** descendants are found only through `parentAgentId` in the meta files, so a nested agent whose transcript exists but whose meta file is missing isn't found, and the sum is partial.
- **A branch resumed from another session** can't be read from this one: omit `subagent-tokens:` and say so; `orchestrator-tokens:` then covers the current session only.

## The `est-cost-usd:` line
<a id="est-cost-usd"></a>

`scripts/est-cost.py` is reference only (`scripts/post-mr-cost.py --measure` runs it for you, with the right windows); nobody runs it by hand.

It prices the orchestrating session's own usage over `--since`/`--until` plus the named agents and their descendants up to `--until`, each response at its own `message.model` and four usage classes, once per message id. The line goes on stdout; the per-model figures, or the reason for an omission as a `note:` line for `## Notes`, go to stderr. **Exit 0** priced, **1** omitted, **2** usage, **3** ledger off.

- **It's omitted, never guessed,** when the price table is older than 90 days, missing, malformed or has no row for a model used, or a response ran in fast mode (`speed` other than `standard`), with a non-global `inference_geo`, or a `service_tier` other than `standard` (the table has no multiplier for any).
- **Cache writes** are split by `message.usage.cache_creation.ephemeral_1h_input_tokens` (1-hour rate) and the rest (5-minute rate). A response without a valid split is priced entirely at the cheaper 5-minute rate, so the estimate can understate on that field and never overstates.

### The price table

`.claude/model-prices.json` holds full model ids as keys, USD per million tokens for `input`, `cache_write_5m`, `cache_write_1h`, `cache_read` and `output`, an optional `long_prompt` tier, a `checked` date and the `source` URL.

**Watch out:** Visiban's table was **copied from Blueprint's table** (`checked` 2026-11-03, `source` the platform.claude.com pricing page), not re-copied from the source page. Prices are copied from that page by a person and checked in review, never invented.

**Refresh it** (re-copy the source table and update `checked`) before it lapses on 2027-02-01, or when `/kaizen` excludes MRs as "a record with no USD total" (`no_usd`): a stale table only omits the estimate, it warns nobody (#2131).

## The cost comments
<a id="the-cost-records"></a>

GitLab renders the bare ledger lines run together as one paragraph, so the readable table is an MR comment, `## Cost of this MR (#<issue>)`, with a Sonnet vs Opus split. The description carries no `## Cost` section. The same setting governs it: ledger on, an MR carries the lines and the comment; off, neither.

Work on an MR after its first comment is a further comment, never an edit:

- **Record 1** covers the session's work up to the moment `glab mr create` ran (the hook measures it then; macrodream/blueprint#387), not the description's ledger lines, which are the go-ahead snapshot from `--measure`. Its heading has no record number.
- **Record K** (2, 3, ...) covers one later window: a fix round after the MR opened, or a re-measure. Its heading is `## Cost of this MR (#<issue>) — record K`, it states its window start and end, its figures come from the measuring scripts' own stdout for that window (not from the description), and it adds a running-total row across records 1..K.
- **The `## Gates` lines are the go-ahead snapshot.** `/kaizen` does not read them as an MR's cost (their orchestrator share overlaps other MRs of a wave); it sums the MR's windowed records instead ([What `/kaizen` reports](#kaizen)). `subagent-tokens:` from `## Gates` stays usable: it is per branch.
- **One record per window.** A re-run for the same window (same start and end) updates that window's record, which must be the latest; a different window posts a new one. An earlier record is never edited: record 1 is refused (exit 5) once a record 2 exists, and so is a window that matches any record but the latest.
- **A subagent that keeps working after a record is counted in the next one, once.** Each agent has its own watermark (the end of the last record that measured it), and the next record counts that agent only for usage after it (`--agent <id>@<since>`, below). This is the per-agent cut upstream's `macrodream/blueprint#385` asked for.
- **A window with no subagent** shows a **measured 0** for the Subagents row, only from the explicit `--no-agents`, given to both `subagent-tokens.py` (prints `subagent-tokens: 0`) and `est-cost.py` (prices the orchestrator alone). A forgotten `--agent` isn't a 0: without `--agent` and without `--no-agents` both exit 2, and the two together are a usage error. An orchestrator with no usage in the window still prints no line, so its cells stay `n/a`.

### Non-overlap: per-session state and attribution
<a id="non-overlap"></a>

macrodream/blueprint#387. An audit of 40 MRs found records that repeated the session's growing total, a window marker shared by every session and worktree, and subagents attached to whichever MR opened first. The decision: **records do not overlap.** Each record claims only tokens no earlier record of the same session claimed, so summing every record a session posted gives that session's total. In a parallel wave the first MR to open carries the orchestrator spend interleaved up to that point, and the record's footnote says so.

- **State.** `${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.json`, one file per session and not per repo (a session spans repos, so a record in one repo must advance the window every other repo's record starts from; the old per-repo files under `<git-common-dir>/mr-cost-state/` are never read): `{"schema": 1, "orchestrator_until": "<UTC Z>", "agents": {"<agent-id>": "<UTC Z>"}}`, written atomically (a temp file in the same directory, then `os.replace`) after **every** successful post by `scripts/post-mr-cost.py`: `orchestrator_until` and the watermark of each agent that record measured (descendants too) move to the record's `until`. It is per session. The legacy shared `mr-cost-last-until` marker is **never read**, not even as a fallback; delete it if you find one. A state file that exists but doesn't validate posts nothing and says so, because guessing a window would double count. A `mr-cost-state` directory that is a symlink resolving outside the config directory is refused the same way: nothing is posted and the message says "path escapes the config directory" (#2152); keep the real directory there, not a link.
- **A record with no `pending` entry that landed without the state moving (reconcile).** Records this version posts are settled by the write-ahead `pending` claim (below), which covers a landed post on any MR. Reconcile covers only a record with no pending entry: one posted by an older version of this code, or after the state file was lost. The next run of the hook (on an MR that already has a cost comment) or of `--retry` adopts such a record: it posts nothing and advances the state to the record's end, for the orchestrator and for the agents that record's window would have attributed. A record is adopted only if it is **this session's**, which is decided by its window **start**: the token user's own record whose `Window: <since> to <until>` line starts exactly at the session's current `orchestrator_until` (a session with no state yet matches the session's first transcript entry), and whose end is not in the future. A record another session posted on the same MR starts at that session's own watermark, a record by another user is never read, and an older record with no `Window:` line has no start and is never adopted; in those cases the hook posts nothing and leaves the state alone, and `--retry` falls through to `--round`. It never moves a watermark backwards. Only expected failures (an unreadable state, a missing transcript) read as "nothing to adopt"; any other error is reported, not swallowed.
- **Windows.** Orchestrator: from `orchestrator_until` to now (no state: from the session transcript's first entry). Each agent: from its own watermark to now (none: from its first entry); a descendant is measured over its own watermark and goes with its top-level parent. A watermark is an exclusive bound, so a response stamped exactly at the previous record's end is counted once. The measuring scripts take this as `--agent <id>@<since>` (and `--agent-since <id>@<since>` for an agent that isn't named, such as a descendant) on `subagent-tokens.py` and `est-cost.py`.
- **Attribution of top-level agents to an MR.** A subagent transcript's `cwd` and `gitBranch` always show the session root and `main`, so they can't say which branch an agent worked on. Two things in the transcript can:
  1. **Where it acts** (strongest). The git worktree, and so the BRANCH, holding the majority of the agent's `Edit` / `Write` / `NotebookEdit` `file_path`s; else the one its Bash `cd <path>` and `git -C <path>` (not `show`, `diff` or `log`) calls target most, when one leads strictly (a read-only auditor `cd`s into what it audits). When that home is known the agent counts for this MR if it is this MR's worktree and not otherwise, and its brief is ignored: a port agent's brief names the worktree it reads as well as the one it writes, so the brief can't tell them apart. A path is resolved with `git worktree list --porcelain` for the hook's repo (the deepest listed worktree containing it): the agent counts for this MR only if that worktree's branch is the MR's source branch. This is what keeps `/wave`'s workers, which run under `<main>/.claude/worktrees/agent-*` while the MR is opened from the main checkout, apart: a path there is a worker's branch, never the main checkout's, and one under `.claude/worktrees/` that git no longer lists is no home at all. Only a path in no listed worktree (another repo's, or one already removed) falls back to the `*-wt/<issue>-<slug>` leaf. Two worktrees written equally often are no home (a strict majority is required), so the `cd` rule decides, then the brief.
  2. **Its brief** (the text of its first `user` entry), when no home is known. It counts if it names this MR's source branch, branch leaf or worktree leaf (`<issue>-<slug>`); it is left for another record if it names another branch `(feat|fix|docs|chore)/<digits>-...` or another worktree path component `.../<issue>-<slug>`; a brief naming both this MR and another keeps this MR; an unnamed gate counts if it has usage after its watermark, so the first record to open claims it.

  `--agent` and pins override both. Briefs, paths and commands are untrusted text: they are classified and matched, never printed.
- **Empty rows.** Claude Code writes `<synthetic>` assistant entries with all-zero usage on an interrupt or an error. The parser drops any response whose four usage values are all zero and counts it in the `empty` figure on stderr, so no `model unknown 0` split line exists and the **Other** column appears only when a model outside Sonnet and Opus used tokens.
- **The golden fixture.** `scripts/tests/cost-ledger-golden/` is one synthetic session (an orchestrator, an agent with a nested descendant, an agent for another branch that started before the first MR opened, an unnamed gate, a zero-usage row, an agent resumed after its record) replayed through the real hook, `--round`, the state files and `cost-table.py` with a fake `glab` and a temp git dir. `expected.json` pins each record's totals and rows and that the three records add up to the session's usage with nothing claimed twice. `python3 scripts/post-mr-cost.py --self-test` runs it. The directory is copied byte for byte into the other repos that carry this harness (check with `diff -r`), so it names no repo-specific path or issue.

### Concurrency and known limits

- **One post at a time per session.** The state (and the pins) are a read, a post and a write. An exclusive `flock` on `mr-cost-state/<session-id>.lock` is held from reading the watermark through writing it, by the hook, `--round`, `--retry`, reconcile and `--pin`, so two MRs opened at once in one session claim consecutive windows instead of the same one, and neither drops the other's agent watermarks. (No locking on a platform without `fcntl`, or when the state directory escapes the config directory, which the state read and write then refuse; the writes stay atomic.)
- **A post that lands while its state write does not (the write-ahead `pending` claim).** Before a post, inside the lock, the state file gets `"pending": {"mr", "project", "since", "until", "agents"}` beside the unchanged watermarks; after a confirmed post the watermarks move to those values and `pending` is removed. If the POST landed but the commit did not (cost-table exited non-zero after it, a kill, a timeout), the next run of the hook, `--round`, `--retry`, `--measure` or `--pin`, on ANY MR, settles it first by reading the pending MR's notes: a record by the token user with exactly that `Window: S to U` was posted, so the claim is committed; none, with the notes read, was not posted, so the claim is dropped and the window is claimed again exactly once; notes that can't be read refuse the post (and print the `--retry` command), never a guess (a malformed state or pending entry is reported with the state file's path and the reason, and the fix is to inspect or remove that file, not to retry). `--measure` commits or drops a pending entry but never posts, and `--pin` is written even when the entry can't be settled. Reconcile stays for a record with no `pending` entry, one posted by an older version of this code or after the state file was lost, where only the window-start rule can tie it to this session.
- **Known limit: agents that write in a detached-HEAD worktree, or in the main checkout while it is on the default branch, belong to no MR.** Their home is a worktree with no branch, or a branch no MR has as its source, so they are excluded from every record. Run such work in a branch's own worktree.
- **Known limit: a record edited after it was posted can be claimed twice.** A pending claim is settled by matching the record's `Window: S to U` line. If someone edits the comment so it no longer parses, or changes its window, the claim is read as absent, dropped, and the window is claimed again.
- **Known limit: a `glab` child that outlives `cost-table.py`'s 300 s timeout.** If it lands its POST after the pending claim was settled as absent (dropped), that window is claimed again and the record exists twice.
- **Known limit: an agent attributed to a branch that never gets an MR in this session is never claimed.** Attribution sends an agent's tokens to the MR of the branch it works on. If that branch is abandoned, or its MR is opened from another session, no record of this session ever includes the agent. Nothing double counts, but those tokens are in no record. `--agent <id>` on a `--round` for another MR counts them there by hand.
- **Known limit: a session's first record includes the work done before its MR's issue.** Its orchestrator row starts at the session's first entry, and says so.

### One repo per hook, and explicit projects

The hook runs in the **session's** directory, which can be a different repo from the one an MR was opened on (a worktree of another project, or `glab mr create -R`). Reading the MR by iid in the wrong repo would post a cost record on an unrelated MR. So the hook parses the project path from the printed MR URL (`https://<host>/<namespace/project>/-/merge_requests/<n>`) and posts only when it equals the project of the repo it runs in (its `origin` remote); otherwise it posts nothing and prints `python3 scripts/post-mr-cost.py --retry --mr <n> --session <sid>` to run in the right checkout. Every `glab api` call also names its project explicitly (`projects/<url-encoded path>/...`, and `cost-table.py --project`), so nothing resolves `:id` against whichever repo the process happens to run in. The golden fixture's fake `glab` rejects `:id` and any other project, and one step replays a `glab mr create` printed for another project.

### Running it

`scripts/post-mr-cost.py` is the only code that measures and posts a record; a person or a skill never runs the three measuring scripts by hand, and nothing writes a window marker.

- **Record 1: the hook.** `.claude/hooks/post-mr-cost.sh` runs it as a `PostToolUse(Bash)` hook after a `glab mr create` that printed an MR URL (timeout 300). It posts nothing when the ledger is off, the MR description carries `cost-ledger: off`, or a `## Cost of this MR` comment already exists; otherwise it measures the session's next window, posts record 1 through `scripts/cost-table.py`, and advances the state. Every outcome of a `glab mr create` is one line in `<git-common-dir>/mr-cost-hook.log`.
- **The go-ahead snapshot: `--measure`.** `python3 scripts/post-mr-cost.py --measure` prints the `subagent-tokens:`, `orchestrator-tokens:` and `est-cost-usd:` lines for the window the next record would cover, for the MR description's `## Gates` section. It never posts and never moves a watermark, so the hook still claims the same tokens at `glab mr create`; its only state writes are the pins (`--pin`) and settling a pending claim from an earlier post (committing it if the record landed, dropping it if not). It attributes by the current branch and worktree.
- **Record K: `--round`.** `python3 scripts/post-mr-cost.py --round --mr <iid>` after the push of a fix round (`/fix-mr` does this). It posts `## Cost of this MR (#N) — record K` with the window that session has not yet claimed, whatever other sessions posted on the MR (the MR must already carry a readable record, the `cost-table.py --next-since` value), a running total across records, and advances the state. A re-run posts a record only if the orchestrator or an attributed agent has new usage since the last post; otherwise it says there is nothing measurable.
- **`--agent <id>`** (repeatable, `--round` and `--measure`): name exact agents (the `agentId:` of the Agent tool result) instead of auto-attribution; a named agent is always counted if it has usage in the window.
- **`--measure --agent <id>` without `--pin`** applies to that run only and prints a one-line stderr warning: record 1 (the hook) won't attribute those agents unless they are pinned.
- **`--measure --agent <id> --pin`:** run it in the branch's own worktree. It also records those agents as belonging to this branch, in `${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.pins.json` (`{"schema": 1, "branches": {"<project>:<branch>": ["<agent-id>"]}}`, the project being the `origin` project as above, so one branch name in two repos can't collide; written atomically, kept apart from the state file). The hook (record 1) and `--round` (record K) read it, so an agent whose brief names no branch is attributed to the same MR in the snapshot and in the records, and is left out of every other branch's record. It refuses (exit 2) to pin to the default branch (`main`, or whatever `origin/HEAD` names): no MR has that source branch, so the agent would be left out of every real branch's record and its tokens never claimed.
- **`--retry --mr <iid> --session <sid>`:** what a fail-soft message tells you to run (it prints the session id, or `<session-id>` when none was usable, and the literal `<iid>` when no MR number was known), in the checkout of the MR's project. It posts record 1 when the MR has no cost comment yet (the hook's work), otherwise the next record (`--round`'s), and advances the state like any other post.
- **`cost-table.py` is reference only.** It renders and reads records (`--comment`, `--next-since`) and is called by `post-mr-cost.py`; don't run it by hand to post a record, since a record posted that way doesn't advance the session state and the next record would count the same tokens again. `--self-test` covers each mode with a fake `glab api`.
- **File arguments** of `cost-table.py` (`--file`, `--ledger`, `--split`) must resolve under the checkout, the current directory, the system temp directory or the clone's git common dir. The measuring scripts' path arguments (`--projects-dir`, a transcript, `--prices`) must resolve under the same roots or `~/.claude` / `$CLAUDE_CONFIG_DIR` (#1377).

Exit codes of `cost-table.py`: **0** rendered (printed or posted); **1** no `## Gates` section; **2** usage, an unreadable file, or a file outside the allowed directories; **3** the ledger is off or unreadable, or the lines carry `cost-ledger: off`, so no record and no API call; **4** the notes or the token's user couldn't be read or written; **5** refused, the window belongs to an earlier record.

### What a record shows

- **Sonnet vs Opus.** A tokens and an estimated-cost column per model family, for subagents and for the orchestrator, plus the ledger lines' totals. The per-model figures come only from the exact `model` lines the measuring scripts print on stderr (`subagent-tokens: model <id> <N>`, `orchestrator-tokens: model <id> <N>`, `est-cost: subagent|orchestrator model <id> <USD> USD`); `--split <file>` is those stderr streams concatenated, and no other line in it is read. The `Other` column appears only when a model outside Sonnet and Opus used tokens.
- **n/a, never 0.** A model with no estimate, a missing, doubled or malformed ledger line, or no window end shows `n/a` with a fixed reason; it never echoes the line's text. A family a side didn't use shows `none used`. **No per-model split at all** (no split file, or neither side has a family) renders a compact two-column `Tokens | Est. cost` table, not a per-family table of `n/a` cells: the Subagents and Orchestrator rows show their tokens and a `-` for cost (a measured 0 shows `0.00 USD`), and the Total row is the record; it parses and numbers like any other. If a side's split doesn't sum to its ledger line, the record says so; the line is the record. The Total tokens cell is `n/a` unless both token lines are present.
- **States** the window, always its actual start and end (record 1 posted by the hook or `--retry` states `Window: S to U.`; the older `Window end: X.` form, which assumed the go-ahead, still parses), plus, on a session's first record only, that the orchestrator row starts at the session's start and includes work done before this MR's issue, that the cost is a list-price estimate from `.claude/model-prices.json` with its price date, and the non-overlap sentence: "Records do not overlap: the orchestrator row is this session's spend since its previous cost record, across every branch it worked, and each subagent is counted only for usage after its previous record. Records from one session add up to its total." (Comments posted before macrodream/blueprint#387 carry the older "must not be added" sentence and still parse.) A record K also states each stretch this MR has no record for; the work in such a stretch is in another MR's record from the same session, or in none.

### Checks that the comment exists
<a id="checks-that-the-comment-exists"></a>

The check is `python3 scripts/cost-table.py --next-since --mr <iid>`: it reads only the token user's own records. Exit 0: a record with a window end exists. Exit 1: no such record (none, one that doesn't parse, or one with no window end). Exit 3: the ledger is off, so nothing is expected. Exit 4: the notes couldn't be read, which is unknown, never missing. Exit 2: usage.

- **`/wave` Step 6** doesn't post record 1: the hook does. It checks that the comment exists and, if it doesn't, says so in the Step 7 report (`mr-cost-hook.log` says why); it never posts one by hand.
- **`/mr` Step 4** runs it only for a hand-run `/mr` (a person typing it), when `scripts/cost-ledger enabled` exits 0 and the description carries measured cost lines (`subagent-tokens:`, `orchestrator-tokens:` or `est-cost-usd:`). It checks and reports; it doesn't post, because the hook posts record 1 when `glab mr create` runs. When an agent opens the MR under `/wave`, the implementer skips this check and Step 6 owns it.
- **`/fix-mr`** posts a record K for its pass when the MR already has record 1 and the ledger is on; it runs no existence check, because there is nothing to create without a record 1.
- **Exempt:** ledger off, a description with `cost-ledger: off`, or a plain `/mr` with no cost lines. No comment is expected, and its absence isn't a gap.

A CI lint of descriptions is out of scope here (#2131).

### Reading earlier records back

Earlier records are MR notes, which anyone who can comment can write, so the running total is built only from notes that pass every check:

- **Authored by the token's own user** (`glab api user`). A note with the heading by anyone else is counted ("N note(s) with this heading by another user were not read") and never read, numbered from or edited.
- **The generated heading** as the first line and **the generated footer** as the last.
- **At most 32 KB,** ASCII apart from the heading's dash, exactly one header row, one **Total** row and one window line, every Total cell a bold figure of a fixed shape (`1,234`, `0.40 USD`) or `n/a (...)`, and valid UTC times.

A failed check never becomes 0 or a guess: the running-total row reads `n/a` and the record states why, from a fixed list (an earlier record didn't parse; this user's earlier records aren't exactly records 1 to K-1; an earlier record states no window end). Windows that overlap in time aren't on the list: records are non-overlapping in tokens, not in time (each claims what no earlier record of its own session claimed), so two sessions' records on one MR may cover the same hours and the running total simply sums them. A time gap between windows isn't on the list either: the total still adds up and the record states the uncovered stretch. No note text is echoed in any message or record, so a hostile note can't put text into the comment this script posts with your token.

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

`scripts/kaizen_gate_ledger.py` reads the `## Gates` lines through `scripts/cost_ledger_lines.py`, the same reader `cost-table.py` uses, and the MR's cost comments through `cost-table.py`'s record parser, and adds a `## Cost` section to its report (`cost` in `--json`).

- **Each MR is in one state:** `recorded` (a well-formed figure), `disabled` (`cost-ledger: off`: nothing recorded, by choice) or `none` (no figure yet). A disabled MR is never counted as 0 and never averaged. A window or change class whose MRs are all disabled reads "disabled", not a mean and not "not recorded yet". **A window of disabled MRs isn't evidence that cost fell.**
- **Per-MR cost comes from the cost comments, not from `est-cost-usd:` (#2154).** The `## Gates` `est-cost-usd:` and `orchestrator-tokens:` lines are a go-ahead snapshot: their orchestrator share is session spend that every MR of the same wave also covers, and a record that states only `Window end:` has an orchestrator row cumulative from the session start. Averaging them inflates the means and makes later MRs of a long session look the most expensive (the `Window end:`-only records of !1752 to !1756 grew 5.2M, 10.1M, 12.4M, 16.2M, 19.8M orchestrator tokens while the Opus part stayed 470,283). So for each MR that carries a `## Gates` cost line, `/kaizen` reads the MR's notes (the token user's own `## Cost of this MR` comments only, parsed by `cost-table.py`'s `parse_record`) and sums the **Total** `Est. cost` of every record that states `Window: S to U`. Those windows do not overlap.
- **An MR it cannot cost is excluded, never read as 0.** The report prints how many MRs it left out of every mean and why, each with its MR ids: `legacy record with no window start (orchestrator row not windowed)` (any `Window end:`-only record makes the whole MR unreadable: leaving the record out would undercount and adding it would double count), `legacy and windowed records: partial` (an MR with both kinds; the windowed part alone is never summed), `records by another user` (a cost comment by anyone but the token user, even beside the token user's own records: summing only the own part would undercount), `no cost record by the token user`, `duplicate or non-consecutive record numbers` (a repeated K, or Ks that are not 1..n), `overlapping windows` (once sorted, a window starts before the previous one ends, or repeats it), `a record did not parse`, `a record with no USD total`, `notes unreadable` (the notes call failed) and `notes not read`. An MR with no cost line in `## Gates`, or `cost-ledger: off`, costs no API call and is not in the cost population. The report accounts for every MR it read (costed + excluded + `cost-ledger: off` + no cost lines in `## Gates`), and an offline `--input` cut by `--window` prints how many MRs it did not read. Offline MRs behave exactly like live ones: they carry GitLab note objects in `notes` and the token user's id in `token_user_id`, and go through the same `own_records` filter.
- **`subagent-tokens:` stays a `## Gates` figure.** It is per branch (a subagent is attributed to the MR whose worktree it acts in), so it is still averaged from the description.
- **By change class** (the branch prefix `feat`, `fix`, `docs`, `chore`, else `other`, the same proxy as the [yield watch](kaizen-yield-watch.md)): mean est. cost over the class's costed MRs (the sum of their windowed records) and mean `subagent-tokens` over its recorded MRs. `orchestrator-tokens:` is never averaged.
- **By gate:** the mean cost of the MRs a gate ran on vs was `n/a` on, and findings per USD (the gate's findings on those MRs over their summed cost), over costed MRs only. It's the MR-level cost, not the gate's own cost: the ledger records cost per MR, not per gate.
- **Malformed lines:** MRs whose cost lines fail the checker are listed; their malformed figures are ignored, not read as 0.

### A record without a window start
<a id="no-window-start"></a>

A record that states only `Window end:` (the form posted before macrodream/blueprint#387) has an orchestrator row that starts at the session's start. It still parses, `--next-since` still reads its end, and `/kaizen` excludes it from cost means. The only code path in this repo that can still render one is a hand-run `cost-table.py --comment --file` without `--since` (`scripts/cost-table.py`, the `elif record == 1:` branch of `_render`); `post-mr-cost.py` passes `--since` on every record it posts (`scripts/post-mr-cost.py` `post_record`). That branch now adds the fixed line "This record has no window start: its orchestrator row is not windowed, so it overlaps other MRs of the same session and must not be compared with or added to another MR's cost." and no longer claims the records do not overlap.

## What isn't ported

- **No MR-description CI lint.** Upstream's `mr-gate-ledger` job checks every MR description; Visiban has no gate-ledger lint job, and this port didn't add one (#2131). The cost rules live in `scripts/cost_ledger_lines.py`, run by hand before `glab mr create` (the `/mr` and `/wave` skills say when).
- **Not ported:** upstream's `gate-yield.py` and `mr-verdict.py` (the `/kaizen` adaptation above replaces the cost sections of `gate-yield.py`), its `change-class:` ledger line (Visiban classifies by branch prefix), and its context-nudge Stop hook.
