---
name: kaizen
description: Audit the development harness by reading the `## Gates` ledger across recently merged MRs — computes per-gate yield, run count, and ledger adoption, and names concrete gate-narrowing candidates with evidence. Distinct from /pre-release, which audits the codebase.
argument-hint: "[window]"
---

# Kaizen — Harness Audit

`/kaizen` audits **the development harness itself**: does the gate battery
(`architect`, `security-review`, `rbac-check`, `perf-check`,
`broadcast-check`, `migration-check`, `regression-check`, `ux-design`,
`ux-review`, `changelog`, `test-scaffold`, `api-docs`, `docs-writer`, `voc`,
`dependency`, `enterprise-check`) still earn its slot? It asks "does this
check still mean anything?" — never "is the code correct right now?".

## `/kaizen` vs `/pre-release` — do not merge these

| | `/pre-release` | `/kaizen` |
|---|---|---|
| Audits | the **codebase** | the **development harness** |
| Question | "what becomes a public commitment we can't take back?" | "does this gate still catch anything?" |
| Input | source files, migrations, API surface | `## Gates` lines in merged MR descriptions |
| Output | 🔴/🟡/🟢 findings against a release | per-gate yield table + narrowing candidates |
| Cadence | feature freeze + one sprint before tag | ad hoc, whenever gate drag is suspected |

If a future change tries to fold these into one skill, that is a regression
— they read different inputs and answer different questions. See issue
#1094 for why this skill exists: `CLAUDE.md` has required the `## Gates`
ledger since before this skill did, cited "kaizen finding #682" as settled
precedent, and no `/kaizen` existed to have produced it. This skill is the
reader the rule already assumed.

Related, not duplicated: #1093 (a gate that can go green forever without a
self-test — "can this gate fail?"), #1090 (a gate that flips on run-to-run
variance — "can this gate ever reliably pass?"). This skill covers the third
case: a gate that runs, passes, reports honestly, and simply never finds
anything.

---

## Step 0 — window

Read `$ARGUMENTS` as an integer window (number of most-recently-merged MRs
to audit). Default to **30** if empty or not an integer — this matches the
sample size issue #1094 was scoped against, and GitLab's API returns them in
one page.

---

## Step 1 — run the parser

The parsing is mechanical (regex over MR descriptions) and lives in
`scripts/kaizen_gate_ledger.py`, not in this skill's own reasoning — a
20-line yield table should be reproducible byte-for-byte on a re-run, not
re-derived by eyeballing 30 descriptions each time.

```bash
python3 scripts/kaizen_gate_ledger.py --window "$WINDOW" --json > /tmp/kaizen-report.json
python3 scripts/kaizen_gate_ledger.py --window "$WINDOW"                  # human table, same run
```

(`--input <file>` reads a local JSON array of MR objects instead of calling
`glab` — this is what the test fixture and any offline re-run should use.)

### Parser grammar — looser than `.claude/skills/mr/SKILL.md` documents

The `mr` skill's canonical line is `gate: <name> — <N> findings`. Real MRs
also use: en/em/plain dashes with variable spacing (including the
fixed-width-aligned form inside a fenced code block), singular "finding",
bare `n/a` with no parenthetical, and non-numeric "deliverable" outcomes
(`ran (...)`, `fragment added (...)`, `deferred to #NNN`, `see pipeline`) for
gates whose mandated output is an artifact rather than a finding count —
`changelog`, `docs-writer`, and (inconsistently — sometimes numeric, sometimes
not) `test-scaffold`. The parser accepts all of this loose-but-real grammar
rather than only the documented strict form, because rejecting real lines
would silently understate both adoption and run counts. **Say this in the
report** — do not present the parsed numbers as if every line matched the
documented format cleanly.

`test-scaffold`'s split reporting style (numeric in some MRs, deliverable
prose in others) is itself worth one line in the report as a harness
consistency note, not a yield finding — it means the harness doesn't agree
with itself about what kind of gate `test-scaffold` is.

---

## Step 2 — read the adoption line first

The script's JSON carries `adopted` / `window` / `adoption_pct` at the top
level. **State this before any per-gate number** — CLAUDE.md is explicit
that a yield number without its coverage is misleading, and adoption biases
which MRs even have data to compute yield from. If adoption is below ~50%,
say plainly that the sample is small relative to the branch population and
that gates could be silently under- or over-represented.

If this run's adoption differs materially from a previously reported number
(e.g. issue #1094 measured 11/30 at filing time), **do not silently overwrite
that history as if this were the first measurement** — say both numbers and
that the difference reflects continued MRs landing between measurements, the
same "re-measure, don't trust the old number" discipline `CLAUDE.md`'s memory
section asks for elsewhere. A stale number in an issue is not evidence the
new number is wrong.

---

## Step 3 — apply the thresholds (already computed per gate)

The script's `verdict` field per gate is one of:

- **`inconclusive (n=X < 10)`** — fewer than 10 findings-bearing runs. Report
  the gate's raw counts but do not draw a yield conclusion from it. A 0%
  yield over 2 or 3 runs means nothing; say so explicitly rather than
  omitting the gate.
- **`fast-path candidate (0% yield, narrow the trigger — never delete)`** —
  ≥10 runs, zero of them found anything. This is the actionable signal
  #1094 exists to surface.
- **`load-bearing (resist trimming)`** — >50% yield. Call these out
  explicitly as gates to leave alone; a narrowing proposal that doesn't
  mention which gates are working *against* the trimming pattern reads as
  one-sided.
- **`deliverable gate — ...`** — `changelog` / `docs-writer` /
  `test-scaffold`-when-reported-as-deliverable. No yield applies; report the
  run count only.
- **`normal`** — between the two thresholds, or exactly at 50%. Neither
  actionable nor load-bearing; report the number, no verdict language needed.

### The one hard rule: never propose deletion

A `fast-path candidate` verdict is a proposal to **narrow the gate's trigger
condition** — e.g. "run `ux-design` only when the diff introduces a new
interaction pattern, not on every UI change" — never to remove the gate from
the roster. This is an explicit acceptance criterion in #1094, not a style
preference. If a narrowing proposal has no defensible narrower trigger to
propose, say the finding is "flagged, no narrowing proposed yet" rather than
reaching for deletion as the fallback.

---

## Step 4 — truthfulness findings rank above speed findings

Before ranking any yield/narrowing finding, check for these — they undermine
every other number in the report if left unmentioned:

1. **Phantom gates.** For every gate name appearing in the ledger, confirm a
   corresponding file exists: `.claude/agents/<name>.md`,
   `.claude/skills/<name>/SKILL.md`, or (for `voc`) `.claude/skills/voc/`
   per the `mr` skill's own documented shorthand. A name with no backing
   file is being tallied as "covered" while it can never actually run —
   report it before any yield number, since it means the adoption/run counts
   for that name are uninterpretable.
2. **Self-inconsistent reporting.** A gate reported both numerically and as
   a deliverable across different MRs (see `test-scaffold` above) — the
   harness doesn't have one shared idea of what the gate produces.
3. **Any stale claim this run's data contradicts** — e.g. a previously
   recorded adoption/yield number in an issue or memory file that no longer
   matches. Report the correction, not just the new number silently.

Only after these, list yield/speed findings (fast-path candidates,
load-bearing confirmations).

---

## Step 5 — declined findings

`.claude/kaizen-declined.json` is the ledger of findings a user has already
seen and declined to act on. **Read it before finalizing the report; write
to it only when the user explicitly declines a finding in this session** —
never seed a decline preemptively.

Schema: a JSON array of objects:
```json
[
  { "id": "ux-design:fast-path-candidate", "declined_on": "2026-09-15", "note": "one-line reason the user gave" }
]
```
`id` is `<gate>:<verdict-kind>` (e.g. `migration-check:fast-path-candidate`,
`test-scaffold:self-inconsistent-reporting`) — stable across runs as long as
the same gate keeps landing the same verdict kind. Before including a
finding in the capped list (Step 6), skip any whose `id` already appears
here. If a declined finding's underlying verdict has since changed (e.g. a
gate that was a fast-path candidate is now `normal`), it naturally drops out
on its own — no cleanup needed.

---

## Step 6 — cap and report

Cap the report at **~5 findings total**, truthfulness findings first (Step
4), then yield/narrowing findings ordered by run count descending (the
best-evidenced fast-path candidates first). Always include, regardless of
the cap:

- The adoption line (Step 2).
- The full per-gate table (every gate, every verdict) — the cap applies to
  *narrative findings*, not to the raw table. Hiding a gate's row because it
  didn't make the top 5 findings would recreate the exact invisibility
  problem #1094 exists to fix.

Report format:

```
## Kaizen — Harness Audit — <date> — window: last N merged MRs

### Adoption
`## Gates` present in A/N MRs (P%). <caveat if low/changed from prior measurement>

### Gate ledger
<full table: gate | runs | zero | >0 | n/a | skipped | unscored | yield | verdict>

### Findings (max 5, truthfulness first)
1. 🔴/🟡 <finding> — evidence: <numbers> — proposal: <narrow X to Y>  [or: declined <date>, skipped]
...

### Declined (not re-raised)
<any finding suppressed this run because .claude/kaizen-declined.json already covers it>
```

Never present this report's contents as user research or as a substitute for
`/pre-release` — it is a harness read, not a code or product audit.

---

## Rules

- **Never recommend deleting a gate.** Only narrowing its trigger condition,
  with a specific proposed condition.
- **`0 findings`, `n/a`, and `skipped` are three distinct states** — never
  average or sum them together. `n/a` never counts toward a gate's run
  denominator; `skipped` is a compliance signal (the gate should have run
  and didn't), reported separately, also excluded from yield.
- **Always report adoption alongside yield**, every run, not just when it's
  low.
- **A gate with fewer than 10 findings-bearing runs is inconclusive** —
  report its raw counts, draw no verdict.
- **Truthfulness findings (phantom gates, stale claims, self-inconsistent
  reporting) outrank yield findings** in the capped list.
- **Cap at ~5 findings; never re-raise one recorded in
  `.claude/kaizen-declined.json`.**
- This skill only reads MR descriptions and repo files — it does not modify
  application code, does not open issues, and does not file its own findings
  as GitLab issues automatically. Report to the user; let them decide what
  to act on.
