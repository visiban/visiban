---
name: sunset-check
description: >
  Decide whether to remove, fix, narrow, or demote an existing Visiban surface. Inverts
  the Voice-of-Customer question — instead of "would you adopt this?", it asks each
  persona "this is gone next release, what breaks for you?" — and scores removal cost
  rather than adoption likelihood. Verifies what the surface actually does against what
  the docs and decision records claim before scoring anything, and routes any removal
  through the backward-compatibility rules in CLAUDE.md. Use when considering deleting a
  feature, when a shipped surface is half-built or oversold, when maintenance cost is
  outrunning use, or when asked whether something should just be taken out.
argument-hint: "<feature, page, endpoint, or flow>"
---

# Sunset Check

Answer the question "should this still exist?" about a surface that already ships.

Ported from Blueprint (`macrodream/blueprint`, `.claude/skills/sunset-check/`) and adapted
to Visiban: personas come from the root `CLAUDE.md`, decisions live in
`docs/architecture/decisions.md`, and the reversibility check is the *Backward
compatibility* section of `CLAUDE.md`. This skill decides **whether** a surface should go;
it does not scan for deprecations whose removal window has already closed.

---

## What this skill produces — read this before using its output

Like `/voc`, this produces **simulated feedback from modeled personas** plus a reading of
the codebase. It is not user research. Nobody is asked anything. Every output carries the
Step 5 banner, real signal supersedes the panel, and nothing this skill emits may be quoted
outside a sunset-check context as though it were customer feedback.

> **A simulated panel never authorizes a removal.** Deleting a shipped capability is a
> promise broken to whoever was using it — and since 1.0 it may be a broken public API
> contract. The panel routes attention and prices the maintenance burden; a human decides.
> A low removal-cost score is an argument to *investigate* a removal, never a mandate to
> merge one.

## Why this is not `/voc` with a different prompt

`/voc` scores **predicted adoption of a proposed addition**. Pointed at a removal question
its number is ambiguous: a 3/10 cannot be read as "removing this would be bad" or as "this
thing is bad" — opposite recommendations, same digit. `/voc-audit` reviews shipped surfaces,
but always *toward improvement*: it has no cell for "this should not exist." This skill
fills the gap.

---

## Step 0 — Establish what the surface actually does

**Do not skip this, and do not substitute the design document for it.** A panel handed a
decision record scores a feature *as designed*; the decision in front of you is about the
feature *as shipped*, and on a half-built surface those are different products.

1. **Find the implementation.** Name the files, endpoints, serializers, WebSocket events,
   management commands, settings / env vars, and UI entry points. If you cannot find an
   entry path a user could actually reach, that is the single most important finding in
   the run — say so in the first line of the report.
2. **Read what the project claims about it** — `docs/features/`, `docs/administration/`,
   `docs/api/`, `docs/architecture/decisions.md`, `README.md`, www.visiban.com copy if the
   surface is marketed (the `visiban-www` repo), and the changelog entry that introduced it.
3. **Diff claim against code** and classify the surface into exactly one of:

   | State | Meaning |
   |---|---|
   | **Delivered** | Code does what the docs say |
   | **Oversold** | Docs and/or a decision record promise materially more than the code does |
   | **Vestigial** | Code exists, but there is no reachable entry point — or no reader for what it writes |
   | **Undocumented** | Code does something real that nobody was ever told about |

4. **Check reversibility before anything else.** Removal is not symmetric with addition: a
   feature can be re-added, destroyed data cannot, and a broken client stays broken. Answer
   each against `CLAUDE.md` *Backward compatibility*, and put the answers in the report:
   - **User data** — does removing it destroy or orphan rows? Then the recommendation is a
     deprecation path with a migration, never a delete, and any column or table drop lands
     in a separate migration at least one release after the ORM reference goes.
   - **REST contract** — is any serializer field or endpoint public? A field cannot be
     removed or retyped without a major bump; an endpoint returns `410 Gone` with a
     deprecation notice for at least one minor release first. Check `docs/api/`.
   - **WebSocket events** — never removed without a documented deprecation of at least one
     release; payload fields are never removed without a major bump.
   - **Env vars / settings** — a removed or renamed env var keeps a deprecated alias for at
     least one minor release; a changed default is documented in the upgrade guide.
   - **Enterprise extension point** — does `visiban-enterprise` register against it
     (signals, settings includes, URL patterns, extension panels)? Its shape is a contract
     with enterprise customers; removing it breaks them.

5. **Price the cost of keeping it.** Nobody on the panel represents this, so measure it
   here and hand it to them as fact: source lines, test files, docs pages, decision records,
   open issues, CI jobs, and suppression markers that exist *only* to serve this surface.
   An oversold surface also carries a **trust cost** — someone who finds the docs overstate
   one feature reasonably discounts every other claim in them.

> **The Oversold case has no status-quo option.** When Step 0 classifies a surface as
> Oversold, "leave it alone" is not on the menu, because the current state actively
> misleads users. The verbs collapse to three: fix the code, narrow the claim, or remove
> both. Say this explicitly rather than letting inaction win by default.

## Step 1 — Establish what evidence already exists

**Modeled opinion is the fallback, not the default.** Check three sources and record which
produced anything — that is the run's **evidence tier**:

1. **The tracker** — has anyone real spoken about this surface?
   `glab issue list --search "<surface keywords>" --all --per-page 50`. Read notes, not just
   titles; separate reports from real users from maintainer- or panel-filed issues.
2. **External practitioner discourse** — two or three web searches on the **functional
   category, never the product name** ("do teams actually use kanban WIP limits", not
   "Visiban WIP limits"). A competitor's deprecation notice is unusually strong evidence
   here: if comparable Kanban tools shipped and then removed this class of functionality,
   their changelog usually says why. Spend a search on it.
3. **The calibration ledger** — `.claude/persona-calibration.md`, if it exists
   (`/voc-audit --calibrate` writes it). A persona that mispredicted this class of question
   before gets its verdict weighted down, and the report says so.

| Tier | Meaning | Effect |
|---|---|---|
| **E0** | Nothing in 1 or 2 | Full panel. State the tier plainly |
| **E1** | External category evidence only | Panel runs; that evidence enters as established fact the panel may not reason against |
| **E2** | The tracker carries a real report bearing on this question | Real signal supersedes the panel — scope the panel to the residue |
| **E3** | A named real user, or a measured behavior, answers the question | **Do not convene.** Report the evidence and stop |

External evidence is about the *category*. It is cited as "practitioners on `<source>`
describe X", never "our users say X", and never called corroboration.

**Absence of complaint is not evidence of value, and not evidence of worthlessness
either.** On a young product you have neither. Record E0 honestly.

## Step 2 — Convene the panel with the question inverted

One sub-agent per relevant persona from the root `CLAUDE.md` (Maya, Jordan, Sam, Alex), run
in parallel, each handed its persona entry and the Step 0 findings as fact. The question is
**not** "would you use this?" It is:

> "This surface is gone in the next release. What breaks for you?"

Every persona whose workflow could plausibly touch the surface participates, plus any
persona who carries the **trust cost** of an oversold claim — they feel a removal as an
upgrade surprise. Alex usually carries that cost for anything an admin configured.

Each returns exactly this shape:

```
## <PERSONA>: removal cost N/10 [BLOCKER | CONCERN | WIN]
"<one sentence in this persona's voice, reacting to the surface being gone>"

What breaks: <concretely, what this persona can no longer do — or "nothing">

Cheapest replacement: <the smallest thing that would make this removal painless for this
persona: an export, a doc line, a different existing feature. "None needed" if the removal
costs them nothing.>

Falsification: <for each BLOCKER and CONCERN, one line naming the real-world observation
that would confirm or refute it after a removal — "nobody reports its absence within one
release", "someone asks where it went in the first week". A code check is NOT a
falsification line. If you cannot name one for a BLOCKER, downgrade it to CONCERN and say
why.>

Blind spot: <one line — what could a real person in this role tell us that you, reasoning
only from the persona definition, structurally cannot?>
```

Note the inverted severity: a **WIN** means the feature going away is *good* for that
persona.

## Step 3 — Weigh the panel against the cost of keeping

Do not delegate this. The synthesis is the skill.

The panel prices what is lost; Step 0 item 5 priced what is paid. Neither number decides alone,
and **a removal-cost average is not an inverted adoption average** — do not carry either
across from a `/voc` run on the same surface.

| Removal cost | Cost of keeping | Reading |
|---|---|---|
| Low | High | Strongest case to **remove** |
| Low | Low | **Demote to experimental** — cheap to keep, nobody needs it, stop advertising it |
| High | High | **Keep-and-fix** — load-bearing and underbuilt. The expensive answer, and usually the right one |
| High | Low | **Keep.** There is no decision here; do not manufacture one |

A single BLOCKER outweighs a low average in either direction. Do not average away a hard
NO, and do not let a chorus of WINs retire one.

## Step 4 — Pick a verb

The recommendation is exactly one of four:

- **Remove** — no BLOCKER, removal cost low across the panel, cost of keeping real, no data
  destroyed. Ships **through the deprecation path Step 0 item 4 named** — `410 Gone`, event and
  env-var deprecation notices, a later drop migration — never as a single-release delete of
  a public contract. Ships with: the docs removal, a changelog fragment
  (`changelog.d/<issue>.changed.md`, or `.security.md` if it closes an exposure), and an
  issue recording what was removed and why, so it is not silently re-proposed in six months.
- **Keep-and-fix** — a BLOCKER exists, or the surface is Oversold and the promise is worth
  keeping. Ships with: one issue per gap between claim and code.
- **Keep-but-narrow-the-claim** — the code is fine, the documentation is not. The most
  common right answer for an Oversold surface, and the cheapest. Ships with: the docs diff
  that makes the claim true (and the `visiban-www` diff if the claim is marketed).
- **Demote to experimental** — keep the code, remove the advertising. Ships with: docs moved
  behind an explicit experimental label, and removal from any getting-started or evaluation
  path (including the try.visiban.com demo seed data, if it features the surface).

**"Leave it exactly as it is" is not one of the four.** If that is genuinely right, the run
should have concluded at Step 0 that there was no question here.

## Step 5 — Report

```
> **Simulated panel — not user research.** Every persona verdict below is a language model
> reasoning from the composite personas in the root CLAUDE.md. No user was interviewed,
> surveyed, or observed. Scores are predicted removal cost, not measured sentiment.
> **A simulated panel does not authorize a removal.** This is a recommendation to a human.
> **Evidence tier:** <E0 | E1 | E2 | E3> — <what each Step 1 source returned>

### Surface reviewed
<files, entry points, and the Step 0 classification>

### Reversibility
<data, REST, WebSocket, env var, extension point — and what each constrains>

### Cost of keeping
<source lines, tests, docs pages, decision records, open issues, CI jobs. Plus trust cost if
Oversold.>

### Panel verdict — removal cost
| Persona | Cost | Tag | What breaks | Cheapest replacement |

### Recommendation: <remove | keep-and-fix | keep-but-narrow-the-claim | demote to experimental>
<the Step 4 condition that selects it, and what ships with it>

### Falsification lines
<carried out of the panel verbatim — these are what a later cycle checks against>

### What this panel could not see
<the Blind spot lines, consolidated>
```

## Step 6 — Record the recommendation on the tracker

The verdict is work state: a human decides on it, a later cycle scores its falsification
lines, and a Remove that is not written down gets re-proposed in six months. A prediction
nobody wrote down cannot be wrong, which is the same as not having made one.

1. **Find the issue that records the decision.** Search open and closed issues for the
   surface (`glab issue list --search "<surface keywords>" --all`). An open issue about the
   surface's future takes the record as a comment. If none exists, offer to file one titled
   `Sunset check: <surface>`; ask which milestone and `release::` label apply, never infer.
2. **Show the record and ask before posting or filing.** If the user declines, say the
   recommendation is **not recorded**.
3. **Post it** (comment: `glab issue note <iid> --message "$(cat <<'EOF' ... EOF
)"`; new issue: `glab issue create --description` with the same heredoc body), in this
   shape:

```
## Sunset check (/sunset-check), <YYYY-MM-DD>

> Simulated panel, not user research. A simulated panel does not authorize a removal: this is a recommendation to a human. Evidence tier: <E0–E3>.

Surface: <files, entry points> · Step 0 state: <Delivered | Oversold | Vestigial | Undocumented>
Reversibility: <data / REST / WebSocket / env var / extension point>
Cost of keeping: <the Step 0 measures>
Recommendation: <verb> — <the Step 4 condition that selects it>

### Falsification lines
- <carried from the panel verbatim>

### What this panel could not see
- <the Blind spot lines>
```

   The record never carries a per-persona removal-cost score or an average.
4. **File what the verb ships with as each item is confirmed**, not at the end:
   Keep-and-fix files one issue per gap between claim and code, each linked to the decision
   issue, with the same confirm-and-ask-the-label step. Remove's "issue recording what was
   removed and why" is the decision issue itself.

Tell the user what was recorded and where: the issue link and any gap issues filed.

## What this skill does NOT do

- It does not remove anything. It recommends; a human merges.
- It does not answer "should we build this?" — that is `/voc`.
- It does not audit a shipped surface toward improvement — that is `/voc-audit`.
- It does not produce a number anyone may quote outside a sunset-check context.
- It does not treat a design document as evidence about the code.
