---
name: voc-audit
disable-model-invocation: true
description: >
  Run a Voice-of-Customer panel against a Visiban surface that has already SHIPPED — a
  merged feature, page, or flow — verify every finding against the code, then
  cross-reference the survivors with the issue tracker. Produces a ranked
  "file new / boost priority / already tracked" matrix. `--calibrate` instead scores
  what an earlier /voc panel predicted against what real users reported, and appends
  the result to `.claude/persona-calibration.md`. Distinct from /voc, which evaluates a
  feature before it is built; distinct from the `ux-review` agent, which checks
  design-system compliance; and distinct from /sunset-check, which decides whether a
  surface should exist at all.
argument-hint: "<merged MR, page, or feature name> [--calibrate]"
---

# VoC Audit — Persona Review of Shipped Surfaces

Ported from Blueprint (`macrodream/blueprint`, `.claude/skills/voc-audit/`) and adapted to
Visiban: personas come from the *Personas* section of the root `CLAUDE.md` (Maya, Jordan,
Sam, Alex — `.claude/personas.md` does not exist here), and Visiban's `/voc` does not post
its panels to the tracker, so `--calibrate` finds predictions where they were written down.

## What this produces, and what it is not

**Simulated feedback from modeled personas. Nobody is asked anything.** A model reasons from
composite personas. That is a legitimate post-launch proxy and an illegitimate substitute
for a user report. Three rules follow, and they are not stylistic:

- **Never present panel output as customer feedback** — not in an issue, MR, ADR, roadmap
  entry, or commit message. If a finding is worth filing, file it on its merits and say a
  simulated panel surfaced it.
- **Two panels agreeing is not corroboration.** It is the same model agreeing with itself.
  Only a real user report corroborates a modeled finding.
- **Check for real signal first.** If a real report already covers the question, it
  decides. Scope the panel to the remainder, or skip it. Never run a panel to argue a real
  report away.

Every output of this skill opens with this banner:

> **Simulated persona panel (/voc-audit) — not user research.** Personas: root `CLAUDE.md`.
> No real user was consulted. These are modeled concerns, verified against the code, not
> customer feedback.

---

## Step 0 — Resolve the target surface

From the argument, resolve exactly what shipped: the merged MR(s), the files, the routes or
endpoints, the WebSocket events, and the release it landed in. If the target is ambiguous,
ask — auditing the wrong surface wastes the whole run.

## Step 1 — Inventory what shipped

Read the code on `origin/main`. Produce a factual brief of the surface **as it exists**:
what a user can do, what they cannot, which roles can reach it, what states exist (empty,
error, loading, permission-denied, real-time update from another user), its keyboard path,
and what is stubbed or enterprise-only.

This brief is the panel's only ground truth, so its errors propagate to every finding.
Record what you actually read, file by file.

## Step 2 — Choose the personas that can reach this surface

**Seat personas by reachability, not by role plausibility.** The failure mode: seating all
four because the surface is "user-facing", when Alex never opens a board and Sam visits
twice a week. Those personas then mark their criteria N/A *and* drag the average down —
the panel reports a low number that means "wrong audience", not "bad surface".

Seat a persona only if this surface is on the path of one of their top-three tasks. Name
the ones you excluded and why.

## Step 3 — Run the panel

Spawn one sub-agent per seated persona, in parallel. Hand each the persona's `CLAUDE.md`
entry and the Step 1 brief (never the design doc). Each returns:

```
## <PERSONA>: N/10  [🔴 blocker | 🟡 friction | 🟢 fine]

### Material improvements (ranked by daily-task impact)
- <finding> — falsification line: <a real-world observation that would prove this wrong>

### Already-acceptable aspects
### What this persona could NOT see
```

The **falsification line is mandatory and must predict an observation about the world**,
not a code condition. "There is no export button" is a code check, and Step 4 spends it.
"Users will abandon this flow rather than paginate" is a claim a later real report can
confirm or refute. Only the second kind can ever be scored by `--calibrate`.

---

## Step 4 — Verify every finding against the code, BEFORE touching the tracker

**This is the step that makes the run worth doing.** The panel is a hypothesis generator;
this is the only step that touches ground truth. Searching the tracker first means filing
model output as fact.

Deduplicate first — personas surface overlapping concerns. Merge identical substance into
one entry and credit each persona that raised it.

Then check each finding against the tree: read the component, grep the symbol, check the
serializer and the permission class, read the issue the finding assumes is open. Assign
one of three outcomes:

- **survived** — the check ran and the finding stands. Carry it to Step 5 and record what
  you checked, so the report rests on a `file:line` rather than on a persona.
- **falsified** — the condition was met; the finding is wrong. **Drop it and say so in the
  report.** A falsified finding is a result, not an embarrassment — it keeps wrong issues
  out of the tracker.
- **surfaced-during-verification** — the check falsified the finding as stated but exposed
  a real defect one layer away. Often the strongest findings in a run. **Attribute them to
  the check, never to a persona** — crediting a persona with a finding it did not make
  corrupts calibration.

Two rules that matter more than they look:

- **A finding that rests on an absence must be verified as absent.** "There is no X" is the
  most common false finding, because the Step 1 brief can be wrong and the personas take
  it as given. Grep before you believe it — including `frontend/src/` keyboard shortcut
  maps and the enterprise extension panels.
- **Re-check the brief itself.** If verification shows Step 1 misstated the shipped
  behavior, every finding downstream is suspect — say so, rather than quietly correcting
  one row.

**Code verification is not falsification.** "Verified at `<sha>`" proves the defect exists;
it does not predict what a user would say, which is the only thing calibration can score. A
finding whose falsification line merely restates a code check is **unscoreable** — write
the real-world line before filing, or file it explicitly marked unscoreable.

Record the counts: survived / falsified / surfaced-during-verification.

---

## Step 5 — Cross-reference survivors against the tracker

Only **survived** and **surfaced-during-verification** findings reach this step. For each,
search the tracker in **all** states with 2–3 keywords; one search per facet of a
multi-faceted finding:

```bash
glab issue list --search "<keywords>" --all --per-page 50
```

Assign a state:

- **`tracked in #N (priority::P)`** — an open issue exists. If the finding raises urgency
  above the current `priority::` label, mark it a **boost candidate**.
- **`closed #N (<date>, <close reason>)`** — read the close reason and the notes. Do **not**
  silently re-file. Classify with the user as: regression / new instance of the same class
  / already-decided.
- **`untracked`** — eligible for a new issue.

Separate **real** reports from modeled ones. An issue filed from a user's words is evidence
of a different kind from one filed off a panel — including this one. A finding a real user
also raised is **corroborated**; a finding matching only other panel-filed issues is
**not**. Write "raised again by the panel", never "confirmed by users".

---

## Step 6 — Report

```
<the banner above>

# VoC Audit — <surface> — <date>

## Surface reviewed        <files, routes, events, release>
## Personas seated         <and who was excluded, and why>
## Panel verdict           <per-persona scores — context only, never a decision>
## Verification yield      <survived / falsified / surfaced-during-verification>

## File new                <untracked survivors, ranked by impact × frequency × personas>
## Boost priority          <tracked, with current and proposed priority>
## Already tracked         <no action>
## Regression / new instance of closed #N
## Already decided         <closed and not a regression>
## Falsified               <reported, not filed — with what falsified each>
## What the panel could not see
```

**The panel average never authorizes a decision.** It is context. What leaves this skill is
the verified findings and their falsification lines.

---

## Step 7 — Record on the tracker (only with user confirmation)

Ask in **one batched `AskUserQuestion` round** (at most four questions per call): show
every proposed write below, and for each item ask file/post, decline, or leave. Nothing
posts or files unconfirmed, and a declined item is said to be unrecorded.

- **File new.** Each untracked survivor becomes an issue whose body carries, in separate
  sections, the verification (`file:line`, the grep, the query), the falsification line,
  and the banner. Check the finding for a security weakness first: one that is gets
  `--confidential`. Never set a `release::` label — ask, never infer.
- **Boost candidates.** Post one comment on the tracked issue, headed
  `## Simulated persona panel (/voc-audit), <YYYY-MM-DD>`, with the banner, the current
  priority, the proposed priority, and the verified finding with its falsification line.
  Never the average, a per-persona verdict, or an in-character quote. **Never change the
  priority label yourself**: it is the user's call.
  `glab issue note <iid> --message "$(cat <<'EOF' ... EOF
  )"`.
- **Regressions and new instances of a closed issue.** File a new issue linking closed `#N`,
  with the same verification and falsification sections. For a **regression**, name the MR
  that **introduced** it in an `Introduced by: !<iid>` line (`git log` / `git blame` on the
  surface; the MR that closed `#N` is the fix, not the introducer, unless the fix itself was
  incomplete — say so). Prove the closing fix actually landed via its merge SHA on the
  GitLab API, not a local `git log -S`: the local clone can be shallow. A true regression
  belongs in the **current** working release. **Never reopen the closed issue.**
- **Already decided** and **already tracked** need no write. The report says so.

---

## `--calibrate`

Once a feature has shipped to real users, score what its `/voc` panel predicted against
what users actually reported, and append the result to `.claude/persona-calibration.md`.
A release that shipped to users with no calibration entry is a finding for `/kaizen`, not
an oversight to catch up on later. Calibration is the only thing that tells a useful
persona from a plausible one; without it the panel is unfalsifiable by construction.

### C1 — Find the recorded prediction

Visiban's `/voc` returns its panel to the session (it feeds `architect`) and does not post
it anywhere, so a prediction exists only where someone wrote it down. Search, in order:
the feature issue's notes, the implementing MR's description and notes (look for
`Panel Summary`, `Key blockers`, or `Simulated persona panel`), and any ADR in
`docs/architecture/decisions.md` that cites the panel. Score only blockers and concerns
**written before the release shipped**. A feature with none has no recorded prediction:
say so and stop. Never reconstruct a prediction from memory or by re-running `/voc` now —
a prediction made after the outcome is known scores nothing.

Comments headed `(/voc-audit)` record a shipped-surface audit, not a prediction; do not
score them.

### C2 — Gather real reports

Search the tracker for issues and notes about the feature filed **by people outside the
maintainer team**, or quoting a named user, since the release date. Panel-filed issues
(they carry the banner) are never evidence. If there are no real reports, record
`no signal` — absence of complaint is not confirmation.

### C3 — Score each prediction

For each recorded blocker or concern:

| Outcome | Meaning |
|---|---|
| **confirmed** | A real report describes the predicted friction |
| **refuted** | Real usage contradicts it (users did the thing the panel said they would not) |
| **no signal** | No real report bears on it either way |
| **unscoreable** | The prediction had no real-world falsification line |

### C4 — Append to the ledger (with confirmation)

Show the entry and ask before writing. Create `.claude/persona-calibration.md` on first use
with the heading `# Persona Calibration Ledger` and a one-line note that entries are
append-only. The change goes through a branch and MR like any other file. Entry format:

```
## <YYYY-MM-DD> — <feature> (released in <version>)

- Prediction source: <issue/MR note link, date written>
- Real reports: <issue links, or "none">
- Window: <release date> → <today>

| Persona | Prediction | Falsification line | Outcome | Evidence |
|---|---|---|---|---|
| Maya | ... | ... | confirmed | #NNNN |

Hit rate (confirmed ÷ (confirmed + refuted)): <x/y, or "n/a — no scored rows">
Notes: <a persona that mispredicted this class of question, so later panels weight it down>
```

Never average across entries in the file, and never quote a hit rate outside this ledger.

---

## When the answer is "this should not exist"

This skill's matrix — file new / boost priority / already tracked — has no cell for that,
and forcing one produces an improvement issue against a surface nobody should be
improving. **Hand the question to `/sunset-check`** and say so in the report. The tells:
the panel keeps returning the same friction release after release; the surface's docs
promise materially more than its code does; or a persona's honest answer to "what would you
do instead" names a different feature that already exists.
