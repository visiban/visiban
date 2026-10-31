# Docs Style: Smart Brevity

How to rewrite a Visiban docs page so a reader gets the one thing they need first, and can scan for the rest.

**Why it matters:** Most docs readers are mid-task. They need one command, one setting, or one warning, and they skim to find it. A page that opens with background makes them read the background.

**The big picture:** This guide adapts Axios's *Smart Brevity* format to technical docs. It came out of the Starlight docs spike (#1271), which rewrote `docs/getting-started/` this way in `docs-site/src/content/docs/getting-started/`. Use those pages as worked examples. The follow-up issues that rewrite the rest of `docs/` link here.

## The one rule

**Brevity cuts words, never facts.** Every command, env var, default, version note, warning, and edge case on the old page must be on the new page. If a fact looks too minor to keep, move it lower on the page or into a table. Do not delete it.

Before you call a rewrite done, diff the old and new pages for:

- every code block (each command must still be there, unchanged unless it was wrong)
- every env var, Helm key, and file path
- every callout, by severity (see [Callouts](#callouts)), and every blockquote callout label (`> **Added in 1.2**`, `> **Visiban Enterprise**`)
- every version note ("Added in 1.2", "since 1.2", "Changed in 1.2", "(1.2+)")
- every link, external and internal (page and `#anchor`)
- every heading anchor the old page published (see [Headings and links](#headings-and-links))

`docs-site/scripts/check-rewrite-facts.mjs` checks every item on this list. Version notes are matched as phrases, so a reworded note can pass while saying something different; read those yourself. For a rewrite done in place in `docs/`, compare against the branch point; no build is needed:

```bash
cd docs-site && npm ci
node scripts/check-rewrite-facts.mjs --base origin/main features
```

It must end with `problems 0`. Paste that summary line in the MR.

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

**A callout keeps its callout and its severity.** Never flatten a `!!! warning` or `!!! danger` into prose, a bold label, or the lede. A reader scanning for warnings looks for the callout box, so a warning that isn't in one has been deleted as far as that reader is concerned. The lede may restate the action a warning asks for, but the callout stays. A rewrite must have at least as many callouts of each severity as the page it replaces.

Use a *new* callout only for a fact a reader could be hurt by missing, not for asides.

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
- **Never break a published anchor.** Every `##`–`######` heading on a page that has been published is a URL someone may have bookmarked or linked, from places no grep can reach. If you rename, merge, or remove a heading, keep its old anchor resolving: leave `<a id="old-anchor"></a>` right above wherever that content now lives. mkdocs anchors are the heading lowercased, punctuation removed, and runs of spaces and hyphens collapsed to one `-`. A repeated heading gets `_1`, `_2`, and so on. `check-rewrite-facts.mjs` lists any that no longer resolve, including the duplicate-heading `_1` class.
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

**After** (161 words, counting the anchor shim):

```markdown
## Marking the Done column

Mark every column where work finishes (for example "Done", "Closed", or "Released") as
**done**, before your team moves its first card.

!!! warning "Required for accurate analytics"
    Until at least one column is marked as done, the dwell-time heatmap includes all
    columns: closed work stays in the data and distorts stage timing.

**How it works:** A done column is:

- **left out of the dwell-time heatmap**, so completed work doesn't inflate time-in-stage
  figures for active stages
- **counted as completed work** when cards move into it, which feeds the 7-day and 30-day
  velocity in the **Summary** view

<a id="steps"></a>

**To mark it:** open the column's **⋯** header menu (it appears on hover) → **Edit** →
check **Mark as done column** → **Save**.

**Yes, but:** the column label doesn't change on the board. The "done" flag shows up only
in analytics views. You can mark more than one column, for example both "Closed Won" and
"Closed Lost".
```

What changed, and why:

- **The action became the lede.** "Mark it before your team moves its first card" is the one thing a reader must do, so it comes first. The example names ("Done", "Closed", "Released") moved into the lede with it.
- **The warning kept its callout and its severity.** The lede restates its action; the callout still carries the consequence, where a reader scanning for warnings will find it. Only the sentence the lede now says was removed from it.
- **The four-step list became one line**, because each step is one click. Use a numbered list when a step takes more than one action or can fail.
- **The removed `### Steps` heading left its anchor behind** as `<a id="steps"></a>`, so `board-setup/#steps` still resolves.
- **The surprise went under "Yes, but".** The board doesn't visibly change, which a reader might take as a sign the setting didn't save.
- **No facts were dropped.** That covers the hover menu, both velocity windows, the Summary view, multiple done columns, and all five example names.

## Checklist for a rewrite MR

- [ ] Every page has a lede sentence and a **Why it matters:** line.
- [ ] `check-rewrite-facts.mjs --base origin/main <section>` reports `problems 0`. That means no code block, inline-code token, external or internal link, callout (per severity), blockquote label, version note, or published anchor was lost. Any reworded version notes were also read by hand.
- [ ] Every warning and danger is still a callout of the same severity.
- [ ] No "Coming in X" or "Ships in X" wording for a version that has shipped. CI's `docs-version-accuracy` job fails on it.
- [ ] Every page is written in US English.
