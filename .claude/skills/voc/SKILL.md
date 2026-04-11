---
name: voc
description: Voice of Customer panel — evaluate a feature from Visiban persona perspectives with scored feedback.
argument-hint: "<all|persona names> <feature description>"
---

# Voice of Customer Panel

You are running a structured Voice of Customer (VoC) review. Your job is to evaluate the proposed feature or change from the perspective of each Visiban persona and return a scored panel report.

## Arguments

`$ARGUMENTS` — a description of the feature or change to evaluate. If `all` is the first word, evaluate from all four personas. Otherwise, evaluate only from the personas named (e.g. `jordan sam`).

## Personas (from CLAUDE.md)

- **Maya** (Project Manager, mid-size team): plans sprints, monitors progress, needs at-a-glance status across multiple simultaneous workstreams. Values: speed and overview. Pain: too many context switches, can't see the whole picture in one place.
- **Jordan** (Senior Engineer, power user): lives in the board all day, uses keyboard shortcuts, relies on the audit trail for incident retrospectives. Values: accuracy, keyboard nav, full history. Pain: anything that interrupts flow or hides information.
- **Sam** (Designer, occasional user): checks in a few times a week to update card status and add notes. Values: intuitive UI that requires no training. Pain: features that assume daily familiarity.
- **Alex** (IT Admin): provisions users, manages SSO, monitors usage, handles onboarding. Values: control, visibility, low maintenance. Pain: anything requiring manual intervention at scale.

## What to do

For each requested persona, produce a panel section in this format:

```
### [Name] — [score]/10

**Perspective:** [1–2 sentences describing how this persona encounters this feature in their workflow]

**What they like:** [bullet list, 1–3 items]

**Blockers / concerns:** [bullet list, 1–3 items — label each 🔴 blocking or 🟡 minor]

**Verdict:** [one sentence summary]
```

After all personas, produce a summary section:

```
## Panel Summary

**Average score:** [X.X]/10
**Key blockers:** [list any 🔴 items across all personas, or "None"]
**Recommendation:** [Proceed / Proceed with adjustments / Revisit design — one sentence justification]
```

## Rules

- Score 1–10: 1 = actively harmful, 5 = neutral/acceptable, 10 = delightful
- A 🔴 blocker means the feature as described would frustrate or fail this persona in a significant way
- Be honest — do not inflate scores. A feature that benefits Maya but confuses Sam should show that split
- Keep each section concise — this report feeds directly into the architect review prompt
