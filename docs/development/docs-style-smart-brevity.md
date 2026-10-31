# Docs Style: Smart Brevity

How to rewrite a Visiban docs page so a reader gets the one thing they need first, and can scan for the rest.

**Why it matters:** Most docs readers are mid-task. They need one command, one setting, or one warning, and they skim to find it. A page that opens with background makes them read the background.

**The big picture:** This guide adapts Axios's *Smart Brevity* format to technical docs. It came out of the Starlight docs spike (#1271), which rewrote `docs/getting-started/` this way in `docs-site/src/content/docs/getting-started/`. Use those pages as worked examples. The follow-up issues that rewrite the rest of `docs/` link here.

## The one rule

**Brevity cuts words, never facts.** Every command, env var, default, version note, warning, and edge case on the old page must be on the new page. If a fact looks too minor to keep, move it lower on the page or into a table. Do not delete it.

Before you call a rewrite done, diff the old and new pages for:

- every code block (each command must still be there, unchanged unless it was wrong)
- every env var, Helm key, and file path
- every `!!! warning` / `!!! danger` (or `:::caution` / `:::danger`)
- every version note ("Added in 1.2", "since 1.2", "Changed in 1.2")
- every link

## Page anatomy

Each page follows this order. Skip a part only if it would be empty or padded.

1. **Title: say what the reader gets.** Write a plain promise, not a topic label. "Mark your Done column so analytics stay honest" beats "Board Setup". Keep it under about 60 characters. In Starlight, set a short `sidebar.label` so the nav stays scannable.
2. **Lede: one sentence.** Give the single thing the reader must know or do. If they stop reading here, they should still act correctly.
3. **Why it matters:** one or two sentences on the consequence: what breaks, what it costs, or what it unlocks.
4. **Bold-label axioms:** short, labeled blocks the reader can jump between. Use only the labels that fit:
    - **The big picture:** where this fits in the whole system.
    - **How it works:** the mechanism, in steps or bullets.
    - **By the numbers:** limits, defaults, sizes, timeouts.
    - **Yes, but:** the honest caveat or tradeoff. Use it whenever there is one. Don't hide a limitation in a footnote.
    - **Watch out:** a footgun with a non-obvious failure mode.
    - **Go deeper:** links to the next page or the reference.
5. **Sections (`##`)** for the task steps and reference material, in the order the reader does them.

## Sentence and paragraph rules

- **Lead with the verb or the fact.** Write "Set `ALLOWED_HOSTS` before going live", not "It is important to remember that you should set...".
- **Keep paragraphs to one to three sentences.** If a paragraph lists three things, make it a list.
- **No throat-clearing.** Cut "This section describes", "Note that", "Simply", "In order to", "As mentioned above", and "It's worth noting".
- **Put a condition before its instruction.** Write "If you access Visiban from a LAN IP, set...". The reader can skip the instruction once they see the condition doesn't apply.
- **Bold the noun the reader scans for:** a UI label (**Admin → Settings**), a hard requirement (**must**), or the one word that changes the meaning (**not**). Never bold a whole sentence.
- **Use a table for a set of three or more items with the same attributes.** Examples: env vars, TLS modes, failure meanings.
- **Use US English** (see the project `CLAUDE.md`).

## Callouts

Keep the callout's severity. Use a callout only for a fact a reader could be hurt by missing, not for asides.

| mkdocs (today, `docs/`) | Starlight (`docs-site/`) | Use for |
|---|---|---|
| `!!! note "Title"` | `:::note[Title]` | context the reader needs |
| `!!! info "Title"` | `:::note[Title]` | same as note |
| `!!! tip "Title"` | `:::tip[Title]` | a shortcut or a better way |
| `!!! warning "Title"` | `:::caution[Title]` | something that breaks or costs time |
| `!!! danger "Title"` | `:::danger[Title]` | data loss, security exposure |

Write the callout title as the takeaway, not a category. "Back up first: this deletes the database" beats "Warning".

## Headings and links

- **Write headings as tasks or answers.** "Retrieve the admin password" beats "Retrieving the password".
- **Don't silently break an anchor that is linked to.** Before you rename a `##`/`###` heading, grep for its anchor across `docs/`, `frontend/src`, `backend`, `helm`, and `README.md`. If something links to it, keep the heading text, or leave the old anchor in place with `<a id="old-anchor"></a>` right above the new heading.
- **Link once per page, where the reader needs it.** Don't add a "Related" section that repeats links already in the body. Put new links under **Go deeper:** instead.

## Before and after

This example is from `docs/getting-started/board-setup.md`, "Marking the Done column". The rewrite keeps every fact.

**Before** (176 words):

```markdown
## Marking the Done column

!!! warning "Required for accurate analytics"
    Until at least one column is marked as done, the dwell-time heatmap includes all
    columns — closed work stays visible in the data and distorts stage timing. Mark your
    completion column before your team starts moving cards.

Every board should have at least one column designated as the completion point (for
example, "Done", "Closed", or "Released"). Marking it tells Visiban to:

- **Exclude it from the dwell-time heatmap** — so completed work does not inflate
  time-in-stage figures for active stages
- **Count movements into it as completed work** — powering the 7-day and 30-day velocity
  figures in the Summary view

### Steps

1. Open the column header overflow menu on your Done column (the **⋯** icon that appears on hover).
2. Choose **Edit**.
3. Check **Mark as done column**.
4. Save.

The column label does not change on the board — the "done" designation is only reflected
in analytics views. You can mark multiple columns as done (for example, both "Closed Won"
and "Closed Lost").
```

**After** (139 words):

```markdown
## Marking the Done column

Mark every column where work finishes as **done**, before your team moves its first card.

**Why it matters:** Until one column is marked done, the dwell-time heatmap counts finished
work as if it were still in flight. Closed cards look like bottlenecks, and velocity stays at zero.

**How it works:** A done column is:

- **left out of the dwell-time heatmap**, so finished work doesn't inflate time-in-stage
- **counted as completed work**, which feeds the 7-day and 30-day velocity in **Summary**

**To mark it:** open the column's **⋯** header menu (it appears on hover) → **Edit** → check
**Mark as done column** → **Save**.

**Yes, but:** nothing changes on the board itself. The flag shows up only in analytics.
You can mark more than one column, for example both "Closed Won" and "Closed Lost".
```

What changed, and why:

- **The warning became the lede.** It was the one thing a reader must do, so it now comes first instead of sitting in a callout.
- **The consequence moved into "Why it matters"** and absorbed two facts from a later section ("bottlenecks" and "velocity stays at zero") that repeated the same idea.
- **The four-step list became one line**, because each step is one click. Use a numbered list when a step takes more than one action or can fail.
- **The surprise went under "Yes, but".** The board doesn't visibly change, which a reader might take as a sign the setting didn't save.
- **No facts were dropped.** That includes the hover menu, both velocity windows, multiple done columns, and the example names.

## Checklist for a rewrite MR

- [ ] Every page has a lede sentence and a **Why it matters:** line.
- [ ] The old page and new page were diffed for commands, env vars, warnings, version notes, and links (see "The one rule").
- [ ] Every renamed heading that is linked from somewhere keeps its old anchor.
- [ ] No "Coming in X" or "Ships in X" wording for a version that has shipped. CI's `docs-version-accuracy` job fails on it.
- [ ] Every page is written in US English.
